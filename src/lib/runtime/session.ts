// K2-S2 会话态 runtime service 抽取，行为不变
// =====================================================================================
// 把 route.ts（src/app/api/chat/route.ts）中「会话态 sticky 场景」module 级可变状态
// （chatStickyScenes: Map<nodeId, Set<ToolScene>>）收敛为 SessionRuntime 单例 service：
//   - sticky 生命周期：跨 chat 请求持久（同 nodeId 下，场景一旦激活即在该会话内保持，
//     后续请求仍粘住），仅 nodeId 存在的会话持久化；无 nodeId 的会话不落库（仅当轮生效）。
//   - 保留全局态（module 级单例导出）：迁移前为 route.ts 模块顶层 Map，进程内所有 chat
//     请求共享；本服务以单例实例承载同一全局语义，仅把读写点收进 service 方法。
//   - 写点① 每请求首帧合并写回：读回已有 sticky 并入 activeScenes，再过滤 general/coding/team
//     后替换写回（同 nodeId 跨请求聚合，sticky 只增不减）——mergeStickyScenes；
//   - 写点② 场景中途激活 sticky：search_capabilities / load_skill 经 TakeoverServices
//     .addStickyScene 追加（就地 add 去重）——addStickyScene；
//   - 读点：首帧合并处 get / hasSticky（只读判存）。
// 硬约束：读写语义（含同 nodeId 聚合、去重、general/coding 不持久化）与迁移前逐位一致。
//
// 跨重启落盘（2026-10-02）：此前 sticky 只在进程内存里，应用重启 / 构建重载即全部丢失——
// 重启后首个请求按当轮意图重新检测场景，工具集从「上一轮的常驻全集」塌回「本轮命中的子集」，
// 正是 CacheGuard 记录的 cross-restart-drift（一个月 63 次；受影响任务命中率 85.4% vs 基线 93.3%）。
// 现把 sticky 表落盘到 <appRoot>/.runtime/sticky-scenes.json（与 hippo-bridge.json 同目录），
// 重启后首个请求即可读回同一批场景 → 工具段跨重启字节稳定，前缀缓存不再整段作废。
//   - 落盘失败 / 文件损坏一律静默降级为「无持久化」，绝不影响工具循环主链路；
//   - 仅在内容真正变化时写盘（稳定轮次零 IO）；
//   - 会话数上限 MAX_PERSISTED_SESSIONS，按最近使用淘汰（Map 插入序 = LRU，merge 时刷新）。
// =====================================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import type { ToolScene } from '@/app/api/chat/tools';

/** 落盘文件名（app root/.runtime 下，与其它运行态桥文件同目录） */
const STICKY_STATE_FILE = 'sticky-scenes.json';
/** 落盘格式版本（结构变更时递增；读到旧版本按空表处理） */
const STICKY_STATE_VERSION = 1;
/** 最多保留的会话数：超出按最近使用淘汰，避免长期使用后文件无限增长 */
const MAX_PERSISTED_SESSIONS = 500;

interface StickyStateFile {
  version?: number;
  updatedAt?: string;
  /** key（nodeId）→ 场景名数组 */
  scenes?: Record<string, unknown>;
}

/** SessionRuntime：会话态（场景 sticky）单例 service。
 * key = nodeId；无 nodeId 的会话不持久化，由 route 调用侧守卫（与原内联分支一致）。 */
export class SessionRuntime {
  /** 会话 sticky 场景表：nodeId → 已 sticky 场景集合
   * （跨 chat 请求、同 nodeId 聚合；general/coding 永不落库）。
   * Map 插入序同时作为 LRU 序：merge/add 时先 delete 再 set，把该会话挪到队尾。 */
  private readonly stickyScenes = new Map<string, Set<ToolScene>>();
  /** 是否已尝试从磁盘读回（懒加载一次；失败也置位，避免每请求重试 IO） */
  private hydrated = false;
  /** 上次写盘的 scenes 签名（相同则跳过写盘，稳定轮次零 IO） */
  private lastWritten = '';

  /** 落盘路径（懒算：BOBWORK_HOME 在测试 / 开发隔离下可变，故不缓存为模块常量） */
  private stateFile(): string {
    return join(resolveAppRoot(), '.runtime', STICKY_STATE_FILE);
  }

