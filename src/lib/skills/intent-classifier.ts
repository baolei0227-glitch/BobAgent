/**
 * skills/intent-classifier.ts — 用户意图粗分类器（技能匹配 Stage 1 门控）
 *
 * @deprecated P4d（2026-09-07 标记）：仅被同被废弃的 matcher.ts 引用（sandbox searchSkills 链路）。
 *   新功能禁止 import；随 matcher.ts 一起删除。
 *
 * 在精细关键词匹配前，先快速判断用户本次请求属于哪个「场景大类」，
 * 只让场景匹配的技能进入 Stage 2 精细匹配。
 * 解决："识别图片"（image场景）误命中 "video-split"（video场景）等跨场景误加载。
 *
 * 设计原则：零依赖、纯同步、<1ms 完成。不调用任何模型。
 */

import type { UserIntentCategory, IntentClassifyResult } from '@/lib/types';

/**
 * 各场景的【强触发关键词】—— 命中则高置信度归为该场景。
 * 与 description 中的宽泛描述词区分开：这里只用"明确指向某一场景、不会歧义"的词。
 */
const STRONG_TRIGGERS: Record<UserIntentCategory, string[]> = {
  visualization: [
    // 制图/可视化专属词
    '图表', '柱状图', '折线图', '饼图', '雷达图', '桑基图', '漏斗图', '散点图',
    '流程图', '时序图', '架构图', '示意图', '对比图', '思维导图', '甘特图',
    '数据看板', 'KPI', '信息图', 'infographic', 'integraph', 'dashboard',
    '可视化', '一图看懂', '数据图',
    // 口语化画图词（用户说"画个图""画UI图"时应命中 visualization 而非 image）
    '画图', '画个图', '画一张图', '画一个图', '画ui', 'ui图', 'mockup', 'wireframe',
    '线框图', '界面图', '原型图', '效果图', '标注图', 'UI界面', '用户界面',
    '画个示意图', '画个流程图', '画个架构图',
  ],
  legal: [
    '法条', '法律', '法院', '合同', '条款', '判例', '裁判', '案由',
    '诉讼', '仲裁', '律师', '法务', '合规', '风险', '民法典', '刑法',
    '劳动法', '公司法', '司法解释', '起诉', '答辩', '举证', '违约',
    '侵权', '赔偿', '判决书', '起诉状', '答辩状', '法律意见书',
  ],
  design: [
    '前端', '页面', 'UI', '界面', '组件', '样式', '配色', '主题',
    'landing page', '落地页', '官网', '作品集', '网站', '网页',
    '响应式', '动效', '原型', '交互', 'h5页面', 'h5',
  ],
  docs: [
    '报告', '文档', 'docx', 'word', 'ppt', 'pptx', '演示', '幻灯片',
    'excel', 'xlsx', '表格', 'pdf', '生成报告', '写报告', '总结报告',
    '合同审查', '模板', '简历', '路演', '课件',
  ],
  office: [
    '飞书', '日历', '日程', '会议', '邮件', '待办', '审批', '考勤',
    '多维表格', 'bitable', '文档协作', '提醒', '通知',
  ],
  video: [
    // 视频专属，不与"图片/识别"通用词重叠
    '录屏切页', '视频截图', '屏幕录制', '滚动截图', '视频切分',
    'split_video', '视频拆帧', '录制视频', '视频分段', '录屏视频',
    'ffmpeg', '视频帧',
  ],
  image: [
    // 视觉/图片专属
    '识别图片', '图片识别', '图像识别', 'ocr', '文字识别',
    '视觉模型', 'vlm', '图片描述', '分析图片', '看图',
    '图像生成', '生成图片', '文生图', '图生图', '三视图',
    'detect all', '识别猫咪', '识别物体',
  ],
  code: [
    '写代码', '开发', '编程', '重构', '调试', 'debug', '函数',
    '组件开发', 'api', '接口', '脚本', '算法', '部署', '测试用例',
  ],
  search: [
    '搜索', '调研', '查一下', '查找资料', '最新消息', '新闻',
    '行业报告', '市场分析', '竞品',
  ],
  general: [],
};

/**
 * 【跨场景排除规则】—— 命中 A 场景强词后，若同时命中 B 场景的"排除特征"，
 * 则避免 A 场景的误命中。例：
 *   - "识别图片中的文字" → image 正确，但若描述里只含通用词"识别"+"切"可能误进 video
 *   - "滚动截图" → video 正确（长录屏），但"截图"本身也指向 image
 */
const EXCLUSION_RULES: Array<{
  category: UserIntentCategory;
  /** 当命中这些词时，即使有 STRONG_TRIGGERS 重叠，也排除该 category */
  exclusionWords: string[];
}> = [
  // video 场景：必须含"视频/录屏/帧/ffmpeg"等明确视频特征，不含则排除
  {
    category: 'video',
    exclusionWords: [
      // 若请求含这些纯图片词，则不可能是 video 场景
      '猫咪图片', '客厅图片', '照片', '截图图片',
    ],
  },
  // visualization 场景：纯"图片识别"请求不该进制图技能
  {
    category: 'visualization',
    exclusionWords: [
      '识别图片', '图片识别', 'ocr', '文字识别', '看图',
      '猫咪', '进食', '照片', '描述图片内容',
    ],
  },
  // docs 场景：纯聊天不含文档产物词
  {
    category: 'docs',
    exclusionWords: [
      '识别图片', '图片识别', '猫咪', '客厅', '进食',
    ],
  },
  // legal 场景：无法律专属词直接排除
  {
    category: 'legal',
    exclusionWords: [
      '识别图片', '图片识别', '猫咪', '画图', '设计', '前端',
    ],
  },
  // visualization 场景：排除纯图片识别/生成（非制图）
  {
    category: 'visualization',
    exclusionWords: [
      '识别图片', '图片识别', 'ocr', '文字识别', '图像生成', '生成图片',
      '文生图', '图生图', '识别猫咪', '识别物体',
    ],
  },
];

