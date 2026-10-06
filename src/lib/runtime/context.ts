// K2-S3 动态上下文链 runtime service 抽取，行为不变
// =====================================================================================
// 把 route.ts（src/app/api/chat/route.ts）中「动态上下文 prepend 链」的**内容生成**部分
// （四段低频变化注入文本的 provider）收敛为 ContextRuntime 单例 service：
//   ① 项目路径注入文本（原 projectPathInjection，route 2899-2901）；
//   ② 授权目录清单文本（原 authorizedRootsInjection，route 2904-2917）；
//   ③ 用户记忆注入文本（原 prefInjection，route 2941-2962 的 listPreferences/分档/拼装部分）；
//   ④ OCR/视觉引擎现状事实文本（原 module 级 buildOcrEngineFactInjection，route 1604-1674）；
// 统一入口 buildChain 按原 route 注入顺序（pathContext → userPreferences → ocrFact）依次生成，
// 各段独立容错（单段读取/解析失败仅该段返回 ''，不阻断后续段）——与原 route 各段独立 try/catch
// 语义一致；空串段 = 原代码该段不调用 prependDynamicContext。
// 硬约束（注入通道保留 route，K2-S3 红线）：
//   - prependDynamicContext 机制与三次 prepend 调用点、顺序、if 条件全部留在 route，本 service
//     只产出文本、绝不触碰消息数组；
//   - 各段文本字节与迁移前逐字节一致（换行/前缀/插值格式原样复刻，此处无任何格式"优化"）。
// 说明：AI Coding 沙盒上下文（route 原 2971-3174 一带，readAppEntry/hasAppImplementation/
//   getBridgeActionsText 等依赖深、~170 行模板文本）为 K2-S3b 段：内容生成收敛进独立方法
//   buildCodingSandboxInjection（本文件），node 定位（resolveNodeProject/loadNodeById）与
//   prepend/场景/工具联动判定仍留在 route 原位（时序与迁移前一致）。
// =====================================================================================

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getLocalAuthorizedRoots, type ToolScene } from '@/app/api/chat/tools';
import { pluginDataHome } from '@/lib/extensions/data-home';
import type { NodeMarkdown } from '@/lib/node-markdown';
import { readAppEntry, hasAppImplementation } from '@/lib/sandbox/apps';
import { getBridgeActionsText } from '@/lib/sandbox/bridge';
import { BUTLER_COMMANDS } from '@/lib/core/commands';
import { BUTLER_SCHEDULE_DISCIPLINE, BUTLER_MEMORY_ROUTING, BUTLER_ROUTING_HINT } from '@/lib/agents/profiles';
import { getMeetingState } from '@/lib/core/meeting-session';
import { SOURCES, type SourceStatus } from '@/lib/runtime/sources';

/** 项目路径/授权目录段生成所需的最小入参（route 已解析好的请求级上下文） */
export interface PathContextInput {
  /** 展示用当前项目路径（已替换 homedir 为 ~）；空串 = 未激活项目 */
  currentProjectPath: string;
  /** 产物目录名（route 原常量 'homework'） */
  nodeHomeworkDir: string;
}

/** buildChain 统一入口返回：按原 route 注入顺序排列的三段注入文本 */
export interface ContextInjectionChain {
  /** 段①+②：项目路径文本 + 授权目录文本（原 pathContextInjection = projectPathInjection + authorizedRootsInjection） */
  pathContextInjection: string;
  /** 段③：用户记忆注入文本（无记忆/读取失败 = ''，不注入） */
  userPreferencesInjection: string;
  /** 段④：OCR/视觉引擎现状事实文本（未配置/读取失败 = ''，不注入） */
  ocrEngineFactInjection: string;
}

/**
 * 「新建会话」意图正则（2026-10-06）—— 只认**消息开头**的派单式说法：
 *   新建会话 / 新建一个会话 / 新开一个会话 / 开个会话 / 开个新会话 / 建个新会话 / 创建会话 …
 * 可带「帮我 / 请 / 麻烦」前缀；句中提到"会话"（如"刚才那个会话里说的"）不匹配 → 不注入。
 */
export const NEW_SESSION_INTENT_RE =
  /^\s*(?:帮我|请|麻烦)?\s*(?:新建|新开|新增|创建|开|建)(?:一个|个)?\s*新?\s*会话/;

/** 「会话」后紧跟这些词 = 说的是**已存在**的会话（追问 / 指代），不是派单：
 *  「新建会话那边怎么样了」「新建会话的任务做完了吗」都不该被当成"再去建一个"。
 *  仅在**没有分隔符**（「，」「：」「空格」）时用于否决——"新建会话，X"永远算派单。 */
const NEW_SESSION_FOLLOWUP_RE = /^(?:那边|那里|这个|那个|刚才|之前|上面|的任务|里|中|的)/;

/** ContextRuntime：动态上下文链内容生成 provider（无实例状态，单例安全）。
 * 方法签名按 route 实读所需的最小入参设计：路径段传入已 ~ 化展示路径 + 产物目录名，
 * 偏好/OCR 段各自内部读取（与原 route 内联读取时机一致：均为"每轮生成时读一次"）。 */
export class ContextRuntime {
  /** 段①：项目路径注入文本（恒非空——无激活项目也有兜底文案，原 route 三元同语义） */
  buildProjectPathInjection(input: PathContextInput): string {
    const { currentProjectPath, nodeHomeworkDir } = input;
    return currentProjectPath
      ? `\n\n当前项目路径：${currentProjectPath}\n产出文档默认 .md，用 ${nodeHomeworkDir}/ 前缀相对路径写入（如 write_file(path="${nodeHomeworkDir}/报告.md")），不要写入 homework/.ai-workspace/ 临时工作区。\n【产物声明】写文件成功后，在最终回答末尾另起一行输出 \`OutputFile: ${nodeHomeworkDir}/文件名\`（每行一个），前端据此生成可点击打开的产物卡片；禁止声明未写入或写入失败的路径。\n【模板填充产物路径】模板填充生成的 .docx 保存在 homework/template/ 目录（Finder 可见），读取/检查须用 homework/template/ 前缀。`
      : `\n\n当前没有激活项目：所有相对路径将解析到临时工作区 ~/BobWork/.sandbox。如果你的产出属于某个项目，请提醒用户先在 BobWork 中激活该项目，再把文件写入该项目的 homework/ 目录。`;
  }

