/**
 * thinking-parser.ts — 思考文本结构化解析器
 *
 * 将模型输出的 <think> 内容（常是一大段自由文本）按"理解/拆解/推理/验证"
 * 四阶段切分为结构化子 Span，每个阶段作为独立 thinking_phase TraceSpan
 * 进入统一时间线，与工具调用交错展示，避免原来整块折叠不可读的问题。
 *
 * 解析规则（确定性、无模型调用）：
 *   - Phase 标题关键词识别（如"## 理解问题"、"Phase 1:"、"首先理解"等）
 *   - 编号步骤提取（1.xxx、一、xxx）
 *   - 未匹配的自由文本 → 归为 "other" 阶段（不丢弃）
 */

import type { ParsedThinking, ThinkingStage } from '@/lib/types';

interface StageRule {
  stage: ThinkingStage;
  title: string;
  /** 正则按优先级从高到低尝试；命中则进入该阶段 */
  patterns: RegExp[];
}

/**
 * 阶段规则表：顺序=优先级，第一个命中生效。
 * 规则覆盖常见中文/英文写法，大小写不敏感，支持中英文数字混合编号。
 */
const STAGE_RULES: StageRule[] = [
  {
    stage: 'understanding',
    title: 'Understanding',
    patterns: [
      // 明确标题型
      /(?:##|###|阶段\s*[1一]|Phase\s*1|Part\s*1)[^\n]{0,30}?(?:理解|复述|问题|需求|输入|background|context|understand|restatement|goal)[^\n]{0,30}?/gi,
      // 语义型：开头出现
      /(?:^|\n)[^\n]{0,10}?(?:首先[，,:：]?)?(?:用|我)?(?:自己的话|先|来)?(?:复述|重述|理解|确认|回顾)(?:一下|问题|需求)?[。,，:：\s]/g,
      /(?:^|\n)[^\n]{0,10}?(?:已知条件|前提条件|约束条件|用户需求|问题描述)[：:是为]/g,
      /(?:^|\n)[^\n]{0,10}?(?:let me|first[,:]?)\s+(?:understand|restate|recap|rephrase|summarize the question)/gi,
    ],
  },
  {
    stage: 'decomposition',
    title: 'Decomposition',
    patterns: [
      /(?:##|###|阶段\s*[2二]|Phase\s*2|Part\s*2)[^\n]{0,30}?(?:拆解|分解|分|子问题|拆|breakdown|decompose|plan|approach)[^\n]{0,30}?/gi,
      /(?:^|\n)[^\n]{0,10}?(?:拆解|分解|拆分|拆分成|拆分为|分为|分成)[^\n]{0,20}?(?:个子|个步骤|个部分|个子问题|个阶段)[^\n]{0,10}?[。,，:：]/g,
      /(?:^|\n)[^\n]{0,10}?(?:子问题|子任务|步骤\s*(?:列表|清单)|执行计划|解题思路)[：:是为]/g,
      /(?:^|\n)[^\n]{0,10}?(?:列出|整理)[^\n]{0,15}?(?:子问题|步骤)[^\n]{0,10}?[：:]/g,
      /(?:^|\n)[^\n]{0,10}?(?:i'll|i will|next[,:]?)\s+(?:break|decompose|split|divide|plan|outline)/gi,
    ],
  },
  {
    stage: 'reasoning',
    title: 'Reasoning',
    patterns: [
      /(?:##|###|阶段\s*[3三]|Phase\s*3|Part\s*3)[^\n]{0,30}?(?:推理|分析|方案|推导|reason|analysis|inference|deduce)[^\n]{0,30}?/gi,
      /(?:^|\n)[^\n]{0,10}?(?:深度推理|逐步推理|开始推理|分析一下|推理过程|分析过程)[。,，:：\s]/g,
      /(?:^|\n)[^\n]{0,10}?(?:方案[一二三四五六七八九十\d]+[：:]|可选方案|候选方案|解法|路径|思路)[^\n]{0,10}?[：:是为]/g,
      /(?:^|\n)[^\n]{0,10}?(?:权衡|比较|对比|优劣|利弊|pros\s*and\s*cons)[^\n]{0,10}?[：:分析]/gi,
      /(?:^|\n)[^\n]{0,10}?(?:因为|所以|因此|由此|如果|假设|假定|那么|否则|进一步[说地])[，,。\s]/g,
      /(?:^|\n)[^\n]{0,10}?(?:i'll|i will|now[,:]?)\s+(?:reason|analyze|derive|think through|evaluate)/gi,
    ],
  },
  {
    stage: 'verification',
    title: 'Verification',
    patterns: [
      /(?:##|###|阶段\s*[4四5五]|Phase\s*[45]|Part\s*[45])[^\n]{0,30}?(?:验证|检查|复核|校验|整合|收尾|verify|check|validate|integrate|final)[^\n]{0,30}?/gi,
      /(?:^|\n)[^\n]{0,10}?(?:验证|检查|复核|校验|核对|确认|验证一下|检查一下|反查|自检)[。,，:：\s]/g,
      /(?:^|\n)[^\n]{0,10}?(?:回?溯到?原|完整回答|覆盖|是否|有没有遗漏|不确定性|薄弱环节|检验标准|什么情况[下]?会被证明是错)[^\n]{0,15}?[？?。,，:：]/g,
      /(?:^|\n)[^\n]{0,10}?(?:整合|收尾|汇总|总结子|得出最终|最后|conclude|final check|verify before answer)/gi,
      /(?:^|\n)[^\n]{0,10}?(?:finally|lastly|in conclusion|to verify|let me check|to validate)/gi,
    ],
  },
];

/** 阶段标题的简写正则（不含换行，用于 inline 触发） */
function findNextStageBoundary(
  text: string,
  fromIdx: number,
): { idx: number; stage: ThinkingStage; title: string; matchLen: number } | null {
  let best: { idx: number; stage: ThinkingStage; title: string; matchLen: number } | null = null;

  for (const rule of STAGE_RULES) {
    for (const pattern of rule.patterns) {
      // Reset regex lastIndex (global regexes have state)
      pattern.lastIndex = 0;
      const sliced = text.slice(fromIdx);
      // 注意：带 g flag 的正则，match() 返回 string[]（无 .index），必须用 exec() 才能拿到含 index 的单个 Match 对象
      const m = pattern.exec(sliced);
      if (!m || m.index === undefined) continue;
      const absoluteIdx = fromIdx + m.index;
      if (!best || absoluteIdx < best.idx) {
        best = {
          idx: absoluteIdx,
          stage: rule.stage,
          title: rule.title,
          matchLen: m[0].length,
        };
      }
    }
  }
  return best;
}

/**
 * 结构化解析思考文本。
 *
 * 算法：
 *   1. 全文扫描，寻找所有命中的阶段边界（标题位置）
 *   2. 相邻两边界之间的文本 = 该阶段内容
 *   3. 开头到第一个边界之间的内容 = 归属首个命中阶段的"前置引导语"，或单独 unclassified
 *   4. 未命中任何边界 → 全量 unclassified（保持兼容，不强行拆）
 *
 * 流式模式（opts.streaming = true，断点3修复）：
 *   思考文本是逐 token 到达的不完整文本，阶段标题关键词（如"## 理解问题"）可能尚未出现，
 *   此时不再把长文本归为 unclassified——那会导致 UI 无 span 可渲染、TraceTimeline 整体不显示、
 *   思考内容完全不可见。改为始终产出单个 "Thinking" span 承载实时累积文本；
 *   已出现的边界正常切分，尾部未完成内容天然落在最后一个 span 内，
 *   由 TraceTimeline 将其标记为 running 状态（带呼吸光标）。
 */
export function parseThinkingToSpans(
  thinkText: string,
  opts?: { streaming?: boolean },
): ParsedThinking {
  const text = (thinkText || '').trim();
  if (!text) return { spans: [], unclassified: '' };

  // 收集所有边界（按位置升序）
  const boundaries: Array<{ idx: number; stage: ThinkingStage; title: string; matchLen: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = findNextStageBoundary(text, cursor);
    if (!next) break;
    boundaries.push(next);
    cursor = next.idx + Math.max(1, next.matchLen);
  }

  // 无边界识别
  if (boundaries.length === 0) {
    // 流式模式：始终产出可见 span（承载实时累积的思考文本），长度不设限
    if (opts?.streaming) {
      return {
        spans: [{ stage: 'other', stageTitle: 'Thinking', content: text }],
        unclassified: '',
      };
    }
    // 完成态兜底：按短文本/长文本处理，只有当文本 < 300 字时才进 other 阶段（避免"整块折叠"感）
    if (text.length <= 300) {
      return {
        spans: [{ stage: 'other', stageTitle: 'Thinking', content: text }],
        unclassified: '',
      };
    }
    return { spans: [], unclassified: text };
  }

  const spans: ParsedThinking['spans'] = [];
  const unclassified = '';

  // 处理：[text start → 边界0] 之间的引导语
  const firstIdx = boundaries[0].idx;
  if (firstIdx > 20) {
    // 引导语足够长（>20字）→ 归为 "other" 阶段；短的话并入第一阶段
    const lead = text.slice(0, firstIdx).trim();
    if (lead.length > 0) spans.push({ stage: 'other', stageTitle: 'Prelude', content: lead });
  }

  // 处理每个阶段
  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i];
    const next = boundaries[i + 1];
    const contentStart = cur.idx + cur.matchLen;
    const contentEnd = next ? next.idx : text.length;
    const rawContent = text.slice(contentStart, contentEnd).trim();
    if (!rawContent) continue;

    spans.push({
      stage: cur.stage,
      stageTitle: cur.title,
      content: rawContent,
    });
  }

  return { spans, unclassified };
}
