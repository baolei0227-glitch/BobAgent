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
// 正是 CacheGuard 记录的 cross-restart-drift。现把 sticky 表落盘到
// <appRoot>/.runtime/sticky-scenes.json（与 hippo-bridge.json 同目录），重启后首个请求即可读回。
//
// 场景衰减（2026-10-08，一周回测结论）：落盘解决了跨重启漂移，但顺手拿掉了「重启即衰减」
// 这个天然复位阀，于是「只增不减」变成单调累积——实测一周后工具数中位 79、最大 130
// （工具段最大 150KB），而首调 miss 随工具段增大 4.4 倍（≤40KB 时 5.4k → >120KB 时 23.7k），
// 工具段 >80KB 的首调吃掉全部 miss 的 38%。
// 故引入两条约束（都不碰 system 提示词，因此不触发全局重新预热）：
//   ① TTL：场景只在**被本轮意图重新命中 / 中途显式激活**时刷新时间戳；仅靠 sticky 读回
//      不再续命 —— 超过 STICKY_TTL_MS 未再被命中的场景自动脱落；
//   ② 上限：每会话最多保留 STICKY_MAX_SCENES 个场景，超出按最近激活时间淘汰。
//   语义边界：衰减只影响「工具面是否常驻」，不影响正确性——模型需要时仍可经
//   search_capabilities 重新激活（一次额外往返 ≈1–2k tokens，远小于每次冷启动 ~18k 的全价读）。
// =====================================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import type { ToolScene } from '@/app/api/chat/tools';

/** 落盘文件名（app root/.runtime 下，与其它运行态桥文件同目录） */
const STICKY_STATE_FILE = 'sticky-scenes.json';
/** 落盘格式版本：2 = node → { scene: lastActivatedAt }；1 = node → scene[]（读到时按 updatedAt 兜底） */
const STICKY_STATE_VERSION = 2;
/** 最多保留的会话数：超出按最近使用淘汰，避免长期使用后文件无限增长 */
const MAX_PERSISTED_SESSIONS = 500;
/** 场景存活时长：超过这么久没有被本轮意图重新命中（或中途显式激活）就脱落 */
const STICKY_TTL_MS = 24 * 60 * 60 * 1000;
/** 每会话最多保留的场景数（按最近激活淘汰）；node/ledger 这类 L1 场景每轮都会被重新命中，天然保留 */
const STICKY_MAX_SCENES = 6;

interface StickyStateFile {
  version?: number;
  updatedAt?: string;
  /** v2：nodeId → { 场景名: lastActivatedAt(ms) }；v1：nodeId → 场景名数组 */
  scenes?: Record<string, unknown>;
}

/** 单会话的场景时间戳表：场景 → 最近一次「被本轮意图命中 / 中途显式激活」的时间（ms） */
type SceneStamps = Map<ToolScene, number>;

/** SessionRuntime：会话态（场景 sticky）单例 service。
 * key = nodeId；无 nodeId 的会话不持久化，由 route 调用侧守卫（与原内联分支一致）。 */
