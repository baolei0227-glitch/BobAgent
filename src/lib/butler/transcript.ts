/**
 * lib/butler/transcript.ts —— 会话可读记录落盘
 *
 * 线程真源是 `<APP_ROOT>/butler/.state/threads/<threadId>.json`（见 threads.ts，读写 / 过期清理都依附它）。
 * 本模块把该会话的消息按**消息当天**分组，幂等重写到
 *   <APP_ROOT>/butler/<角色>/<YYYY-MM-DD>/chat/YYYY-MM-DD.md
 * 给用户一份可直接打开阅读的历史记录（跨天会话拆到多天文件）。
 *
 * 命名只到日期（不含 threadId）：同一角色同一天只有一个文件；同名角色的多个会话会互相覆盖，
 * 这是方案既定取舍（目录整洁、与「角色」维度对齐优先于逐会话隔离）。
 *
 * 幂等性：每次全量覆盖当天文件，不追加、不删除历史日期的文件（避免误删同角色其他会话的记录）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { stripThinkTags, type ChatMessage } from '@/lib/bus';
import { stripInjectedBlocks } from './threads-shared';
import { butlerRoot, dateStamp, ensureDir, resolveRole } from './storage';

const pad = (n: number) => String(n).padStart(2, '0');

/** 消息时间戳 → HH:mm（本地时区） */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把会话消息按消息当天分组写入角色目录下的 chat/YYYY-MM-DD.md。
 *
 * @param threadId  会话线程（用于解析角色目录）
 * @param messages  完整消息列表（system 提示词不入记录）
 * @param tailTimes 逐条消息时间戳，**尾部倒序对齐 messages**（与 ButlerThread.tailTimes 同构）
 */
export async function writeSessionTranscript(
  threadId: string,
  messages: ChatMessage[],
  tailTimes: number[],
): Promise<void> {
  const role = await resolveRole(threadId);
  const base = join(butlerRoot(), role.dir);

  // 按自然日归集（保持消息原始顺序）
  const byDay = new Map<string, { who: string; time: number; content: string }[]>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const t = tailTimes[messages.length - 1 - i];
    const time = typeof t === 'number' ? t : Date.now();
    const day = dateStamp(new Date(time));
    const list = byDay.get(day) ?? [];
    // user 侧再剥掉「注入块」（附件列表 / 工作区）：那是发给模型的上下文、不是用户说的话，
    // 原样写进这份**给人看**的记录会变成一屏机器文案（与气泡同一口径，见 stripInjectedBlocks）。
    const text = stripThinkTags(m.content);
    list.push({
      who: m.role === 'user' ? '用户' : role.name,
      time,
      content: m.role === 'user' ? stripInjectedBlocks(text) : text,
    });
    byDay.set(day, list);
  }

  for (const [day, items] of byDay) {
    const dir = join(base, day, 'chat');
    await ensureDir(dir);
    const lines: string[] = [`# ${role.name} · ${day}`, ''];
    for (const it of items) {
      lines.push(`**${it.who}** ${hhmm(it.time)}`, '', it.content.trim(), '');
    }
    await fs.writeFile(join(dir, `${day}.md`), `${lines.join('\n').trimEnd()}\n`, 'utf-8');
  }
}