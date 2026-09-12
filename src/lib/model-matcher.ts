import type { AvailableModel, ModelCapability, ModelSpec, ThinkingLevel } from './types';
import { VISION_MODEL_PATTERN, isOcrModel } from './model-tags';

export type TaskType = 'reasoning' | 'conversation' | 'coding' | 'creative' | 'analysis' | 'translation' | 'long-context' | 'general';

interface TaskAnalysis {
  type: TaskType;
  confidence: number;
  requiredCapabilities: ModelCapability[];
  description: string;
}

const CODING_KEYWORDS = [
  '写代码', '写个', '编程', '代码', 'function', 'function ', 'class', 'class ',
  'javascript', 'python', 'typescript', 'java', 'go', 'rust', 'c++', 'cpp', 'sql',
  'api', '接口', '实现', '开发', 'debug', '调试', 'bug', '修复', '重构',
  '算法', 'leetcode', '数据结构', '排序', '递归', '动态规划',
  'import', 'export', 'const', 'let', 'var', 'def', 'public', 'private',
  '组件', 'component', 'hooks', 'useState', 'useEffect', 'vue', 'react',
  'npm', 'yarn', 'package', 'node', 'server', 'client', '前后端',
  '报错', '错误信息', '异常', 'exception', 'stack trace',
  '优化性能', '内存泄漏', '并发', '异步', 'promise', 'async', 'await',
  'css', 'html', 'dom', '网页', 'ui', '样式', '布局',
];

const REASONING_KEYWORDS = [
  '为什么', '原因', '原理', '逻辑', '推理', '证明', '推导',
  '怎么', '如何', '步骤', '过程', '方法', '策略', '方案',
  '计算', '求解', '方程', '数学', '论证',
  '矛盾', '悖论', '假设', '验证', '检验', '真假', '正确',
  '判断', '是否', '对不对', '合理吗',
];

const CREATIVE_KEYWORDS = [
  '创作', '小说', '故事', '诗歌', '写诗', '写故事', '写小说',
  '文案', '营销', '广告语', '口号', '宣传', '品牌',
  '灵感', '点子', '艺术', '绘画',
  '设计', '构思',
];

const ANALYSIS_KEYWORDS = [
  '分析', '评估', '评价', '对比', '比较', '差异', '优劣', ' vs ', 'vs.',
  '研究', '调研', '报告', '总结', '归纳', '概括', '梳理',
  '趋势', '预测', '数据', '统计', '图表', '指标',
  '优缺点', '利弊', '权衡', '建议', '推荐', '哪个好', '选哪个',
];

const TRANSLATION_KEYWORDS = [
  '翻译', '英文', '中文', '英语', '日语', '韩语', '法语',
  '英文怎么说', '中文怎么说', '意思是', '解释',
];

const LONG_CONTEXT_KEYWORDS = [
  '长文', '长篇', '完整', '全文', '文档', '文章', '论文',
  '综述', '总结', '摘要', '报告', '分析报告',
];

export function analyzeTask(input: string): TaskAnalysis {
  const trimmed = input.trim().toLowerCase();
  const length = trimmed.length;

  const scores: Record<TaskType, number> = {
    reasoning: 0,
    conversation: 0,
    coding: 0,
    creative: 0,
    analysis: 0,
    translation: 0,
    'long-context': 0,
    general: 0,
  };

  for (const kw of CODING_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores.coding += 2;
  }

  for (const kw of REASONING_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores.reasoning += 1.5;
  }

  for (const kw of CREATIVE_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores.creative += 1.5;
  }

  for (const kw of ANALYSIS_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores.analysis += 1.5;
  }

  for (const kw of TRANSLATION_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores.translation += 2;
  }

  for (const kw of LONG_CONTEXT_KEYWORDS) {
    if (trimmed.includes(kw.toLowerCase())) scores['long-context'] += 1;
  }

  if (length > 500) scores['long-context'] += 2;
  if (length > 1000) scores['long-context'] += 3;

  if (trimmed.includes('```')) scores.coding += 3;
  if (trimmed.includes('代码')) scores.coding += 2;
  if (trimmed.includes('编写')) scores.coding += 2;

  if (/[\u4e00-\u9fa5]/.test(input)) {
    scores.conversation += 1;
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) {
    return {
      type: length > 200 ? 'analysis' : 'conversation',
      confidence: 0.5,
      requiredCapabilities: ['conversation'],
      description: '通用对话',
    };
  }

  const type = Object.keys(scores).find((k) => scores[k as TaskType] === maxScore) as TaskType;
  const confidence = Math.min(maxScore / 10, 0.95);

  const capabilityMap: Record<TaskType, ModelCapability[]> = {
    reasoning: ['reasoning', 'analysis'],
    conversation: ['conversation'],
    coding: ['coding'],
    creative: ['creative', 'conversation'],
    analysis: ['analysis', 'reasoning'],
    translation: ['multilingual', 'conversation'],
    'long-context': ['long-context', 'analysis'],
    general: ['conversation'],
  };

  const descriptions: Record<TaskType, string> = {
    reasoning: '逻辑推理',
    conversation: '日常对话',
    coding: '代码编写',
    creative: '创意创作',
    analysis: '数据分析',
    translation: '翻译',
    'long-context': '长文档处理',
    general: '通用任务',
  };

  return {
    type,
    confidence,
    requiredCapabilities: capabilityMap[type],
    description: descriptions[type],
  };
}

