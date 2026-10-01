#!/usr/bin/env node
/**
 * cleanup-sessions.mjs — 清理过期的 Butler /chat 会话与其 BobMail inbox 线程
 *
 * 存储：<appRoot>/.inbox.db（BOBWORK_HOME 优先，默认 ~/BobWork）
 *   - chat_sessions：会话上下文。source='wechat' 的行 expires_at = 写入时间 + 24h（panel 长期，expires_at=null）
 *   - inbox：BobMail 收件记录。/chat 线程（kind='chat'）用 thread_id 关联会话
 *
 * 清理规则（默认保守）：
 *   1) 删除 expires_at 已过期的 chat_sessions 行（微信 24h 过期会话）；
 *   2) 删除 inbox 中 thread_id 属于上述过期会话的收件（无法再续聊的线程）；
 *   3) 对"inbox 里 kind='chat' 但已无任何会话记录"的孤儿线程：默认只统计不删，
 *      加 --include-orphans 才删除（避免误清仍想留档的历史邮件）。
 *
 * 用法：
 *   node scripts/cleanup-sessions.mjs            # 预演（只打印，不删除）
 *   node scripts/cleanup-sessions.mjs --run      # 真正执行
 *   node scripts/cleanup-sessions.mjs --run --include-orphans   # 含孤儿线程
 * 退出码：0 正常；1 参数错误/数据库打不开。
 */
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const args = new Set(process.argv.slice(2));
const doRun = args.has('--run');
const includeOrphans = args.has('--include-orphans');

const appRoot = (() => {
  const env = (process.env.BOBWORK_HOME || '').trim();
  return env && env.startsWith('/') ? env : path.join(os.homedir(), 'BobWork');
})();
const dbFile = path.join(appRoot, '.inbox.db');

if (args.has('--help') || args.has('-h')) {
  console.log(`usage:
  node cleanup-sessions.mjs                dry-run (print only)
  node cleanup-sessions.mjs --run          delete expired chat_sessions + their inbox threads
  node cleanup-sessions.mjs --run --include-orphans   also delete orphan kind='chat' inbox rows (no session left)
db: ${dbFile}`);
  process.exit(0);
}

let db;
try {
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.error(`无法打开数据库: ${dbFile}\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const now = Date.now();

const list = db.prepare('select thread_id from chat_sessions where expires_at is not null and expires_at < ?').all(now);
const expiredIds = list.map((r) => r.thread_id);

const countSessions = db.prepare('select count(*) c from chat_sessions where expires_at is not null and expires_at < ?').get(now).c;
const countInboxThreads = expiredIds.length > 0
  ? db.prepare(`select count(*) c from inbox where thread_id in (${expiredIds.map(() => '?').join(',')})`).get(...expiredIds).c
  : 0;

const orphans = db.prepare(`select i.id, i.thread_id, i.title from inbox i where i.kind='chat' and i.thread_id is not null and not exists (select 1 from chat_sessions s where s.thread_id = i.thread_id) and i.done = 0`).all();
const orphanIds = orphans.map((r) => r.id);

console.log(`库: ${dbFile}`);
console.log(`过期 chat_sessions: ${countSessions} 条${doRun ? '' : '（预演）'}`);
if (expiredIds.length) console.log(`  ↳ 关联 inbox 线程: ${countInboxThreads} 条`);
console.log(`孤儿 chat inbox（无会话记录）: ${orphans.length} 条${includeOrphans ? '' : '（需 --include-orphans 才会删）'}`);

if (!doRun) {
  console.log('\n预演结束，未做任何删除。加 --run 执行。');
  db.close();
  process.exit(0);
}

const delSession = db.prepare('delete from chat_sessions where expires_at is not null and expires_at < ?');
const delInboxByThread = db.prepare(
  expiredIds.length > 0 ? `delete from inbox where thread_id in (${expiredIds.map(() => '?').join(',')})` : 'delete from inbox where 0',
);

db.transaction(() => {
  delSession.run(now);
  if (expiredIds.length > 0) delInboxByThread.run(...expiredIds);
  if (includeOrphans && orphanIds.length > 0) {
    const delOrphan = db.prepare(`delete from inbox where id in (${orphanIds.map(() => '?').join(',')})`);
    delOrphan.run(...orphanIds);
  }
})();

const after = db.prepare('select count(*) c from chat_sessions').get().c;
console.log(`执行完成。剩余 chat_sessions: ${after}（共删会话 ${countSessions}、线程 ${countInboxThreads}${includeOrphans ? `、孤儿 ${orphans.length}` : ''}）。`);
db.close();
