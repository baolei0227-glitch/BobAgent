'use client';

/**
 * TranscriptPanel —— 画布音频编辑器的**对话稿**面板。
 *
 * **主定位仍是"看稿 + 定位"的阅读面（2026-10-17 收敛）**：用户要的是"查看文字对话稿，点一下让播放头
 * 落到音轨对应位置"。所以这里的主要行为只有两件事：① 把稿子按**对话稿形式**读出来；② 点击跳转
 * （点某句 = 跳该句起点，点轮首 = 跳本轮开头）。
 * 逐行的"勾选 / `＋` 打点 / `✂` 截取"与顶部的 `Clip N` 批量截取**已移除**：那是操作、不是阅读。
 * 打点与截取仍在别处——音轨上拖选 + 选区按钮、`Split at marks`、
 * AI 精选（Suggested 页签里勾选后 `Mark` 落点 / `Export` 导出，见 AudioViewer 文件头那条链路的当前口径）。
 * 原本那个整稿动作 `Generate marks`（逐段铺点）**已删**（2026-10-18）：它机械铺点、与 Highlights 意图重叠，
 * 打点改由"精选选中的区间手动落点"承担（青色点，与手打的琥珀点区分）。
 *
 * **句子的文字可原地改**（错别字/人名/断句）。2026-10-21 起入口收敛成**正文常驻可编辑**：
 *   - **点击分工**：点**时间戳** = 跳转定位（不自动播放）；点**正文** = 光标落进去直接改，
 *     不跳播放头、也不需要先点铅笔（原文与润色稿共用 `InlineText`）；
 *   - **双击时间戳 = 改这一句的起点时间**（2026-10-21 新增；`mm:ss` 或纯秒数）：
 *     单击仍是跳转，双击才进编辑，避免每次定位都误触输入框。改动经由 `updateSegmentStart`
 *     一并重排上一段的 `end`（段时间始终首尾相接），打点/片段按绝对时间存、**不跟着挪**；
 *   - **专用调时间按钮**（2026-10-21 补）：时间戳右侧常驻一个半透明的时钟图标，点开同一条
 *     编辑入口（不改"单击 = 跳转"的手感）；保存成功后**直接把播放头定位到新时间**，让文稿与
 *     轨道上的位置当场对齐（只 seek，不改播放状态）。润色稿同样可调——轮起点落回该轮第一段
 *     原文的 `t`，服务端会把轮的 `start` 与上一段的 `end` 一起重排；
 *   - 改文字时只动 `text`，**不动** `t` / `end` / `speaker` —— 打点与片段一律按时间存，所以改字不会让
 *     已有的点/片段失位（`lib/audio/transcript.ts` 的 `updateSegmentText` 承接这条约束）；
 *   - 父级没接 `onUpdateSegment`（只读场景）时正文退回纯文本 —— 不摆一个点了没反应的输入框；
 *   - 提交只走一条路：`Enter` 保存 / `Shift+Enter` 换行 / `Esc` 取消 / 失焦保存；
 *   - 🔴 `Enter` 必须带 IME 守卫（`isComposing || keyCode === 229`）：中文输入法回车是"选词"，
 *     不挡就会在拼音上屏的一瞬间把半截文本提交掉；
 *   - 保存**失败时保留草稿**（下次失焦会重试）：绝不静默吞掉用户刚打的字；
 *   - 有输入框聚焦时**暂停自动跟随**（`typing`）：否则播放推进会在打字中途把这一行滚走。
 *
 * 关键交互口径：
 *   - **折叠态由父级给**（`defaultOpen`）：这一页签本身已由 `Transcript` 页签把门（父级只在
 *     `activeDetailTab === 'transcript'` 时渲染本组件），所以父级传 `defaultOpen` 直接展开，
 *     免得"进了页签还要再点一下"；折叠时只留一行 `▸ Transcript (42)`，占位与普通行等高。
 *   - 点**时间戳** = **只跳转定位，不自动播放**：
 *     播放/暂停状态原样保留 —— 原本暂停就停在跳转处，原本在播就从跳转处接着播。点正文不跳转（改为编辑）。
 *   - 播放高亮 + 自动跟随：只滚动**本面板内部**的列表（手算 `scrollTop`，不用 `scrollIntoView`
 *     —— 后者会连带滚动祖先滚动容器，而画布面板壳是 `overflow:hidden`，会莫名把内容顶走）。
 *   - **对话稿形式**：转写稿里真有 ≥2 位说话人时，连续同一位的段并成**一轮**，轮首给出说话人
 *     （带色）+ 本轮时间范围，点轮首跳到本轮开头；轮内逐句排列 ⇒ 读起来就是"谁在什么时候说了
 *     什么"。**只在多于 1 人时启用**：单人稿 / 无标签稿并轮，只会把每一行都套上一个标题（纯增噪），
 *     故那两种情况保持平铺原样。
 *   - 正文**不再截断**（原来是 2 行 `-webkit-line-clamp`）：既然这里是给人读的稿子，省略号会把
 *     要说的话藏起来，不如让它撑开、由列表滚动兜住。
 *
 * **2026-10-18 补：说话人能改**（分离经常把某几轮归错人，或只给出 `Speaker 1 / 2` 这种编号）。
 * 两件事、两条路径，互不干扰（各自乐观上屏、各自回滚）：
 *   - **改一轮归属**：轮首 hover 浮出小箭头 → **就地**展开一排人（稿子里出现过的簇 + `Unassigned`），
 *     点谁就把**这一轮**整轮改归谁。刻意**不按单句改**：分轮是"相邻同人"合并出来的，
 *     只改一句会让这一轮当场被拆开（见 `updateSegmentSpeakers` 的说明）；
 *   - **给某个说话人起名**：点轮首那个名字 → 就地变成输入框（与逐行改字同一套提交口径：
 *     `Enter` 保存 / `Esc` 取消 / 失焦保存 / 失败保留草稿）。名字存 sidecar 的 `speakerNames`，
 *     **只影响显示，绝不碰 `segments`**（`speakerLabel` 是显示名的单一真源）。
 * 归属选择刻意**就地展开**、不用浮层：列表自身 `overflow-y-auto`，浮层会被裁掉且跟着滚动漂移。
 * 入口只在**对话稿**（`turns`）路径的轮首：平铺路径那个 `1 / 2` 贴片是"第几位"的编号，
 * 不承载改名 —— 它落在整行 `<button>` 里，往里塞输入框是非法结构（同 renderRow 那条注释）。
 *   - **集中改名面板**（⋯ 菜单 → `Rename speakers`）：分离只给出 `Speaker 1 / 2 / 3` 时，
 *     逐个翻到轮首去点名字太费事。面板一次列出稿子里**出现过**的说话人（各带自己的颜色 +
 *     默认名 `Speaker N`），每行一个输入框，改完按 `Save` **一次性**提交（服务端 `rename_speakers`）。
 *     它渲染在列表**上方**、不参与列表滚动 ⇒ 打字时不会被自动跟随滚走，也不必暂停跟随。
 *
 * **2026-10-21 补：正文常驻可编辑，且润色稿同样能改**
 *   - **点击分工**：点**时间戳** = 跳播放头（不自动播放）；点**正文** = 光标落进去直接改，
 *     不跳播放头、也不需要先点铅笔（原文与润色稿共用 `InlineText`）。
 *   - **润色稿改文字**：写回 `polished.turns[index].text`（父级 `onUpdatePolishedTurn`）。
 *     润色轮与 `segments` 不是一一对应（多句并一轮），所以**不回写原文**；切回 `View original`
 *     仍是 ASR 原文，导出 raw 也不受影响。
 *   - **改名 / 改归属**：轮首复用原文对话稿那两套入口（`speakerNames` 与 `assign_speaker`）。
 *     改归属时按时间重叠把这轮覆盖的段下标交给父级，服务端再按 `start` 刷新润色稿的标注。
 *
 * **2026-10-21 补：插入对话**
 *   - 每行 hover 浮出 `+`（或正文里 `Ctrl/Cmd+Enter`）= 在**当前行下面**挂一条空草稿；
 *     说话人**复制上一行**，时间默认取**当前播放头**（夹在"本行起点 ~ 下一行起点"内），
 *     落盘后**上一行的 `end` 自动收到新行起点**（服务端统一处理，两个视图一致）。
 *     不猜、也不改其他任何已有段的时间。
 *   - **时间不钩稽上一行**：插入行没有独立音频区间，可用行尾的时钟按钮调到音频内任意位置；
 *     改完按时间**自动归位**（段序/正文/润色轮一起重排），播放头同时 seek 到新时间；
 *     插入时截出来的那条边（上一行的 `end`）会**一直跟着插入行起点走**，跳到别的行后面则不再跟。
 *   - 草稿先只在本地：空文本在 sidecar 里会被丢弃，所以写下非空文字并离开输入框才落盘
 *     （`onInsertSegment` / `onInsertPolishedTurn`）；没写字就离开 = 放弃这条草稿。
 *   - 两个视图都支持；服务端两个纯函数会**双向同步**原文与润色稿 ⇒ 切视图不会少一行。
 *   - 每行 hover 还浮出 `Trash2` = 删掉这一行；对侧"时间+文字全等"的一行由服务端一并删掉
 *     （插入的逆操作）。文案不同的润色轮（LLM 改写）不动，且至少保留一句原文。
 *   - 润色视图的插入轮按**精确配对**找自己的插入段（不能按 `start` 对账：同起点的上一轮会抢先命中）。
 *
 * **2026-10-22 补：行级 AI 润色（人与 AI 协作，Word 式修订）**
 *   - 每行常驻半透明的 `✦`：只把**这一行此刻的文字**（含还没落盘的草稿）交给模型润色，不动时间轴、
 *     不动其他行；结果先以**修订对照**呈现（删除带删除线、新增高亮），`Accept` 才落盘、
 *     `Discard`（或 `Esc`）原样退回 —— 正文没有撤销栈，AI 的修改必须先让人看见。
 *   - 按钮 `onMouseDown` 阻止抢焦点：否则点按钮会先让正文失焦落盘，再拿去润的是旧文本。
 *   - 整份润色仍是 `⋯ → Polish`（`onPolish`）；两者互不影响。
 *
 * 字号口径（与 AudioViewer / AudioMarkTrack 同一套，见那两份文件头）：
 *   L1 操作（`✦ Highlights` / `Polish`）= `text-12 font-medium`；
 *   读数/计数/轮首 = `text-10`；正文 = `text-xs`（自带行高）。
 */
import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Clock3, FileText, Loader2, MoreHorizontal, Plus, RefreshCw, Scissors, Sparkles, Trash2, Users } from 'lucide-react';
import type { AudioTranscript, PolishedTurn } from '@/lib/audio/transcript';
import { activeSegmentIndex, findInsertedSegmentIndex, isInsertedSegment, normalizeSpeakerName, parseTimecode, speakerLabel } from '@/lib/audio/transcript';
import { diffText, type DiffOp } from '@/lib/audio/text-diff';

/**
 * 一次导出多条区间的形状（服务端 `action:'clip_many'` 的入参）。
 * 本面板**不再产出**它，类型留在原处是因为父级 `clipMany`（`Split at marks` 与 AI 精选）仍按它收参数。
 */
