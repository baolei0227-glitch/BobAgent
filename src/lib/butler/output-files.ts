/**
 * 管家对话正文里的产物文件解析（`OutputFile: <path>` 行）。
 *
 * 为什么单独成模块：这段解析决定「文件卡片能不能出现」，是纯字符串逻辑、不依赖 React，
 * 放在 5000 行的 ButlerDrawer 里没法单测（2026-10-05 抽出，原在 ButlerDrawer 内部）。
 *
 * 与画布 `ChatNodeKernel.extractOutputFileBlocks` 的口径差异（刻意保留）：
 *   - 画布节点属于某个项目，只认**项目相对路径**（homework/ materials/ attachments/ .sandbox/）；
 *   - 管家是**跨项目**助手，会把别的项目里的资料发给用户（`search_materials project=…` 给的就是
 *     绝对路径），所以这里额外接受**绝对路径**（`/…`）与 home 路径（`~/…`）。
 *
 * 命中即从显示正文里剥离该行，改由文件卡片承载（卡片侧 `WechatFileCard` / `ButlerDocPanel`
 * 早已支持绝对路径）。
 */

/** `OutputFile: <path>` 行（行首可有空白；path 到行尾，行尾换行一并吃掉） */
export const OUTPUT_FILE_LINE_RE = /^\s*OutputFile:\s*([^\n\r]+?)\s*(\r?\n|$)/gm;

/** 可交付路径：项目相对前缀 / Outbox 暂存区 / home 路径 / 绝对路径 */
const DELIVERABLE_PREFIX_RE = /^(homework\/|materials\/|attachments\/|\.sandbox\/|outbox\/)/;

/** 该路径是否值得做成文件卡片（判据：可交付形态，不判存在性——存在性由卡片/预览侧兜底） */
export function isDeliverablePath(raw: string): boolean {
  return DELIVERABLE_PREFIX_RE.test(raw) || raw.startsWith('~/') || raw.startsWith('/');
}

/** 从正文里提取产物文件行：返回去掉这些行的干净正文 + 去重后的文件清单（保序） */
export function extractOutputFiles(content: string): { files: Array<{ path: string; name: string }>; clean: string } {
  if (!content) return { files: [], clean: content };
  const files: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();
  let clean = content;
  let m: RegExpExecArray | null;
  OUTPUT_FILE_LINE_RE.lastIndex = 0;
  while ((m = OUTPUT_FILE_LINE_RE.exec(content)) !== null) {
    // Windows 反斜杠归一化：模型可能给出 C:\… 或 homework\x.md
    const raw = m[1].trim().replace(/\\/g, '/');
    if (!raw || !isDeliverablePath(raw)) continue;
    clean = clean.replace(m[0], '');
    if (seen.has(raw)) continue;
    seen.add(raw);
    files.push({ path: raw, name: raw.split('/').pop() || 'file' });
  }
  return { files, clean };
}

/**
 * 把「打不开的产物」的 `OutputFile:` 行还原回正文（2026-10-05）。
 *
 * 产物行在渲染时会被剥离、改由文件卡片承载；卡片一旦点不开，那一行已不在正文里，
 * 用户连路径都看不到、文件等于凭空消失（实测：管家切过项目后，早先发出的相对路径卡片
 * 会解析到别的项目而打不开）。读失败时用本函数追加还原，保证路径始终可见、可复制。
 */
export function restoreOutputFileLines(clean: string, paths: string[]): string {
  if (paths.length === 0) return clean;
  const lines = paths.map((p) => `OutputFile: ${p}`).join('\n');
  return clean.trim() ? `${clean}\n\n${lines}` : lines;
}
