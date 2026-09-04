/**
 * 微信消息跨实例去重（DB 级，替代内存 Map）
 *
 * 背景：微信桥可能在多个服务实例（如桌面应用 + 预览实例）同时运行时，
 * 各实例内存态 seenMessages / inflightMessages 互相不可见，
 * 同一条消息会被多个实例各执行一次（表现为 3 秒成对的重复写入）。
 *
 * 方案：改用全局 SQLite（.inbox.db）持久化消息指纹锁，所有实例读写同一张表：
 *   - kind='seen'     ：15 分钟幂等窗口（消息 id / 内容签名），防重复投递与跨时段重放
 *   - kind='inflight' ：执行中强锁，120s 超时兜底（90s 执行上限 + 余量），
 *                       进程崩溃后自动过期，同一条消息可被重新拾取处理
 *
 * 语义与旧内存实现保持一致：执行权归首个写入实例；其余实例（无论窗口内重复
 * 还是另一实例正在执行）一律跳过。
 */
import { join } from 'path';
import { resolveAppRoot, INBOX_DB_FILENAME } from '@/lib/app-root';

type DB = import('better-sqlite3').Database;

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 与旧 seenMessages 幂等窗口一致
const INFLIGHT_TIMEOUT_MS = 120 * 1000; // 90s 执行上限 + 余量

let _db: DB | null = null;
let _dbPromise: Promise<DB> | null = null;

async function getDb(): Promise<DB> {
  if (_db) return _db;
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(join(resolveAppRoot(), INBOX_DB_FILENAME));
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS wechat_msg_dedupe (
          fingerprint TEXT NOT NULL,
          kind        TEXT NOT NULL,          -- 'seen' | 'inflight'
          expire_at   INTEGER NOT NULL,
          PRIMARY KEY (fingerprint, kind)
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_wechat_msg_dedupe_expire ON wechat_msg_dedupe(expire_at);`);
      return db;
    })();
  }
  _db = await _dbPromise;
  return _db;
}

/** 获取消息执行权：返回 true 表示本实例可执行；15 分钟内重复或另一实例正在执行则返回 false */
export async function acquireMessageLock(fingerprint: string): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    // 顺带清理过期条目（含崩溃残留的 inflight 超时锁），控制表体积
    db.prepare(`DELETE FROM wechat_msg_dedupe WHERE expire_at <= ?`).run(now);
    // 另一实例正在执行（inflight 未过期）→ 拒绝
    const inflight = db
      .prepare(`SELECT 1 FROM wechat_msg_dedupe WHERE fingerprint = ? AND kind = 'inflight' AND expire_at > ?`)
      .get(fingerprint, now);
    if (inflight) return false;
    // 15 分钟幂等窗口内已处理过 → 拒绝
    const seen = db
      .prepare(`SELECT 1 FROM wechat_msg_dedupe WHERE fingerprint = ? AND kind = 'seen' AND expire_at > ?`)
      .get(fingerprint, now);
    if (seen) return false;
    // 首次：同时写入 inflight（执行中强锁）+ seen（幂等窗口）
    db.prepare(
      `INSERT OR REPLACE INTO wechat_msg_dedupe (fingerprint, kind, expire_at) VALUES (?, 'inflight', ?)`,
    ).run(fingerprint, now + INFLIGHT_TIMEOUT_MS);
    db.prepare(
      `INSERT OR REPLACE INTO wechat_msg_dedupe (fingerprint, kind, expire_at) VALUES (?, 'seen', ?)`,
    ).run(fingerprint, now + DEDUP_WINDOW_MS);
    return true;
  });
  return tx() as boolean;
}

/** 执行完成：释放 inflight 强锁（seen 幂等窗口保留，15 分钟内仍拒绝重复） */
export async function releaseMessageLock(fingerprint: string): Promise<void> {
  try {
    const db = await getDb();
    db.prepare(`DELETE FROM wechat_msg_dedupe WHERE fingerprint = ? AND kind = 'inflight'`).run(fingerprint);
  } catch {
    // DB 异常不影响主流程（最坏情况该消息在 120s 超时后可被重新处理）
  }
}
