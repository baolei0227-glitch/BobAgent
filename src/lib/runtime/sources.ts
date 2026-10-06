// Butler 检索源注册表（2026-10-05）
// =====================================================================================
// 病根：管家「能看见哪些知识源」这件事，此前散落在四处硬编码——
//   ① tools/registry.ts 的 SCENED_TOOLS（工具 → 场景）
//   ② agents/official-packages.ts 的 fixedScenes（画像 → 场景）
//   ③ app/api/chat/route.ts 的运行时场景并集（补丁式放行）
//   ④ runtime/context.ts 的可见源清单文案（硬编码微信/飞书/本地授权目录三行）
// 后果：新增一个源要同时改四处且口径一致，必然漂移。真实缺口——模型**不知道**
// 「项目材料索引 / 项目账本 / 笔记 / 会议归档 / 本地文件」这些索引库存在，于是舍近求远
// 用 list_directory 慢慢翻，而 search_materials / read_ledger / read_notebook 从未被调用。
//
// 本文件把「一个源」变成唯一真源：可见性清单由它派生，能力边界（工具面）也以它为断言基准
// （见 sources.registry.test.ts 的漂移护栏）——新增源只改这一处登记。
//
// 边界：本文件是**纯数据 + 纯渲染函数**，不持有任何 IO。
//   - IO（微信桥 / 飞书桥 / 本地授权目录）全部留在 context.ts，预取后经 SourceStatus 传入；
//   - render 必须是纯同步函数（不得 await / 不得读盘），保证注册表可被测试直接遍历。
// =====================================================================================

import type { ToolScene } from '@/app/api/chat/tools';

/** 源类型：indexed = 宿主已建索引、可检索；external = 外部接入（桥 / 授权目录） */
export type SourceKind = 'indexed' | 'external';

/** context.ts 预取后传入的运行时状态；注册表只读，不反向触发任何取数 */
export interface SourceStatus {
  /** 是否有激活项目（决定项目级源是否展示） */
  hasProject: boolean;
  /** 本地授权目录（已 ~ 化；空数组 = 未授权任何目录） */
  authorizedRoots: string[];
  /** 微信桥状态；undefined = 桥模块不可用（降级省略该行） */
  wechat?: { running: boolean; bound: boolean };
  /** 飞书桥状态；undefined = 桥模块不可用（降级省略该行） */
  feishu?: { running: boolean; bound: boolean };
}

/** 一条源登记。新增源只在此数组追加一条即可（可见性文案 + 工具面护栏同时就位）。 */
export interface SourceEntry {
  /** 稳定 id，供测试与后续治理引用 */
  id: string;
  /** 展示名（人话） */
  label: string;
  kind: SourceKind;
  /** 可见所需场景；[] = 与场景无关（恒在候选，由 render/IO 决定是否展示） */
  scenes: ToolScene[];
  /** 该源的入口工具名（漂移护栏断言用：改名/被删会在此暴露悬空引用） */
  tools: string[];
  /** 场景放行但被画像 coreExclusions 剔除的工具（如管家的 delete_notebook） */
  excludedTools?: string[];
  /** 纯同步渲染；返回 null = 本次不展示该行 */
  render: (st: SourceStatus) => string | null;
}

/**
 * 桥状态 → 人话（微信 / 飞书共用口径）。
 *
 * 文案与改造前 context.ts 内联实现**逐字节一致**（含「未接入 → 引导去设置」的括注），
 * 故此处抽取不构成任何可观察变化。st 为 undefined（模块不可用）→ 返回 null（省略该行）。
 */
function bridgeLine(
  label: string,
  st: { running: boolean; bound: boolean } | undefined,
  hint: string,
): string | null {
  if (!st) return null;
  const state = st.running ? (st.bound ? '已绑定并运行中' : '运行中未绑定') : st.bound ? '已绑定未连接' : '未接入';
  return `- ${label}：${state}${st.bound ? '' : `（可引导用户去${hint}）`}`;
}

/**
 * 源登记表（唯一真源）。
 *
 * 排序即注入顺序：前三条（微信 / 飞书 / 本地授权目录）保持改造前的相对次序不变，
 * `butler-domain`（恒可见事务域）固定**最后**——与改造前「恒可见行落在清单末尾」一致。
 */
export const SOURCES: SourceEntry[] = [
  {
    id: 'wechat',
    label: '微信',
    kind: 'external',
    scenes: [],
    tools: [],
    render: (st) => bridgeLine('微信', st.wechat, '设置扫码绑定'),
  },
  {
    id: 'feishu',
    label: '飞书',
    kind: 'external',
    scenes: [],
    tools: [],
    render: (st) => bridgeLine('飞书', st.feishu, '设置填写凭证'),
  },
  {
    id: 'files',
    label: '本地授权目录',
    kind: 'indexed',
    scenes: [],
    tools: ['read_file', 'list_directory', 'search_files'],
    render: (st) =>
      st.authorizedRoots.length > 0 ? `- 本地授权目录：${st.authorizedRoots.join('、')}` : null,
  },
  {
    id: 'materials',
    label: '项目材料索引',
    kind: 'indexed',
    scenes: ['ledger'],
    tools: ['search_materials', 'read_attachment'],
    render: (st) =>
      st.hasProject
        ? '- 项目材料索引（materials/ 已建索引的正文，可全文检索）：用 search_materials 命中，再用 read_attachment 取原文 / 页码'
        : null,
  },
  {
    id: 'ledger',
    label: '项目账本',
    kind: 'indexed',
    scenes: ['ledger', 'ledger-keeper'],
    tools: ['read_ledger'],
    render: (st) => (st.hasProject ? '- 项目账本（结论 + 出处，先读它定位，再按路径取原文）：用 read_ledger' : null),
  },
  {
    id: 'notebook',
    label: '笔记库',
    kind: 'indexed',
    scenes: ['notebook'],
    tools: ['read_notebook', 'read_note'],
    excludedTools: ['delete_notebook'],
    render: () => '- 个人笔记库（索引优先，先看 index 再精读单条）：用 read_notebook，精读用 read_note',
  },
  {
    id: 'meeting',
    label: '会议归档',
    kind: 'indexed',
    // 会议归档是 Recorder 专属（刻意能力边界）：管家 effectiveScenes 不含 'meeting' → 本行不出现。
    // 日后若对管家开放，只需在 route 的 extraScenes 补一行，本行文案自动跟随。
    scenes: ['meeting'],
    tools: ['meeting_search', 'meeting_summarize'],
    render: () => '- 会议归档（跨会议检索转写 / 纪要正文）：用 meeting_search',
  },
  {
    id: 'butler-domain',
    label: '管家事务域',
    kind: 'indexed',
    // 工具（read_todo / query_schedule…）本就标 ['butler']：管家 fixedScenes 含 'butler' → 恒命中；
    // 而空场景集（降级路径）下不命中 → 整段可返回 ''，保住改造前的静默降级语义。
    scenes: ['butler'],
    tools: ['read_todo', 'query_schedule'],
    render: () => '- 恒可见：待办 / 日程 / 便签 / 计划树 / 项目（管家自有事务域）',
  },
];
