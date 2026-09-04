/**
 * src/lib/nodes/references.ts
 * 引用区（附件解析缓存）持久化
 *
 * read_attachment 工具解析附件（本地 OCR / 视觉模型）成功后，将"附件路径 + 解析摘要"
 * 写入附件所属节点的 .md 引用区 section，供下游节点的 intern_search 溯源命中。
 *
 * 说明：
 * - 引用区定位为"索引/摘要"而非全文备份：每条保留 300 字符单行摘要，
 *   manifest 据此建立关键词索引；需要完整原文时仍可 read_attachment 重读附件。
 * - 附件所属节点通过遍历项目 notes-memory/*.md、匹配对话记录中的附件路径反查。
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { parseNodeMarkdown } from '@/lib/node-markdown';

const REFERENCES_HEADING = '## 引用区';
const SUMMARY_LEN = 300;

/** 反查附件所属节点：遍历 notes-memory，找包含该附件路径的 .md */
export async function findNodeFileByAttachment(
  attachmentPath: string,
  projectRoot: string,
): Promise<{ nodeId: string; filePath: string } | null> {
  const dir = join(projectRoot, 'notes-memory');
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const filePath = join(dir, f);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.includes(attachmentPath)) continue;
      const parsed = parseNodeMarkdown(content);
      return { nodeId: parsed.frontmatter.node_id, filePath };
    } catch {
      // 单个文件解析失败跳过
    }
  }
  return null;
}

/** 解析摘要：压成单行并截断 */
export function summarize(text: string): string {
  const oneLine = (text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > SUMMARY_LEN ? oneLine.slice(0, SUMMARY_LEN) + '…' : oneLine;
}

/** 在 .md 的引用区 section 中插入/更新单个附件条目（文本级操作，不动其他 section） */
export function upsertReferenceSection(md: string, attachmentPath: string, summary: string): string {
  if (!summary) return md;
  const entry = `- \`${attachmentPath}\`：${summary}`;
  const idx = md.indexOf(REFERENCES_HEADING);

  // 无引用区 section → 追加到文件末尾
  if (idx < 0) {
    return md.trimEnd() + `\n\n${REFERENCES_HEADING}\n\n${entry}\n`;
  }

  const bodyStart = idx + REFERENCES_HEADING.length;
  const rest = md.slice(bodyStart);
  const nextHeading = rest.search(/\n## /);
  const sectionEnd = nextHeading >= 0 ? bodyStart + nextHeading : md.length;
  const section = md.slice(bodyStart, sectionEnd);

  // 该附件条目已存在 → 替换整行；否则追加
  const escaped = attachmentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp(`^- \\\`${escaped}\\\`：[^\\n]*`, 'm');
  let newSection: string;
  if (lineRe.test(section)) {
    newSection = section.replace(lineRe, entry);
  } else {
    newSection = section.trimEnd() + `\n${entry}`;
  }
  return md.slice(0, bodyStart) + newSection + md.slice(sectionEnd);
}

/**
 * 将附件解析结果持久化到附件所属节点的引用区。
 * 找不到所属节点（如本地文件附件未关联节点）时静默跳过。
 */
export async function persistAttachmentReference(
  attachmentPath: string,
  parsedText: string,
  projectRoot: string,
): Promise<void> {
  if (!attachmentPath) return;
  const summary = summarize(parsedText);
  if (!summary) return;
  try {
    const target = await findNodeFileByAttachment(attachmentPath, projectRoot);
    if (!target) return;
    const md = await fs.readFile(target.filePath, 'utf-8');
    const updated = upsertReferenceSection(md, attachmentPath, summary);
    if (updated !== md) {
      await fs.writeFile(target.filePath, updated, 'utf-8');
    }
  } catch {
    // 引用区写入失败不影响主流程
  }
}