export class SessionRuntime {
  /** 会话 sticky 场景表：nodeId →（场景 → 最近激活时间）
   * （跨 chat 请求、同 nodeId 聚合；general/coding/team 永不落库）。
   * Map 插入序同时作为「会话」LRU 序：merge/add 时先 delete 再 set，把该会话挪到队尾。 */
  private readonly stickyScenes = new Map<string, SceneStamps>();
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
      if (!raw.scenes || typeof raw.scenes !== 'object') return;
      // v1 平滑迁移：旧格式只有场景名没有时间戳，统一按文件 updatedAt 打戳
      // （= 最后一次改动距今的时间；解析不出就用 now，等价于给一轮完整 TTL 的宽限）。
      const fallbackAt = (() => {
        const t = Date.parse(String(raw.updatedAt ?? ''));
        return Number.isFinite(t) ? t : Date.now();
      })();
      const isV2 = raw.version === STICKY_STATE_VERSION;
      for (const [key, value] of Object.entries(raw.scenes)) {
        if (!key || value === null || typeof value !== 'object') continue;
        const stamps: SceneStamps = new Map();
        if (isV2) {
          for (const [scene, at] of Object.entries(value as Record<string, unknown>)) {
            if (!scene || scene === 'team' || typeof at !== 'number' || !Number.isFinite(at)) continue;
            stamps.set(scene as ToolScene, at);
          }
        } else if (Array.isArray(value)) {
          for (const scene of value) {
            if (typeof scene !== 'string' || !scene || scene === 'team') continue;
            stamps.set(scene as ToolScene, fallbackAt);
          }
        }
        const capped = capByRecency(stamps, STICKY_MAX_SCENES);
        if (capped.size > 0) this.stickyScenes.set(key, capped);
        if (this.stickyScenes.size >= MAX_PERSISTED_SESSIONS) break;
      }
    } catch {
      // 文件损坏 / 不可读 → 视为无持久化基准，不阻断请求
    }
  }

  /** 写盘当前 sticky 表（scenes 未变则跳过；失败静默忽略） */
  private persist(): void {
    try {
      const scenes: Record<string, Record<string, number>> = {};
      for (const [key, stamps] of this.stickyScenes) {
        if (stamps.size === 0) continue;
        scenes[key] = Object.fromEntries(stamps);
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

  /** 超上限时按「会话」LRU（Map 插入序头部 = 最久未用）淘汰到上限内 */
  private evictOverflow(): void {
    while (this.stickyScenes.size > MAX_PERSISTED_SESSIONS) {
      const oldest = this.stickyScenes.keys().next();
      if (oldest.done) break;
      this.stickyScenes.delete(oldest.value);
    }
  }

  /** 某会话当前仍存活的场景（按 TTL 过滤；过期即视为不存在） */
  private liveScenes(key: string): SceneStamps {
    const stamps = this.stickyScenes.get(key);
    if (!stamps) return new Map();
    const now = Date.now();
    const live: SceneStamps = new Map();
    for (const [scene, at] of stamps) {
      if (now - at <= STICKY_TTL_MS) live.set(scene, at);
    }
    return live;
  }

  /** 读某会话 sticky 集合；该会话无存活场景时返回 undefined（与原 chatStickyScenes.get 同语义） */
  getStickyScenes(key: string): Set<ToolScene> | undefined {
    this.hydrate();
    const live = this.liveScenes(key);
    return live.size > 0 ? new Set(live.keys()) : undefined;
  }

  /** 某场景是否已在该会话 sticky（且未过期） */
  hasSticky(key: string, scene: ToolScene): boolean {
    this.hydrate();
    return this.liveScenes(key).has(scene);
  }

  /** 会话 sticky 追加一个场景（中途显式激活：search_capabilities / load_skill）。
   *  时间戳按「此刻」刷新——这是 TTL 的唯一续命来源之一（另一个是本轮意图重新命中）。
   *  'team' 例外：多智能体唯一入口是「Multi-agent mode」开关（per-request），永不落 sticky。 */
  addStickyScene(key: string, scene: ToolScene): void {
    if (scene === 'team') return;
    this.hydrate();
    const stamps = this.liveScenes(key);
    const now = Date.now();
    if (stamps.get(scene) !== undefined && now - stamps.get(scene)! < 1000) return; // 同秒重复激活不写盘
    stamps.set(scene, now);
    const capped = capByRecency(stamps, STICKY_MAX_SCENES);
    // 刷新「会话」LRU 位置：先删再插（Map 对已存在键 set 不改变插入序）
    this.stickyScenes.delete(key);
    if (capped.size > 0) this.stickyScenes.set(key, capped);
    this.evictOverflow();
    this.persist();
  }

  /** 每请求首帧合并写回（等价原 route 内联块 3219-3230 语义 + 衰减）：
   *   ① **先**摘出调用方传入的 fresh = 本轮真正命中的场景（L1 画像场景 + L2 意图命中）——
   *      只有它们续命；必须在读回 sticky 之前取，否则读回的旧场景会被误当成"本轮命中"，
   *      TTL 与上限同时失效（这正是本方法最容易写错的一步）。
   *   ② 读回该会话仍在 TTL 内的 sticky 并入 activeScenes（保持激活，本轮工具集不抖），
   *      它们**保留原时间戳**，因此不会被续命，能按 TTL 自然脱落。
   *   ③ fresh 场景时间戳刷成此刻；超过 STICKY_MAX_SCENES 时按最近激活淘汰
   *      （fresh 时间最新，不会被淘汰）。
   *  'team' 与 general/coding 同列：不落 sticky、读回时也剔除——开关是 per-request 语义，
   *  若 sticky 常驻 team，关掉「Multi-agent mode」后 team_run 仍在工具面 = 绕过开关的第二条入口。 */
  mergeStickyScenes(key: string, activeScenes: Set<ToolScene>): void {
    this.hydrate();
    // ① 本轮命中的场景（读回 sticky 之前取快照）
    const fresh = [...activeScenes].filter(
      (s) => s !== 'general' && s !== 'coding' && s !== 'team',
    );
    // ② 读回未过期的 sticky（保留旧时间戳 = 不续命）
    const stamps = this.liveScenes(key);
    for (const scene of stamps.keys()) {
      if (scene !== 'team') activeScenes.add(scene);
    }
    // ③ 只有本轮命中的才续命
    const now = Date.now();
    for (const scene of fresh) {
      stamps.set(scene, now);
    }
    const capped = capByRecency(stamps, STICKY_MAX_SCENES);
    // 空集合不落表（与 undefined 同语义：读回时不并入任何场景）——避免文件里堆空条目
    this.stickyScenes.delete(key);
    if (capped.size > 0) this.stickyScenes.set(key, capped);
    this.evictOverflow();
    this.persist();
  }
}

/** 按最近激活时间保留前 max 个场景（时间新者优先；用于 TTL 之后的硬上限） */
function capByRecency(stamps: SceneStamps, max: number): SceneStamps {
  if (stamps.size <= max) return stamps;
  const ordered = [...stamps.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  return new Map(ordered);
}

/** 全局单例：迁移前 chatStickyScenes 为 route.ts 模块顶层 Map（进程内跨请求共享），
 *  故以单例承载同一全局态；class 一并导出供测试构造隔离实例。 */
export const sessionRuntime = new SessionRuntime();
