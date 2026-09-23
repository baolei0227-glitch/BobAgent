import type { ModelCapability, ModelSpec } from './types';
import { VISION_MODEL_PATTERN, isOcrModel } from './model-tags';

/**
 * 按模型 id 名字启发式推断能力画像。
 *
 * 消费面仅剩「上下文窗口推断」（context-limits / providers/resolve）与设置页展示，
 * 不再参与任何模型选路打分 —— Auto 模式只保留「候选池首项 + 带图视觉优先」（见 ChatNodeKernel）。
 */
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