export interface ClipRequest {
  start: number;
  end: number;
  name: string;
}

/** 说话人色板（与会议回放同一套思路：中明度，深色底上也能读清）。
 *  刻意**不跨文件共用**：那是 Butler 侧的渲染，两边主题各自演化，耦合色板得不偿失。 */
const SPEAKER_COLORS = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6', '#6366f1'];

/** `mm:ss`（时间戳与轮首时间范围共用一套写法） */
const mmss = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/**
 * **选区高亮**底色：落在波形选区内的句子用它。
 *
 * 与"正在播放"那档（`--primary-soft`）**刻意分开**：播放高亮表达"当前读到这里"，
 * 选区高亮表达"你圈定的范围"，两者语义不同、可同时命中同一行（此时底色随播放档，左侧竖条仍标出选区）。
 */
const SEL_HL_BG = 'color-mix(in oklab, var(--primary-strong) 12%, transparent)';

export interface TranscriptPanelProps {
  transcript: AudioTranscript;
  /** 当前播放时刻（父级把 AudioMarkTrack 的 onTimeUpdate 转过来） */
  time: number;
  /**
   * 波形**选区**（绝对秒；父级把 AudioMarkTrack 的 `onSelectionChange` 转过来）。
   * 与它时间上**有交叠**的句子会被高亮；`null` / 不传 = 不高亮。
   */
  highlightRange?: { start: number; end: number } | null;
  /** 父级正在跑重活（转写 / 导出 / 模型）⇒ 动作置灰 */
  busy?: boolean;
  /** 点某句 / 点轮首：跳到该处起点（**不改播放/暂停状态**：暂停则停在跳转处，播放中则从跳转处接着播） */
  onSeek: (t: number) => void;
  /** AI 精选入口；不传则不显示（没接模型时不摆一个点了没反应的按钮） */
  onHighlights?: () => void;
  /**
   * “没有说话人标签”时的一键重试（强制两位重新分离）。不传则只提示、不给按钮。
   * 只在**确实请求过分离**（`transcript.diarize` 或引擎抬头里的“未分说话人/按说话人分块”）
   * 且所有段 `speaker === null` 时出现 —— 不把真正的单人录音也判成失败。
   */
  onRetrySpeakers?: () => void;
  /** DeepSeek 润色后的对话轮（null/空 = 还没润色）；只改 text，时间/说话人沿用原轮 */
  polished?: PolishedTurn[] | null;
  /** 触发润色；不传则不显示 Polish 按钮 */
  onPolish?: () => void;
  /** 正在润色（按钮转圈/置灰） */
  polishing?: boolean;
  /** 润色进度（第 done 批 / 共 total 批）；不可点击 ⇒ text-10 */
  polishProgress?: { done: number; total: number } | null;
  /** 有稿子后的"再转一次"（半截稿续跑 / 完整稿重来）；不传则菜单里不出现 */
  onRetranscribe?: () => void;
  /** 只转当前选区；不传则菜单里不出现 */
  onTranscribeSelection?: () => void;
  /** 当前是否有波形选区（决定"Transcribe selection"是否可点） */
  hasSelection?: boolean;
  /** 正在转写（菜单项显示 Transcribing… 并置灰） */
  transcribing?: boolean;
  /** 把当前视图（raw / polished）导出为 Markdown 并打开阅读器 */
  onOpenMarkdown?: (variant: 'raw' | 'polished') => void;
  /**
   * 原地改一句的文字（只改文案，时间轴不动）。
   *
   * 正文常驻可编辑（点正文即可改，无需进入编辑态）；返回 `false` = 落盘失败（父级负责弹错误条）
   * ⇒ 本组件**保留草稿**（下次失焦会重试）。
   * 不传则正文退回纯文本（只读场景，例如会议回放那份复用）。
   */
  onUpdateSegment?: (index: number, text: string) => Promise<boolean>;
  /**
   * 原地改一句的**起点时间**（秒）。双击时间戳进入编辑，`mm:ss` 或纯秒数均可。
   *
   * 返回 `false` = 落盘失败（父级负责弹错误条）⇒ 本组件还原成原时间。
   * 不传则时间戳只保留"点击跳转"（只读场景）。
   */
  onUpdateSegmentTime?: (index: number, t: number) => Promise<boolean>;
  /**
   * 原地改**润色稿里的一轮**文字（`view=polished` 时）。入参是润色轮的**下标**，不是段下标：
   * 润色轮与 `segments` 不是一一对应，父级会单独把它写回 sidecar 的 `polished.turns`。
   *
   * 返回口径与 `onUpdateSegment` 相同（`false` = 落盘失败 ⇒ 保留草稿）。
   * 不传则润色稿正文退回纯文本（只读场景）。
   */
  onUpdatePolishedTurn?: (index: number, text: string) => Promise<boolean>;
  /**
   * 在原文稿第 `afterIndex` 行**下面**插一行（时间由界面复制上一行后传入）。
   * 父级负责落盘；`false` = 失败 ⇒ 本组件保留草稿行，让用户重试。
   * 不传则不提供插入入口（只读场景）。
   */
  onInsertSegment?: (afterIndex: number, line: { t: number; end: number; speaker: number | null; text: string }) => Promise<boolean>;
  /** 在润色稿第 `afterIndex` 轮下面插一轮；契约与 `onInsertSegment` 相同（`t` 用 `start` 口径传入） */
  onInsertPolishedTurn?: (afterIndex: number, line: { t: number; end: number; speaker: number | null; text: string }) => Promise<boolean>;
  /**
   * 删掉原文稿第 `index` 句（插入的逆操作）。
   *
   * 不传则不提供删除入口（只读场景）。服务端会**拒绝删到 0 段**（空稿 sidecar 会整份失效）。
   */
  onDeleteSegment?: (index: number) => Promise<boolean>;
  /** 删掉润色稿第 `index` 轮；契约与 `onDeleteSegment` 相同 */
  onDeletePolishedTurn?: (index: number) => Promise<boolean>;
  /**
   * **行级 AI 润色**：把这一行**此刻的文字**（含用户还没落盘的改动）交给模型润色，返回新文本。
   *
   * 只润这一行，不动时间轴、不动其他行；返回 `null` = 失败或没有变化（本组件不报错，父级负责弹提示）。
   * 结果**不直接写进正文**：本组件先以**修订对照**呈现（删除线 + 高亮），Accept 才落盘、
   * Discard（或 Esc）原样退回 —— AI 的修改必须先让人看见。
   * 不传则不渲染每行的 `✦` 入口（只读场景）。
   */
  onPolishText?: (text: string) => Promise<string | null>;
  /**
   * 改**一轮**的说话人归属（`indexes` = 这一轮的段下标；`speaker === null` = 未归属）。
   *
   * 入参刻意是**一批下标**：界面上的最小操作单位是"一轮"，只改单句会让这一轮被分轮逻辑拆开。
   * 返回 `false` = 落盘失败（父级负责弹错误条）⇒ 本组件**保留展开的选择面板**，让用户重试或改选。
   * 不传则不渲染归属入口（只读场景，例如会议回放那份复用）。
   */
  onUpdateSpeaker?: (indexes: number[], speaker: number | null) => Promise<boolean>;
  /**
   * 给**一个说话人**起显示名（去空白后为空 = 恢复默认 `Speaker N`）。
   *
   * 返回 `false` = 落盘失败 ⇒ 本组件**保留编辑态与草稿**并把焦点送回输入框。
   * 不传则不渲染改名入口（只读场景）。
   */
  onRenameSpeaker?: (id: number, name: string) => Promise<boolean>;
  /**
   * **批量**改说话人显示名（⋯ 菜单里那个"列出所有人 → 统一保存"的面板）。
   *
   * 为什么不是复用 `onRenameSpeaker` 让本组件循环调 N 次：那样会写 N 次盘、弹 N 条提示，
   * 失败还留下"一半改了一半没改"的中间态 —— 而这里是**一次动作**。
   * 入参是"当前列表里所有人的名字"（含没变的；父级按同一份 `normalizeSpeakerName` 自己筛）。
   * 返回 `false` = 落盘失败 ⇒ 本组件**保留面板与所有草稿**，用户可直接重试。
   * 不传则不渲染这个入口（只读场景）。
   */
  onRenameSpeakers?: (entries: Array<{ id: number; name: string }>) => Promise<boolean>;
  /** 是否默认展开：父级在 `Transcript` 页签内渲染时应传 true */
  defaultOpen?: boolean;
  /** 大屏（Hippo 全页）：面板填满右侧列，列表高度跟随视口 */
  wide?: boolean;
}

/** `InlineText` 的对外句柄：行级 AI 润色要读到"用户正在改的草稿"（已落盘的 `value` 可能落后） */
type InlineTextHandle = {
  /** 输入框里此刻的文字（含还没落盘的改动） */
  draft: () => string;
};

interface InlineTextProps {
  value: string;
  readOnly?: boolean;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCommit: (text: string) => Promise<boolean>;
  onFocusChange?: (focused: boolean) => void;
  /** 没写任何字就离开（新插入的空行）⇒ 让父级把它丢掉，别留一条空对话 */
  onEmptyBlur?: () => void;
  /** `Ctrl/Cmd + Enter`：在当前行下面再插一行（由父级建草稿行并聚焦） */
  onInsertBelow?: () => void;
}

/**
 * 正文的**就地编辑区**（原文的句子 / 润色稿的一轮共用）。
 *
 * 2026-10-21 起正文**本身就是输入框**：点正文 = 光标落进去直接改，不再有"铅笔 → 编辑态"这一步；
 * 点正文**不**再把播放头带走（转跳只留给轮首 / 句首的时间戳）。
 *
 * 为什么用 `textarea` 而不是 `contentEditable`：
 *   - 值由 React 受控（`draft`）⇒ 外部真源（重新转写 / 润色 / 服务端归一）变了能可靠同步；
 *   - 中文输入法的 composition、粘贴纯文本、多行换行全走浏览器原生行为，不用自己拼 HTML。
 *
 * 退出方式（与原编辑态口径一致）：
 *   - Enter（不带 Shift）保存并失焦；Shift+Enter 换行（一句里确实可能有停顿）；
 *   - Esc 还原成原值并失焦（**不**写盘）；
 *   - 失焦保存；空文本 / 无变化 ⇒ 还原（不把句子抹掉：时间轴上会留洞）。
 * 保存失败：父级弹错误条，这里**保留用户刚打的字**（下次失焦会重试），绝不静默吞输入。
 */
