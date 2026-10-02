/**
 * lib/butler/report-doc.ts — 报告文档落盘（助理「直接发文档」的写入侧）
 *
 * 与 receipts（邮件体）分工：邮件负责「通知到了」，文档负责「内容可沉淀、可读、可翻历史」。
 * 落成真实文件后，Butler 面板点击即可在右侧展开阅读（渲染器复用 viewers/registry）。
 *
 * 存储：<APP_ROOT>/butler/<角色>/<YYYY-MM-DD>/docs/YYYY-MM-DD-<kind>[-<n>].md
 * 同日同类型重复时追加序号，不覆盖历史（日报补发场景下避免丢失前一版）。
 * 无会话上下文（日报等定时产出）时归属常驻「通知助理」。
 */
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { NOTIFY_THREAD_ID, dateStamp, ensureDir, resolveRoleDir } from './storage';

/**
 * 写一份报告文档。
 * @param kind     报告类型（morning / sticky / notes / 自定义），用于文件名分组
 * @param title    报告标题（写入 md H1）
 * @param body     正文（markdown）
 * @param threadId 归属会话线程；缺省 = 系统定时产出，归常驻「通知助理」
 * @returns        落盘绝对路径
 */
export async function writeReportDoc(
  kind: string,
  title: string,
  body: string,
  threadId?: string | null,
): Promise<string> {
  const now = new Date();
  const stamp = dateStamp(now);
  const dir = join(await resolveRoleDir(threadId || NOTIFY_THREAD_ID), stamp, 'docs');
  await ensureDir(dir);

  const stem = `${stamp}-${kind}`;
  let n = 0;
  let path = join(dir, `${stem}.md`);
  // 同日同类型不覆盖：追加 -2 / -3 …
  while (existsSync(path)) {
    n += 1;
    path = join(dir, `${stem}-${n + 1}.md`);
  }
  const content = `# ${title}\n\n> ${now.toLocaleString('zh-CN')} · BobWork Butler\n\n${body.trim()}\n`;
  await writeFile(path, content, 'utf-8');
  return path;
}