/**
 * 项目账本「编译」的后台触发（server-only）
 *
 * 触发时机定案（2026-09-17）：**材料到达即触发**。
 *   否掉的两种时机：
 *     a) 任务收尾编译 —— 编译是一串串行工具往返（ledger_pending → read_ledger ×N → ledger_record ×M），
 *        份数越多越慢，挂在用户任务的收尾上等于让用户等它读完几十份材料；
 *     b) 每日班车 —— 积压窗口最长（当天上传的材料当天查不到），且「只传材料不派任务」时没人触发。
 *   采用：材料索引落盘 → 宿主登记 raw（0 token）→ 打脏标记 + 重置防抖计时器 → 静默期满 →
 *   宿主自调 /api/chat 起一个**独立后台会话**（archivist 身份 → ledger-keeper 工具面）把本批编译成 wiki。
 *   用户全程零等待，编译既不占对话轮次也不占任务时延。
 *   2026-09-18 身份变更：账本 keeper 从管家（butler）剥离给 Archivist 档案员，编译会话随之改用
 *   `archivist` 身份——Archivist 是市场包、需先安装；未安装时**明确跳过并告警一次**（不静默空转：
 *   否则每批材料到达都会白起一个没有写工具的会话），装好后新登记的材料自动继续编译。
 *
 * 四个要点：
 *   1. **防抖攒批**：一次上传 N 份会触发 N 次 → 静默 QUIET_MS 后只起一个会话，把这一批当一个编译单元。
 *      必须「一批一起编」而非「一份一编」：跨材料归并（同组证据互相印证、多版本合同串脉络）才有意义，
 *      且避免后续材料到达时反复重写同一条 wiki（结论抖动 + 重复耗时）。
 *   2. **单飞 + 项目级让位**：同项目同时只跑一个编译会话（running）；跑动期间到的新材料记一拍（queued），跑完再排。
 *      与用户对话、成果块提炼共用一个项目级调度器（user > outcome > compile，见 @/lib/runtime/project-scheduler）：
 *      用户正对话时这里只排队不起会话；被抢占只挡后续批次，不 abort 已起的会话。
 *   3. **分批 + 有进展才续跑**：单会话最多编 MAX_PER_RUN 条；跑完比较积压数，**减少了才续跑**下一批。
 *      无进展（模型报错 / 工具被拒 / 根本没读到材料）立即停 —— 防止后台无限循环空烧 token。
 *   4. **失败静默**：任何环节出错（无项目、账本不可读、模型不可用）都只 console.warn，绝不打断用户流程。
 */

import { resolve } from 'path';
import { countPendingRaw } from '@/lib/mcp/ledger';
import { runBackground } from '@/lib/runtime/project-scheduler';

/** 静默窗口：最后一份材料登记后再等这么久才动手（上传中途不编译，攒成一批） */
const QUIET_MS = 30_000;
/** 单会话最多编译条数：材料多时靠「续跑」分批清，不让一个会话跑到天荒地老 */
const MAX_PER_RUN = 8;
/** 后台会话自身超时（编译要读多份材料正文，给足时间；仍须兜底防僵死） */
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** 待触发/已排队的项目根（key = 规范化绝对路径） */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 正在跑编译会话的项目根 */
const running = new Set<string>();
/** 跑动期间又来了新材料 / 上一批还没编完 → 跑完再排一轮 */
const queued = new Set<string>();

/** 服务端自调用绝对 base（Node fetch 不支持相对路径），与 daily-tasks / query_todos 同一约定 */
function selfBaseUrl(): string {
  return `http://localhost:${process.env.PORT || '5000'}`;
}

/** 项目根 → 项目 id（后台会话用 projectId 定位项目上下文，不切换全局当前项目） */
async function resolveProjectIdByPath(projectRoot: string): Promise<string | null> {
  try {
    const { listProjects } = await import('@/lib/project/project-manager');
    const { projects } = await listProjects();
    const target = resolve(projectRoot);
    return projects.find((p) => p.path && resolve(p.path) === target)?.id ?? null;
  } catch {
    return null;
  }
}

/** 编译会话的用户消息（后台任务，非用户提问 → 明确要求不寒暄、只回一行结果） */
const compilePrompt = (pending: number): string => `（后台账本编译任务 · 非用户提问，无需寒暄、无需过程叙述）

本项目账本当前有 ${pending} 条已登记但未编译的材料。请在本轮完成其中**最多 ${MAX_PER_RUN} 条**的编译：

1. 调 \`ledger_pending\` 取待编译清单（已按最新优先排序），只处理前 ${MAX_PER_RUN} 条，其余留给下一批；
2. 按每条登记的出处路径用 \`read_attachment\` 读材料正文（**逐条读、读完即编**，不要把大量正文一次性堆在上下文里）；
3. 写成 \`wiki/\` 条目：**同批同类材料合并成一条**（同一组证据、同一份合同的多版本等归并到一条并写清各自出处），
   用 \`ledger_record\` 写入，并带 \`rawIds\` 列出所依据的 raw id（标记这些 raw 已编译）；
   每条出处必须是 \`materials/\` 下的真实路径。允许的 type 只有三种：
   - \`fact\`（材料事实）/ \`entity\`（实体）：正文写**可核对的内容**——这份材料是什么、讲了什么、出处哪一页/哪一节。
     **若这条只引用单侧材料（分侧见 SCHEMA.md「当事人与材料分区」段），必须在正文显式写一句「仅单侧依据，缺对照」**
     （补充条款 11 认可的合规标注；不写会被 \`ledger_lint\` 报出，写了即不再报）；
   - \`comparison\`（双方对照）：**仅当同一焦点两侧材料都已读到、或另一侧已在账本登记时**才写（可先 \`read_ledger\` 定位另一侧），
     必须**两侧各至少一条 \`materials/\` 出处**（缺一侧即缺对照，硬约束，\`ledger_lint\` 会报）。
     正文**只做并列**：双方各自的主张与依据、一致点、分歧点、缺口——**不得写"成立/不成立/本院认为"式判断**，取舍由人决策。
   不得写 \`issue\`（争议焦点）/ \`analysis\`（分析推断）/ \`claim\`（论断假设）——那是用户找档案员明确要求时才做的事，编译任务不做，也不要替用户下结论；
4. 只回复一行结果：\`编译 N 条，剩余 M 条\`。不要输出过程、不要往别处写文件。`;

