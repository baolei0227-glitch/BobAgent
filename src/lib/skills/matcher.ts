/**
 * skills/matcher.ts — 技能匹配器（DSH 模式重构后：仅用于「主动搜索」）
 *
 * 注意：2026-08 起技能加载改为 DSH 模式（L1 目录常驻 + 模型 load_skill 按需加载），
 * 对话链路不再调用本匹配器做自动加载。本文件仅保留给「主动搜索技能」场景：
 *   - sandbox bridge 的 searchSkills IPC（小程序在已安装技能库中按关键词搜索）
 * 切勿再将其接入对话自动注入链路。
 *
 * 算法说明（历史）：两阶段路由——
 * Stage 1 门控：intent-classifier 粗分类，只让场景匹配的技能进入精细匹配。
 * Stage 2 精细：关键词 2-gram + 强词加权 + 【最少强词要求】，阈值 0.20。
 *
 * 解决原问题：
 *   - 0.08 太低：通用词"识别"命中不相关技能（如 image 命中 video-split）
 *   - 无强词要求：仅 1 个弱 2-gram 相交就通过
 *   - 无跨场景排除：image/visualization/video 三大场景互相串扰
 */

import type { SkillMeta, SkillMatchResult } from './types';
import { classifyUserIntent, getAllowedScenesForIntent } from './intent-classifier';

// 停用词
const STOP_WORDS = new Set([
  '的', '是', '在', '了', '和', '与', '或', '到', '要', '会', '能', '对',
  '当', '用', '被', '把', '从', '也', '就', '都', '而', '及', '但', '以',
  '不', '这', '那', '有', '我', '你', '他', '她', '它', '们',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'to', 'of', 'in', 'for', 'on',
  'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'about', 'up', 'out', 'if', 'now',
  '使用', '可以', '需要', '能够', '以及', '通过', '进行', '没有',
  '一个', '一种', '这个', '那个', '什么', '怎么', '如何', '为什么',
  // 【新增】高频但无场景区分力的通用动词——仅靠它们命中=假阳性
  '识别', '描述', '分析', '处理', '生成', '提取', '读取', '查看',
  '帮助', '支持', '包含', '提供', '使用', '用于', '进行', '通过',
  '内容', '信息', '数据', '结果', '方式', '方法', '情况', '问题',
]);

/** 英文制图/可视化术语归一化表 */
const EN_ALIAS_MAP: Record<string, string[]> = {
  infographic:   ['信息图'],
  infographics:  ['信息图'],
  integraph:     ['信息图'],
  chart:         ['图表'],
  charts:        ['图表'],
  graph:         ['图表'],
  graphs:        ['图表'],
  diagram:       ['示意图'],
  diagrams:      ['示意图'],
  dashboard:     ['数据看板'],
  dashboards:    ['数据看板'],
  mockup:        ['UI图', 'ui设计图'],
  mockups:       ['UI图', 'ui设计图'],
  wireframe:     ['线框图'],
  wireframes:    ['线框图'],
  ui:            ['ui图'],
  ocr:           ['文字识别'],
  vlm:           ['视觉模型'],
};

/**
 * 【强关键词权重表】—— 这些词命中时，分数乘 3 倍权重。
 * 设计原则：每个技能 description 中的【触发词】核心词（而非通用动词）。
 * 命中至少 1 个强词才视为"有效匹配"（避免 2-gram 的单弱字符相交误命中）。
 */
const STRONG_KEYWORD_WEIGHT = 3;
const STRONG_KEYWORDS = new Set([
  // visualization
  '图表', '柱状图', '折线图', '饼图', '流程图', '架构图', '数据看板',
  '可视化', '示意图', '对比图', '信息图', 'widget', 'mermaid', 'antv',
  'dashboard', 'chart', 'diagram', 'infographic',
  '画图', '画个图', '画一张', 'ui图', 'ui设计图', 'mockup', '线框图',
  '界面图', '原型图', '效果图', '标注图',
  // legal
  '法条', '民法典', '合同审查', '起诉状', '答辩状', '法律意见书',
  '判例', '裁判', '司法解释', '法规检索',
  // video
  '录屏切页', '视频截图', '屏幕录制分段', '滚动截图', '视频拆帧',
  'split_video', 'ffmpeg', '录屏视频',
  // image
  'ocr', '文字识别', '视觉模型', '图片识别', '图像生成',
  '三视图', '文生图', '图生图', 'detect',
  // design
  'ui设计', '前端开发', '落地页', '响应式', '原型', '动效', 'h5页面',
  // docs
  'docx', 'pptx', '幻灯片', '演示文稿', '路演', '课件', '简历',
  // office
  '飞书', '日程', '审批', '考勤', '多维表格', 'bitable',
  // code
  '代码重构', '调试', '测试用例', '组件开发', 'api接口',
]);

