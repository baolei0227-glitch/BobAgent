/**
 * lib/tts/plain-text.ts — Markdown → 可朗读文本 + 分段（纯函数，客户端可用）
 *
 * 为什么需要它：butler 的回复是 **Markdown 渲染**的，直接丢给 TTS 会把 `**`、表格竖线、
 * 代码围栏、URL 一并念出来（"星号 星号 加粗"），听感极差。
 *
 * 两个函数，各自解决一个必踩的坑：
 *   - toSpeakableText()：把 Markdown 还原成一句句人话（代码块直接丢——念代码没有意义；
 *     表格去掉竖线、保留单元格文字，不能整块丢，日报里表格常常承载正文）；
 *   - chunkForSpeech()：两套 TTS 引擎都有 **2000 字符硬上限**（见 lib/tts/index.ts 的 MAX_TEXT_CHARS），
 *     且长文一次合成会让首字延迟很难看。故按句子边界切段，调用方串行请求 + 预取下一段。
 *
 * 不依赖任何 Node 模块（客户端组件直接 import 本文件，不要 import '@/lib/tts' 的 index）。
 */

/** 单段目标长度：远低于引擎 2000 上限，兼顾首字延迟与请求数 */
export const SPEECH_CHUNK_CHARS = 600;

/** 表情/符号：TTS 念不出（念成"warning sign"）或念出来是噪声，去掉 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** 高亮/加粗/行内代码/删除线的包裹符号 */
const INLINE_WRAP_RE = /\*\*|__|`|~~/g;

/**
 * Markdown → 可直接朗读的纯文本。
 * 原则：**只去格式，不丢正文**（唯一整块丢弃的是代码围栏——念代码无意义）。
 */
export function toSpeakableText(md: string): string {
  if (!md) return '';
  let s = md.replace(/\r\n?/g, '\n');

  // ① 代码围栏整块丢（含流式未闭合的收尾情况）；行内代码只脱掉反引号
  s = s.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  // ② HTML 标签（<br>、<div> 等）与图片：图片取 alt
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // ③ 链接：留文字，去 URL
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // ④ 表格：去掉竖线与分隔行，单元格用顿号连起来（不整块丢，内容会说话）
  s = s.split('\n').map((line) => {
    if (!/^\s*\|/.test(line)) return line;
    if (/^[\s|:-]+$/.test(line)) return '';
    return line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join('、');
  }).join('\n');

  s = s
    .split('\n')
    .map((line) => line
      // ⑤ 标题 / 引用 / 列表标记 / 复选框 / 分隔线：只去标记，保留文字
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*([-*_])\1{2,}\s*$/, ''))
    .join('\n');

  // ⑥ 行内格式符号：先去掉成对包裹，再清掉贴词的单个 * _（不误伤 snake_case 这类词内下划线）
  s = s.replace(INLINE_WRAP_RE, '');
  s = s.replace(/(^|\s)[*_](\S)/g, '$1$2').replace(/(\S)[*_](?=\s|$)/g, '$1');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~])/g, '$1');
  s = s.replace(EMOJI_RE, '');

  // ⑦ 归一空白：行内多空格压一个，空行压到最多一档
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 按句子边界把文本切成若干段（每段 ≤ max 字符）供 TTS 分次合成。
 * 无句读的长串（英文段落、长串数字）走硬切兜底，避免整段超限被引擎拒绝。
 *
 * 换行被当作**停顿**而不是透明：净化后的 Markdown 里，标题与列表项结尾通常没有标点
 * （"今日要点"、"回复张总关于合同的问题"），直接与下一行连读会串成一句话——故给缺标点的行尾补句号。
 */
export function chunkForSpeech(text: string, max: number = SPEECH_CHUNK_CHARS): string[] {
  const src = text.trim();
  if (!src) return [];

  /** 行尾没标点就补一个句号（有标点的不动，逗号/冒号本身已是停顿） */
  const withStop = (s: string) => (/[。！？；;…，,：:、]$/.test(s) ? s : `${s}。`);

  // 句子边界：中文句读/省略号（不含英文句点——小数点与缩写会误切，交给硬切兜底）
  const sentences: string[] = [];
  for (const line of src.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=[。！？；;…])/).map((s) => s.trim()).filter(Boolean);
    parts.forEach((part, i) => sentences.push(i === parts.length - 1 ? withStop(part) : part));
  }

  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      // 先按次级停顿（逗号/顿号/冒号）切，仍超长再按字符数硬切
      let pending = '';
      for (const piece of sentence.split(/(?<=[，,、：:])\s*/)) {
        if (piece.length > max) {
          if (pending) { chunks.push(pending.trim()); pending = ''; }
          for (let i = 0; i < piece.length; i += max) chunks.push(piece.slice(i, i + max).trim());
          continue;
        }
        if ((pending + piece).length > max) { chunks.push(pending.trim()); pending = piece; }
        else pending += piece;
      }
      if (pending.trim()) chunks.push(pending.trim());
      continue;
    }
    if ((cur + sentence).length > max) push();
    cur += sentence;
  }
  push();

  return chunks.filter(Boolean);
}