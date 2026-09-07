// K2-S2 会话态 runtime service 抽取，行为不变
// =====================================================================================
// 把 route.ts（src/app/api/chat/route.ts）中「会话态 sticky 场景」module 级可变状态
// （chatStickyScenes: Map<nodeId, Set<ToolScene>>）收敛为 SessionRuntime 单例 service：
//   - sticky 生命周期：跨 chat 请求持久（同 nodeId 下，场景一旦激活即在该会话内保持，
//     后续请求仍粘住），仅 nodeId 存在的会话持久化；无 nodeId 的会话不落库（仅当轮生效）。
//   - 保留全局态（module 级单例导出）：迁移前为 route.ts 模块顶层 Map，进程内所有 chat
//     请求共享；本服务以单例实例承载同一全局语义，仅把读写点收进 service 方法。
//   - 写点① 每请求首帧合并写回：读回已有 sticky 并入 activeScenes，再过滤 general/coding
//     后替换写回（同 nodeId 跨请求聚合，sticky 只增不减）——mergeStickyScenes；
//   - 写点② 场景中途激活 sticky：search_capabilities / load_skill 经 TakeoverServices
//     .addStickyScene 追加（就地 add 去重）——addStickyScene；
//   - 读点：首帧合并处 get / hasSticky（只读判存）。
// 硬约束：读写语义（含同 nodeId 聚合、去重、general/coding 不持久化）与迁移前逐位一致。
// =====================================================================================

import type { ToolScene } from '@/app/api/chat/tools';

/** SessionRuntime：会话态（场景 sticky）单例 service。
 * key = nodeId；无 nodeId 的会话不持久化，由 route 调用侧守卫（与原内联分支一致）。 */
export class SessionRuntime {
  /** 会话 sticky 场景表：nodeId → 已 sticky 场景集合
   * （跨 chat 请求、同 nodeId 聚合；general/coding 永不落库） */
  private readonly stickyScenes = new Map<string, Set<ToolScene>>();

  /** 读某会话 sticky 集合；该会话未 sticky 时返回 undefined（与原 chatStickyScenes.get 同语义） */
  getStickyScenes(key: string): Set<ToolScene> | undefined {
    return this.stickyScenes.get(key);
  }

  /** 某场景是否已在该会话 sticky */
  hasSticky(key: string, scene: ToolScene): boolean {
    return this.stickyScenes.get(key)?.has(scene) ?? false;
  }

  /** 会话 sticky 追加一个场景（就地 add 去重；不存在时建集合后写入）。
   *  等价原 takeoverServices.addStickyScene 闭包语义：nodeId 存在守卫在 route 侧，跨请求保持。 */
  addStickyScene(key: string, scene: ToolScene): void {
    const cur = this.stickyScenes.get(key) ?? new Set<ToolScene>();
    cur.add(scene);
    this.stickyScenes.set(key, cur);
  }

  /** 每请求首帧合并写回（等价原 route 内联块 3219-3230 语义）：
   *   ① 读回该会话已有 sticky 并入 activeScenes（sticky 场景保持激活，本轮工具集不抖）；
   *   ② 把 activeScenes 中非 general/coding 的场景作为该会话新 sticky 替换写回——
   *      已 sticky 场景因步骤①重新并入 activeScenes 而持续保留（同 nodeId 聚合、只增不减）。 */
  mergeStickyScenes(key: string, activeScenes: Set<ToolScene>): void {
    const sticky = this.stickyScenes.get(key);
    if (sticky) for (const s of sticky) activeScenes.add(s);
    const merged = new Set<ToolScene>();
    for (const s of activeScenes) {
      if (s !== 'general' && s !== 'coding') merged.add(s);
    }
    this.stickyScenes.set(key, merged);
  }
}

/** 全局单例：迁移前 chatStickyScenes 为 route.ts 模块顶层 Map（进程内跨请求共享），
 *  故以单例承载同一全局态；class 一并导出供测试构造隔离实例。 */
export const sessionRuntime = new SessionRuntime();