function isStrong(kw: string): boolean {
  if (STRONG_KEYWORDS.has(kw)) return true;
  const lower = kw.toLowerCase();
  if (lower.length < 2) return false;
  for (const sk of STRONG_KEYWORDS) {
    const s = sk.toLowerCase();
    // 正向：token 包含整段强词（如 token="ui设计图规范" 含强词 "ui设计图"）
    if (lower.includes(s)) return true;
    // 反向：token 是强词的组成部分（如 "UI 图" 分词后 token="ui" ∈ 强词 "ui图"；
    //        避免带空格/latin变体拆词后丢失强命中）
    if (s.includes(lower)) return true;
  }
  return false;
}

function extractKeywords(text: string): Map<string, number> {
  text = text.toLowerCase().trim();
  // 权重表：keyword → accumulated_weight（强词乘系数，普通词=1）
  const keywords = new Map<string, number>();

  const addKw = (raw: string, weight = 1) => {
    if (!raw) return;
    if (STOP_WORDS.has(raw)) return;
    const w = isStrong(raw) ? weight * STRONG_KEYWORD_WEIGHT : weight;
    keywords.set(raw, (keywords.get(raw) ?? 0) + w);
  };

  // 英文/字母数字 token
  const engMatches = Array.from(text.matchAll(/[a-z][a-z0-9]{1,}/g));
  for (const m of engMatches) {
    addKw(m[0]);
    const aliases = EN_ALIAS_MAP[m[0]];
    if (aliases) {
      for (const alias of aliases) {
        addKw(alias, STRONG_KEYWORD_WEIGHT); // 归一化的中文词视为强触发
        for (let i = 0; i < alias.length - 1; i++) {
          addKw(alias.slice(i, i + 2));
        }
      }
    }
  }

  // 中文 2-gram
  const chineseChars = Array.from(text.matchAll(/[\u4e00-\u9fff]/g)).map(m => m[0]);
  for (let i = 0; i < chineseChars.length - 1; i++) {
    const bigram = chineseChars[i] + chineseChars[i + 1];
    addKw(bigram);
  }

  // 中文词组（>= 2 字符）
  const chineseMatches = Array.from(text.matchAll(/[\u4e00-\u9fff]{2,}/g));
  for (const m of chineseMatches) {
    addKw(m[0], 2); // 整词比 2-gram 权重更高
  }

  return keywords;
}

/**
 * 两阶段技能匹配。
 *
 * @param threshold 精细匹配最低分（默认 0.20；原 0.08 误命中太多）
 * @param minStrongKeywords 至少命中的【强关键词】数（默认 1；若 0 则允许纯通用词命中——仅低置信度意图下放宽）
 */