export function selectBestModel(
  availableModels: AvailableModel[],
  taskAnalysis: TaskAnalysis,
): AvailableModel | null {
  if (availableModels.length === 0) return null;

  const scoredModels = availableModels.map((model) => {
    let score = 0;
    let tiebreaker = 0; // 二级排序分
    const capabilities = model.spec?.capabilities || [];

    // 一级：能力匹配
    for (const required of taskAnalysis.requiredCapabilities) {
      if (capabilities.includes(required)) {
        score += 3;
      }
    }

    // 加分项
    if (model.thinking && (taskAnalysis.type === 'reasoning' || taskAnalysis.type === 'analysis')) {
      score += 2;
    }

    if (capabilities.includes('long-context') && taskAnalysis.type === 'long-context') {
      score += 2;
    }

    if (capabilities.includes('coding') && taskAnalysis.type === 'coding') {
      score += 2;
    }

    if (capabilities.includes('creative') && taskAnalysis.type === 'creative') {
      score += 2;
    }

    if (capabilities.includes('multilingual') && taskAnalysis.type === 'translation') {
      score += 2;
    }

    // 二级排序（tiebreaker）：能力匹配数量
    for (const cap of capabilities) {
      if (taskAnalysis.requiredCapabilities.includes(cap)) {
        tiebreaker += 1;
      }
    }

    // conversation 任务：非思考模型优先（更快）
    if (taskAnalysis.type === 'conversation' && !model.thinking) {
      tiebreaker += 2;
    }

    // reasoning/analysis 任务：思考模型优先
    if ((taskAnalysis.type === 'reasoning' || taskAnalysis.type === 'analysis') && model.thinking) {
      tiebreaker += 1;
    }

    // coding 任务：有 coding 能力的多给 tiebreaker
    if (taskAnalysis.type === 'coding' && capabilities.includes('coding')) {
      tiebreaker += 1;
    }

    // 三级排序：价格偏好（contextWindow 更大的模型通常更强/更贵，conversation 任务偏好上下文小的快模型）
    const contextBonus = (model.spec?.contextWindow || 8192) > 100000 ? 0 : 1;

    // 复杂度分层（score 相等时的决胜）：复杂任务（推理/分析/创作/长文）偏好更强模型（输入单价更高=旗舰），
    // 日常任务（对话/翻译/通用/编码）偏好更快更便宜的模型。
    // 背景：deepseek-flash 与 v4-pro 的能力标注高度重叠 → 多数任务 score 全等，
    //   若无此分层，稳定排序会永远选中数组中的第一个模型（v4-flash），Auto 形同虚设。
    const price = model.spec?.pricePerMillionTokens?.input ?? 1;
    const complex = ['reasoning', 'analysis', 'creative', 'long-context'].includes(taskAnalysis.type);
    tiebreaker += complex ? price * 0.01 : -price * 0.01;

    return { model, score, tiebreaker: tiebreaker + contextBonus * 0.1 };
  });

  // 按 score 降序，score 相同按 tiebreaker 降序
  scoredModels.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.tiebreaker - a.tiebreaker;
  });

  return scoredModels[0].model;
}

/**
 * 根据选定模型的思考能力推断思考强度（auto 联动）。
 * 设计：模型已由 auto 按任务类型选出（复杂任务 → 思考模型，闲聊 → 快模型），
 * 因此思考强度直接由模型能力决定，无需再重复判断任务复杂度/输入长度：
 *   - 推理型模型（capabilities 含 reasoning，如 R1/Z1/K 系列）→ high
 *   - 支持思考的普通模型 → medium
 *   - 不支持思考 → low（即使能力表标了 reasoning 也按不支持处理）
 */