  /**
   * 段⓪：当前时间锚点注入文本（恒非空）。
   *
   * 模型没有「现在几点 / 今天几号」的内在感知：用户说「明天下午三点」「下周三」时，
   * 不知道锚点就无法推算绝对时间，只能反问或凭记忆猜——对话式建日程因此首轮必卡。
   * 故每轮现算一次本机时间（含时区偏移与星期）注入。与 task-summarize.ts 的 /todo
   * 解析同一个思路（那里把 nowIso() 写进系统提示）。
   *
   * 缓存影响：走 prependDynamicContext 动态通道（落在当前轮 user 消息内），
   * system + 工具 + 历史前缀字节不变，不影响前缀缓存命中。
   */
  buildNowInjection(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    // 本机 UTC 偏移（分钟）→ ±HH:MM 字面量，供模型直接拼进 ISO
    const offMin = -now.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const off = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${weekday}`;
    return (
      `\n\n## 当前时间（相对时间锚点）\n` +
      `现在是 ${local}（UTC${off}）。\n` +
      `用户说"今天 / 明天 / 后天 / 下周三 / 周五下午三点 / 一小时后"等相对时间时，必须以此刻为锚点推算绝对时间，` +
      `并把 start_time / end_time / due_at 写成带 ${off} 偏移的 ISO（形如 YYYY-MM-DDTHH:mm:ss${off}）。` +
      `不要凭记忆猜测当前日期与星期。`
    );
  }

  /** 段②：授权目录清单注入文本（无授权目录/读取失败返回 ''，原 route try/catch 忽略语义） */
  async buildAuthorizedRootsInjection(input: { nodeHomeworkDir: string }): Promise<string> {
    try {
      const authorizedRoots = await getLocalAuthorizedRoots();
      if (authorizedRoots.length > 0) {
        const list = authorizedRoots.map((r) => `- ${r.replace(homedir(), '~')}`).join('\n');
        return (
          `\n\n你已被授权操作的本地目录（与项目目录同级，可读可写）：\n${list}\n` +
          `- 用户明确要求操作某授权目录时，用完整绝对路径在该目录执行；未指定目录时默认当前项目目录\n` +
          `- 最终产出仍统一写入当前项目 ${input.nodeHomeworkDir}/ 目录（产物声明规则同上），授权目录仅用于读素材和写临时/中间文件，除非用户明确指定"把产出保存到某授权目录"\n` +
          `- 除当前项目目录和上述授权目录外，禁止读写其他本地路径`
        );
      }
      return '';
    } catch {
      // 无授权目录时忽略（与原 route 内联 catch 一致）
      return '';
    }
  }

  /** 段③：用户记忆注入文本（listPreferences 读取 + 注入分档，原 route 2941-2962 纯生成部分）。
   *  分档：常驻档（身份画像 / 偏好习惯）注入正文；其余类型只注入 type 目录，按需 read_preferences 取全文。
   *  安全阀：常驻档**合计**超 ALWAYS_INJECTED_MAX 时按类型**逐级退化**（2026-10-02 改：此前是整体退化，
   *  连身份画像也一起掉出常驻，用户会突然觉得「它不记得我了」；判定抽成纯函数 `selectResidentTypes`）。
   *  无记忆/读取失败返回 ''（原代码 prefs.length > 0 才注入、读取异常被 catch 忽略）。 */
  async buildUserPreferencesInjection(): Promise<string> {
    try {
      const { listPreferences, ALWAYS_INJECTED_TYPES, ALWAYS_INJECTED_MAX, selectResidentTypes } = await import(
        '@/lib/core/preferences'
      );
      const prefs = await listPreferences();
      if (prefs.length === 0) return '';

      // 常驻档：条数少、每轮都用，注入正文；合计超阈值则从**最低优先级**的类型开始退回目录档
      const counts: Record<string, number> = {};
      for (const p of prefs) counts[p.type] = (counts[p.type] ?? 0) + 1;
      const residentTypes = selectResidentTypes(counts, ALWAYS_INJECTED_TYPES, ALWAYS_INJECTED_MAX);
      const isResident = (type: string) => residentTypes.includes(type);
      const resident = prefs.filter((p) => isResident(p.type));
      const rest = prefs.filter((p) => !isResident(p.type));

      const blocks: string[] = [];
      const hints: string[] = [];
      if (resident.length > 0) {
        const lines = resident.map((p) => `- [${p.type}] ${p.content}`).join('\n');
        blocks.push(`**常驻档（${residentTypes.join(' / ')}，每轮注入正文）**\n${lines}`);
        hints.push('上方常驻档每轮随上下文给出全文');
      }
      // 目录档：按 type 分组统计条数（不注入具体内容，节省上下文、避免无关记忆干扰）
      const typeCounts = new Map<string, number>();
      for (const p of rest) {
        typeCounts.set(p.type, (typeCounts.get(p.type) || 0) + 1);
      }
      if (typeCounts.size > 0) {
        const typeLines = Array.from(typeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `- [${type}] ×${count}`)
          .join('\n');
        blocks.push(`**目录档（按需调取）**\n${typeLines}`);
        hints.push(
          '目录档只给分类，当前任务涉及某类时（工作上下文、事实经历、目标计划、关系边界），调用 read_preferences(type) 读取该类完整记录并严格遵守；需要全部记录时调用 read_preferences()'
        );
      }

      return `\n\n## 用户记忆（统一长期记忆，所有联系人共享，记的是用户本人）\n已记录 ${prefs.length} 条。${hints.join('；')}。识别到持久的偏好/事实时主动调用 remember_preference 写入（type 取六类：身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界）；写入前先 read_preferences 查同类：有矛盾走 update_preference 覆盖、同一件事（哪怕措辞不同）合并成一条，而非重复追加或另起条目；密码/密钥/token/证件号等敏感信息不记录；遗忘用 delete_preference（按序号）；${BUTLER_ROUTING_HINT}。\n\n${blocks.join('\n\n')}`;
    } catch {
      // 记忆读取失败忽略（与原 route 内联 try/catch 一致）
      return '';
    }
  }

  /**
   * 段⑤：Butler 斜杠命令表注入（P0 · 统一入口）。
   *
   * 为什么走动态注入而不是写进系统提示词：管家提示词（BUTLER_BASE_SYSTEM_PROMPT）在安装时被
   * 物化为 `<APP_ROOT>/agents/butler/agent.json`，改常量对**已安装用户不生效**；而命令表
   * （BUTLER_COMMANDS）是宿主层唯一真源，必须让已装用户也立刻看到变化 → 每轮从真源现算、
   * 经 prependDynamicContext 低频通道注入（注入动作仍在 route 原位，本方法只产出文本）。
   *
   * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），system + 工具 + 历史前缀字节不变。
   *
   * 两端通用：微信 / Butler 抽屉的斜杠输入经 normalizeSlashInput 翻译为
   * 「意图：…」+ 正文后交给本画像，故只需注入一次即可覆盖全部入口。
   * （⌘F 面板的指令态已于 2026-09 P1-c 移除，不再是斜杠输入入口：见 UnifiedPalette.tsx 头注释。）
   */
  buildButlerCommandsInjection(): string {
    const lines = BUTLER_COMMANDS.map((c) => {
      const cap = c.capability
        ? `你可用：${c.capability}`
        : '**该能力不在你手里**：如实说明并引导用户去对应节点（不要假装执行）';
      return `- /${c.keyword} — ${c.label}（意图：${c.intent}）→ ${cap}`;
    });
    return (
      `\n\n## 斜杠命令（用户的快捷语法，两端通用：微信 / Butler 抽屉）\n` +
      `命令清单（唯一真源，勿编造）：\n${lines.join('\n')}\n\n` +
      `收到以「意图：…」开头的文本时，按该意图调用你手里的工具（标注「不在你手里」的如实说明并引导）。` +
      `用户发 /help 或未知命令（如 /foo）时，用上面的清单如实列出或指出不存在，不要编造命令名。`
    );
  }

  /**
   * 段⑤：Butler 排期纪律注入（P0 · 与命令表同一理由）。
   *
   * 为什么走动态注入：与命令表完全同因——管家提示词被物化为
   * <APP_ROOT>/agents/butler/agent.json，改 profiles.ts 的常量对**已装用户不生效**，
   * 而「建日程回复太长」这条纪律必须立刻对所有人生效。故把
   * BUTLER_SCHEDULE_DISCIPLINE（与 BUTLER_BASE_SYSTEM_PROMPT 内插值同一常量）经本通道注入。
   *
   * 幂等去重（2026-10-02）：BUTLER_BASE_SYSTEM_PROMPT 内已插值同一常量，故**新装用户**（agent.json
   * 由当前源码物化）的 system 里本来就有最新口径——再注入一遍是逐字重复（约 950 字符/轮，且给模型
   * 制造"新旧两版要挑一个"的伪冲突）；而**已装老用户**的 agent.json 是安装时物化的旧文本，
   * 不含本段，必须照常注入覆盖（原设计意图）。故按 basePrompt 实测包含与否决定注不注：
   *   - 含 → 返回空串（真源已在 system，零重复、零冲突）；
   *   - 不含 → 照常注入（覆盖旧版，附「以本段为准」）。
   * 传 undefined（老调用点）时行为与改动前完全一致（恒注入）。
   *
   * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），system + 工具 + 历史前缀字节不变。
   */
  buildScheduleDisciplineInjection(basePrompt?: string): string {
    // 真源已在 system 里逐字存在 → 不重复注入（新装用户 / agent.json 已刷新的用户走这一支）
    if (basePrompt && basePrompt.includes(BUTLER_SCHEDULE_DISCIPLINE)) return '';
    // 已装用户的 agent.json 里是旧版排期纪律，故显式声明「以本段为准」避免两条规则打架
    return `\n\n以下是宿主层下发的最新排期口径（与提示词里的旧版不一致时，一律以本段为准）：\n${BUTLER_SCHEDULE_DISCIPLINE}`;
  }

  /**
   * 信息分层纪律注入（2026-10-04）—— 与排期纪律**同款双通道、同款幂等去重**。
   *
   * 为什么：用户四类信息（人与分工 / 口径与标准 / 节奏 / 授权接源）此前没有落层纪律，容易
   * 把可执行的习惯只记成不会被执行的偏好、把事实写成规则。管家提示词被物化为 agent.json，
   * 改常量对已装用户不生效 → 每轮经本动态通道注入同一段（真源见 profiles.ts 的 BUTLER_MEMORY_ROUTING）。
   *
   * 幂等：basePrompt 已含同一常量（新装 / agent.json 已刷新的用户）→ 返回空串，零重复、零伪冲突；
   *       不含（已装老用户）→ 照常注入并附「以本段为准」。
   * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），system + 工具 + 历史前缀字节不变。
   */
  buildMemoryRoutingInjection(basePrompt?: string): string {
    if (basePrompt && basePrompt.includes(BUTLER_MEMORY_ROUTING)) return '';
    return `\n\n以下是宿主层下发的最新信息分层口径（与提示词里的旧版不一致时，一律以本段为准）：\n${BUTLER_MEMORY_ROUTING}`;
  }

  /**
   * 「新建会话」意图注入（2026-10-06）—— **宿主判定，只在命中时注入**（不命中零成本）。
   *
   * 为什么需要它（实测事故，2026-10-06 16:31）：用户对管家说
   * 「新建会话，涉及一份合作模式，甲方是十三幺公司…」，管家把这句话读成了「本次会话的背景说明」，
   * **0 次调用 create_session**，自己在管家线程里把协议写完了 —— 既没建成会话，也违背了
   * 「你是调度者，不是执行者」。工具的可用性没问题（cacheguard 证明 create_session 当时在册），
   * 卡点是「一句话两种读法」的判定。
   *
   * 为什么走动态注入：管家提示词被物化为 `<APP_ROOT>/agents/butler/agent.json`
   * （本机实况：2026-09-28 物化，源码里后补的 switch_project / create_session 说明一个字都没进去）
   * —— 改 profiles.ts 对已装用户不生效。而「以『新建会话』开头 = 派单」这条判定必须立刻对所有人生效，
   * 故由宿主按用户原文判定，命中才注入当前轮 user 消息（C8 低频通道，system / 工具 / 历史前缀字节不变）。
   *
   * 边界：只在**开头**匹配（可带「帮我 / 请 / 麻烦」前缀）——句中提到"会话"是普通对话内容，不注入；
   *      紧跟其后无分隔符且是「那边 / 的 / 里…」这类指代时也不算派单（追问已建的会话）。
   */
  buildButlerNewSessionInjection(userText?: string): string {
    const text = (userText || '').trim();
    const m = text ? NEW_SESSION_INTENT_RE.exec(text) : null;
    if (!m) return '';
    const after = text.slice(m[0].length);
    // 「新建会话，X」= 派单；「新建会话那边怎么样」= 追问已建的会话 → 不注入
    if (!/^[，,。.：:；;、\s]/.test(after) && NEW_SESSION_FOLLOWUP_RE.test(after)) return '';
    const rest = after.replace(/^[，,。.：:；;、\s]+/, '').trim();
    return (
      `\n\n【宿主判定 · 本轮意图：新建会话】\n` +
      `用户这句话以「新建会话」开头 → 这是**要求你新建一个画布会话、并把后面的任务交给新会话执行**，` +
      `不是本次对话的背景说明。请立刻调用 create_session：\n` +
      `- project：不传（用当前项目）；只有用户点名了别的项目才传；\n` +
      `- task：把用户消息里「新建会话」之后的任务描述**原样**带过去（自包含：当事人 / 交付物 / 约束 / 参考材料都要在）` +
      (rest ? '；\n' : '；用户没给任务内容时就不传 task（只建空会话）；\n') +
      `- agent：按任务性质选已装身份（法律文书 / 合同起草 → legal-intern，知识库 / 笔记 → note，代码 → coding，项目账本 → archivist）；\n` +
      `- title：用几个字概括这件事。\n` +
      `**不要自己在管家线程里把这项工作做完**（写合同、改代码、做调研都不是管家的活），也不要只回一句「好的」——` +
      `建完用一句话回报「已新建 <agent> 会话「<title>」，任务已在后台执行」。` +
      `若工具返回 ui_not_open，如实告诉用户先打开 BobWork 再重试，不要谎称已建。`
    );
  }

  /**
   * 可见源（能力边界）注入（2026-10-04；2026-10-05 改为**注册表派生**）。仅管家身份调用。
   *
   * 「授权 / 接源」既不是记忆也不是规则，而是**能力边界**：模型看不见自己接了哪些源，就会含糊
   * 承诺或假装执行。本段把「当前能看见什么 / 看不见什么」如实下发，缺什么就引导用户去接源 / 授权。
   *
   * 清单不再硬编码在此，而是从 `runtime/sources.ts` 的 SOURCES 注册表**派生**：
   *   - 场景命中（`entry.scenes` 为空 = 恒在候选；否则需与本轮 `scenes` 有交集）且 render 非 null → 收行；
   *   - 新增一个源只改注册表一处，可见性文案与漂移护栏（sources.registry.test.ts）同时就位。
   * 本文件只负责**采集 IO**（不新增网络请求 / 轮询，全部取自既有内存态 / 落盘态）：
   *   - 微信桥 wechatBridge.getStatus()（同步）
   *   - 飞书桥 feishuBridge.getStatus()（同步）
   *   - 本地授权目录 getLocalAuthorizedRoots()（异步，与段②同源）
   * 各源分别容错：单项取数失败只令该源不展示；全部无行或整体异常 → 返回 ''（静默降级，不阻断对话）。
   *
   * 缓存影响：与其余动态注入同走 prependDynamicContext（落在当前轮 user 消息内），
   * system + 工具 + 历史前缀字节不变，不影响前缀缓存命中。
   */
  async buildVisibleSourcesInjection(scenes: Set<ToolScene>): Promise<string> {
    try {
      // ① 采集 IO（逐项容错：单项失败只令该源不展示，不阻断其余）
      const status: SourceStatus = {
        // 场景含 ledger = 该画像有项目档案面（投影自生效场景集，与工具面同判据）
        hasProject: scenes.has('ledger'),
        authorizedRoots: [],
      };

      try {
        const { wechatBridge } = await import('@/lib/bridge/wechat-bridge');
        const st = wechatBridge.getStatus();
        status.wechat = { running: st.running, bound: st.bound };
      } catch { /* 微信桥不可用 → 该源不展示 */ }

      try {
        const { feishuBridge } = await import('@/lib/bridge/feishu-bridge');
        const st = feishuBridge.getStatus();
        status.feishu = { running: st.running, bound: st.bound };
      } catch { /* 飞书桥不可用 → 该源不展示 */ }

      try {
        const roots = await getLocalAuthorizedRoots();
        status.authorizedRoots = roots.map((r) => r.replace(homedir(), '~'));
      } catch { /* 读取失败 → 该源不展示 */ }

      // ② 注册表派生：场景命中且 render 非 null 才收行（顺序即 SOURCES 登记顺序）
      const lines: string[] = [];
      for (const src of SOURCES) {
        if (src.scenes.length > 0 && !src.scenes.some((s) => scenes.has(s))) continue;
        const line = src.render(status);
        if (line) lines.push(line);
      }

      // ③ 全部无行 → 静默降级（与改造前语义一致）
      if (lines.length === 0) return '';

      return (
        `\n\n## 你当前能看见什么（能力边界，勿承诺清单外的事）\n` +
        `${lines.join('\n')}\n` +
        `- 清单之外的东西（未接入的源、未授权的目录）你**看不到**：如实说明，并一句话引导用户去接源 / 授权，不要假装能执行。`
      );
    } catch {
      return '';
    }
  }

  /**
   * 段⑤：进行中的会议状态注入（P1-b · `/meeting` 工具化）。
   * route 注入位置：管家在命令表之后；其他身份（主对话等）在命令表段之前单独注入。
   *
   * 会议缓冲是服务端**全局单场状态**（lib/core/meeting-session.ts，P1-d 起落 SQLite .inbox.db），
   * 模型看不见它——不注入的话，会议进行中用户每条补充内容都会被当成新任务处理
   * （回话/建日程），而不会用 meeting_append 原样记录，会议链路就断了。
   * 无进行中会议 → 空串（不注入）。与命令表同走低频动态通道
   * （prepend 到当前轮 user 消息，system 缓存前缀字节稳定）。
   *
   * 覆盖面：P1-b 起仅管家（identity==='butler'）注入；2026-09-26 放宽为全身份——
   * 主对话（画布 chat 节点）开会后同样需要"会议进行中"这条状态，否则第二轮起链路必断。
   * route 侧按画像 gate：dynamic 画像（主对话）恒可注入；fixed 画像须 fixedScenes 含 butler
   * （browser 侧栏 / coding 节点拿不到会议三件套，故不注入，避免"指引有、工具没有"）。
   */
  async buildMeetingStateInjection(): Promise<string> {
    const st = await getMeetingState();
    if (!st.active) return '';
    return (
      `\n\n## 进行中的会议记录\n` +
      `会议「${st.title}」正在记录中（已记录 ${st.count} 条）。用户本条消息默认是**补充会议内容**：` +
      `调用 meeting_append 原样记录（不要总结、不要回应内容、不要另起任务）；` +
      `用户要求结束或整理纪要（如 /meeting out）→ 调用 meeting_end 并把纪要转述给用户；` +
      `用户明确要做别的事 → 照常办，并提示会议仍在记录中。`
    );
  }

  /**
   * 段④：OCR/视觉引擎现状事实注入（[SYS FACT]）——原 route.ts module 级 buildOcrEngineFactInjection
   * 整体随迁（实现逐字节保留，含 v2 schema（vision.* 与 ocr.*）与旧版 schema 顶层 glmOcr / onlineOcr 兜底）。
   *
   * 问题背景：BASE_SYSTEM_PROMPT 曾硬编码「bob-ocr-mcp 已配置本地视觉模型（Qwen2.5-VL）」，
   * 而插件真实配置由用户随时可改（云端 DeepSeek VL / GLM-OCR / 本地 MLX 等皆可能）——
   * 配置变了、缓存头里的静态断言没变，模型据 stale 文案向用户转述错误引擎归属。
   * 根因：易变配置被写进了字节稳定的 system 缓存头。
   *
   * 方案：system 保持零插值（C8）；每轮从插件数据根 config.json
   * （BobWork 托管：~/BobWork/extensions/bob-ocr-mcp）读真实生效值，
   * 以固定格式事实行经 prependDynamicContext 低频通道注入（注入动作仍在 route 原位）。
   * 只原样转述字段值，不做本地/云端的语义推断（provider/baseUrl 字段本身已表达），绝不输出 apiKey。
   *
   * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），跨轮前缀
   * （system + 工具 + 历史）字节不变，命中率不受影响；用户改插件配置的瞬间
   * 仅影响本轮及之后的消息前缀，属预期失效（事实必须反映最新配置）。
   */
  buildOcrEngineFactInjection(): string {
    try {
      const cfgPath = join(pluginDataHome('bob-ocr-mcp'), 'config.json');
      if (!existsSync(cfgPath)) return '';
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');
      const lines: string[] = [];

      // 视觉理解（v2：vision.selected 指向 vision.models[] 中某条目）
      if (raw.vision && typeof raw.vision === 'object') {
        const vision = raw.vision as { selected?: unknown; models?: unknown };
        const selected = str(vision.selected);
        const models = Array.isArray(vision.models)
          ? (vision.models as { id?: unknown; provider?: unknown; baseUrl?: unknown }[]).filter(
              (m): m is NonNullable<typeof m> => !!m && typeof m === 'object',
            )
          : [];
        const entry = selected ? models.find((m) => str(m.id) === selected) : undefined;
        if (entry) {
          lines.push(`- 视觉理解模型：${selected}（provider=${str(entry.provider) || '未声明'}，baseUrl=${str(entry.baseUrl) || '默认'}）`);
        } else if (selected) {
          lines.push(`- 视觉理解模型：${selected}（模型清单中未找到对应条目）`);
        } else {
          lines.push('- 视觉理解模型：未选择');
        }
      }

      // 文字识别（v2：ocr.source / ocr.glm / ocr.local；旧版兜底：顶层 glmOcr / onlineOcr）
      if (raw.ocr && typeof raw.ocr === 'object') {
        const ocr = raw.ocr as Record<string, unknown>;
        const src = str(ocr.source);
        const sel = str(ocr.selected);
        const detail: string[] = [];
        if (ocr.glm && typeof ocr.glm === 'object') {
          const glm = ocr.glm as { model?: unknown; baseUrl?: unknown; enabled?: unknown };
          const state = glm.enabled === true ? '启用' : glm.enabled === false ? '停用' : '未声明';
          detail.push(`glm=${str(glm.model) || state}@${str(glm.baseUrl) || '默认'}`);
        }
        if (ocr.local && typeof ocr.local === 'object') {
          const local = ocr.local as { baseUrl?: unknown; enabled?: unknown };
          const state = local.enabled === true ? '' : local.enabled === false ? '（停用）' : '';
          detail.push(`local=${str(local.baseUrl) || '默认'}${state}`);
        }
        lines.push(`- 文字识别主力：${src || sel || '未配置'}${src && sel ? `（selected=${sel}）` : ''}${detail.length ? `｜${detail.join('｜')}` : ''}`);
      } else if (
        ((raw.glmOcr ?? null) && typeof raw.glmOcr === 'object') ||
        ((raw.onlineOcr ?? null) && typeof raw.onlineOcr === 'object')
      ) {
        const seg: string[] = [];
        if (raw.glmOcr && typeof raw.glmOcr === 'object') {
          const leg = raw.glmOcr as { model?: unknown; enabled?: unknown };
          seg.push(`glm=${str(leg.model) || (leg.enabled === false ? '停用' : '已配置')}`);
        }
        if (raw.onlineOcr && typeof raw.onlineOcr === 'object') {
          const onl = raw.onlineOcr as { model?: unknown; provider?: unknown; enabled?: unknown };
          seg.push(`online=${str(onl.model) || str(onl.provider) || (onl.enabled === false ? '停用' : '已配置')}`);
        }
        lines.push(`- 文字识别主力（旧版配置）：${seg.join('｜')}`);
      }

      if (!lines.length) return '';
      return (
        `\n\n## OCR/视觉引擎现状（[SYS FACT]）\n以下为 bob-ocr-mcp 插件本轮实际生效的引擎配置（读取自其 config.json 原样字段值）。` +
        `回答任何"用的什么视觉模型 / OCR 引擎是本地还是云端 / 是否已配置"等引擎归属类问题时，必须以此为准：\n` +
        lines.join('\n')
      );
    } catch {
      /* 配置缺失/损坏一律静默跳过——此时 system 护栏要求如实回答"无法确认"，不得虚构 */
    }
    return '';
  }

  /** 统一入口：按原 route 注入顺序依次生成三段注入文本（pathContext → userPreferences → ocrFact）。
   *  各段独立容错；route 拿到结果后仍按原三个 prepend 原位执行注入。 */
  async buildChain(input: PathContextInput): Promise<ContextInjectionChain> {
    const pathContextInjection =
      this.buildProjectPathInjection(input) +
      (await this.buildAuthorizedRootsInjection({ nodeHomeworkDir: input.nodeHomeworkDir }));
    const userPreferencesInjection = await this.buildUserPreferencesInjection();
    const ocrEngineFactInjection = this.buildOcrEngineFactInjection();
    return { pathContextInjection, userPreferencesInjection, ocrEngineFactInjection };
  }

  /** K2-S3b：AI Coding 沙盒上下文文本生成（原 route 2887-3052 内容生成部分，行为不变）。
   *  仅产出待 prepend 的注入文本；注入动作（prependDynamicContext）、coding 场景/工具联动判定
   *  与 toolLoopSandboxAppId 供 args_transform 注入等仍留在 route 原位：
   *    - node 由 route 按 resolveNodeProject + loadNodeById 解析后传入（null = 未定位到节点）；
   *    - frontmatter 无合法 sandbox_app_id（缺失/非 string/节点缺失）→ 返回 ''（原 route 不注入语义）；
   *    - readAppEntry/hasAppImplementation/getBridgeActionsText 读取失败时向上抛，由 route 调用点
   *      原 try/catch 统一 console.warn（toolLoopSandboxAppId 已在调用前按 frontmatter 赋值，
   *      读取失败时沙箱参数注入不丢、仅注入文本为 ''——与迁移前一致）。 */
  async buildCodingSandboxInjection(input: { node: NodeMarkdown | null }): Promise<string> {
    const { node } = input;
    const sandboxAppId = node?.frontmatter?.sandbox_app_id;
    if (!(sandboxAppId && typeof sandboxAppId === 'string')) return '';
    const entry = await readAppEntry(sandboxAppId);
    if (entry) {
      const appName = entry.app.name || sandboxAppId;
      // 首轮判定：没有任何真实对话轮次 → 可能是首轮。
      // 真实轮次 = 去除 answer 为 __BAI_INITIAL_PROMPT_PLACEHOLDER__ 的"创建节点时预填需求占位"
      const INIT_PLACEHOLDER = '__BAI_INITIAL_PROMPT_PLACEHOLDER__';
      const isFirstRound =
        !Array.isArray(node?.conversations) ||
        node.conversations.filter((c) => typeof c?.answer !== 'string' || c.answer !== INIT_PLACEHOLDER).length === 0;
      // Spec 采集豁免：小程序已存在真实实现（index.html 非内置模板初始内容）时，
      // 新建节点对已有小程序的修改不强制采集 Spec——直接读现有文件按本次指令修改。
      // 仅"从零新建（无实现）"的首轮才强制走 6 问题采集。
      const appHasImpl = isFirstRound ? await hasAppImplementation(sandboxAppId) : true;
      const requireSpec = isFirstRound && !appHasImpl;
      const injectionText =
        `\n\n=== AI Coding 编程任务上下文 ===\n` +
        `你正在为一个 Bob Sandbox 小程序「${appName}」（appId: ${sandboxAppId}）进行 AI 编程开发。\n` +
        (requireSpec
          ? `\n【首轮引导：先采集 Spec，不写代码 —— 仅"从零新建"的首轮强制执行，后续轮次跳过】\n` +
            `这是该节点的首轮对话（还没有任何 Q&A 记录），且该小程序还没有任何真实实现（仍为内置模板初始状态）。用户通常无法一次性清晰描述需求，你必须先采集结构化的设计规格（Spec），绝不能直接写代码。\n` +
            `方法：调用 ask_user_questions 工具并把以下 6 个问题一次性放入其 questions 数组（宿主会弹出结构化表单，用户提交后答案会作为工具结果返回给你，进入下一轮生成）。每个问题元素格式：{ id: string, question: string, options: string[], allowCustom: boolean }。\n` +
            `必须询问的 6 个问题（id 用 spec_0 到 spec_5）：\n` +
            `  spec_0: 小程序的核心功能是什么？（用户用一句话描述后，AI 自行归纳为 1 句话写入目标定位）\n` +
            `         options 示例：["待办/任务管理","表单填写与数据收集","数据图表/大屏展示","计算/换算工具","信息/文档阅读器","个人主页/作品集页","营销/产品落地页","倒计时/打卡/习惯追踪","AI 智能问答/内容生成","其他（自定义）"]\n` +
            `  spec_1: 目标使用场景和人群？allowCustom: true\n` +
            `         options 示例：["个人日常使用","工作效率工具","面向客户展示","小组/团队协作","学习/备考工具","法律/医疗等专业场景","其他（自定义）"]\n` +
            `  spec_2: 主要交互呈现方式？\n` +
            `         options 示例：["表单输入 + 结果展示","列表 + 增删改查","图表 + 可视化","单页卡片式展示","对话式交互","多页导航","其他（自定义）"]\n` +
            `  spec_3: 数据是否需要持久化（关闭再打开仍保留）？\n` +
            `         options 示例：["需要，历史记录/重要数据必须保留（用 BobStorage.save）","仅本次会话临时保存即可（用 BobStorage.set）","不需要，每次打开重新开始"]\n` +
            `  spec_4: 视觉风格偏好？allowCustom: true\n` +
            `         options 示例：["极简清爽（大量留白、轻量边框）","专业商务（稳重配色、层次清晰）","活泼多彩（渐变、丰富视觉）","仿纸质（米色背景、手写风格）","跟随 BobWork 主题默认（推荐，自动适配明暗）"]\n` +
            `  spec_5: 是否需要接入 AI 能力（模型调用）？\n` +
            `         options 示例：["不需要，纯工具型小程序即可","需要，我稍后会说明细节","请按功能判断是否需要并询问我"]\n` +
            `要求：\n` +
            `  - 6 个问题全部通过 ask_user_questions 工具提供，不要自由提问；\n` +
            `  - 正文开头先写一句话引导语（如「为了更准确地生成你想要的小程序，请先填写以下 6 个简单问题：」），然后紧接着调用 ask_user_questions 工具弹出表单；\n` +
            `  - 正文禁止输出任何代码、伪代码或"我来写吧"等跳过采集的声明；\n` +
            `  - 若用户在首轮消息里已明确写出需求（例如有具体功能点），请基于其描述自动预填/归纳各选项，仍调用 ask_user_questions 让用户确认或修改，不能省略采集。\n`
          : (isFirstRound
            ? `\n【首轮引导：已有实现，修改模式 —— 不采集 Spec，直接动手】\n` +
              `这是该节点的首轮对话，但小程序「${appName}」已存在真实实现（非模板初始状态）。用户意图是对现有小程序进行修改/升级，不要弹出需求采集表单。\n` +
              `正确做法：先用 read_file / list_files 读取 bob-sandbox/apps/${sandboxAppId}/ 下的现有文件（尤其 index.html / manifest.json / smoke-test.js），了解当前实现与功能后，直接按用户本次输入执行修改；修改后按下方【主动测试分级引导】自检。\n` +
              `若用户输入仅提到具体改动点（如"把引擎换成 xxx"），针对该点精确修改，不要重构无关部分，也不要重新收集需求。\n`
            : '')) +
        (requireSpec
          ? `\n【交底方案 · 分级自适应（收到用户 spec 答案后执行一次，进入写码阶段后不再重复）】\n` +
            `当你从首轮 ask_user_questions 的结果中拿到用户提交的 6 项 spec 答案后的第一轮，先判定复杂度再行动：\n` +
            `  1.【复杂度判定】\n` +
            `     - 复杂任务（满足任一即算复杂）：多页面/多视图导航；功能模块 ≥ 3 个；含数据可视化/图表/大屏；多步骤表单流程；需对接多个 Bridge API 或复杂数据模型\n` +
            `     - 简单任务：单屏、纯展示或单一功能工具（计算器、倒计时、单位换算、单表单提交、简单信息展示等）\n` +
            `  2.【复杂任务 → 先方案后代码】\n` +
            `     - 先在正文输出交底方案：① 一句话目标定位 ② 功能模块清单（标注优先级）③ 页面结构（每页布局与关键交互）\n` +
            `     - 然后调用 write_file 生成 HTML 原型稿 bob-sandbox/apps/${sandboxAppId}/mockup.html：用真实 CSS 搭出与最终一致的结构与配色（样式必须自包含——直接写具体色值即可，mockup.html 走静态文件路由、不经宿主注入，不要依赖 var(--primary) 等宿主主题变量），示例数据填充内容；页面间跳转/按钮用简单 JS 切换即可，不实现真实业务逻辑\n` +
            `     - 正文附上原型预览地址（完整地址，禁止 localhost:PORT 占位符）：http://localhost:${process.env.PORT || '8321'}/api/sandbox/preview/${sandboxAppId}/mockup.html，并请用户确认或提出修改\n` +
            `     - 根据用户反馈迭代 mockup.html，直到用户明确确认后，再删除 mockup.html（用 delete_file）并开始编写真实功能代码\n` +
            `  3.【简单任务 → 直接写码】\n` +
            `     - 正文用两三句话简述将实现的功能与页面布局（不生成 mockup.html），然后直接按 spec 开始写代码\n` +
            `  4.【清理】mockup.html 是设计稿不是交付物：用户确认并进入写码后必须删除（delete_file），保持 bob-sandbox/apps/${sandboxAppId}/ 下只留真实交付文件\n`
          : `\n【修改已有实现 · 直接动手】\n` +
            `本次是对已有小程序的修改：无需交底方案，也禁止生成 mockup.html 原型稿。直接按用户本次指令修改现有文件；改动点较多时可在正文用两三句话简述将改动哪些位置。修改后按下方【主动测试分级引导】自检。\n`) +
        `- 该小程序的全部代码文件位于应用数据目录 bob-sandbox/apps/${sandboxAppId}/ 下，写入与修改一律使用相对路径 bob-sandbox/apps/${sandboxAppId}/<文件名>（例如 bob-sandbox/apps/${sandboxAppId}/index.html）。\n` +
        `- 【硬性规则】本节点的所有产物（HTML/JS/CSS 等）必须且只会落在 bob-sandbox/apps/${sandboxAppId}/ 内（宿主已强制：即使误用 homework/ 或裸文件名路径，也会自动重定向到该小程序目录），禁止在正文声称写入 homework/ 或任何项目目录；小程序全局存储是刻意设计——删除节点/项目后小程序依然保留\n` +
        `- 预览地址（如需用 browser.navigate 在真实浏览器中打开验证，必须使用此完整地址，禁止写成 localhost:PORT 占位符；端口为当前 BobWork 服务端口，写死替换即可）：${`http://localhost:${process.env.PORT || '8321'}/api/sandbox/preview/${sandboxAppId}`}\n` +
        `- 动手前先用 read_file / list_files 读取该目录现有文件，了解当前实现后再修改\n` +
        `- 第三方库引入：小程序可直接用 CDN 引入常用库（如 <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>、<script src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>、<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script> 等）。预览 CSP 已放开 http/https 外链，可直接使用；导出独立页面（sandbox_export）时 CDN 外链会自动保留。优先选用体积小、无需构建的 UMD 版本，不要自己手写复杂的图表/日期逻辑\n` +
        `- 主动测试分级引导（修改后按序自检，直到符合用户要求）：\n` +
        `  1.【视觉自检·每轮必做】每完成一轮代码修改，立即调用 capture_preview 截取预览效果图（真实 headless Chromium 渲染，视觉模型描述渲染结果），检查布局/样式/配色是否符合预期；发现视觉问题直接继续修改，不要进入下一步\n` +
        `  2.【交互测试·改动涉及交互时 + 每轮交付前的最小冒烟】视觉自检无法验证交互时序（点击、表单、跳转、状态切换、持久化）。此时调用 interact_preview 工具在真实浏览器内做交互测试：传 target（app 预览地址或 HTML 路径）与 script，脚本在页面全局作用域执行（document/window 可用），可模拟点击（el.click()）、填表（el.value=... 并派发 input 事件）、跳转、状态切换，并用 DOM 断言（querySelector 检查弹窗/按钮状态/渲染数据）验证结果，通过 window.__testResult = {...} 返回结构化结果；工具会捕获 console 日志（LOG/WARN/ERR）并截图，脚本异常会以 SCRIPT ERROR 报出。交互 bug（按钮无响应/表单不拦截/状态不保存）只有真实运行时才能暴露，禁止仅用截图代替\n` +
        `  2b.【冒烟脚本持久化·每轮交付前必做】把最小冒烟脚本（点击主入口 + 断言核心元素渲染 + 检查无 ERR 日志）保存到 bob-sandbox/apps/${sandboxAppId}/smoke-test.js（首次写好即可，后续轮次用 read_file 读取直接复用，不要每次重写）。每轮交付给用户前，必须用 interact_preview 执行一次该最小冒烟，确认应用可用、无 console 错误\n` +
        `  3.【逻辑测试·涉及计算/数据处理时】用 run_command / execute_script 写脚本校验计算结果与边界值（如金额计算、日期处理、表单必填校验），不要在脑子里算\n` +
        `- 任一层发现问题 → 修改代码 → 重新从第 1 步自检，循环直至全部通过\n` +
        `- 本节点的最终交付物就是这个小程序本身，无需在 homework/ 下额外生成说明文档（除非用户明确要求）；交底方案与 HTML 原型稿只在对话流与 mockup.html 中呈现，用户确认后即清理，不落盘为独立文档\n` +
        `\n【manifest.json 字段说明（可选）】\n` +
        `小程序的 manifest.json 在 bob-sandbox/apps/${sandboxAppId}/manifest.json，默认包含以下字段，修改后立即生效（无需重启）：\n` +
        `  - aiBadge: boolean (默认 true) —— 宿主是否在小程序预览右上角自动注入 AI 状态胶囊徽章。\n` +
        `    * 默认注入：绿点（已授权调用模型）/灰点（未授权，点击可申请），无需小程序代码干预。\n` +
        `    * 若小程序 UI 自带模型绑定状态展示（如自定义开关徽章），或右上角有自有按钮会遮挡，主动设为 false 关闭宿主注入，用自定义 UI 配合 BobWork.request('chatGetPermission') / 'chatRequestPermission' 自行管理。\n` +
        `\n=== BobWork Host Bridge API（亲儿子待遇：主动对接、深度融合） ===\n` +
        `\n【小程序定位 — BobWork 亲儿子功能组件】\n` +
        `小程序是 BobWork 原生功能组件，不是外部"外勤物种"。鼓励主动对接主程序资源（Butler 待办、节点、主题、模型、技能、项目、日历等），让小程序成为用户在 BobWork 中的信息门户和工作面板，而非孤立的独立页面。\n` +
        `只要功能合理且不会误操作，直接在代码中调用 Bridge API 即可，不需要等待用户明确要求。\n` +
        `\n【持久化 API — 默认允许主动使用】\n` +
        `以下为小程序自身的持久化能力（私有数据），用户提到"加持久化"、"保存记录"、"关掉再打开还在"、"恢复上次状态"、"存历史记录"等场景时，应主动使用，无需用户额外说明：\n` +
        `  （小程序 iframe 运行时已全局注入 window.BobStorage 对象，直接调用即可）\n` +
        `  - BobStorage.set(key, value)  → 浏览器端 localStorage，自动加 appId 前缀隔离，关闭 BobWork 清空浏览器缓存会丢失\n` +
        `  - BobStorage.get(key)         → 读取上条，返回解析后的值或 null\n` +
        `  - BobStorage.remove(key)      → 删除上条\n` +
        `  - BobStorage.listLocalKeys()  → 列出该小程序在 localStorage 中所有的 key\n` +
        `  - BobStorage.save(key, value) → 写入磁盘私有数据目录 ~/BobWork/bob-sandbox/apps/<appId>/data/<key>.json，真正持久化，重启/升级/重装均保留，推荐用于历史记录、长存档、表单完整状态等需要跨重启保留的数据\n` +
        `  - BobStorage.load(key)        → 读取磁盘私有数据目录，返回解析后的值或 null\n` +
        `  - BobStorage.listDiskKeys()   → 列出磁盘私有数据目录下所有 key\n` +
        `  - BobStorage.deleteKey(key)   → 删除磁盘私有数据目录下某 key\n` +
        `  选择原则：表单临时状态/UI 偏好 → 用 set/get（快，不需要等待 Promise）；历史记录/长存档/重要数据 → 用 save/load（写入磁盘，跨重启保留）。\n` +
        `\n【主程序共享资源 API — 鼓励主动对接，只读接口默认自由使用】\n` +
        `小程序作为 BobWork 亲儿子组件，默认鼓励主动调用以下 Bridge 只读接口读取主程序资源，打造信息门户/工作面板类体验：\n` +
        `  - Butler 系列：readWantedTodo（待办看板）、readWantedNotebook（个人记录索引）、readWantedPreferences（偏好配置）—— 做全局待办面板、个人偏好驱动 UI 等场景直接用\n` +
        `  - 节点信息系列：listNodes、readNode、getNodeAncestorChain、getNodeManifest —— 做节点导航/检索/目录页等场景直接用\n` +
        `  - 技能与模型：searchSkills、listConfiguredModels —— 做能力缺口检测、模型选择 UI 等场景直接用\n` +
        `  - 项目与配置：listProjects、getAppConfig、getProjectInfo、getTheme —— 做项目切换、主题适配、总览仪表盘等场景直接用\n` +
        `  - 日历提醒：listCalendarEvents —— 做今日日程/待办提醒面板直接用\n` +
        `  - 写入类接口（writeWanted）：仍需用户明确提及"写入 butler"场景才使用，避免误写全局交付目录\n` +
        `  - 通过注入的 window.BobWork.request(action, data) 调用：\n` +
        getBridgeActionsText() + '\n' +
        `  - 调用示例：const nodes = await BobWork.request('listNodes', {}); const todo = await BobWork.request('readWantedTodo', {});\n` +
        `  - 运行时可用 BobWork.listActions() 查询所有可用操作` +
        `\n【画布对接 API（GraphGateway，太空舱对接协议）— 需要对接画布时主动申请授权】\n` +
        `graph* 系列动作用于小程序对接主程序画布（如"节点地图"、"画布操控面板"、"节点导航器"等需求）。规则：\n` +
        `  1. 小程序核心功能涉及画布操作/浏览时，主动申请授权，不要等用户反复要求；\n` +
        `  2. 使用前调用 BobWork.request('graphRequestPermission', { level: 'read'|'control' }) 申请授权：\n` +
        `     - read = 只读（graphGetSnapshot）；control = 可读可操作（展开、移动、选中节点）；\n` +
        `     - 宿主会弹出确认框由用户授予，用户拒绝或未授权时返回 level: 'none'；\n` +
        `  3. 未获授权就调用其他 graph* 动作会失败（Promise reject），代码应 catch 并给出友好提示（如"未获得画布访问权限，请先授权"），不得用 alert；\n` +
        `  4. 可先用 BobWork.request('graphGetPermission', {}) 查询当前授权级别，避免无谓申请。\n` +
        `\n【小程序模型调用 API（chat）— 需先获授权，AI 原生体验放开】\n` +
        `chat* 系列动作用于让小程序直接调用 AI 模型（无工具、纯文本裸对话，与节点对话不同——模型没有文件/工具权限）。规则：\n` +
        `  1. 使用前必须先调用 BobWork.request('chatRequestPermission', {}) 申请授权：宿主会弹出确认框由用户授予；\n` +
        `     可先用 BobWork.request('chatGetPermission', {}) 查询当前是否已授权，避免无谓申请；\n` +
        `  2. 调用示例：const res = await BobWork.request('chat', { messages: [{ role: 'user', content: '...' }], maxTokens: 4096 });\n` +
        `     - model 参数可省略：默认走 Auto 模式（系统自动从已配置模型池里选可用模型，优先已勾选模型）；\n` +
        `     - 如需显式指定，格式 provider:modelId，只要 provider 已配置 API Key 即可使用（不限 selectedModels 勾选范围）；\n` +
        `     - 纯文本进出，默认输出 8192 tokens，最大支持 32768 tokens，无 PII 脱敏（亲儿子模式数据不篡改）；\n` +
        `  3. 流式调用（推荐用于长回复、打字机效果）：const handle = BobWork.chatStream({ messages, maxTokens, onDelta: (text) => { /* 追加到输出 */ } });\n` +
        `     - 返回 handle.promise 等待最终结果（{ model, provider, usage }），handle.abort() 可中途停止生成；\n` +
        `     - 每段增量文本经 onDelta 回调实时获得，用于逐字渲染；与 chat 相同鉴权/无硬 token 上限；\n` +
        `  4. 未授权 / 模型不可用 / 超限都会 reject，代码必须 catch 并给出友好提示（如"模型调用未授权，请先授权"），不得用 alert。\n` +
        `\n【小程序模型调用接入策略 - 何时该主动询问用户 + 模型选择流程】\n` +
        `是否给小程序接入 AI，按以下两级判断（避免擅自加 AI 打扰用户，也避免该加时不问）：\n` +
        `  A. 用户主动要求（情形 1）-> 直接接入，按上述规则申请授权并调用，无需再问。\n` +
        `  B. 用户未提及，但小程序核心功能天然依赖 AI（情形 2）-> 在生成代码前，先用一句话向用户确认："这个小程序看起来需要 AI 能力（如翻译/总结/问答/文案生成），需要我接入吗？"\n` +
        `     典型应主动询问的功能：翻译、智能问答、内容总结、文案/创意生成、语义分类、情感分析、对话式交互等。\n` +
        `     典型不应询问的纯工具功能：计算器、倒计时、待办清单、表单填写、单位换算、文件格式转换、数据图表展示等--这些加了 AI 反而多余，不要问。\n` +
        `     用户回复"不用"或未明确同意 -> 不接入，按纯前端实现；用户同意 -> 按情形 1 接入。\n` +
        `  C. 纯工具型小程序 -> 不询问、不接入，避免弹授权框打扰用户。\n` +
        `  D. 用户明确禁止调用 AI（情形 4）-> 绝对禁止接入。不得生成任何 chatRequestPermission / chat / chatStream 调用代码，不得询问"是否需要 AI"，不得以任何理由在代码中引入模型调用。即使小程序功能看起来需要 AI，也必须用纯前端方案实现。此规则优先级最高，覆盖以上所有情形。\n` +
        `\n【模型选择流程 — 用户同意接入 AI 后必须执行】\n` +
        `当用户同意接入 AI（情形 1 或情形 2 用户确认后），你必须按以下步骤执行模型选择流程：\n` +
        `  1. 立即调用 list_configured_models 工具（无需参数），获取用户已配置的模型池；\n` +
        `  2. 将返回的可用模型以易读列表呈现给用户，格式示例：\n` +
        `     "你已配置以下可用模型：\\n  • DeepSeek: deepseek-flash（快速对话）\\n  • Qwen: qwen-max（长文本理解）\\n  • Zhipu GLM: glm-4-flash（轻量快速）\\n请选择一个模型（回复模型名即可），或回复 'auto' 让系统自动选择。"\n` +
        `     - 如果模型池为空（返回 empty: true），告知用户："当前还没有配置任何模型，请先在 Manage Models 中添加厂商 API Key 并勾选模型，然后告诉我继续。"\n` +
        `     - 等待用户选择后再生成代码，不要跳过此步。\n` +
        `  3. 根据用户选择的模型，在小程序 UI 中添加一个模型选择按钮（下拉菜单或胶囊切换），具体规范：\n` +
        `     - 按钮位置：放在输入框上方或右上角，与 AI 功能区域关联；\n` +
        `     - 按钮样式：胶囊/芯片形，显示当前选中的模型简称（如 "DeepSeek V4"），点击展开下拉列表；\n` +
        `     - 下拉列表：列出 list_configured_models 返回的所有可用模型，每项显示厂商 + 模型名 + 简短描述；\n` +
        `     - 选项中始终包含 "Auto（自动选择）" 作为第一项（对应 model 参数省略）；\n` +
        `     - 用户选择后，将 model 值（provider:modelId 格式）保存到 BobStorage.set('selectedModel', modelId)；\n` +
        `     - 调用 chat 时读取本地存储的 model 值传入：const model = BobStorage.get('selectedModel'); BobWork.request('chat', { model, messages, ... })；\n` +
        `     - model 为 'auto' 或 null 时省略 model 参数，走 Auto 模式。\n` +
        `  4. 模型选择按钮的交互细节：\n` +
        `     - 默认选中 "Auto"（首次使用）；\n` +
        `     - 切换模型后立即生效（下次调用 chat 时使用新模型），无需重新授权；\n` +
        `     - 按钮文案使用英文（如 "Model: Auto" / "Model: DeepSeek V4"），不用中文；\n` +
        `     - 配色跟随小程序主题（用 var(--primary) 等 CSS 变量），不要写死色值。\n` +
        `\n\n=== 小程序 UI 默认规范（无需用户要求即可主动应用） ===\n` +
        `以下规范保证小程序在 BobWork 预览中风格一致且专业，按优先级执行：\n` +
        `1. 布局：外层卡片式容器，圆角 12px（border-radius: 12px）、柔和阴影 box-shadow: 0 4px 20px rgba(0,0,0,0.08)、内容区 padding 20-28px；viewport 移动端优先，容器 max-width 440px 水平居中；分组模块分区，标题字重 600 + 下边框 1px\n` +
        `2. 配色（CSS 变量自适应）：小程序预览环境已自动注入当前主题的 44 个 CSS 变量到 :root，直接使用 var(--primary)、var(--background)、var(--paper)、var(--ink)、var(--ink-muted)、var(--border)、var(--danger)、var(--success) 等即可自动适配所有主题（含自定义主题），无需写死色值。映射关系：主色 var(--primary) / 背景 var(--background) / 卡片 var(--paper) / 正文 var(--ink) 或 var(--foreground) / 辅助文字 var(--ink-muted) 或 var(--muted-foreground) / 边框 var(--border) 或 var(--line) / 危险 var(--danger) / 成功 var(--success) / 警告 var(--warn) / 信息 var(--info)\n` +
        `   - Canvas/SVG/Chart 等无法用 CSS 变量的场景：调用 BobWork.request('getTheme') 获取 keyColors 对象，用 JS 读取色值后传给图表库\n` +
        `   - 深色判断：html[data-bob-dark="true"] 选择器可检测当前是否深色主题\n` +
        `3. 字体：正文 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Serif SC", serif；数字、金额、百分比一律 font-variant-numeric: tabular-nums（等宽对齐）；标题/正文/辅助三级字号（20px / 14px / 12px）\n` +
        `4. 交互：\n` +
        `   - 计算器类：实时计算（input 事件触发，不阻塞），不要求点击"提交"按钮\n` +
        `   - 按钮三态：hover 亮度 +10%（filter: brightness(1.1)）、active 缩放 0.98、focus 2px var(--primary) 半透明环（box-shadow: 0 0 0 2px var(--primary) / alpha 0.4）\n` +
        `   - 输入错误：边框改为 var(--danger) + 行内小字提示，禁止使用 alert() 弹窗\n` +
        `   - 空态：结果区域无数据时给灰色引导文案（如"输入金额后自动计算"），不要显示 NaN、undefined、0 等误导性占位\n` +
        `5. 重点突出：金额/结果数字 28-40px 字号 + 字重 700 + var(--primary)；对应标签弱化（12px / opacity 0.65）；表单控件合理 width: 100%，不要挤在窄容器里\n` +
        `如果用户明确要求其他配色/风格，以用户需求为准覆盖以上默认规范。`;
      return injectionText;
    }
    // 兜底：节点声明了 sandbox_app_id，但宿主读取 app 失败（目录缺失/损坏）。
    // 不能让 AI 在完全无上下文的情况下瞎找路径，给出探测指令。
    return (
      `\n\n=== AI Coding 编程任务上下文 ===\n` +
      `你正在为一个 Bob Sandbox 小程序进行 AI 编程开发，但宿主未能读取到该小程序的清单（appId: ${sandboxAppId}，应用数据目录 bob-sandbox/apps/ 下未找到 manifest.json 或文件损坏）。\n` +
      `请按以下步骤定位程序：\n` +
      `  1. 调用 list_directory("bob-sandbox/apps/") 列出所有小程序目录，检查是否存在 ${sandboxAppId}；\n` +
      `  2. 若存在：读取 bob-sandbox/apps/${sandboxAppId}/manifest.json 确认清单内容，再读取入口文件了解现状后继续修改；\n` +
      `  3. 若确实不存在或为空目录：向用户说明该小程序丢失（可能在清理/重置时被移除），询问是否新建同名小程序再继续。\n` +
      `任何情况下都不要在 bob-sandbox/apps/ 之外的位置凭空创建小程序文件。`
    );
  }
}

/** 全局单例：内容生成无实例状态，跨请求共享安全（对齐 K2-S2 sessionRuntime 单例风格）。 */
export const contextRuntime = new ContextRuntime();