export function matchSkills(
  userInput: string,
  availableSkills: SkillMeta[],
  conversationContext = '',
  threshold = 0.20,
  topK = 5,
  minStrongKeywords = 1,
): SkillMatchResult[] {
  if (!userInput.trim() || !availableSkills.length) return [];

  // ===== Stage 1 门控：意图粗分类 + 场景过滤 =====
  const intent = classifyUserIntent(userInput, conversationContext);
  const allowedScenes = getAllowedScenesForIntent(intent);

  const filteredSkills = availableSkills.filter(s => {
    if (!s.scenes || s.scenes.length === 0) return true; // 无标注默认通过
    // 技能任一 scene 在 allowedScenes 内 → 通过
    return s.scenes.some(sc => allowedScenes.has(sc));
  });

  console.log(
    `[技能匹配 Stage1] 意图=${intent.category}(${intent.confidence}) ` +
    `触发词=[${intent.triggerWords.join(',')}] 排除词=[${intent.exclusionWords.join(',')}] ` +
    `技能池 ${availableSkills.length} → ${filteredSkills.length}`,
  );

  // 无技能剩 → 空；若 Stage1 过于激进（过滤掉所有），则回退全量精细匹配（保证可用性）
  const candidatePool = filteredSkills.length > 0 ? filteredSkills : availableSkills;

  // ===== Stage 2 精细：关键词 + 强词加权 =====
  const userKws = extractKeywords(userInput);
  if (conversationContext) {
    const ctxKws = extractKeywords(conversationContext);
    ctxKws.forEach((w, k) => userKws.set(k, (userKws.get(k) ?? 0) + w * 0.5)); // 上下文打 5 折
  }
  if (userKws.size === 0) return [];

  // 意图强触发词 → 当成用户关键词再加一遍（对正确场景技能进一步倾斜）
  for (const tw of intent.triggerWords) {
    const extra = extractKeywords(tw);
    extra.forEach((w, k) => userKws.set(k, (userKws.get(k) ?? 0) + w * 2));
  }

  // 低置信度意图 → 放宽强词要求（0 个即可通过）；高置信度 → 严格 minStrongKeywords
  const effectiveMinStrong = intent.confidence < 0.3 ? 0 : minStrongKeywords;

  const results: SkillMatchResult[] = [];

  for (const skillMeta of candidatePool) {
    const descKws = extractKeywords(skillMeta.description);
    if (descKws.size === 0) continue;

    // 计算相交（带权重）+ 强词命中计数
    let weightedIntersect = 0;
    let userWeightTotal = 0;
    let strongHitCount = 0;
    const matched: string[] = [];

    userKws.forEach((uw, kw) => {
      userWeightTotal += uw;
      const dw = descKws.get(kw);
      if (dw !== undefined) {
        const contrib = Math.min(uw, dw);
        weightedIntersect += contrib;
        matched.push(kw);
        if (isStrong(kw)) strongHitCount += 1;
      }
    });

    if (matched.length === 0) continue;
    // 强词门槛：高置信度下必须至少 1 个强关键词命中（排除"识别"+"视频切分"这类误匹配）
    if (strongHitCount < effectiveMinStrong) continue;

    const descWeightTotal = Array.from(descKws.values()).reduce((a, b) => a + b, 0);
    if (descWeightTotal === 0 || userWeightTotal === 0) continue;

    // 混合评分：
    //   - Jaccard-like 加权相似度 70%（用户侧）
    //   - 绝对命中数归一化 30%（上限 8 个权重单位 = 5 强词 + 3 普通）
    const matchRatio = weightedIntersect / Math.max(userWeightTotal, 1);
    const absoluteNorm = Math.min(1.0, weightedIntersect / 8);
    let score = Math.min(1.0, matchRatio * 0.7 + absoluteNorm * 0.3);

    // 意图一致加分：技能场景与意图分类对齐 → +0.10（最多加到 1.0）
    const intentBoost = (skillMeta.scenes ?? []).some((s) => {
      const map = {
        visualization: ['design', 'bob-work'],
        legal: ['legal'],
        design: ['design', 'dev'],
        docs: ['docs', 'office'],
        office: ['office', 'lark'],
        video: ['dev', 'bob-work'],
        image: ['bob-work', 'docs'],
        code: ['dev', 'bob-work'],
        search: ['bob-work', 'docs', 'legal'],
        general: ['general', 'bob-work'],
      } as Record<string, string[]>;
      return (map[intent.category] ?? []).includes(s);
    });
    if (intentBoost && intent.confidence >= 0.4) score = Math.min(1.0, score + 0.10);

    if (score >= threshold) {
      results.push({
        skillMeta,
        score: Math.round(score * 1000) / 1000,
        matchedKeywords: Array.from(new Set(matched)).sort(),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const sliced = results.slice(0, topK);

  console.log(
    `[技能匹配 Stage2] 阈值=${threshold} 强词门槛=${effectiveMinStrong} ` +
    `命中 ${results.length} 个，取 Top${topK}=${sliced.map(r => `${r.skillMeta.name}(${r.score})`).join(', ')}`,
  );
  return sliced;
}