const InlineText = forwardRef<InlineTextHandle, InlineTextProps>(function InlineText({
  value,
  readOnly = false,
  label,
  placeholder,
  autoFocus,
  onCommit,
  onFocusChange,
  onEmptyBlur,
  onInsertBelow,
}: InlineTextProps, handle) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 行级 AI 润色：按钮要拿**正在改的草稿**（已落盘的 `value` 可能落后）去做对照，
  // 结果以"修订预览"呈现（见 `aiEdit`），不直接写进正文。
  useImperativeHandle(
    handle,
    () => ({
      draft: () => draft,
    }),
    [draft],
  );

  // 真源变了才同步；正在打字时**不**动用户手里的草稿（否则跟播/他处保存会把光标内容冲掉）
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  /** 高度自适应：`rows={1}` 起步，按内容撑开（上限 240px，超过内部滚动） */
  const fit = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  useEffect(() => {
    fit(ref.current);
  }, [draft, fit]);

  /** 稳定的 ref 回调：内联回调会在每次父级重渲染（跟播每帧）时重挂，重算高度会很贵 */
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      fit(el);
    },
    [fit],
  );

  return (
    <textarea
      ref={setRef}
      rows={1}
      value={draft}
      readOnly={readOnly}
      autoFocus={autoFocus}
      placeholder={placeholder}
      spellCheck={false}
      aria-label={label}
      title="Click to edit · Enter to save · Shift+Enter for a new line · Esc to revert"
      onChange={(e) => {
        setDraft(e.target.value);
        fit(e.currentTarget);
      }}
      onFocus={() => {
        focusedRef.current = true;
        onFocusChange?.(true);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        onFocusChange?.(false);
        const next = e.currentTarget.value.trim();
        // 空文本 / 无变化：还原，不提交（与 `updateSegmentText` 的拒绝口径同源）
        if (!next || next === value) {
          setDraft(value);
          // 新插入的空行：离开就算放弃（空文本在 sidecar 里本来就会被丢弃）
          if (!next) onEmptyBlur?.();
          return;
        }
        void onCommit(next).then(() => {
          // 成功与否都把 trim 后的值留在输入框：失败时用户可继续改、再次失焦即重试
          setDraft(next);
        });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          // 先把 DOM 还原再 blur：否则 blur 读到的还是刚敲的字，会误提交
          e.currentTarget.value = value;
          setDraft(value);
          e.currentTarget.blur();
          return;
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          // Ctrl/Cmd+Enter = 在**本行下面**再插一行（Enter 本身仍是保存，见下）
          onInsertBelow?.();
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          // 🔴 IME 守卫：中文输入法回车是"选词上屏"，不挡会提交半截文本
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          e.currentTarget.blur(); // 真正落盘走 onBlur 那条唯一路径
        }
      }}
      // 不写 `flex-1`：润色稿的容器是 flex-col，`flex: 1 1 0%` 会把高度压成 0；`w-full` + `min-w-0`
      // 在原文的 flex-row 里已能正确让位给时间戳。
      className="w-full min-w-0 resize-none bg-transparent px-0.5 py-0 text-xs outline-none"
      style={{
        color: 'var(--ink)',
        // textarea 的 UA 样式是等宽字体 + 自带行高 ⇒ 必须显式对齐正文的字体与行高，否则一点击正文就跳一行
        fontFamily: 'inherit',
        lineHeight: '1rem',
        maxHeight: 240,
        overflowY: 'auto',
      }}
    />
  );
});