  /** 懒加载磁盘 sticky 表（首次访问时一次；损坏 / 缺失 / 版本不符 → 空表静默降级） */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const file = this.stateFile();
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as StickyStateFile;
      if (raw?.version !== STICKY_STATE_VERSION || !raw.scenes || typeof raw.scenes !== 'object') return;
      for (const [key, value] of Object.entries(raw.scenes)) {
        if (!key || !Array.isArray(value)) continue;
        const scenes = new Set<ToolScene>();
        for (const s of value) {
          // 落盘内容可能被手工编辑 / 由旧版本写入：只接受非空字符串，并沿用 team 永不 sticky 的约束
          if (typeof s === 'string' && s && s !== 'team') scenes.add(s as ToolScene);
        }
        if (scenes.size > 0) this.stickyScenes.set(key, scenes);
        if (this.stickyScenes.size >= MAX_PERSISTED_SESSIONS) break;
      }
    } catch {
      // 文件损坏 / 不可读 → 视为无持久化基准，不阻断请求
    }
  }

  /** 写盘当前 sticky 表（scenes 未变则跳过；失败静默忽略） */
  private persist(): void {
    try {
      const scenes: Record<string, string[]> = {};
      for (const [key, set] of this.stickyScenes) {
        if (set.size === 0) continue;
        scenes[key] = [...set];
      }
      const signature = JSON.stringify(scenes);
      if (signature === this.lastWritten) return;
      const file = this.stateFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ version: STICKY_STATE_VERSION, updatedAt: new Date().toISOString(), scenes }),
        'utf-8',
      );
      this.lastWritten = signature;
    } catch {
      // 落盘失败绝不影响工具循环主链路
    }
  }

  /** 超上限时按 LRU（Map 插入序头部 = 最久未用）淘汰到上限内 */
  private evictOverflow(): void {
    while (this.stickyScenes.size > MAX_PERSISTED_SESSIONS) {
      const oldest = this.stickyScenes.keys().next();
      if (oldest.done) break;
      this.stickyScenes.delete(oldest.value);
    }
  }

  /** 读某会话 sticky 集合；该会话未 sticky 时返回 undefined（与原 chatStickyScenes.get 同语义） */
  getStickyScenes(key: string): Set<ToolScene> | undefined {
    this.hydrate();
    return this.stickyScenes.get(key);
  }

  /** 某场景是否已在该会话 sticky */
  hasSticky(key: string, scene: ToolScene): boolean {
    this.hydrate();
    return this.stickyScenes.get(key)?.has(scene) ?? false;
  }

  /** 会话 sticky 追加一个场景（就地 add 去重；不存在时建集合后写入）。
   *  等价原 takeoverServices.addStickyScene 闭包语义：nodeId 存在守卫在 route 侧，跨请求保持。
   *  'team' 例外：多智能体唯一入口是「Multi-agent mode」开关（per-request），永不落 sticky。 */
  addStickyScene(key: string, scene: ToolScene): void {
    if (scene === 'team') return;
    this.hydrate();
    const cur = this.stickyScenes.get(key) ?? new Set<ToolScene>();
    if (cur.has(scene)) return;
    cur.add(scene);
    // 刷新 LRU 位置：先删再插（Map 对已存在键 set 不改变插入序）
    this.stickyScenes.delete(key);
    this.stickyScenes.set(key, cur);
    this.evictOverflow();
    this.persist();
  }

  /** 每请求首帧合并写回（等价原 route 内联块 3219-3230 语义）：
   *   ① 读回该会话已有 sticky 并入 activeScenes（sticky 场景保持激活，本轮工具集不抖）；
   *   ② 把 activeScenes 中非 general/coding/team 的场景作为该会话新 sticky 替换写回——
   *      已 sticky 场景因步骤①重新并入 activeScenes 而持续保留（同 nodeId 聚合、只增不减）。
   *  'team' 与 general/coding 同列：不落 sticky、读回时也剔除——开关是 per-request 语义，
   *  若 sticky 常驻 team，关掉「Multi-agent mode」后 team_run 仍在工具面 = 绕过开关的第二条入口。 */
  mergeStickyScenes(key: string, activeScenes: Set<ToolScene>): void {
    this.hydrate();
    const sticky = this.stickyScenes.get(key);
    if (sticky) for (const s of sticky) { if (s !== 'team') activeScenes.add(s); }
    const merged = new Set<ToolScene>();
    for (const s of activeScenes) {
      if (s !== 'general' && s !== 'coding' && s !== 'team') merged.add(s);
    }
    // 空集合不落表（与 undefined 同语义：读回时不并入任何场景）——避免文件里堆空条目
    this.stickyScenes.delete(key);
    if (merged.size > 0) this.stickyScenes.set(key, merged);
    this.evictOverflow();
    this.persist();
  }
}

/** 全局单例：迁移前 chatStickyScenes 为 route.ts 模块顶层 Map（进程内跨请求共享），
 *  故以单例承载同一全局态；class 一并导出供测试构造隔离实例。 */
export const sessionRuntime = new SessionRuntime();