export function inferThinkingLevel(model: AvailableModel): ThinkingLevel {
  const caps = model.spec?.capabilities ?? [];
  const reasoningCapable = model.thinking || caps.includes('reasoning');
  if (!reasoningCapable) return 'low';
  return caps.includes('reasoning') ? 'high' : 'medium';
}

export function inferModelSpec(modelId: string, thinking: boolean): ModelSpec {
  const lower = modelId.toLowerCase();
  const capabilities: ModelCapability[] = [];
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const useCases: string[] = [];

  if (thinking || /reason|think|r1|z1|k2[.\-]5|k2[.\-]6|k3|logical|v4/.test(lower)) {
    capabilities.push('reasoning', 'analysis');
    strengths.push('逻辑推理能力强');
    useCases.push('复杂问题分析', '逻辑推理', '决策辅助');
  }

  if (VISION_MODEL_PATTERN.test(lower) && !isOcrModel(lower)) {
    capabilities.push('vision');
    strengths.push('图像理解能力强');
    useCases.push('图片理解', '截图分析', 'OCR 识别');
  }

  if (/code|coder|dev|programming|python|javascript|typescript/.test(lower)) {
    capabilities.push('coding');
    strengths.push('代码生成能力强');
    useCases.push('代码编写', '调试', '算法实现');
  }

  if (/chat|converse|turbo|dialog/.test(lower)) {
    capabilities.push('conversation');
    strengths.push('对话自然流畅');
    useCases.push('日常对话', '信息查询');
  }

  if (/creative|writer|story|novel|poet/.test(lower)) {
    capabilities.push('creative');
    strengths.push('创造力强');
    useCases.push('创意写作', '文案创作', '故事生成');
  }

  if (/multi|translate|lingua|cn|en|ja|zh/.test(lower)) {
    capabilities.push('multilingual');
    strengths.push('多语言支持');
    useCases.push('翻译', '跨语言交流');
  }

  if (/long|8k|128k|256k|1m|1000k|context|window/.test(lower)) {
    capabilities.push('long-context');
    strengths.push('长上下文处理');
    useCases.push('长文档分析', '文献综述');
  }

  if (capabilities.length === 0) {
    capabilities.push('conversation');
    strengths.push('通用对话能力');
    useCases.push('日常对话', '信息查询');
  }

  if (thinking) {
    weaknesses.push('响应速度较慢');
  } else {
    weaknesses.push('复杂推理能力有限');
  }

  // 默认按 1M 假设（与 context-limits 的 DEFAULT_CONTEXT_WINDOW 一致）：
  // 当前环境所有模型均为 1M 上下文（doubao-seed 等），模型 id 无窗口标记时不再回退到 8192，
  // 避免压缩/成果块/上下文闸等阈值被错误地按 8k 小窗口压低。显式 8k/128k/256k/1m 标记仍精确匹配。
  let contextWindow = 1000000;
  if (/1m|1000k/.test(lower)) contextWindow = 1000000;
  else if (/256k/.test(lower)) contextWindow = 256000;
  else if (/128k/.test(lower)) contextWindow = 128000;
  else if (/8k/.test(lower)) contextWindow = 8192;

  return {
    capabilities,
    strengths,
    weaknesses,
    useCases,
    contextWindow,
  };
}

export async function generateModelSpec(
  modelId: string,
  thinking: boolean,
  apiKey: string,
  baseUrl: string,
): Promise<ModelSpec | null> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'system',
            content: '你是一个AI模型分析专家。请根据模型名称分析该模型的能力特征。',
          },
          {
            role: 'user',
            content: `请分析模型 "${modelId}" 的能力特征。该模型${thinking ? '支持思考模式' : '不支持思考模式'}。请返回JSON格式，包含以下字段：
- capabilities: 能力列表，从 ["reasoning", "conversation", "coding", "creative", "analysis", "multilingual", "long-context", "vision"] 中选择
- strengths: 优势列表（2-4项）
- weaknesses: 劣势列表（1-2项）
- useCases: 适用场景列表（3-5项）
- contextWindow: 推测的上下文窗口大小（整数，如8192, 128000, 256000）

只返回JSON，不要其他内容。`,
          },
        ],
        stream: false,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const spec = JSON.parse(jsonMatch[0]) as Partial<ModelSpec>;
    return {
      capabilities: spec.capabilities || ['conversation'],
      strengths: spec.strengths || ['通用对话能力'],
      weaknesses: spec.weaknesses || ['能力未知'],
      useCases: spec.useCases || ['日常对话'],
      contextWindow: spec.contextWindow,
    };
  } catch {
    return null;
  }
}