/** 时间编辑框的初值：整秒写 `mm:ss`，带十分位则保留一位（不静默抹掉精度） */
function timeEditText(value: number): string {
  return Number.isInteger(value)
    ? mmss(value)
    : `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * 时间戳的**就地编辑**（双击进入；单击仍是跳转）。
 *
 * 为什么单击不直接编辑：时间戳的第一职能是**定位**（读稿时点一下就跳到那句），
 * 把编辑塞进单击会让每次定位都变成误触编辑框。双击是浏览器原生的第二动作，不占用手感。
 * 2026-10-21 补：行尾另给了**专用时钟按钮**（`request` 递增即打开编辑），
 * 双击保留为快捷方式 —— 按钮负责"可发现"，双击负责"顺手"。
 *
 * 入参写 `mm:ss` 或纯秒数都行（`parseTimecode` 统一解析）；非法输入 / 无变化 ⇒ 静默还原，
 * 落盘失败由父级弹错误条，这里只保证显示回到真值。
 */
function InlineTime({
  value,
  onSeek,
  onCommit,
  disabled,
  active,
  label,
  request = 0,
  suffix,
}: {
  value: number;
  onSeek: () => void;
  onCommit?: (t: number) => Promise<boolean>;
  disabled?: boolean;
  active?: boolean;
  label: string;
  /** 外部"打开编辑"信号：每次递增打开一次（行尾时钟按钮用；0 = 从不） */
  request?: number;
  /** 显示时的后缀（润色稿用来把 `起点–终点` 画成一行；编辑时只改起点） */
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLInputElement | null>(null);
  const lastRequest = useRef(0);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  // 专用按钮的请求：递增即进入编辑（与双击同一条路径，初值同样取精确值）
  useEffect(() => {
    if (!request || request === lastRequest.current || !onCommit || disabled) return;
    lastRequest.current = request;
    setDraft(timeEditText(value));
    setEditing(true);
  }, [request, onCommit, disabled, value]);

  /** 编辑框初值：整秒写 `mm:ss`，带十分位则保留一位（不静默抹掉精度） */
  const exact = timeEditText(value);

  const commit = (text: string) => {
    setEditing(false);
    const parsed = parseTimecode(text);
    // 非法 / 无变化：还原（不写盘，也不弹错 —— 格式已写在 title 里）
    if (parsed === null || parsed === value) return;
    void onCommit?.(parsed);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
            return;
          }
          if (e.key === 'Enter') {
            // IME 守卫：中文输入法回车是"选词上屏"，不挡会提交半截输入
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="w-[3.4rem] shrink-0 rounded border bg-transparent px-0.5 font-mono text-10 outline-none"
        style={{ color: 'var(--primary-strong)', borderColor: 'var(--primary-strong)' }}
        aria-label={label}
        title="mm:ss or seconds · Enter to save · Esc to cancel"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onSeek}
      onDoubleClick={
        onCommit && !disabled
          ? () => {
              setDraft(exact);
              setEditing(true);
            }
          : undefined
      }
      title={
        onCommit
          ? `Jump to ${mmss(value)} · Double-click to edit start time`
          : `Jump to ${mmss(value)}`
      }
      className="shrink-0 rounded px-0.5 text-left transition-colors hover:bg-[var(--paper)]"
    >
      <span className="font-mono text-10" style={{ color: active ? 'var(--primary-strong)' : 'var(--ink-muted)' }}>
        {mmss(value)}
        {suffix}
      </span>
    </button>
  );
}

/**
 * 行级 AI 润色的**修订预览**（Word 式对照）：删掉的字带删除线、新增的字高亮，不直接改正文。
 *
 * 为什么要这一步：正文没有撤销栈，AI 的修改必须**先让人看见**再决定 —— `Accept` 才落盘、
 * `Discard`（或 Esc）原样退回。对照本身由 `diffText` 给出（按字符，见那边的头注释）。
 */
function AiEditPreview({
  ops,
  busy,
  onAccept,
  onDiscard,
}: {
  ops: DiffOp[];
  busy?: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      // 与 `InlineText` 同一条尺寸口径：`w-full` + `min-w-0`（不写 `flex-1`，
      // 润色稿的容器是 flex-col，`flex: 1 1 0%` 会把高度压成 0）
      className="w-full min-w-0 rounded border px-1 py-0.5"
      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--surface-muted)' }}
    >
      <p className="whitespace-pre-wrap text-xs" style={{ color: 'var(--ink)' }}>
        {ops.map((op, k) =>
          op.type === 'same' ? (
            <span key={k}>{op.text}</span>
          ) : op.type === 'del' ? (
            <del
              key={k}
              style={{ color: 'var(--ink-muted)', textDecoration: 'line-through' }}
              title="Removed by AI"
            >
              {op.text}
            </del>
          ) : (
            <ins
              key={k}
              style={{
                color: 'var(--primary-strong)',
                backgroundColor: 'var(--primary-soft)',
                textDecoration: 'none',
              }}
              title="Added by AI"
            >
              {op.text}
            </ins>
          ),
        )}
      </p>
      {/* 操作条：Accept = 落盘（父级负责失败提示）；Discard = 原样退回，不写任何东西 */}
      <div className="mt-0.5 flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
        <span>AI suggestion</span>
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          className="rounded px-1 font-medium transition-colors hover:bg-[var(--paper)] disabled:cursor-not-allowed"
          style={{ color: 'var(--primary-strong)' }}
        >
          Accept
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="rounded px-1 transition-colors hover:bg-[var(--paper)] disabled:cursor-not-allowed"
          style={{ color: 'var(--ink-muted)' }}
        >
          Discard
        </button>
        <span>· Esc to discard</span>
      </div>
    </div>
  );
}

export function TranscriptPanel({
  transcript,
  time,
  highlightRange,
  busy,
  onSeek,
  onHighlights,
  onRetrySpeakers,
  polished,
  onPolish,
  polishing,
  polishProgress,
  onRetranscribe,
  onTranscribeSelection,
  hasSelection,
  transcribing,
  onOpenMarkdown,
  onUpdateSegment,
  onUpdateSegmentTime,
  onUpdatePolishedTurn,
  onInsertSegment,
  onInsertPolishedTurn,
  onDeleteSegment,
  onDeletePolishedTurn,
  onPolishText,
  onUpdateSpeaker,
  onRenameSpeaker,
  onRenameSpeakers,
  defaultOpen = false,
  wide = false,
}: TranscriptPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  /** raw = 逐句原文；polished = DeepSeek 整理后的对话轮（有润色结果才出现切换） */
  const [view, setView] = useState<'raw' | 'polished'>('raw');
  /** 是否跟随播放自动滚动（用户自己一滚就解除，点某一行 = 重新接上） */
  const [pinned, setPinned] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  /**
   * 润色稿一行一轮：跟播下标按"轮"走，和原文的"句"不是同一套（见 `followIndex`）。
   * 容器类型用 `HTMLElement`：润色轮现在里面嵌了输入框与按钮，不再是 `<button>`。
   */
  const turnRefs = useRef<Array<HTMLElement | null>>([]);
  /** 低频动作（打点/精选/润色/原文）收进 ⋯，头部只留"标题 + 菜单" */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  /**
   * 是否正有正文输入框在编辑（`InlineText` 聚焦时置位）。
   *
   * 正文常驻可编辑 ⇒ 没有"编辑态"可判，只能靠焦点。作用只有一个：**暂停自动跟随**，
   * 否则播放继续推进会把正在打字的这一行滚出视口。
   */
  const [typing, setTyping] = useState(false);
  /**
   * 每行正文输入框的句柄（`raw-3` / `pol-2`）：行级 `✦` 要读**正在编辑的草稿**
   * （已落盘的 `value` 可能落后于用户手里的字），拿去做修订对照。
   */
  const textApis = useRef(new Map<string, InlineTextHandle>());
  /** 正在做行级 AI 润色的行（同一时间只跑一行，避免连点打爆模型调用） */
  const [polishingRow, setPolishingRow] = useState<string | null>(null);
  /**
   * 行级 AI 润色的**修订预览**（同一时间最多一条）：AI 结果先不写正文，等用户 Accept / Discard。
   * `after` 是接受时要落盘的文本，`ops` 只负责对照渲染。
   */
  const [aiEdit, setAiEdit] = useState<{ key: string; after: string; ops: DiffOp[] } | null>(null);
  /**
   * 新插入的对话行（**草稿**，同一时刻最多一条）：先只在本地挂着，等用户写下非空文字才落盘。
   *
   * 为什么不直接写一条空行：sidecar 的校验会丢弃空文本段（`parseTranscriptSidecar`）
   * 与空润色轮（`isTranscriptTurn`）⇒ 先写空行会在下次重载时静默消失。
   * 时间默认取**当前播放头**（用户要求；夹在插入窗口内），之后可用行尾时钟按钮微调；
   * 落盘时只把**上一行的 `end`** 收到新行起点，其余段不动。
   */
  const [draft, setDraft] = useState<{
    key: number;
    kind: 'raw' | 'polished';
    after: number;
    speaker: number | null;
    t: number;
    end: number;
  } | null>(null);
  const draftSeq = useRef(0);
  /**
   * "调时间"专用按钮的请求信号（`{ key, index }`；key 每次递增）。
   *
   * 为什么用信号而不是把 `editing` 提到面板：`InlineTime` 自己拿着编辑态（输入框聚焦/草稿都在它内部），
   * 外部只需要"敲一下门"。双击走同一扇门（直接改它自己的 state），按钮只是换了个更可发现的入口。
   */
  const [timeEdit, setTimeEdit] = useState<{ key: number; index: number; view: 'raw' | 'polished' } | null>(null);
  const timeEditSeq = useRef(0);
  const beginTimeEdit = useCallback((view: 'raw' | 'polished', index: number) => {
    setTimeEdit({ key: ++timeEditSeq.current, index, view });
  }, []);
  /**
   * 润色轮 → 它覆盖的**第一段原文**下标（调轮起点时落回这一段的 `t`）。
   *
   * 润色轮的时间只是它覆盖段的边界：改"轮起点"实质是改第一段的起点，服务端
   * `updateSegmentStart` 会一并把该轮的 `start` 与上一段的 `end` 重排，两边仍然对齐。
   * 插入轮**精确配对**它自己的插入段（同起点时会认到上一轮）；普通轮先按"起点恰好相等"认、
   * 跳过插入行，退化时取区间内第一段；找不到 = 不可调。
   */
  const firstSegmentOfTurn = useCallback(
    (turn: PolishedTurn): number => {
      const segs = transcript.segments;
      // 插入轮与插入段同源：按 start 对账会认到**同起点的上一轮**，必须精确配对
      if (turn.inserted === true) return findInsertedSegmentIndex(segs, turn);
      let exact = -1;
      let first = -1;
      segs.forEach((s, si) => {
        if (isInsertedSegment(segs, si)) return;
        if (exact < 0 && s.t === turn.start) exact = si;
        if (
          first < 0 &&
          s.t >= turn.start &&
          (turn.end > turn.start ? s.t < turn.end : s.t === turn.start)
        ) {
          first = si;
        }
      });
      return exact >= 0 ? exact : first;
    },
    [transcript.segments],
  );
  // 润色结果一出现就切过去；用户手动切回 Raw 后不会被强行拉回（polished 引用没变）
  useEffect(() => {
    if (polished && polished.length > 0) setView('polished');
    else setView('raw');
  }, [polished]);
  /** 正在改名的说话人（`draft` 受控，提交前不进父级 state） */
  const [renaming, setRenaming] = useState<{ id: number; draft: string } | null>(null);
  /** 正在改归属的那一轮（`turns` 的下标）；同一时刻最多一轮展开 */
  const [picking, setPick] = useState<number | null>(null);
  /** 正在改归属的**润色轮**（`polished` 的下标）；与 `picking` 各自独立，两套视图不并存 */
  const [pickingPolished, setPickPolished] = useState<number | null>(null);
  /** 说话人改名/改归属落盘中：禁用重复点击 + 就地显示 `Saving…` */
  const [spkSaving, setSpkSaving] = useState(false);
  const renameRef = useRef<HTMLInputElement | null>(null);
  /** 挡住 Enter 与 blur 的双重提交 */
  const spkSubmitRef = useRef(false);
  /**
   * 集中改名面板是否展开（⋯ 菜单 → `Rename speakers`）。
   * 它渲染在**列表上方**，不参与列表滚动（列表才是 `overflow-y-auto` 的那个），
   * 所以打字期间不必像逐行编辑那样暂停自动跟随。
   */
  const [namesOpen, setNamesOpen] = useState(false);
  /**
   * 集中改名的草稿（`id → 输入框里的字`，全量受控：打开时按当前名字铺满所有行）。
   * 全量而不是"只记改过的"：保存要一次交齐所有人，`''` 与"没这一项"必须分得清
   *（`''` = 恢复默认名，没有这一项 = 这一行还没建过）。
   */
  const [nameDrafts, setNameDrafts] = useState<Record<number, string>>({});

  const segments = transcript.segments;
  const active = activeSegmentIndex(segments, time);
  /**
   * 跟播目标行的下标：原文按**句**（`active`）、润色稿按**轮**。
   * 润色稿的行高/条数都与原文不同，所以自动跟随必须两套下标各认各的 ——
   * 之前只有原文行挂了 ref，切到润色稿后跟随就整个失效了。
   */
  const followIndex = useMemo(() => {
    if (view !== 'polished' || !polished || polished.length === 0) return active;
    return polished.findIndex((t) => time >= t.start && time < t.end);
  }, [view, polished, time, active]);
  /** 取跟播目标行的 DOM。润色稿视图下原文那批行已经不在文档里，只能另取 */
  const followRow = useCallback(
    () =>
      followIndex < 0
        ? null
        : ((view === 'polished' ? turnRefs.current[followIndex] : rowRefs.current[followIndex]) ?? null),
    [followIndex, view],
  );
  /** 说话人显示名映射（只影响显示；`Speaker N` 是缺省名，见 `speakerLabel`） */
  const names = transcript.speakerNames;
  const hasSpeaker = useMemo(() => segments.some((s) => s.speaker !== null), [segments]);
  const multiSpeaker = useMemo(() => new Set(segments.map((s) => s.speaker).filter((s) => s !== null)).size >= 2, [segments]);
  /**
   * 这次转写是否**请求过**说话人分离。新 sidecar 直接读 `diarize`；
   * 老 sidecar 没有该字段，就从引擎抬头里的「未分说话人 / 按说话人分块」推断。
   */
  const diarizeRequested = useMemo(
    () =>
      transcript.diarize === 'auto' ||
      transcript.diarize === 'duo' ||
      transcript.diarize === 'group' ||
      /未分说话人|按说话人分块/.test(transcript.engine || ''),
    [transcript.diarize, transcript.engine],
  );
  /** 要了分离，却一段标签都没有 ⇒ 值得显式告诉用户（旧实现把这条信息截在 engine 的第一段里，等于隐藏） */
  const noSpeakerLabels = diarizeRequested && !hasSpeaker;

  /**
   * 对话稿的**轮次**：连续同一位说话人的段并成一轮。`null` = 不做对话稿（平铺原样）。
   * 只在 `multiSpeaker` 时建（见文件头"对话稿形式"）。
   */
  const turns = useMemo(() => {
    if (!multiSpeaker) return null;
    const out: Array<{ speaker: number | null; items: number[] }> = [];
    // 手工插入行自成一轮（见 `TranscriptSegment.inserted`）：否则轮首改归属会连带改掉整轮
    let prevInserted = false;
    for (let i = 0; i < segments.length; i++) {
      const sp = segments[i].speaker;
      const inserted = isInsertedSegment(segments, i);
      const last = out[out.length - 1];
      // `speaker === null`（这段没归到人）自成一"轮"：并进上一位等于替那个人瞎认
      if (last && !prevInserted && !inserted && sp !== null && last.speaker === sp) last.items.push(i);
      else out.push({ speaker: sp, items: [i] });
      prevInserted = inserted;
    }
    return out;
  }, [segments, multiSpeaker]);

  /** 区间终点钳到已知总时长：ffprobe 与播放器对同一文件的时长读数会差几十毫秒，
   *  不钳的话轮首的时间范围可能比音频还长（那里的容差见 transcript.ts）。 */
  const clampEnd = useCallback(
    (end: number) => (transcript.durationSec && transcript.durationSec > 0 ? Math.min(end, transcript.durationSec) : end),
    [transcript.durationSec],
  );

  /**
   * 稿子里**出现过的**说话人（升序）：改归属的候选。
   * 只列真实存在的簇 —— 摆一个没人说过的 `Speaker 5` 只会让用户把一段话归给幽灵。
   * `Unassigned` 不在这个数组里（它是"没有簇号"这一档，由渲染处补上）。
   */
  const speakerIds = useMemo(
    () =>
      [...new Set(segments.map((s) => s.speaker).filter((n): n is number => n !== null))].sort(
        (a, b) => a - b,
      ),
    [segments],
  );

  /**
   * 提交一次改名（与逐行改字的 `commit` 同口径：失败**保留草稿**，成功才退出编辑态）。
   * 改名作用于**整个人**（所有同 id 的轮首一起变），不是"这一轮的名字"。
   */
  const commitRename = useCallback(
    async (id: number, name: string) => {
      if (!onRenameSpeaker || spkSubmitRef.current) return;
      spkSubmitRef.current = true;
      setSpkSaving(true);
      const ok = await onRenameSpeaker(id, name);
      setSpkSaving(false);
      spkSubmitRef.current = false;
      if (ok) setRenaming(null);
      // 失败不退出编辑态：`renameRef` 里的草稿还在，父级已弹错误条说明原因
      else renameRef.current?.focus();
    },
    [onRenameSpeaker],
  );

  /**
   * 把某一轮整轮改归某个说话人。
   *
   * **点下去就先收起**（乐观：点完立刻有反馈，且不必担心父级乐观上屏后分轮重组、
   * 选择面板还挂在一个已经变了的轮下标上）；落盘失败才重新展开这一轮 ——
   * 那时父级已把归属回滚、分组回到原样，`ti` 指的仍是原来那一轮，用户可以改选另一个。
   */
  const pickSpeaker = useCallback(
    async (ti: number, speaker: number | null) => {
      if (!onUpdateSpeaker) return;
      const turn = turns?.[ti];
      if (!turn) return;
      setPick(null);
      setSpkSaving(true);
      const ok = await onUpdateSpeaker(turn.items, speaker);
      setSpkSaving(false);
      if (!ok) setPick(ti);
    },
    [onUpdateSpeaker, turns],
  );

  /**
   * 润色轮覆盖的段下标（按时间重叠）。
   *
   * 改归属仍然落回 `segments`（服务端 `assign_speaker` 再按 `start` 把润色稿的标注刷新），
   * 所以这里要把「一轮润色文字」映射回它覆盖的那批原始段。润色轮与段边界同源
   * （`groupSegmentTurns` 只合并、不改时间），用半开区间重叠即可，不会跨到相邻轮。
   */
  const polishedSegmentIndexes = useCallback(
    (pi: number) => {
      const turn = polished?.[pi];
      if (!turn) return [];
      // 手工插入轮与插入段是同一件事的两种表示（时间 + 文字全等）⇒ 只能精确配回那一段。
      // 若沿用下面的"时间重叠"，它会和上一轮时间完全重合，一点就把整轮都圈进来。
      if (turn.inserted === true) {
        const i = findInsertedSegmentIndex(segments, turn);
        return i >= 0 ? [i] : [];
      }
      const out: number[] = [];
      segments.forEach((s, i) => {
        // 插入行只归自己那一轮，不被邻轮的时间重叠圈走（老 sidecar 靠时间区间推断）
        if (isInsertedSegment(segments, i)) return;
        if (s.end > turn.start && s.t < turn.end) out.push(i);
      });
      return out;
    },
    [polished, segments],
  );

  /** 改**润色轮**的说话人归属（与 `pickSpeaker` 同口径：先收起、失败再展开） */
  const pickPolishedSpeaker = useCallback(
    async (pi: number, speaker: number | null) => {
      if (!onUpdateSpeaker) return;
      const indexes = polishedSegmentIndexes(pi);
      if (indexes.length === 0) return;
      setPickPolished(null);
      setSpkSaving(true);
      const ok = await onUpdateSpeaker(indexes, speaker);
      setSpkSaving(false);
      if (!ok) setPickPolished(pi);
    },
    [onUpdateSpeaker, polishedSegmentIndexes],
  );

  /**
   * 打开集中改名面板：草稿按**当前**名字铺满所有行（不是空串 —— 用户要看得到现在叫什么）。
   * 同时收起另外两处编辑态：三处都在改"谁是谁"，不该同时开着（同名输入框开着两个会分不清谁是底稿）。
   */
  const openNames = useCallback(() => {
    const init: Record<number, string> = {};
    for (const id of speakerIds) init[id] = names?.[id] ?? '';
    setNameDrafts(init);
    setPick(null);
    setPickPolished(null);
    setRenaming(null);
    setNamesOpen(true);
  }, [speakerIds, names]);

  /** 草稿里**真的改了**的那些人（与服务端同一份 `normalizeSpeakerName` 口径比对） */
  const dirtyNameIds = useMemo(
    () =>
      !namesOpen
        ? []
        : speakerIds.filter(
            (id) => normalizeSpeakerName(nameDrafts[id] ?? '') !== normalizeSpeakerName(names?.[id] ?? ''),
          ),
    [namesOpen, speakerIds, nameDrafts, names],
  );

  /**
   * 统一提交：把所有行一次交上去（父级自己筛"没变的"，只会发真正改动的那几条）。
   * 失败**保留面板与全部草稿** —— 一次动作失败之后，最不该做的就是清掉用户刚敲的字。
   * 一个字都没改 ⇒ 不出请求，直接收起面板。
   */
  const saveNames = useCallback(async () => {
    if (!onRenameSpeakers || spkSubmitRef.current) return;
    if (dirtyNameIds.length === 0) {
      setNamesOpen(false);
      return;
    }
    spkSubmitRef.current = true;
    setSpkSaving(true);
    const ok = await onRenameSpeakers(speakerIds.map((id) => ({ id, name: nameDrafts[id] ?? '' })));
    setSpkSaving(false);
    spkSubmitRef.current = false;
    if (ok) {
      setNamesOpen(false);
      setNameDrafts({});
    }
  }, [onRenameSpeakers, speakerIds, nameDrafts, dirtyNameIds]);

  /** 关闭面板并丢弃草稿（`Esc` / `Cancel` 共用） */
  const closeNames = useCallback(() => {
    setNamesOpen(false);
    setNameDrafts({});
  }, []);

  /**
   * 跟播刚要求滚到的位置 + 当时的距离：用来认出"这条 `scroll` 是跟播自己发的"。
   * 平滑滚动途中每一帧都在**靠近**这个位置，所以"距离没变大"就还算跟随；
   * 其余 `scroll`（滚轮/触屏/拖滚动条/翻页键）一律视为用户接管 ——
   * 这样既不会像监听 `scroll` 那样"跟播滚一次就把自己关掉"，也不需要手写计时窗口。
   */
  const followTargetRef = useRef<number | null>(null);
  const followDistRef = useRef<number | null>(null);

  /** 跟随播放：只滚本面板的列表（手算 scrollTop，不触碰祖先滚动容器） */
  useEffect(() => {
    // 编辑期间**不跟随**：播放推进会在用户打字时把当前行滚出视野（并被自动滚动打断输入）
    // 改说话人名字同理（输入框在轮首，一样会被滚走）
    if (!open || !pinned || typing || renaming || followIndex < 0) return;
    const el = listRef.current;
    const row = followRow();
    if (!el || !row) return;
    // 目标钳到可滚范围：否则"到底了"那一格会被浏览器改数，下面认不出这是自己滚的
    const top = Math.max(0, Math.min(row.offsetTop - el.clientHeight / 2 + row.clientHeight / 2, el.scrollHeight - el.clientHeight));
    followTargetRef.current = top;
    followDistRef.current = Math.abs(el.scrollTop - top);
    el.scrollTo({ top, behavior: 'smooth' });
  }, [followIndex, pinned, open, typing, renaming, followRow]);

  /**
   * 用户自己滚 ⇒ 解除跟随（此后点任意一行 = 重新接上）。
   * ⚠️ 此前是"滚到列表**底部**就重新跟随"：稿子里播放行经常在列表中间，
   * 用户往下翻到末尾就被拽回播放行 —— 就是"下滑后自动回弹到最上面"（2026-10-18 反馈）。
   */
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const target = followTargetRef.current;
    if (target === null) {
      setPinned(false);
      return;
    }
    const dist = Math.abs(el.scrollTop - target);
    const prev = followDistRef.current;
    // 还在往跟播要的位置靠（含已到位）：这条 scroll 是跟播发的，保持跟随
    if (dist <= 1 || (prev !== null && dist <= prev)) {
      followDistRef.current = dist;
      return;
    }
    followTargetRef.current = null;
    followDistRef.current = null;
    setPinned(false);
  }, []);

  /**
   * 行级 AI 润色：**只润这一行**，且润的是输入框里此刻的文字（用户可能正改到一半）。
   *
   * 为什么读句柄而不是 `segments[i].text`：正文常驻可编辑，用户点 `✦` 时手里可能还有没落盘的草稿，
   * 拿旧文本去润等于把用户刚打的字丢了。结果**只放回输入框当草稿** —— 用户 Enter 落盘、Esc 还原，
   * 失败（`null`）时输入框保持原样（父级弹错误条）。
   */
  const polishRow = useCallback(
    async (key: string, saved: string) => {
      if (!onPolishText || polishingRow) return;
      const api = textApis.current.get(key);
      const text = (api?.draft() ?? saved).trim();
      if (!text) return;
      setPolishingRow(key);
      try {
        const next = await onPolishText(text);
        // 有变化才出修订预览：没变化时什么都不弹（用户看不出"润了个寂寞"）
        if (next && next !== text) setAiEdit({ key, after: next, ops: diffText(text, next) });
      } finally {
        setPolishingRow(null);
      }
    },
    [onPolishText, polishingRow],
  );

  /**
   * 保存一句原文（`InlineText` 的 `onCommit`）。
   *
   * 空文本 / 无变化已经由 `InlineText` 先拦过一次；这里再守一遍是为了兜住"真源恰好被别处改了"的
   * 竞态 —— 口径与服务端 `save_transcript` 一致（空文本按取消处理，**不**抹句子）。
   */
  const saveSegment = useCallback(
    async (index: number, next: string): Promise<boolean> => {
      if (!onUpdateSegment) return false;
      if (!next || next === (segments[index]?.text ?? '')) return true;
      return onUpdateSegment(index, next);
    },
    [segments, onUpdateSegment],
  );

  /** 保存一轮润色文字（`InlineText` 的 `onCommit`）；拒绝口径与 `saveSegment` 同源 */
  const savePolishedTurn = useCallback(
    async (index: number, next: string): Promise<boolean> => {
      if (!onUpdatePolishedTurn) return false;
      if (!next || next === (polished?.[index]?.text ?? '')) return true;
      return onUpdatePolishedTurn(index, next);
    },
    [polished, onUpdatePolishedTurn],
  );

  /**
   * 接受 AI 修订：把 `after` 走**正常落盘那条路**（原文 / 润色稿各用各的接口）。
   * 失败时**保留预览**（父级已弹错误条）—— 用户可以再 Accept 重试，或 Discard 放弃。
   */
  const acceptAiEdit = useCallback(async () => {
    const edit = aiEdit;
    if (!edit) return;
    const index = Number(edit.key.slice(4));
    const ok = edit.key.startsWith('raw-')
      ? await saveSegment(index, edit.after)
      : await savePolishedTurn(index, edit.after);
    if (ok) setAiEdit(null);
  }, [aiEdit, saveSegment, savePolishedTurn]);

  /** 修订预览开着时：Esc = 放弃（与正文编辑里 Esc 还原同一条心智） */
  useEffect(() => {
    if (!aiEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAiEdit(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aiEdit]);

  /**
   * 在当前行**下面**挂一条空草稿（同一时刻最多一行）。
   *
   * 时间默认取**当前播放头**（用户口径）：播到想标注的位置再点 `+`，新行就落在那一秒。
   * 插入位置仍是"这一行下面"（结构位置），所以默认时间会被夹在
   * `[本行起点, 下一行起点]` 里 —— 段列表必须按 `t` 非递减（`activeSegmentIndex` 的二分
   * 依赖它），否则高亮会指到错误的行。之后随时可用行尾时钟按钮改到任意位置（改完自动归位）。
   * 说话人仍复制上一行（没有更可靠的来源）。
   */
  const addDraftAfter = useCallback(
    (kind: 'raw' | 'polished', index: number) => {
      const at = Number.isFinite(time) ? Math.round(Math.max(0, time) * 10) / 10 : 0;
      if (kind === 'raw') {
        const s = segments[index];
        if (!s) return;
        const next = segments[index + 1]?.t;
        const t = next === undefined ? Math.max(at, s.t) : Math.min(Math.max(at, s.t), Math.max(s.t, next));
        setDraft({ key: ++draftSeq.current, kind, after: index, speaker: s.speaker, t, end: Math.max(t, s.end) });
        return;
      }
      const turn = polished?.[index];
      if (!turn) return;
      // 与 `insertPolishedTurnAfter` 同一套落点：新段在该轮覆盖的最后一段之后 ⇒ 不甘落后于它
      let si = -1;
      segments.forEach((s, i) => {
        if (s.t < turn.end) si = i;
      });
      if (si < 0) {
        segments.forEach((s, i) => {
          if (s.t <= turn.start) si = i;
        });
      }
      const lower = si >= 0 ? segments[si].t : 0;
      const upper = si >= 0 ? segments[si + 1]?.t : segments[0]?.t;
      const t = upper === undefined ? Math.max(at, lower) : Math.min(Math.max(at, lower), Math.max(lower, upper));
      setDraft({ key: ++draftSeq.current, kind, after: index, speaker: turn.speaker, t, end: Math.max(t, turn.end) });
    },
    [segments, polished, time],
  );

  /** 丢掉草稿（没写字就离开 / 按钮取消）：空行本来就不该进 sidecar */
  const dropDraft = useCallback(() => setDraft(null), []);

  /**
   * 删除中的本地闸门。
   *
   * 删除**不做乐观更新**（等服务端回传整份 transcript），而删掉一行后所有后续行下标都会变：
   * 连点两下会拿旧下标再删一次，把相邻一行也删掉。这里用本地闸门把双击挡住。
   */
  const [deleting, setDeleting] = useState(false);
  const deleteLine = useCallback(
    async (kind: 'raw' | 'polished', index: number): Promise<boolean> => {
      if (deleting) return false;
      setDeleting(true);
      try {
        return kind === 'raw'
          ? (await onDeleteSegment?.(index)) ?? false
          : (await onDeletePolishedTurn?.(index)) ?? false;
      } finally {
        setDeleting(false);
      }
    },
    [deleting, onDeleteSegment, onDeletePolishedTurn],
  );

  /**
   * 把草稿写进 sidecar（`InlineText` 的 `onCommit`）。
   *
   * 成功才清掉草稿行（服务端回传的整份 transcript 会带出真正的新行）；失败**保留**草稿，
   * 用户改完再失焦即重试 —— 与逐句保存同一口径。
   */
  const commitDraft = useCallback(
    async (text: string): Promise<boolean> => {
      const d = draft;
      if (!d || !text.trim()) return false;
      const line = { speaker: d.speaker, t: d.t, end: d.end, text };
      const ok =
        d.kind === 'raw'
          ? await onInsertSegment?.(d.after, line)
          : await onInsertPolishedTurn?.(d.after, line);
      if (ok) setDraft((cur) => (cur?.key === d.key ? null : cur));
      return !!ok;
    },
    [draft, onInsertSegment, onInsertPolishedTurn],
  );

  /** 草稿行：时间默认当前播放头（可读不可改，落盘后可用时钟按钮调），正文就是输入框，写完离开即落盘 */
  const renderDraft = () => {
    if (!draft) return null;
    const color =
      draft.speaker === null ? 'var(--line-soft)' : SPEAKER_COLORS[draft.speaker % SPEAKER_COLORS.length];
    return (
      <div
        key={`draft-${draft.key}`}
        data-role="draft-line"
        className="flex w-full items-start gap-1.5 rounded-md px-1 py-0.5"
        style={{ backgroundColor: 'var(--paper)', border: '1px dashed var(--line-soft)' }}
      >
        <span className="flex shrink-0 items-start gap-1.5 px-0.5">
          <span className="shrink-0 font-mono text-10" style={{ color: 'var(--primary-strong)' }}>
            {mmss(draft.t)}
            {draft.kind === 'polished' ? `–${mmss(clampEnd(draft.end))}` : ''}
          </span>
          {draft.speaker !== null && (
            <span
              className="shrink-0 rounded px-1 text-10"
              style={{ color: '#fff', backgroundColor: color }}
              title="Speaker (copied from the line above)"
            >
              {speakerLabel(names, draft.speaker)}
            </span>
          )}
        </span>
        <InlineText
          value=""
          autoFocus
          readOnly={busy}
          label="New dialogue line"
          placeholder="New dialogue…"
          onCommit={commitDraft}
          onFocusChange={setTyping}
          onEmptyBlur={dropDraft}
        />
      </div>
    );
  };

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)]"
        style={{ color: 'var(--ink)' }}
        title={open ? 'Collapse the transcript' : 'Expand the transcript'}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Transcript ({segments.length})
      </button>
      {/* 润色进度是不可点击读数 ⇒ text-10，且只在跑的时候出现 */}
      {polishProgress && (
        <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
          Polishing {polishProgress.done}/{polishProgress.total}
        </span>
      )}
      {/* 计数/引擎是**不可点击**文字 ⇒ text-10；只显示第一段，完整文案放 title */}
      <span className="min-w-0 max-w-full truncate text-10" style={{ color: 'var(--ink-faint)' }} title={transcript.engine}>
        {(transcript.engine || 'transcript').split('，')[0]}
        {transcript.range ? ` · ${Math.round(transcript.range.start)}–${Math.round(transcript.range.end)}s` : ''}
        {transcript.partial
          ? ` · partial ${Math.round((transcript.coveredUntilSec ?? 0) / 60)}/${Math.round((transcript.durationSec ?? 0) / 60)} min`
          : ''}
      </span>
      <span className="min-w-0 flex-1" />
      {/* 低频动作收进一个菜单：头部只留一个 ⋯，不再摆一排同权重按钮 */}
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy || polishing}
          aria-label="Transcript options"
          aria-expanded={menuOpen}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
          style={{ color: 'var(--ink-muted)' }}
          title="Transcript options"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full z-40 mt-1 flex w-56 flex-col gap-0.5 rounded-md p-1.5"
            style={{ backgroundColor: 'var(--panel-bg)', border: '1px solid var(--line)', boxShadow: '0 4px 16px rgba(0,0,0,0.10)' }}
            role="menu"
          >
            {onRetranscribe && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onRetranscribe();
                }}
                disabled={busy}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--primary-strong)' }}
                title={transcript.partial ? 'Continue from where it stopped' : 'Transcribe this audio again'}
              >
                {transcribing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {transcribing ? 'Transcribing…' : transcript.partial ? 'Continue transcribing' : 'Re-transcribe'}
              </button>
            )}
            {onTranscribeSelection && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onTranscribeSelection();
                }}
                disabled={busy || !hasSelection}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title={
                  hasSelection
                    ? 'Transcribe only the selected range'
                    : 'Drag a range on the waveform first — this transcribes only that part'
                }
              >
                <Scissors className="h-3 w-3" />
                Transcribe selection
              </button>
            )}
            {(onRetranscribe || onTranscribeSelection) && (
              <div className="my-0.5 h-px" style={{ backgroundColor: 'var(--line-soft)' }} />
            )}
            {/* 集中改名：分离只给出 `Speaker 1 / 2 / 3` 时，逐个翻到轮首去点名字太费事。
                稿子里一个说话人都没有（没开分离 / 分离失败）时不摆这个入口 —— 没有可改的对象。 */}
            {onRenameSpeakers && speakerIds.length > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openNames();
                }}
                disabled={busy}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title="Give every speaker a name in one place, then save once"
              >
                <Users className="h-3 w-3" />
                Rename speakers
              </button>
            )}
            {onHighlights && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onHighlights();
                }}
                disabled={busy}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title="Let the model pick the parts worth keeping"
              >
                <Sparkles className="h-3 w-3" />
                Highlights
              </button>
            )}
            {onPolish && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onPolish();
                }}
                disabled={busy || polishing}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--primary-strong)' }}
                title="Clean up the transcript with DeepSeek (sends transcript text to the configured model; keeps speakers/timestamps; original stays available)"
              >
                {polishing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {polished && polished.length > 0 ? 'Re-polish with DeepSeek' : 'Polish with DeepSeek'}
              </button>
            )}
            {polished && polished.length > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setView(view === 'raw' ? 'polished' : 'raw');
                  // 草稿只属于当前视图的行序：换视图后下标含义全变了，留着会在切回来时错位
                  setDraft(null);
                }}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title={view === 'raw' ? 'Show the DeepSeek-polished dialogue' : 'Show the original ASR lines'}
              >
                {view === 'raw' ? 'View polished' : 'View original'}
              </button>
            )}
            {onOpenMarkdown && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenMarkdown(view);
                }}
                disabled={busy}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
                style={{ color: 'var(--ink-muted)' }}
                title="Export the current view as Markdown and open it in the Markdown reader"
              >
                <FileText className="h-3 w-3" />
                Open as Markdown
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  /**
   * 一行（逐**句**）。
   *
   * 版式：**时间戳是跳转锚点**（点它把播放头落到该句起点，不自动播放），**正文是输入框**
   * （点正文只落光标、**不**跳播放头）。拆成兄弟节点还有一层 HTML 原因：
   * `<textarea>` 不能嵌在 `<button>` 里（非法嵌套，且内部按键会冒泡给按钮 → 打字时播放头乱跳）。
   * 没有 `onUpdateSegment`（只读场景）时正文退回纯文本。
   */
  const renderRow = (i: number) => {
    const s = segments[i];
    const isActive = i === active;
    // 与波形选区**有交叠**即算选中（1e-6 容差：正好贴边/零长不算，免得"挨着"也被点亮）
    const inSel =
      !!highlightRange && s.t < highlightRange.end - 1e-6 && s.end > highlightRange.start + 1e-6;
    const color = s.speaker === null ? undefined : SPEAKER_COLORS[s.speaker % SPEAKER_COLORS.length];

    return (
      <div
        key={`${s.t}-${i}`}
        ref={(el) => {
          rowRefs.current[i] = el;
        }}
        className="group flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-[var(--paper-hover)]"
        style={{
          // 播放档优先（"读到这里"更即时）；否则落在选区内就上选区底色。
          // ⚠️ 无高亮时**不写** backgroundColor（不能写 'transparent'）：内联值会压掉 hover 类。
          ...(isActive
            ? { backgroundColor: 'var(--primary-soft)' }
            : inSel
              ? { backgroundColor: SEL_HL_BG }
              : null),
          // 选区另给一条**左侧竖条**：与播放档同时命中时，仍能一眼看出"这句在圈定范围内"
          boxShadow: inSel ? 'inset 2px 0 0 var(--primary-strong)' : undefined,
        }}
      >
        {/* 跳转锚点 + 句首时间编辑：单击跳转，双击改这一句的起点（说话人贴片单独放，不参与编辑） */}
        <div className="flex shrink-0 items-start gap-1.5">
          <InlineTime
            value={s.t}
            active={isActive}
            disabled={busy}
            request={timeEdit?.view === 'raw' && timeEdit.index === i ? timeEdit.key : 0}
            label={`Edit start time of line at ${mmss(s.t)}`}
            onSeek={() => {
              setPinned(true);
              onSeek(s.t);
            }}
            onCommit={
              onUpdateSegmentTime
                ? async (t) => {
                    const ok = await onUpdateSegmentTime(i, t);
                    // 改完就定位过去：文稿上的新时间与轨道播放头**当场对齐**
                    // （只 seek、不改播放状态 —— 与点时间戳同一条口径）
                    if (ok) {
                      setPinned(true);
                      onSeek(t);
                    }
                    return ok;
                  }
                : undefined
            }
          />
          {/* 专用"调时间"按钮：可发现入口（双击时间戳仍保留为快捷方式）。
              常驻半透明而不是纯 hover 浮出 —— 这是用户点名要的按钮，不能靠"碰巧悬停"才发现。 */}
          {onUpdateSegmentTime && (
            <button
              type="button"
              onClick={() => beginTimeEdit('raw', i)}
              disabled={busy}
              className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:bg-[var(--paper)] hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
              style={{ color: 'var(--ink-muted)' }}
              title="Adjust start time (mm:ss or seconds)"
              aria-label="Adjust start time"
            >
              <Clock3 className="h-2.5 w-2.5" />
            </button>
          )}
          {/* 说话人贴片只在**平铺**路径出现；对话稿路径的归属由轮首交代 */}
          {hasSpeaker && !multiSpeaker && s.speaker !== null && (
            <span
              className="shrink-0 rounded px-1 text-10"
              style={{ color: '#fff', backgroundColor: color }}
              title="Speaker"
            >
              {s.speaker + 1}
            </span>
          )}
        </div>
        {/* 正文：点进去即可改，不跳播放头；行级 AI 润色先以"修订预览"替换正文，由用户接受或放弃 */}
        {aiEdit?.key === `raw-${i}` ? (
          <AiEditPreview
            ops={aiEdit.ops}
            busy={busy}
            onAccept={() => void acceptAiEdit()}
            onDiscard={() => setAiEdit(null)}
          />
        ) : onUpdateSegment ? (
          <InlineText
            ref={(el) => {
              if (el) textApis.current.set(`raw-${i}`, el);
              else textApis.current.delete(`raw-${i}`);
            }}
            value={s.text}
            readOnly={busy}
            label={`Edit line at ${mmss(s.t)}`}
            onCommit={(next) => saveSegment(i, next)}
            onFocusChange={setTyping}
            onInsertBelow={onInsertSegment ? () => addDraftAfter('raw', i) : undefined}
          />
        ) : (
          <span className="min-w-0 flex-1 text-xs" style={{ color: 'var(--ink)' }}>
            {s.text}
          </span>
        )}
        {/* 行级 AI 润色：只润这一句，润的是输入框里**此刻**的文字（含还没落盘的改动）。
            常驻半透明而不是纯 hover 浮出 —— 这是用户点名要的入口，不靠"碰巧悬停"才发现。 */}
        {onPolishText && onUpdateSegment && (
          <button
            type="button"
            // 不让按钮抢走 textarea 的焦点：否则正在改的草稿会先失焦落盘、再去润色旧文本
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              void polishRow(`raw-${i}`, s.text);
            }}
            disabled={busy || polishing || polishingRow !== null}
            className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:bg-[var(--paper)] hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
            style={{ color: 'var(--ink-muted)' }}
            title="Polish this line with AI (uses what you're typing; Enter to save, Esc to revert)"
            aria-label="Polish this line with AI"
          >
            {polishingRow === `raw-${i}` ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Sparkles className="h-2.5 w-2.5" />
            )}
          </button>
        )}
        {/* 在这句**下面**插一条对话：hover / 键盘聚焦才浮出，不抢阅读面的视觉重心 */}
        {onInsertSegment && (
          <button
            type="button"
            onClick={() => addDraftAfter('raw', i)}
            disabled={busy}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
            style={{ color: 'var(--ink-muted)' }}
            title="Insert a line below (Ctrl/Cmd+Enter in the text does the same)"
            aria-label="Insert a line below"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        )}
        {/* 删掉这一句：与 `+` 同一条 hover 浮出条；只剩一句时禁用（空稿 sidecar 会整份失效） */}
        {onDeleteSegment && (
          <button
            type="button"
            onClick={() => {
              void deleteLine('raw', i);
            }}
            disabled={busy || deleting || segments.length <= 1}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
            style={{ color: 'var(--ink-muted)' }}
            title={segments.length <= 1 ? 'At least one line must remain' : 'Delete this line'}
            aria-label="Delete this line"
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    );
  };

  if (!open) {
    return <div className="flex flex-col gap-1.5">{headerActions}</div>;
  }

  return (
    <div className={wide ? 'flex min-h-0 flex-1 flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
      {headerActions}
      {/* 集中改名面板（⋯ 菜单进入）。渲染在列表**上方**、不参与列表滚动：
          列表才是那个 `overflow-y-auto`，所以打字时不会被自动跟随滚走。
          只列稿子里**出现过**的说话人 —— 摆一个没人说过的 `Speaker 5` 只会让人给幽灵起名。 */}
      {namesOpen && onRenameSpeakers && (
        <div
          data-role="speaker-names-editor"
          className="flex flex-col gap-1.5 rounded-md p-1.5"
          style={{ backgroundColor: 'var(--surface-muted)', border: '1px solid var(--line-soft)' }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 text-10 font-medium" style={{ color: 'var(--ink-muted)' }}>
              Speaker names
            </span>
            {/* 说明是**读数**，放不下就省略，全句在 title 里 */}
            <span
              className="min-w-0 flex-1 truncate text-10"
              style={{ color: 'var(--ink-faint)' }}
              title="Each name applies to every turn of that speaker. Leave a field empty to go back to Speaker 1 / 2 / 3…"
            >
              Applies to every turn of that speaker · empty = default name
            </span>
            <button
              type="button"
              onClick={closeNames}
              disabled={spkSaving}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--ink-muted)' }}
              title="Discard these changes"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveNames()}
              disabled={spkSaving || dirtyNameIds.length === 0}
              className="shrink-0 rounded-md px-2 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--primary-strong)' }}
              title="Save all the names in one go (one write; nothing is stored if it fails)"
            >
              {spkSaving ? 'Saving…' : dirtyNameIds.length > 0 ? `Save ${dirtyNameIds.length}` : 'Save'}
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {speakerIds.map((id) => (
              <div key={id} className="flex min-w-0 items-center gap-2">
                {/* 颜色即身份：与轮首竖条、归属 chips 同一档 ⇒ 只看颜色就能对上稿子里的那一位 */}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: SPEAKER_COLORS[id % SPEAKER_COLORS.length] }}
                />
                {/* 编号是**这个人的默认名**（改名前他就是 `Speaker N`），不可编辑 */}
                <span className="w-14 shrink-0 font-mono text-10" style={{ color: 'var(--ink-faint)' }}>
                  Speaker {id + 1}
                </span>
                <input
                  type="text"
                  value={nameDrafts[id] ?? ''}
                  onChange={(e) => setNameDrafts((cur) => ({ ...cur, [id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      closeNames();
                      return;
                    }
                    if (e.key === 'Enter') {
                      // 🔴 IME 守卫（同逐行改字）：拼音未上屏时回车是"选词"，不挡会提交半截名字
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      e.preventDefault();
                      void saveNames();
                    }
                  }}
                  // 占位符就是**默认名**（空 = 恢复它），省得用户猜空着会变成什么
                  placeholder={speakerLabel(undefined, id)}
                  disabled={spkSaving}
                  className="min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-10 outline-none disabled:opacity-60"
                  style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                  aria-label={`Name for speaker ${id + 1}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 分离失败/单人稿：明确说清楚，并给一条“按 2 人重试”的路。
          没有这条提示时，engine 抬头里的「未分说话人」会被第一段逗号截掉，用户以为这就是对话稿。 */}
      {noSpeakerLabels && onRetrySpeakers && (
        <div
          data-role="speaker-warning"
          className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1"
          style={{ backgroundColor: 'var(--surface-muted)' }}
        >
          <span className="min-w-0 flex-1 text-10" style={{ color: 'var(--ink-muted)' }}>
            No speaker labels — this may be a single voice, or separation couldn&apos;t split it.
          </span>
          <button
            type="button"
            onClick={onRetrySpeakers}
            disabled={busy}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
            style={{ color: 'var(--primary-strong)' }}
            title="Separate the existing transcript again as 2 people (no re-transcription; may take a few minutes)"
          >
            Retry as 2 people
          </button>
        </div>
      )}
      {/* 自带滚动：面板高度有界，绝不把下方的片段清单推走。
          高度口径（2026-10-17 用户要求"调到最高"）：上限从 14rem（约 11–12 行）改为 **70vh**
          —— 默认档在 900px 高的屏幕上约 630px、≈30 行；仍超出就**在列表内部滚动**，
          所以"句子越多越高"这条仍然不成立（它是上限不是内容高度）。
          ⚠️ 用 vh 而不是 flex 撑满父级：外层 `transcript-section` 是 `height:auto`
          （`max-height` 只是上界），flex-1 在那里没有多余空间可分，结果会变回"按内容长"。
          也因此这一页签**不能**在外层加 `overflow`（见 AudioViewer 该处注释：会裁掉 `⋮` 菜单）。 */}
      <div
        ref={listRef}
        onScroll={onListScroll}
        className={
          wide
            ? 'relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-md max-h-[60vh] lg:max-h-none'
            : 'relative flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto rounded-md'
        }
        style={{ backgroundColor: 'var(--surface-muted)' }}
      >
        {view === 'polished' && polished && polished.length > 0
          ? polished.map((t, i) => {
              const activeTurn = time >= t.start && time < t.end;
              const color = t.speaker === null ? 'var(--line-soft)' : SPEAKER_COLORS[t.speaker % SPEAKER_COLORS.length];
              // 轮起点 → 第一段原文（调时间落回这一段；找不到就不给入口）
              const turnSeg = firstSegmentOfTurn(t);
              return (
                <Fragment key={`polished-${i}`}>
                <div
                  key={`polished-${i}`}
                  ref={(el) => {
                    turnRefs.current[i] = el;
                  }}
                  data-role="polished-turn"
                  className="flex w-full flex-col gap-0.5 rounded-md px-1 py-1 transition-colors"
                  style={{
                    backgroundColor: activeTurn ? 'var(--primary-soft)' : undefined,
                    borderLeft: `2px solid ${color}`,
                    marginTop: i > 0 ? 6 : undefined,
                  }}
                >
                  {/* 轮首：说话人在这里可改名 / 改归属（与原文对话稿的轮首同一套入口）。
                      刻意不把整轮写成 `<button>`：里面要放 `<input>` 与一组按钮，非法嵌套。 */}
                  <div className="group flex min-w-0 items-center gap-1">
                    {renaming && renaming.id === t.speaker ? (
                      <input
                        ref={renameRef}
                        autoFocus
                        value={renaming.draft}
                        onChange={(e) => setRenaming({ id: renaming.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenaming(null);
                            return;
                          }
                          if (e.key === 'Enter') {
                            // 🔴 IME 守卫（同逐行改字：拼音未上屏时回车是"选词"）
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            e.preventDefault();
                            void commitRename(renaming.id, e.currentTarget.value);
                          }
                        }}
                        onBlur={(e) => void commitRename(renaming.id, e.currentTarget.value)}
                        placeholder="Speaker name"
                        disabled={spkSaving}
                        className="w-24 shrink-0 rounded border px-1 py-0.5 text-10 outline-none disabled:opacity-60"
                        style={{
                          borderColor: 'var(--line-soft)',
                          backgroundColor: 'var(--paper)',
                          color: 'var(--ink)',
                        }}
                        aria-label="Speaker name"
                      />
                    ) : (
                      <button
                        type="button"
                        // 只有**已归属**才有名字可改（`Transcript` 是没有簇号的）；只读场景整个不渲染
                        disabled={!onRenameSpeaker || busy || t.speaker === null}
                        onClick={() => {
                          if (t.speaker === null) return;
                          setPickPolished(null);
                          setRenaming({ id: t.speaker, draft: names?.[t.speaker] ?? '' });
                        }}
                        className="shrink-0 rounded px-0.5 text-10 font-medium transition-colors enabled:hover:bg-[var(--paper-hover)] disabled:cursor-default"
                        style={{ color: t.speaker === null ? 'var(--ink-faint)' : color }}
                        title={t.speaker === null ? 'Unassigned' : 'Rename this speaker (empty = Speaker N)'}
                      >
                        {t.speaker === null ? 'Transcript' : speakerLabel(names, t.speaker)}
                      </button>
                    )}
                    {/* 改归属：hover 才浮出的小箭头 ⇒ 就地展开一排人（不用浮层：列表 overflow 会裁掉它） */}
                    {pickingPolished === i ? (
                      <span className="flex min-w-0 shrink items-center gap-0.5">
                        {[...speakerIds, null].map((id) => {
                          const on = id === t.speaker;
                          const chip = id === null ? 'var(--line-soft)' : SPEAKER_COLORS[id % SPEAKER_COLORS.length];
                          return (
                            <button
                              key={id === null ? 'none' : id}
                              type="button"
                              onClick={() => void pickPolishedSpeaker(i, id)}
                              className="max-w-[7rem] shrink-0 truncate rounded px-1 text-10 font-medium transition-colors"
                              style={{
                                color: on ? '#fff' : 'var(--ink-muted)',
                                backgroundColor: on ? chip : 'var(--paper)',
                              }}
                              title={id === null ? 'Mark this turn as unassigned' : `Assign this turn to ${speakerLabel(names, id)}`}
                            >
                              {speakerLabel(names, id)}
                            </button>
                          );
                        })}
                      </span>
                    ) : (
                      onUpdateSpeaker && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setRenaming(null);
                            setPickPolished(i);
                          }}
                          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
                          style={{ color: 'var(--ink-muted)' }}
                          title="Change which speaker this turn belongs to"
                          aria-label="Change speaker"
                        >
                          <ChevronDown className="h-2.5 w-2.5" />
                        </button>
                      )
                    )}
                    <InlineTime
                      value={t.start}
                      suffix={`–${mmss(clampEnd(t.end))}`}
                      active={activeTurn}
                      disabled={busy}
                      request={timeEdit?.view === 'polished' && timeEdit.index === i ? timeEdit.key : 0}
                      label={`Edit start time of turn at ${mmss(t.start)}`}
                      onSeek={() => {
                        setPinned(true);
                        onSeek(t.start);
                      }}
                      onCommit={
                        onUpdateSegmentTime && turnSeg >= 0
                          ? async (next) => {
                              // 轮起点 = 第一段原文的起点：走同一条 `save_segment_time`，
                              // 服务端会把该轮的 start 与上一段的 end 一起重排（两边始终对齐）
                              const ok = await onUpdateSegmentTime(turnSeg, next);
                              if (ok) {
                                setPinned(true);
                                onSeek(next);
                              }
                              return ok;
                            }
                          : undefined
                      }
                    />
                    {/* 专用"调时间"按钮（润色稿同样可调起点；双击时间戳仍是快捷方式） */}
                    {onUpdateSegmentTime && turnSeg >= 0 && (
                      <button
                        type="button"
                        onClick={() => beginTimeEdit('polished', i)}
                        disabled={busy}
                        className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:bg-[var(--paper)] hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Adjust start time (mm:ss or seconds)"
                        aria-label="Adjust start time"
                      >
                        <Clock3 className="h-2.5 w-2.5" />
                      </button>
                    )}
                    {/* 行级 AI 润色：只润这一轮，润的是输入框里**此刻**的文字（含还没落盘的改动）。
                        常驻半透明（用户点名要的入口），结果只当草稿 ⇒ Enter 落盘 / Esc 还原。 */}
                    {onPolishText && onUpdatePolishedTurn && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          void polishRow(`pol-${i}`, t.text);
                        }}
                        disabled={busy || polishing || polishingRow !== null}
                        className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:bg-[var(--paper)] hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Polish this turn with AI (uses what you're typing; Enter to save, Esc to revert)"
                        aria-label="Polish this turn with AI"
                      >
                        {polishingRow === `pol-${i}` ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Sparkles className="h-2.5 w-2.5" />
                        )}
                      </button>
                    )}
                    {/* 在这一轮下面插一轮：时间复制本轮（与原文稿的 `+` 同一口径） */}
                    {onInsertPolishedTurn && (
                      <button
                        type="button"
                        onClick={() => addDraftAfter('polished', i)}
                        disabled={busy}
                        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Insert a turn below (Ctrl/Cmd+Enter in the text does the same)"
                        aria-label="Insert a turn below"
                      >
                        <Plus className="h-2.5 w-2.5" />
                      </button>
                    )}
                    {/* 删掉这一轮：原文里"时间+文字全等"的那一段由服务端一并删掉（插入的逆操作） */}
                    {onDeletePolishedTurn && (
                      <button
                        type="button"
                        onClick={() => {
                          void deleteLine('polished', i);
                        }}
                        disabled={busy || deleting}
                        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Delete this turn"
                        aria-label="Delete this turn"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                  {/* 正文：点进去即可改（不跳播放头）；行级 AI 润色先以"修订预览"替换正文 */}
                  {aiEdit?.key === `pol-${i}` ? (
                    <AiEditPreview
                      ops={aiEdit.ops}
                      busy={busy}
                      onAccept={() => void acceptAiEdit()}
                      onDiscard={() => setAiEdit(null)}
                    />
                  ) : onUpdatePolishedTurn ? (
                    <InlineText
                      ref={(el) => {
                        if (el) textApis.current.set(`pol-${i}`, el);
                        else textApis.current.delete(`pol-${i}`);
                      }}
                      value={t.text}
                      readOnly={busy}
                      label={`Edit polished turn at ${mmss(t.start)}`}
                      onCommit={(next) => savePolishedTurn(i, next)}
                      onFocusChange={setTyping}
                      onInsertBelow={onInsertPolishedTurn ? () => addDraftAfter('polished', i) : undefined}
                    />
                  ) : (
                    <span className="whitespace-pre-wrap px-0.5 text-xs" style={{ color: 'var(--ink)' }}>
                      {t.text}
                    </span>
                  )}
                </div>
                {draft?.kind === 'polished' && draft.after === i && renderDraft()}
                </Fragment>
              );
            })
          : turns
          ? turns.map((turn, ti) => {
              const first = segments[turn.items[0]];
              const lastSeg = segments[turn.items[turn.items.length - 1]];
              const color =
                turn.speaker === null ? 'var(--line-soft)' : SPEAKER_COLORS[turn.speaker % SPEAKER_COLORS.length];
              return (
                <div
                  key={`turn-${ti}`}
                  // 一轮一条说话人色竖条 ⇒ "换人"一眼可见。
                  // 刻意**不引入** relative/absolute：子行的 offsetTop 仍以列表为基准，自动跟播照旧。
                  className="flex flex-col gap-0.5 pl-1"
                  style={{ borderLeft: `2px solid ${color}`, marginTop: ti > 0 ? 6 : undefined }}
                >
                  {/* 轮首：**谁 + 什么时候说的**。说话人在这里可改（改名 / 改归属），不再是只读文本。
                      刻意不把整行写成 `<button>`：里面要放 `<input>` 与一组按钮，
                      `<button>` 里嵌它们是非法的（同 renderRow 那条注释）。
                      `group` 加在本行上 ⇒ 只让**本行内**的小箭头随 hover 浮出，不牵动别处。 */}
                  <div className="group flex min-w-0 items-center gap-1 px-0.5 py-0.5">
                    {renaming && renaming.id === turn.speaker ? (
                      <input
                        ref={renameRef}
                        autoFocus
                        value={renaming.draft}
                        onChange={(e) => setRenaming({ id: renaming.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenaming(null);
                            return;
                          }
                          if (e.key === 'Enter') {
                            // 🔴 IME 守卫（同逐行改字：拼音未上屏时回车是"选词"，不挡会提交半截名字）
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            e.preventDefault();
                            void commitRename(renaming.id, e.currentTarget.value);
                          }
                        }}
                        // 失焦保存（点空白/点别处都算"我改完了"）；从 currentTarget 同步取 value（state 可能差一帧）
                        onBlur={(e) => void commitRename(renaming.id, e.currentTarget.value)}
                        placeholder="Speaker name"
                        // 提交中禁用：防止再敲一次键又发一遍（父级另有 `spkSubmitRef` 兜底）
                        disabled={spkSaving}
                        className="w-24 shrink-0 rounded border px-1 py-0.5 text-10 outline-none disabled:opacity-60"
                        style={{
                          borderColor: 'var(--line-soft)',
                          backgroundColor: 'var(--paper)',
                          color: 'var(--ink)',
                        }}
                        aria-label="Speaker name"
                      />
                    ) : (
                      <button
                        type="button"
                        // 只有**已归属**才有名字可改（`Unassigned` 是没有簇号的）；只读场景整个不渲染
                        disabled={!onRenameSpeaker || busy || turn.speaker === null}
                        onClick={() => {
                          if (turn.speaker === null) return;
                          setPick(null);
                          setRenaming({ id: turn.speaker, draft: names?.[turn.speaker] ?? '' });
                        }}
                        className="shrink-0 rounded px-0.5 text-10 font-medium transition-colors enabled:hover:bg-[var(--paper-hover)] disabled:cursor-default"
                        style={{ color: turn.speaker === null ? 'var(--ink-faint)' : color }}
                        title={turn.speaker === null ? 'Unassigned' : 'Rename this speaker (empty = Speaker N)'}
                      >
                        {speakerLabel(names, turn.speaker)}
                      </button>
                    )}
                    {/* 改归属：hover 才浮出的小箭头 ⇒ **就地**展开一排人（不用浮层：列表 overflow 会裁掉它）。
                        未归属的轮也要有这个入口 —— "把没人认领的一段归给某人"正是它最常见的用法。 */}
                    {picking === ti ? (
                      <span className="flex min-w-0 shrink items-center gap-0.5">
                        {[...speakerIds, null].map((id) => {
                          const on = id === turn.speaker;
                          const chip = id === null ? 'var(--line-soft)' : SPEAKER_COLORS[id % SPEAKER_COLORS.length];
                          return (
                            <button
                              key={id === null ? 'none' : id}
                              type="button"
                              onClick={() => void pickSpeaker(ti, id)}
                              className="max-w-[7rem] shrink-0 truncate rounded px-1 text-10 font-medium transition-colors"
                              style={{
                                color: on ? '#fff' : 'var(--ink-muted)',
                                backgroundColor: on ? chip : 'var(--paper)',
                              }}
                              title={id === null ? 'Mark this turn as unassigned' : `Assign this turn to ${speakerLabel(names, id)}`}
                            >
                              {speakerLabel(names, id)}
                            </button>
                          );
                        })}
                      </span>
                    ) : (
                      onUpdateSpeaker && (
                        <button
                          type="button"
                          // 转写/截取进行中不给改：转写完成会**整份覆盖** sidecar，这时改的归属必然被冲掉
                          disabled={busy}
                          onClick={() => {
                            setRenaming(null);
                            setPick(ti);
                          }}
                          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--paper)] disabled:cursor-not-allowed group-hover:opacity-100 group-focus-within:opacity-100"
                          style={{ color: 'var(--ink-muted)' }}
                          title="Change which speaker this turn belongs to"
                          aria-label="Change speaker"
                        >
                          <ChevronDown className="h-2.5 w-2.5" />
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      onClick={() => onSeek(first.t)}
                      className="flex min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                      title="Jump to where this speaker starts"
                    >
                      <span className="shrink-0 font-mono text-10" style={{ color: 'var(--ink-faint)' }}>
                        {mmss(first.t)}–{mmss(clampEnd(lastSeg.end))}
                      </span>
                    </button>
                  </div>
                  {turn.items.map((si) => (
                    <Fragment key={`row-${si}`}>
                      {renderRow(si)}
                      {draft?.kind === 'raw' && draft.after === si && renderDraft()}
                    </Fragment>
                  ))}
                </div>
              );
            })
          : segments.map((_, i) => (
              <Fragment key={`row-${i}`}>
                {renderRow(i)}
                {draft?.kind === 'raw' && draft.after === i && renderDraft()}
              </Fragment>
            ))}
      </div>
    </div>
  );
}
