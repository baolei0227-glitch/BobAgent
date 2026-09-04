/**
 * src/lib/nodes/anchor.ts
 * 锚点生成与定位
 *
 * 规格：《BobWork 节点记忆与继承规格 v3》§二（锚点规则）
 *  - 锚点 id 全文件唯一，只增不改，删除内容时锚点一并删除但编号不复用
 *  - 定位靠 grep 锚点注释（<!-- #q-003 -->），文件任意位置增删都不影响其他锚点
 *  - 替代 v2 的 offset: number 定位（文件一改偏移全错，且错位不报错）
 */

/** 锚点注释模式：<!-- #q-003 --> */
export const ANCHOR_PATTERN = /<!--\s*#([a-z]+-\d+)\s*-->/g;

/** 锚点所属区块前缀 */
export type AnchorSection = 'q' | 'an' | 'ref';
// q = 对话记录, an = 批注, ref = 引用区

/** 从文本中收集所有已存在的锚点 id（全文件唯一性的判定依据） */
export function collectAnchorIds(text: string): Set<string> {
  const ids = new Set<string>();
  const re = new RegExp(ANCHOR_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

/** 提取单行锚点 id（非锚点行返回 null） */
export function extractAnchorId(line: string): string | null {
  const m = line.match(/^<!--\s*#([a-z]+-\d+)\s*-->$/);
  return m ? m[1] : null;
}

/**
 * 生成下一个锚点 id（如 q-001 → q-002）
 * 编号不复用：已存在的 id 会被跳过，保证只增不改。
 */
export function generateAnchorId(section: AnchorSection, existing: Set<string>): string {
  let n = 1;
  let id = `${section}-${String(n).padStart(3, '0')}`;
  while (existing.has(id)) {
    n++;
    id = `${section}-${String(n).padStart(3, '0')}`;
  }
  return id;
}

/**
 * 在指定 section（## 标题）下插入锚点注释
 * - section 存在：插入到该 section 末尾（下一个 ## 之前）
 * - section 不存在：在文本末尾追加该 section 与锚点
 */
export function insertAnchor(content: string, sectionHeading: string, anchorId: string): string {
  const lines = content.split('\n');
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('## ')) continue;
    const name = line.slice(3).trim();
    if (sectionStart === -1 && name === sectionHeading) {
      sectionStart = i;
    } else if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) {
    lines.push('', `## ${sectionHeading}`, '', `<!-- #${anchorId} -->`);
  } else {
    lines.splice(sectionEnd, 0, `<!-- #${anchorId} -->`);
  }
  return lines.join('\n');
}

/**
 * 定位锚点在文本中的字符偏移（grep 语义）
 * 返回 -1 表示未找到。
 */
export function findAnchorOffset(content: string, anchorId: string): number {
  const re = new RegExp(`<!--\\s*#${anchorId}\\s*-->`);
  const m = re.exec(content);
  return m ? m.index : -1;
}