/** 场景 → 技能 scenes 字段映射（供 Stage 1 过滤技能池） */
export const INTENT_TO_SKILL_SCENES: Partial<Record<UserIntentCategory, string[]>> = {
  visualization: ['design', 'bob-work'],
  legal: ['legal'],
  design: ['design', 'dev', 'bob-work'],
  docs: ['docs', 'office'],
  office: ['office', 'lark'],
  video: ['dev', 'bob-work', 'video'],
  image: ['bob-work', 'docs'],
  code: ['dev', 'bob-work'],
  search: ['bob-work', 'docs', 'legal'],
  general: ['general', 'bob-work'],
};

/** 小写 + 去空白归一化（不做任何分词，保证词表可复现） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * 计算一个 category 的命中分数：
 *   - 强触发词命中：每词 +2 分（权重最高）
 *   - 返回 score（已归一化到 0-1 置信度）+ 命中的触发词列表
 */
function scoreCategory(
  category: UserIntentCategory,
  normText: string,
  origText: string,
): { score: number; triggers: string[] } {
  const triggers = STRONG_TRIGGERS[category];
  if (!triggers || triggers.length === 0) return { score: 0, triggers: [] };

  const hit: string[] = [];
  for (const word of triggers) {
    const w = normalize(word);
    if (!w) continue;
    if (normText.includes(w) || origText.toLowerCase().includes(word.toLowerCase())) {
      hit.push(word);
    }
  }

  // 归一化：最多 5 个强词就算 1.0（超过不加分，避免单场景词多膨胀）
  const raw = hit.length * 2;
  const score = Math.min(1.0, raw / 10);
  return { score, triggers: hit };
}

/** 检查排除词：命中则 score 归零 */
function applyExclusion(
  category: UserIntentCategory,
  normText: string,
  score: number,
): { score: number; exclusions: string[] } {
  const rule = EXCLUSION_RULES.find(r => r.category === category);
  if (!rule) return { score, exclusions: [] };

  const hit: string[] = [];
  for (const w of rule.exclusionWords) {
    if (normText.includes(normalize(w))) hit.push(w);
  }
  if (hit.length > 0) {
    return { score: 0, exclusions: hit };
  }
  return { score, exclusions: [] };
}

/**
 * 用户意图粗分类入口。
 * 算法确定性：
 *   1. 所有 STRONG_TRIGGERS 场景打分
 *   2. 应用 EXCLUSION_RULES 剔除误匹配
 *   3. 取最高分 category；若最高分 < 0.1，视为 general
 *
 * @returns 分类结果（最高分 category + 置信度 + 命中词）
 */
export function classifyUserIntent(
  userInput: string,
  conversationContext = '',
): IntentClassifyResult {
  const combined = (userInput || '') + '\n' + (conversationContext || '');
  const normText = normalize(combined);
  const origText = combined;

  const categories: UserIntentCategory[] = [
    'visualization', 'legal', 'design', 'docs', 'office',
    'video', 'image', 'code', 'search',
  ];

  let best: IntentClassifyResult = {
    category: 'general',
    confidence: 0,
    triggerWords: [],
    exclusionWords: [],
  };

  for (const cat of categories) {
    const { score, triggers } = scoreCategory(cat, normText, origText);
    if (score <= 0) continue;

    const { score: finalScore, exclusions } = applyExclusion(cat, normText, score);
    if (finalScore <= 0) {
      // 虽然被排除，但记录一下排除词，供前端调试展示
      if (exclusions.length > 0 && best.confidence === 0) {
        best = { category: 'general', confidence: 0, triggerWords: triggers, exclusionWords: exclusions };
      }
      continue;
    }

    if (finalScore > best.confidence) {
      best = {
        category: cat,
        confidence: Math.round(finalScore * 1000) / 1000,
        triggerWords: triggers,
        exclusionWords: exclusions,
      };
    }
  }

  return best;
}

/**
 * 给定意图分类，返回"允许参与 Stage 2 匹配的技能场景"。
 * 不在返回集合内的技能直接跳过，不参与精细关键词匹配。
 */
export function getAllowedScenesForIntent(intent: IntentClassifyResult): Set<string> {
  const allowed = new Set<string>(['general']); // general 类技能始终允许（被动兜底）
  const scenes = INTENT_TO_SKILL_SCENES[intent.category] ?? INTENT_TO_SKILL_SCENES.general ?? [];
  for (const s of scenes) allowed.add(s);
  // 高置信度(≥0.4)严格门控；低置信度放宽，允许其他场景参与（模糊请求不要太激进过滤）
  if (intent.confidence < 0.4) {
    for (const extra of ['bob-work', 'docs', 'dev']) allowed.add(extra);
  }
  return allowed;
}