/** 编译会话身份 = 账本 keeper（Archivist 档案员）。
 *  未安装 Archivist（Extensions Store → Agents 里没装）时返回 null —— 调用方跳过本轮并告警一次：
 *  宁可「不编译」也不「起一个没有写工具的会话空烧一轮」，更不能假报编译成功。 */
let archivistMissingWarned = false;
async function resolveCompileIdentity(): Promise<string | null> {
  try {
    const { listInstalledPackages } = await import('@/lib/agents/market-server');
    if (listInstalledPackages().some((m) => m.id === 'archivist')) return 'archivist';
  } catch {
    /* 读取失败按未安装处理（下面的告警会说明） */
  }
  if (!archivistMissingWarned) {
    archivistMissingWarned = true;
    console.warn('[ledger-compile] 未安装 Archivist 档案员（Extensions Store → Agents）→ 跳过账本自动编译；安装后新登记的材料会自动继续编译');
  }
  return null;
}

/** 起一次后台编译会话（自调 /api/chat；Archivist 身份 + projectId，不传 nodeId 以免激活节点场景）。
 *  返回是否成功发起（不代表编译条数）。 */
async function invokeCompileSession(projectId: string, pending: number, identity: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('背景编译会话超时')), SESSION_TIMEOUT_MS);
  try {
    const resp = await fetch(`${selfBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        messages: [{ role: 'user', content: compilePrompt(pending) }],
        identity,
        projectId,
        thinkingLevel: 'medium',
      }),
    });
    // SSE 必须读尽：不读则调用方提前结束，服务端工具轮可能停在中途
    await resp.text();
    if (!resp.ok) {
      console.warn(`[ledger-compile] 编译会话返回 HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[ledger-compile] 编译会话失败:', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 跑一轮编译：算积压 → 无积压直接退出 → 起会话 → 比较积压决定是否续跑 */
async function runCompile(projectRoot: string): Promise<void> {
  if (running.has(projectRoot)) {
    queued.add(projectRoot);
    return;
  }
  const before = countPendingRaw(projectRoot);
  if (before <= 0) return;
  // 未安装 Archivist → 无人持有 ledger-keeper 写工具，本轮跳过（resolveCompileIdentity 已告警一次）
  const identity = await resolveCompileIdentity();
  if (!identity) return;

  running.add(projectRoot);
  try {
    // 项目级互斥 + 优先级（见 @/lib/runtime/project-scheduler）：用户对话 > 成果块提炼 > 账本编译。
    // 用户对话在跑时这里只是排队等，不起会话；被抢占也不中断已起的会话，只把「后续批次」
    // 挡在后面 —— 续跑判据在下面（有进展才续），重新排上就能接着编，不必重来。
    await runBackground(projectRoot, 'compile', async () => {
      const projectId = await resolveProjectIdByPath(projectRoot);
      if (!projectId) {
        console.warn('[ledger-compile] 未找到项目 id，跳过:', projectRoot);
        return;
      }
      await invokeCompileSession(projectId, before, identity);

      const after = countPendingRaw(projectRoot);
      if (after > 0 && after < before) {
        // 有进展但还没清完（材料数 > 单会话上限）→ 排下一批
        queued.add(projectRoot);
      } else if (after >= before) {
        console.warn(`[ledger-compile] 本轮无进展，停止续跑（积压仍 ${after} 条）`);
      }
    });
  } finally {
    running.delete(projectRoot);
    if (queued.delete(projectRoot)) schedule(projectRoot);
  }
}

/** 排一次（重置）防抖计时器 */
function schedule(projectRoot: string): void {
  const prev = timers.get(projectRoot);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(projectRoot);
    void runCompile(projectRoot).catch((e) => {
      console.warn('[ledger-compile] 调度异常:', e instanceof Error ? e.message : String(e));
    });
  }, QUIET_MS);
  // 后台任务不应阻止进程退出（Node/Electron 场景）
  (t as unknown as { unref?: () => void }).unref?.();
  timers.set(projectRoot, t);
}

/**
 * 材料登记到账本后调用（宿主侧，0 token）：打脏标记 + 重置防抖计时器。
 * 登记本身幂等（同一内容只登记一次），所以这里也只在新 raw 落盘后触发。
 */
export function notifyLedgerMaterialRegistered(projectRoot: string): void {
  const root = (projectRoot || '').trim();
  if (!root) return;
  schedule(resolve(root));
}