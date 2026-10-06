'use client';

/**
 * ButlerDrawer —— 助理抽屉（微信式四栏）
 *
 * 为什么是「联系人模型」：原先中栏时间线是**两层叠加**——所有通知回执行铺在最上面、
 * 当前会话的气泡跟在后面，于是切换会话（清空气泡）在视觉上几乎不可见，通知与对话也永远混在同一条流里。
 * 现在每个联系人 = 一条会话 = 一个助理，中栏只显示**当前这一个联系人**的消息流。
 *
 * 四栏分工：
 *   - 左栏 48px：**纯图标功能键**（Buddy · Today · Memory · Calendar · Meeting），名字由悬停弹窗给出
 *   - 联系人列 168px（窄窗收成覆盖层）：**常驻**。置顶行 = 两个常驻联系人：**Bobby**
 *           （通知助理，系统推送类通知的归属）与**Recorder**（会议记录员）；两者都不可删除、
 *           无「人设」入口。其余 = 各会话（头像 / 标题 / 预览 / 时间 / 删除）。点击即切换中栏。
 *           **顶部是搜索栏**（2026-09-26 自中栏工具行移来）：同一个词同时过滤本列联系人与中栏时间线。
 *   - 中栏：**当前联系人的消息流** —— 工具行（人设 + 通知助理的「已读」开关）+ 时间线 + 输入框。
 *           普通联系人 = 该会话的消息气泡；通知助理 = 该线程的通知行 + 追问往返，按时间归并，
 *           通知行渲染成一张卡片：短回执（日历提醒等）的待办项**就在行内勾选**，
 *           报告类长文档（检查报告等）点卡片头部 → 右栏读正文。
 *           **对话气泡按微信的形态**（2026-09-26）：聊天底压成灰（--paper-soft），
 *           自己=绿气泡在右、对方=白气泡在左，头像在最外侧、气泡贴头像那侧带一枚小尖角。
 *           时间不再逐条贴在气泡上，改成微信式**居中灰色分隔条**——相邻两条相隔超过 5 分钟才插一条，
 *           文案随远近在「口语」与「精确」之间切换（今天只给「21:30」→「昨天 21:30」→
 *           「星期三 21:30」→「9月26日 21:30」→「2025年9月26日 21:30」）。
 *           通知卡片不走气泡形态、也不插分隔条：它头部自带的是**事件时间**，与消息时间不是一回事。
 *           **气泡带操作条**（2026-09-27）：鼠标移入这一行，气泡下方浮出复制 / 删除 / 多选三颗图标键
 *           （只给图标，文案放在悬停提示里——三颗写成文字会比气泡还长）。删除只删这一条；
 *           多选进入选择模式：每条气泡左侧出现勾选框、输入框上方浮出圆角矩形批量操作条
 *           （全选 / 复制所选 / 删除所选 / 退出）。落库走 DELETE /api/butler/threads/messages，
 *           按 role + 正文认领要删的那几条，**不动会话的 updated_at**（删一条不该把会话顶到
 *           联系人列最前，见 lib/butler/threads）。
 *           **流式等待有交代**（2026-09-26）：回答期间时间线末尾挂一条等待行
 *           （见 ButlerWaitingLine）——**不报「思考」、不报工具名、不带秒表**，
 *           只说一句随时长换档的人话，口吻跟着当前会话人设走（称呼 + 性格 / 说话风格）。
 *           它是**临时态**：只随 sending 渲染，整轮收尾即卸载，
 *           等待中的碎句不会留在消息列表、会话历史或最终结果里。
 *           **只有一个状态维度：已读 ≡ 归档**（2026-09-26 合并原 done / read 两维）。
 *           读 / 未读由卡片右端那颗**眼睛按钮**显式切换（2026-09-27 改，与日历面板同款）：
 *           睁眼 = 未读，点一下变闭眼 = 已读，再点恢复未读。**点开卡片不再顺手置已读**
 *           （原来点开就置读、卡片当场从当前界面退场，用户只是想看看却把列表看乱了）。
 *           反悔也可以走右栏底部那颗「标为已读 / 未读」药丸。
 *           **「已读」区不摊开待办，但支持批量清理**（2026-09-27 加回多选）：
 *           工具行的多选键只在「已读」视图出现，卡片行首出勾选框，输入框上方浮出「全选 / 删除所选 / 退出」；
 *           待办项仍不摊——归档区要的是清理，不是逐条完成。
 *           中栏工具行那颗开关（2026-09-27 起**只有一颗「已读」**）：不点亮 = 当前界面（未读通知），
 *           点亮 = 只看读过的；「待处理」标签已去掉——常态不需要名字。
 *           抽屉打开**不会**替用户置已读。
 *           输入框支持**附件上传**（回形针 / 拖拽 / 粘贴三条入口）——文件落 **Butler 自己的
 *           存储空间** `butler/<角色>/<日期>/attachments/`，发送时以「--- 资料列表 ---」块附在正文后，
 *           模型用 read_attachment 按绝对路径直读（与画布节点的附件方案**刻意不复用**，见 uploadButlerAttachment）。
 *   - 右栏（详情默认 420px、文档预览 560px）：**预览区 / 阅读器** —— 默认**不显示**（抽屉因此更窄），
 *           点左栏功能键 / 点中栏某条回执 / 点桌面通知才展开（「详情」分区还可由悬浮球直接唤起）。
 *           详情分区（= 通知助理）自 2026-09-26 起**只有阅读器一种形态**：没有列表层，
 *           同一份通知列表全项目只剩中栏一份；没选中任何一条时显示空态。
 *           底部动作：标为已读 / 标为未读（唯一的状态出入口），以及日历、下载 .md 等按 kind 出现的动作。
 *           **右栏是增量**：展开不从中栏扣面积，而是把抽屉整体加宽（中栏宽度不变）；
 *           窗口不够时先压右栏宽度，最后才动中栏。
 *           日报三页签（2026-09-27 起）**已整体移交右栏的 Today 面板**（Report / Schedule / Sticky），
 *           不再作为回执推送；仍会到这里来的只有知识库每日维护（kind=notes-maintenance）。
 *           栏首自带关闭键，可**单独收起**（不关整个抽屉）。
 *
 * 「左栏管右栏（分区）、联系人列管中栏（会话）」两条轴互相独立；
 * 窄窗下右栏与联系人列依次退化成覆盖层（同一套做法：绝对定位 + 返回键）。
 *
 * 悬挂方式仍是全局事件（butlerEvents.ts）：ButlerHost 只负责「右栏看哪个分区 + 哪份文档」，
 * 本组件负责渲染。**无遮罩**——抽屉从右侧滑出，点外部不关闭（Esc / 关闭键关闭）。
 *
 * 数据来源：butlerNotices store（ButlerNoticeHost 写入）+ /api/butler/inbox 历史
 * + /api/butler/threads 会话列表 / 单会话全文（含逐条时间戳）。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpCircle,
  Bell,
  Brain,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  Flag,
  /** 本地文件夹入口按钮（与回形针并排，见 attachFolder） */
  FolderOpen,
  Link2,
  ListChecks,
  Loader2,
  MapPin,
  Mic,
  PanelLeft,
  Paperclip,
  Pause,
  Play,
  Repeat,
  ScanSearch,
  Search,
  Sparkles,
  Square,
  Sun,
  Trash2,
  UserRound,
  UsersRound,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import {
  stripThinkTags,
  type ChatMessage,
  type ButlerNoticeItem,
  type WechatArticleCard,
  type WechatSearchTrace,
} from '@/lib/bus';
/** 周期规则短标签（纯函数，通知详情日程块复用日历面板的文案口径） */
import { recurrenceLabel } from '@/lib/calendar/recurrence';
/** 回执详情的展示格式层（2026-10-05 抽出，桌面与移动端共用一份口径）：
 *  formatTime / ScheduleDetail / fmtEventWhen / fmtReminderMinutes 见该文件注释。 */
import { fmtEventWhen, fmtReminderMinutes, formatTime, type ScheduleDetail } from './noticeFormat';
/** 头像：人物素材 id + 底色都由名字/性格稳定派生（纯函数，见文件注释） */
import { avatarTint, defaultAvatarId } from '@/lib/butler/avatar';
import PersonaAvatar from '@/components/butler/PersonaAvatar';
/** 会话列表项 / 人设 / 思考档位清洗（threads-shared 是纯类型 + 纯函数模块，无 fs，可进客户端包） */
import {
  ATTACHMENTS_BLOCK_HEAD,
  WORKSPACE_BLOCK_HEAD,
  parseThinkingLevel,
  parseWorkspaceFolder,
  stripInjectedBlocks,
} from '@/lib/butler/threads-shared';
import type {
  ButlerPersona,
  ButlerThreadSummary,
  ButlerWorkspaceFolder,
  ThreadMessageHit,
} from '@/lib/butler/threads-shared';
import {
  buildCommandTextAtLine,
  detectCommand,
  filterCommands,
  getLineAtCursor,
  hasCommandIntent,
  loadCommandUsage,
  normalizeSlashInput,
  recordCommandUsage,
  type ButlerCommand,
} from '@/lib/core/commands';
/** 报告类回执判定（决定右栏是否渲染「复制链接 / 下载 .md」）；分享 URL 与文件名规则
 *  已随 2026-10-05 的 noticeActions 抽出，本文件不再直接引用。 */
import { isShareableReportKind } from '@/lib/butler/report-share';
/** 附件上传：复用画布 composer 的 base64 与体积格式化（**只借这两个纯函数**——
 *  上传端点不同：Butler 走 /api/butler/attachments 落自己的存储空间，见下方 uploadButlerAttachment）。 */
import { fileToBase64, formatFileSize } from '@/components/canvas/composer/useComposer';
/** desktop = 系统目录选择器（选本地文件夹）；isDesktop = 浏览器 dev 下判空，见 attachFolder */
import { desktop, isDesktop } from '@/lib/desktop-adapter';
/** 语音输入：录音状态机 + 麦克风左侧内联展开的录音条（与画布聊天节点的输入框共用同一套，见该文件注释） */
import { VoiceRecordBar, useVoiceInput, appendVoiceText } from '@/components/ui/voice-input';
/** 会话级选型控件：模型品牌 logo + 思考档位月相图标（与画布对话节点同款，见 chatNodeKernelParts） */
import { ModelBrandLogo, MoonPhaseIcon } from '@/components/canvas/chatNodeKernelParts';
/** 朗读回复：与上面的语音输入对称的出口（引擎 = 设置里已选中的那一款 TTS） */
import { stopReadAloud, useReadAloud } from './useReadAloud';
import { clearActiveThreadId, readActiveThreadId, writeActiveThreadId } from './butlerSession';
import { extractOutputFiles, restoreOutputFileLines } from '@/lib/butler/output-files';
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  getAvailableModels,
  type MessageAttachment,
  type ProviderConfig,
  type ThinkingLevel,
} from '@/lib/types';
/** 对话模型判定（自动选型与抽屉模型下拉共用一条正则，见 model-tags 注释） */
import { isChatModel } from '@/lib/model-tags';
/** 读设置（模型池 → 抽屉模型下拉候选；选型本身按会话存在线程文件里） */
import { loadSettings } from '@/lib/settings';
import { ButlerConfirmModal, type ButlerConfirmState } from '@/components/canvas/ButlerConfirmModal';
/** 正文渲染器：与画布对话节点同源（rAF 合并 + 200ms 节流 + 未闭合代码围栏稳定化）。
 *  HtmlRenderer 早已由 page.tsx → CanvasFlow → ChatNodeKernel 进入首屏包，故此处静态引用不新增首载成本。 */
import { StreamingMarkdown, openFileByProjectRelPath } from '@/components/canvas/HtmlRenderer';
import QuestionPopup, {
  type AnswerEntry,
  type QuestionItem,
} from '@/components/canvas/QuestionPopup';
import { useConfirm } from '@/components/canvas/ConfirmDialog';
/** 复制到剪贴板：Electron / 非 secure context 下 navigator.clipboard 可能不可用，这里带 execCommand 降级 */
import { copyText } from '@/components/canvas/chatNodeKernelUtils';
import LoginDialog from '@/components/canvas/LoginDialog';
import { kindMeta, loadInboxHistory, watchForUnreadGrowth } from './ButlerNoticeHost';
import { ButlerTodayPanel } from './ButlerTodayPanel';
import { ButlerMemoryConsole } from './ButlerMemoryConsole';
import { ButlerDocPanel } from './ButlerDocPanel';
import { ButlerCalendarPanel } from './ButlerCalendarPanel';
/** 检索实况面板（2026-10-05 自本文件抽出，见 ./ButlerSearchTrace 文件头）：桌面右栏 search 分区
 *  与移动端 /butler 分区栈共用同一份实现，避免「复制一份」造成的双真源。原名为 WechatSearchTrace。 */
import { ButlerSearchTrace } from './ButlerSearchTrace';
/** 回执动作层（2026-10-05 抽出）：桌面与移动端共用同一套落库链路，见 ./noticeActions */
import { copyNoticeReportLink, downloadNoticeMd, removeNoticesByIds, toggleNoticeItem } from './noticeActions';
/** 公众号检索整条链路（状态 + SSE 判定 + 历史回看）：桌面与移动端共用一份，见 ./useWechatSearch */
import { useWechatSearch } from './useWechatSearch';
/** 会议模式控制台：会议进行中顶替中栏（顶部条 + 实时字幕流），见该文件注释 */
import { MeetingConsole, type MeetingSnapshot } from './MeetingConsole';
import { MeetingStart } from './MeetingStart';
import PersonaDialog from './PersonaDialog';
import {
  getButlerNotices,
  patchButlerNotice,
  subscribeButlerNotices,
  type ButlerNotice,
} from './butlerNotices';
import { BUTLER_UNREAD_CHANGED_EVENT, notifyButlerUnreadChanged, openButlerDoc } from './butlerEvents';

/**
 * 正文文件链接的接管回调（稳定引用，避免破坏 HtmlRenderer 的 memo）。
 *
 * 点开 Butler 正文里的 `homework/…` / `materials/…` 链接时，**开在抽屉自己的右栏**
 * （ButlerDocPanel，复用画布的 md 阅读器）。不能走 file.open：抽屉是覆盖式浮层
 * （z-[1320]），画布右侧预览面板会被它整块遮住，表现为「点了没反应」。
 */
const openDocInDrawer = (path: string): boolean => {
  openButlerDoc(path);
  return true;
};

/**
 * 右栏（预览区）的分区：由左栏功能键切换。
 * **中栏恒为 Butler 会话**，不随本分区改变——分区只决定右栏显示什么。
 *
 * 'search' = 公众号「检索实况」（**没有左栏键**，由「Search WeChat Articles」触发时自动切入）：
 * 逐篇显示召回结果与 AI 精选的判定（留下 / 去除）。它是**过程态**，不落库。
 */
export type ButlerSection = 'detail' | 'today' | 'preferences' | 'rules' | 'calendar' | 'meeting' | 'search';

export interface ButlerDrawerProps {
  section: ButlerSection;
  onSectionChange: (s: ButlerSection) => void;
  /** 右栏文档预览路径（空 = 展示选中回执详情） */
  docPath: string | null;
  onCloseDoc: () => void;
  onClose: () => void;
  /** 桌面通知点击后要定位的回执 id（由 ButlerHost 从事件里取出后传入） */
  focusNoticeId?: string | null;
}

/** 单条会话的取回结果：气泡 + 会话级选型（模型 / 思考档位，见 lib/butler/threads-shared） */
interface SessionState {
  messages: DialogMessage[];
  /** `provider:modelId` 标签；null = 未存过选型（Auto 时代的存量会话），由迁移 effect 落成具体模型 */
  modelId: string | null;
  /** null = 未选（回默认档） */
  thinkingLevel: ThinkingLevel | null;
  /** 会话级工作区（用户指定 · 锁定操作范围）；null = 未指定（见 lib/butler/threads-shared） */
  workspaceFolder: ButlerWorkspaceFolder | null;
}

/** 抽屉模型下拉的一项（标签即 `provider:modelId`，与 /api/butler/threads 的 modelId 同构） */
interface ModelOption {
  tag: string;
  label: string;
  /** 是否推理模型（否 → 思考档位不可选，与画布对话节点同口径） */
  thinking: boolean;
}

interface DialogMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time: number;
  pending?: boolean;
  /** 检索到的文章卡片（仅「小微」搜索综述消息携带；随线程落库，刷新后仍在） */
  cards?: WechatArticleCard[];
  /** 本轮检索的实况账本（同上随消息落库）；有它 → 气泡下方出现「查看检索实况」入口 */
  searchTrace?: WechatSearchTrace;
}

/**
 * 中栏时间线的一项：通知卡片（通知助理里）或会话气泡。
 * 两者在通知助理里按时间归并成一条流——所以必须共用同一个 time 口径（都有逐条时间戳）。
 *
 * 2026-09-27：日报三页签已移交 Today 面板、不再进通知中心，原先「同日日报并卡」的
 * `mates` 归组随之取消——每条回执各成一张卡片。
 */
type TimelineItem =
  | { kind: 'notice'; key: string; notice: ButlerNotice }
  | { kind: 'msg'; key: string; msg: DialogMessage };

function timeOfItem(it: TimelineItem): number {
  return it.kind === 'notice' ? it.notice.time : it.msg.time;
}

/**
 * 取一条会话的**当前消息**并统一成气泡。返回 null = 会话不存在 / 已过期（调用方保持原样）。
 *
 * 气泡 id 取 `h-<服务端 messages 数组下标>`（不是「剥掉 system 之后的顺序号」）。
 * ⚠️ 这个下标只是**提示**：服务端会裁头（threads-shared.trimThreadMessages 只留最近 N 轮），
 * 裁过之后旧气泡上的下标就整体偏大了。删除**不作数于它**——服务端按 role + 正文认领，
 * 下标只在两条正文逐字相同时帮着认准是哪一条（见 deleteMessages）。
 * 逐条时间由服务端随会话下发（tail_times，见 threads-shared.messageTimeAt）；缺失时退化用 updatedAt。
 */
/** 取一条会话的**消息 + 会话级设置**（模型 / 思考档位 / 工作区），供切联系人时一并回填。 */
async function fetchSessionState(threadId: string): Promise<SessionState | null> {
  const res = await fetch(`/api/butler/threads?threadId=${encodeURIComponent(threadId)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    messages?: ChatMessage[];
    updatedAt?: number;
    times?: number[];
    indexes?: number[];
    modelId?: string | null;
    thinkingLevel?: string | null;
    workspaceFolder?: unknown;
  };
  const fallback = data.updatedAt ?? Date.now();
  return {
    messages: (data.messages ?? []).map((m, i) => {
      const isUser = m.role === 'user';
      const msg: DialogMessage = {
        id: `h-${data.indexes?.[i] ?? i}`,
        role: isUser ? 'user' : 'assistant',
        // user 侧再剥一层「注入块」：块随正文落库，重开会话会读回，不剥就会在气泡里
        // 冒出「--- 工作区 … ---」机器文案（刚发出去那条用的是干净原文，两条路径要一致）。
        content: isUser ? stripInjectedBlocks(stripThinkTags(m.content)) : stripThinkTags(m.content),
        time: data.times?.[i] ?? fallback,
      };
      // 小微搜索综述自带文章卡片（落库字段）→ 透传到时间线渲染
      if (m.cards?.length) msg.cards = m.cards;
      // 检索实况账本（落库字段）→ 气泡下方「查看检索实况」入口据此渲染；账本随消息生死
      if (m.searchTrace?.items?.length) msg.searchTrace = m.searchTrace;
      return msg;
    }),
    modelId: typeof data.modelId === 'string' ? data.modelId : null,
    thinkingLevel: parseThinkingLevel(data.thinkingLevel),
    workspaceFolder: parseWorkspaceFolder(data.workspaceFolder),
  };
}

/**
 * 上传一个附件到 **Butler 自己的存储空间**（`<APP_ROOT>/butler/<角色>/<日期>/attachments/`）。
 *
 * 为什么不复用画布的 uploadAttachment：那个端点以 **nodeId** 为文件夹键、落**项目**的
 * materials/attachments（生命周期绑画布节点；materials 一侧还登记进项目材料 manifest、
 * 参与 search_materials 正文检索）。Butler 不是画布节点、没有 nodeId，也不属于任何
 * 「项目资料」语义——同一份文件不该因为换了项目就失效。故这里是独立端点
 * `/api/butler/attachments`，服务端按**会话 threadId** 解析角色、按上传日归档
 * （路径真源见 lib/butler/storage.ts），与 butler/preferences.md 同在 butler/ 下。
 *
 * 回传的 `path` 是**绝对路径**：read_attachment 的路径解析在越出项目根时走 isReadablePath
 * 校验，该校验对 appRoot 全量放行，butler/ 在其内——相对路径会被解析到项目根下必然落空。
 *
 * threadId 为空（新会话首条消息发出前）→ 服务端兜底落 `未分类` 角色目录。
 */
async function uploadButlerAttachment(threadId: string | null, file: File): Promise<MessageAttachment> {
  const base64 = await fileToBase64(file);
  const resp = await fetch('/api/butler/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: threadId ?? '',
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      data: base64,
    }),
  });
  const j = (await resp.json()) as { success?: boolean; attachment?: MessageAttachment; error?: string };
  if (!j.success || !j.attachment) throw new Error(j.error || `HTTP ${resp.status}`);
  return j.attachment;
}

/**
 * 待发附件 → 「--- 资料列表 ---」文本块（与画布 composer.renderMaterialBlock 同格式，
 * 追加在正文之后——与画布 `text + blocks` 的口径一致）。
 * 路径用附件自身的 `path`（Butler 侧是绝对路径），并显式提示模型用 read_attachment 读取、
 * 勿向用户索要；否则模型看到陌生绝对路径会倾向先反问「请把文件发我」。
 *
 * ⚠️ 目录**不走这里**：目录是**会话级工作区**（常驻、每轮注入，见 workspaceBlock），
 * 不混进本轮附件列表——否则模型会把「本会话的操作范围」误当成「这条消息带的一份资料」。
 */
function attachmentBlock(atts: MessageAttachment[]): string {
  if (atts.length === 0) return '';
  const lines = atts
    .map((a, i) => {
      const kind = a.type === 'text' ? 'Text' : a.type === 'image' ? 'Image' : 'File';
      return `  ${i + 1}. ${a.name} (${kind}, ${formatFileSize(a.size)})\n     Path: ${a.path}`;
    })
    .join('\n');
  return `${ATTACHMENTS_BLOCK_HEAD}\n${lines}\n--- End of attachments ---\n\nTo learn what the attachments contain, read them with the read_attachment tool (their paths are listed above — do not ask the user for them).`;
}

/**
 * 会话级**工作区** → 「--- 工作区 ---」文本块（**每轮都注入**，与一次性附件分开）。
 * 语义对齐画布「操作目录」的锁定版（composer/useComposer.buildFolderBlock 的 sent-folder）：
 * 明确「用户指定 · 锁定操作范围」，让模型把文件读写严格收在这个目录内、不得越出。
 *
 * 为什么每轮都带：工作区是**常驻状态**而不是某条消息的附件，模型每轮上下文里都得看到它，
 * 否则中途几轮它就会「忘记」范围。注入成本很低（几行文本），换来的是行为稳定。
 */
function workspaceBlock(folder: ButlerWorkspaceFolder | null): string {
  if (!folder) return '';
  return (
    `${WORKSPACE_BLOCK_HEAD}\n- ${folder.name}\n  路径: ${folder.path}\n` +
    '这是用户为本会话指定的工作区：文件读写请严格集中在该目录内（使用完整绝对路径），不得越出该目录。' +
    '先用 list_directory 看清目录里有什么，再用 read_file / write_file 等文件工具操作。\n' +
    '--- 工作区结束 ---\n'
  );
}

/** kind → 分区（与原通知中心同一分类口径，保证历史回执落入正确的筛选 chip） */
type BucketKey = 'schedules' | 'actions' | 'web' | 'notes' | 'meeting';
const BUCKET_OF: Record<string, BucketKey> = {
  check: 'schedules',
  todo_del: 'schedules',
  calendar: 'schedules',
  'notes-maintenance': 'schedules',
  task: 'actions',
  note: 'actions',
  info: 'actions',
  web: 'web',
  notes: 'notes',
  meeting: 'meeting',
};
const BUCKET_LABEL: Record<BucketKey, string> = {
  schedules: 'SCHEDULES',
  actions: 'ACTIONS',
  web: 'WEB',
  notes: 'NOTES',
  meeting: 'MEETINGS',
};

function bucketOf(n: ButlerNotice): BucketKey | null {
  return BUCKET_OF[n.kind] ?? null;
}

/**
 * 搜索匹配：标题 / 正文 / 待办项标题 / 类别名。
 * 类别筛选已并入搜索（不做独立 chips）：输入 schedules / notes 等类别名即按类过滤。
 */
function matchesQuery(n: ButlerNotice, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  const bucket = bucketOf(n);
  if (bucket && BUCKET_LABEL[bucket].toLowerCase().includes(s)) return true;
  if (n.title.toLowerCase().includes(s) || n.body.toLowerCase().includes(s)) return true;
  return (n.items ?? []).some((it) => it.title.toLowerCase().includes(s));
}

/** 命中片段：先压成单行，再以关键词为中心截前后各一段（微信式「…命中…」），返回文本与关键词在其中的下标 */
function hitExcerpt(content: string, q: string): { text: string; at: number } {
  const one = content.replace(/\s+/g, ' ').trim();
  const i = q ? one.toLowerCase().indexOf(q) : -1;
  const start = i < 0 ? 0 : Math.max(0, i - 24);
  const end = i < 0 ? Math.min(one.length, 64) : Math.min(one.length, i + q.length + 40);
  const lead = start > 0 ? '…' : '';
  const tail = end < one.length ? '…' : '';
  return { text: `${lead}${one.slice(start, end)}${tail}`, at: i < 0 ? -1 : lead.length + (i - start) };
}

/**
 * 等待话风：温和（默认）/ 高冷（傲娇·毒舌·冷静…）/ 简洁（少话·利落）。
 * 从**用户填的人设**里读性格与说话风格，关键词命中即取；未命中走温和，
 * 于是「换个人设，等待时的口吻也跟着换」，不需要用户额外配置。
 */
function waitVoiceOf(persona: ButlerPersona | null): 'warm' | 'cool' | 'brief' {
  const t = `${persona?.template ?? ''} ${persona?.personality ?? ''} ${persona?.style ?? ''}`;
  if (/tsundere|傲娇|毒舌|高冷|冷静|沉稳|严肃|冷淡/.test(t)) return 'cool';
  if (/简洁|简短|少话|利落|不啰嗦|直接/.test(t)) return 'brief';
  return 'warm';
}

/** 三档等待口语（0-5s / 5-25s / 25s+），每 5 秒轮换一句；越久越安抚，但始终是「一个人在跟你说话」。
 *
 *  重写于 2026-09-27。上一版三档其实都在说同一件事——「我在处理，请稍等」，只是换了字数和语气词，
 *  读起来像客服话术模板。这一版立了三条规矩：
 *    ① **句式不重样**：口头反射（「这就去」）、自言自语（「想一下」）、安抚（「手上没停」）、
 *       自嘲（「比看着费劲」）各来一点；三档之间也换腔调，越久越软。
 *    ② **只写永远成立的话**：不写「在查资料 / 在写代码」这类**具体动作**——那是在猜进度，猜错就露馅。
 *       创意全落在**怎么说**，不在**说什么**，所以它不可能说错话。
 *    ③ **句子不以「…」收尾**：行尾已经挂了三个跳动点，再缀一个省略号就是同一个"话没说完"说两遍。
 *       （cool 档句首的「……」是语气停顿，不在此列。）
 *  注：0-5s 档轮换索引恒为 0，只会用到每档第一句，故首句单独打磨——warm 那句还会被拼上称呼（「老板，……」）。
 */
const WAIT_LINES: Record<'warm' | 'cool' | 'brief', [string[], string[], string[]]> = {
  // 温和：像个熟人同事，先应一声，久了自己也着急
  warm: [
    ['On it.', 'Let me take a look.'],
    ['Thinking, one sec.', 'Hands full, hold on.', 'Let me sort this out.'],
    ['This is rougher than it looks, pushing on.', "Sorry for the wait, I'm not slacking.", 'Just a bit longer, almost there.'],
  ],
  // 高冷：嘴上不饶人，手上没停；不解释、不道歉，但会认账
  cool: [
    ['...Mm, watching it.', "...What's the rush, looking now."],
    ["Not stuck, just thinking.", "Rushing won't make it faster.", '...Working on it, quit staring.'],
    ["...I know it's been a while — rushing won't help.", "Slow, but I'm not slacking.", "Hold on, this can't be rushed."],
  ],
  // 简洁：能省则省，但每个字都还在动
  brief: [
    ['Taking a look.', 'One sec.'],
    ['On it.', 'Almost.', 'Still moving.'],
    ['Not done yet.', 'A bit more.', 'Nearly there, one sec.'],
  ],
};

/**
 * Butler 的等待行 —— 它**就是那条还没吐字的助手气泡**：头像 → 灰底气泡（一句随时长换档的口语
 * + 行尾三个跳动的点）。口语每 5 秒换一句，越久越安抚。
 *
 * 为什么并进气泡里（2026-09-27 改）：原来它是时间线末尾一条**裸文字**，而它正上方还悬着一条
 * 「头像 + 三个点」的空占位气泡——一句完整的话与一堆没有主语的点并排出现，读起来是割裂的
 * 「两个东西」，不像「对面那个人正在打字」。并进气泡后，口语与点同属一个说话人，并与正式回复
 * 共用同一套灰底气泡样式：吐字时只是文字接着往下长，视觉上不跳。
 * （发送期间调用方会跳过那条空占位气泡，见中栏时间线，否则这里会出现两颗头像。）
 *
 * 不报「思考」、不报工具名、不带秒表，也不猜具体动作（见 WAIT_LINES 的规矩②）：只写永远成立的话，
 * 创意落在怎么说而不是说什么，因此不可能说错话。
 * 口吻与**当前会话人设**关联：称呼（addressUser）与话风（性格 / 说话风格）都从 persona 取，
 * 温和档第一句会带上对用户的称呼（「老板，这就去」），读起来就是这个人说的。
 */
function ButlerWaitingLine({
  persona,
  since,
  title,
  personality,
}: {
  persona: ButlerPersona | null;
  since: number;
  title: string;
  personality?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const sec = since > 0 ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  const addr = persona?.addressUser?.trim() || '';
  const voice = waitVoiceOf(persona);
  const tiers = WAIT_LINES[voice];
  const pool = sec < 5 ? tiers[0] : sec < 25 ? tiers[1] : tiers[2];
  let line = pool[Math.floor(sec / 5) % pool.length];
  // 温和档的第一句带上人设对用户的称呼（人设没填称呼就保持原样）
  if (voice === 'warm' && sec < 5 && addr) line = `${addr}, ${line}`;
  return (
    <div className="flex items-start gap-2">
      {/* 头像：与正式回复同款同尺寸——等待与正文是同一个说话人，换的只是气泡里的字 */}
      <ContactAvatar name={title} personality={personality} size={BUBBLE_AVATAR_SIZE} />
      <div
        className="relative flex min-w-0 max-w-[80%] items-center gap-1.5 px-3 py-1.5 text-xs"
        style={bubbleOtherStyle}
      >
        {/* 句子在前、跳点在右：点只表示"话还没说完"，收在句尾才像对面那个人一边打字一边说 */}
        <span className="min-w-0 truncate">{line}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="think-dot" />
          <span className="think-dot" />
          <span className="think-dot" />
        </span>
        <BubbleTail side="left" color={WECHAT_OTHER_BUBBLE} />
      </div>
    </div>
  );
}

/**
 * （原 `formatTime` / `ScheduleDetail` / `fmtEventWhen` / `fmtReminderMinutes`
 *  已于 2026-10-05 迁往 `./noticeFormat`，桌面与移动端共用；本地仅保留 import。）
 */

/**
 * 联系人列**标题右侧**那枚时间（比 formatTime 更省宽度）：
 *   当天 → 只给时间「21:30」（此刻最关心它多新）
 *   更早 → 只给日期「09-26」，**不带时分**（同一天的旧消息，几点几分没有意义）
 * 跨年补上年份（2025-09-26），否则只看月日分不出是哪一年。与 formatTime 的「日期+时间」分工不同，
 * 故不合并：那边是通知卡片头，宽度够、要精确到分。
 */
function formatListTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 微信式时间分隔条：相邻两条消息相隔超过 5 分钟才插一条（微信聊天就是这条规则）。 */
const WECHAT_TIME_GAP_MS = 5 * 60 * 1000;

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * 微信式时间分隔**文案**（中栏时间线专用，与 formatTime 的列表紧凑格式分工不同）：
 *   今天 → 只给时间「21:30」
 *   昨天 → 「昨天 21:30」
 *   前天 → 「前天 21:30」
 *   2~6 天前 → 「星期三 21:30」
 *   同年更早 → 「9月26日 21:30」
 *   跨年 → 「2025年9月26日 21:30」
 * 与微信一致：越近的会话越口语（相对日），越远越精确（绝对日期）。
 */
function wechatTimeLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(n) - dayStart(d)) / 86400000);
  if (dayDiff <= 0) return hm;
  if (dayDiff === 1) return `Yesterday ${hm}`;
  if (dayDiff === 2) return `2 days ago ${hm}`;
  if (dayDiff <= 6) return `${WEEKDAY_EN[d.getDay()]} ${hm}`;
  if (d.getFullYear() === n.getFullYear()) return `${MONTH_EN[d.getMonth()]} ${d.getDate()} ${hm}`;
  return `${MONTH_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hm}`;
}

/**
 * （原 `WechatPhase` 阶段枚举已随检索流程迁往 `./useWechatSearch`，本文件不再持有它。）
 */

/** 微信式时间分隔条：**居中、极小、灰字**，不占底色——它只是时间轴上的一个刻度 */
function TimeSeparator({ ms }: { ms: number }) {
  return (
    <div className="flex justify-center py-0.5">
      <span className="text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
        {wechatTimeLabel(ms)}
      </span>
    </div>
  );
}

/**
 * 气泡配色：**自己=绿、对方=灰**。
 * 对方（AI 回复）取 --paper-soft（#efeff2）：2026-09-26 按用户口径，灰要淡到与
 * Butler 侧栏一致（左轨 / 联系人列同底 --paper-soft）——白底上只留一层极淡的分色，不描边。
 * 绿只留在自己一侧（#95EC69 是「微信感」最认得出的一处，这次没动）。
 */
const WECHAT_SELF_BUBBLE = '#95ec69';
const WECHAT_OTHER_BUBBLE = 'var(--paper-soft)';
/** 气泡圆角：微信不是胶囊，是很小的圆角（这里取 8px，比应用其它面板方正一档） */
const WECHAT_BUBBLE_RADIUS = 8;
/** 气泡头像边长（微信两侧头像同尺寸） */
const BUBBLE_AVATAR_SIZE = 32;
/**
 * 抽屉内区域分割线（左轨右边界 / 联系人列右边界 / 中栏工具行下沿 / 右栏左边界 …）：
 * 比 --line-soft（--line 的 0.08 档）再淡两档 ≈0.03 —— 区域边界只留"看得出分区"的程度，
 * 白底上不再切成一块块。描边（输入框、头像方格、选中态）仍用 --line，不跟着变淡。
 */
const DIVIDER_SOFT = '1px solid color-mix(in oklab, var(--line-soft) 40%, transparent)';
/** 气泡圆角 + 微信式小尖角（朝头像一侧）：尖角是微信气泡的识别点之一 */
const bubbleSelfStyle = {
  backgroundColor: WECHAT_SELF_BUBBLE,
  color: 'var(--ink-strong)',
  borderRadius: WECHAT_BUBBLE_RADIUS,
};
const bubbleOtherStyle = {
  backgroundColor: WECHAT_OTHER_BUBBLE,
  color: 'var(--ink)',
  borderRadius: WECHAT_BUBBLE_RADIUS,
};

/**
 * 「我」这边的头像：与 Butler 侧栏（左轨那颗助理标）**同一张河马线稿**（/butler-orb.png），
 * 也照它那样装在白底圆角方格里（--panel-bg + 1px --line）。
 * 同一张图在同一抽屉里出现两次，读到的才是同一个身份；此前是用「我」派生出的 emoji 头像。
 */
function SelfAvatar({ size }: { size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: 'var(--panel-bg)',
        border: '1px solid var(--line)',
      }}
      aria-hidden
    >
      <img src="/butler-orb.png" alt="" draggable={false} className="h-5 w-5 select-none" />
    </span>
  );
}

function BubbleTail({ side, color }: { side: 'left' | 'right'; color: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute h-0 w-0"
      style={{
        top: 11,
        left: side === 'left' ? -5 : undefined,
        right: side === 'right' ? -5 : undefined,
        borderTop: '5px solid transparent',
        borderBottom: '5px solid transparent',
        borderRight: side === 'left' ? `5px solid ${color}` : undefined,
        borderLeft: side === 'right' ? `5px solid ${color}` : undefined,
      }}
    />
  );
}

/**
 * 窗口宽度断点。抽屉是**居中弹窗**（宽 = 各栏实测宽度之和，高 min(760px,86vh)），
 * 窄窗下依次降级，否则中栏被挤成一条缝：
 *   - < NARROW_W：右栏改为**覆盖层**（点开回执才盖住列表，带返回键）
 *   - < TIGHT_W：左栏收成纯图标（48px）+ **联系人列也收成覆盖层**（工具行的开关按钮展开），
 *     把宽度全让给当前会话
 * 阈值随四栏重算过：右栏常驻需要 84 + 200 + 420 + 中栏 340，故 NARROW_W 取 1000。
 */
function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}
/** 视口高度：面板手动几何（拖动 / 拖拽改尺寸）的钳位与最大化要用，口径同 useWindowWidth */
function useWindowHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}
/** 数值钳位（拖动/缩放用；min > max 时以 max 为准，优先保证「不越出视口」） */
function clampNum(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, max), Math.min(min, max));
}
const NARROW_W = 1000;
const TIGHT_W = 640;

/**
 * 联系人列宽度（常驻栏 / 窄窗覆盖层同宽，覆盖层只是改成绝对定位）。
 * 2026-09-26 由 200 收到 168：行首加了 30px 头像，靠缩边距 / 删键让位，
 * 中栏反而多出一截——这一列只承担「找得到人」，不承担阅读。
 */
const CONTACTS_W = 168;

/**
 * 中栏（对话）宽度上限：余量优先给中栏（对话区），不够了才回落右栏。
 * 2026-09-27 自 420 放宽到 560：用户要求「中间对话区域加宽」，回到更舒展的阅读宽度。
 * 放宽只影响自适应宽度 autoW（中栏本身是 flex-1，靠抽屉整体加宽而非向内挤压右栏）；
 * 右栏仍先满足 rightDesiredW，余量不足时才压到 RIGHT_MIN_W。
 */
const CHAT_MAX_W = 560;
/** 右栏最小宽度：再窄列表 / 待办就挤不下，宁可让抽屉整体加宽 */
const RIGHT_MIN_W = 280;

/**
 * 系统推送类通知（= 常驻「通知助理」的联系人范围）。
 * 真源在 lib/core/butler-notify.ts 的 isNotifyKind（服务端落库时兜底把这些 kind 的 thread_id
 * 填成常驻线程）；这里按 kind 再兜一层，覆盖两种情况：① 存量行（上线前落库、尚未归位）；
 * ② 实时推送刚落内存（POST 响应里的 thread_id 还没回到 store）。
 * meeting：会议纪要 / 会议记录也是系统回执（服务端 meeting-finalize 直写 inbox），
 * 2026-09-27 起并入这里 —— 否则它既进不了本时间线、又被行角标计入，
 * 表现为「Bobby 没有未读项却亮着角标」。
 */
const NOTIFY_KINDS = new Set(['notes-maintenance', 'calendar', 'meeting']);

/**
 * 抽屉（居中弹窗）高度上限：min(760px, 86vh)。
 * 宽度**不再写死**——见下方 drawerW，由各栏实测宽度之和得出，
 * 上限只受 DRAWER_W_RATIO（按 vw 收口、四周留边距）约束。
 */
const DRAWER_W_RATIO = 0.9;
const DRAWER_MAX_H = 760;
const DRAWER_H_RATIO = 0.86;

/**
 * 面板手动几何（拖动移动 / 拖拽改尺寸）。
 *
 * 为什么要落盘：抽屉是**条件挂载**（ButlerHost 里 `{drawer && <ButlerDrawer/>}`），
 * 关一次即卸载 —— 几何不存盘的话每次打开都弹回居中态，用户刚拖好的位置就白拖了。
 * null / 读不到 = 从未手动调整过 → 完全走原来的「居中 + 各栏之和」自适应。
 */
const DRAWER_GEOM_KEY = 'butler.drawer.geom.v1';
/** 手动改尺寸的下限：左栏 84 + 联系人列 168 + 中栏 ~270（再窄中栏就没法读消息了） */
const DRAWER_MIN_W = 520;
const DRAWER_MIN_H = 360;
/** 面板四周至少留出的边距（拖动/缩放钳位用，防拖出屏幕后抓不回来） */
const DRAWER_EDGE = 8;
/** 右下角把手的边长（同时改宽高）；右缘/下缘是 4~5px 的窄热区 */
const DRAWER_GRIP = 14;
/**
 * 拖动生效的位移阈值（px）：小于它一律算**单击**，不冻结、也不落盘手动几何。
 * 为什么必须挡：左栏空白抓取面 / 右缘把手只要 pointerdown 就 `freezeBox()` 把抽屉当时的矩形
 * 冻结成手动几何，pointerup 又无条件落盘——没有位移阈值时，**单击一下就永久锁死尺寸**。
 * 锁死之后右栏展开不再把抽屉整体加宽，只能在固定宽度里向内挤压中栏（对话区域）；
 * 且几何存在 localStorage（安装版 origin 固定 http://localhost:8321），跨版本一直背着。
 */
const DRAG_THRESHOLD = 3;

interface DrawerGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function readDrawerGeom(): DrawerGeom | null {
  try {
    const raw = localStorage.getItem(DRAWER_GEOM_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<DrawerGeom>;
    const nums = [g.x, g.y, g.w, g.h];
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
    return { x: g.x as number, y: g.y as number, w: g.w as number, h: g.h as number };
  } catch {
    return null;
  }
}
function writeDrawerGeom(g: DrawerGeom | null): void {
  try {
    if (g) localStorage.setItem(DRAWER_GEOM_KEY, JSON.stringify(g));
    else localStorage.removeItem(DRAWER_GEOM_KEY);
  } catch {
    /* 隐私模式 / 存储被禁：几何存不下只影响下次打开，本次交互不受影响 */
  }
}

/**
 * 当前会话指针的 localStorage key。
 * 为什么必须落盘：抽屉是**条件挂载**（ButlerHost 里 `{drawer && <ButlerDrawer/>}`），
 * 关一次即卸载，组件内 ref（threadIdRef）随之归零 —— 原先因此每次打开都是「全新会话」，
 * 盘上堆了一堆无人认领的孤儿会话。指针持久化后，重开抽屉会接回上次聊的那条。
 * 'panel' 会话无 TTL，指针指向的行不会自行消失；指向已删行时前端会退到列表最新一条。
 *
 * 键与读写实现已于 2026-10-02 外移到 `./butlerSession`：心跳（ButlerNoticeHost）也需要读它。
 */

/**
 * Today 键红点的「已读」标记（localStorage，值是看过的摘要日期键 YYYY-MM-DD）。
 *
 * 红点口径：当日 Report 摘要（每天 9:00 生成并落缓存）已存在、且用户还没点开过 Today。
 * 阅读状态只存本机 —— 这是单机应用、没有多端同步诉求，服务端不必为此存状态。
 * 存**日期键**而不是布尔：隔天摘要轮换后自然重新亮起，用户 8:00 先打开 Today（当时还没有摘要）
 * 也不会把 9:00 才生成的那份误标为已读。
 */
const TODAY_SEEN_KEY = 'butler.today-digest.seen.v1';

/** 红点探针轮询周期：摘要是每天 9:00 的定点产物，30s 一次足够及时发现（探针只 stat 一个文件） */
const TODAY_BADGE_POLL_MS = 30_000;

/**
 * 联系人头像：人物卡通头像（PersonaAvatar）+ 名字派生的底色（见 lib/butler/avatar.ts）。
 * 用哪张由**人设性格**（personality）决定，没写性格才按名字散列——每处调用都必须把人设传进来，
 * 否则同一个人会在联系人列和中栏气泡 / 通知卡片变成两个人。
 * 纯派生物，不落库——所以各处各渲染一次也永远一致。
 * 形状是**圆角矩形**而非正圆（2026-09-26）：方头像才和右侧的名字行同属一个「内容块」，
 * 正圆更像徽标/状态点。圆角取 size 的 0.3 倍，两处尺寸（32 / 30）自动等比；
 * 素材的衣领画到画布下沿，靠 overflow-hidden 被圆角裁掉。
 */
function ContactAvatar({ name, personality, size }: { name: string; personality?: string; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        ...avatarTint(name),
      }}
      aria-hidden
    >
      <PersonaAvatar id={defaultAvatarId(name, personality)} />
    </span>
  );
}

/** 复制成功的回执时长：够看清那一下打钩，又不至于一直亮着 */
const COPIED_FEEDBACK_MS = 1200;

/**
 * 单条消息操作条上的一颗图标键。文案只放在 title / aria-label 里：
 * 复制 / 删除 / 多选三颗挤在窄气泡下面，写成文字会把操作条撑得比气泡本身还长。
 */
function MsgAction({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** 点亮态（如「已复制」的即时回执） */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
      style={{ color: active ? 'var(--primary)' : 'var(--ink-muted)' }}
      title={label}
      aria-label={label}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

/**
 * 单条消息的操作条（复制 / 删除 / 多选）—— 微信「长按消息」在桌面上的等价物：
 * 鼠标移入这一行才浮出来（父行挂 `group`，这里靠 group-hover 显形）。
 *
 * **不用绝对定位**：绝对定位展开时会盖住下一条气泡的顶部，对话流里那比多占一行更难看
 * （与朗读按钮同一条口径，见 AssistantBubble 注释）。因此它是**占位**的——
 * 助手气泡那行本来就为朗读按钮留着高度，自己发的气泡只为它多留 20px 左右的一条。
 *
 * 复制用 copyText（navigator.clipboard + execCommand 降级）：Electron 打包后可能不是
 * secure context，直接用 navigator.clipboard 会静默失败，而「复制了却是空的」比不复制更糟。
 */
function MessageActions({
  content,
  onDelete,
  onSelect,
}: {
  content: string;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    void copyText(content).then((ok) => {
      if (!ok) return; // 失败不点亮：宁可什么都不说，也不要给一个假回执
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  }, [content]);
  return (
    <>
      <MsgAction icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy'} onClick={copy} active={copied} />
      <MsgAction icon={Trash2} label="Delete" onClick={onDelete} />
      <MsgAction icon={ListChecks} label="Select" onClick={onSelect} />
    </>
  );
}

/** 多选模式的勾选框：贴在该条消息内容的外侧（自己发的在气泡左侧、对方的在头像左侧） */
function MsgCheckbox({
  checked,
  onToggle,
  className = 'mt-1.5',
}: {
  checked: boolean;
  onToggle: () => void;
  /** 外边距按宿主行高调（默认 mt-1.5 对齐气泡 / 卡片首行；宿主若已 items-center 传空串） */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`${className} flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors`}
      style={{
        borderColor: checked ? 'var(--primary)' : 'var(--line)',
        backgroundColor: checked ? 'var(--primary)' : 'transparent',
        color: '#fff',
      }}
      title={checked ? 'Deselect' : 'Select'}
      aria-pressed={checked}
    >
      {checked && <Check className="h-2.5 w-2.5" />}
    </button>
  );
}

/**
 * 多选模式的操作条：只在多选期间出现，是**压在输入框上方的圆角矩形浮层**
 * （宽度与输入框对齐，不占正文版面、不推挤时间线）。
 * `N/总数` 是这一行唯一需要读的信息（全选状态从最左边那颗图标就能看出来）——
 * 三个动作照旧只给图标，与气泡操作条同一套观感。
 */
function SelectActionBar({
  count,
  total,
  allSelected,
  onToggleAll,
  onCopy,
  onDelete,
  onCancel,
}: {
  count: number;
  total: number;
  allSelected: boolean;
  onToggleAll: () => void;
  /** 返回是否复制成功：失败不点亮回执（与单条气泡操作条同一口径）。
   *  不传则不显示「复制所选」这颗 —— 通知卡片的批量操作只做删除（正文在右栏读）。 */
  onCopy?: () => Promise<boolean>;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = () => {
    if (!onCopy) return;
    void onCopy().then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };
  return (
    <div
      className="flex items-center gap-1 rounded-xl border px-2 py-1"
      style={{
        borderColor: 'var(--line)',
        backgroundColor: 'var(--popover)',
        boxShadow: '0 10px 28px rgba(0,0,0,0.16)',
      }}
    >
      <MsgAction
        icon={allSelected ? X : ListChecks}
        label={allSelected ? 'Deselect all' : 'Select all'}
        onClick={onToggleAll}
      />
      <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
        {count}/{total}
      </span>
      <span className="flex-1" />
      {onCopy && <MsgAction icon={copied ? Check : Copy} label="Copy selected" onClick={copy} active={copied} />}
      <MsgAction icon={Trash2} label="Delete selected" onClick={onDelete} />
      <MsgAction icon={X} label="Exit select" onClick={onCancel} />
    </div>
  );
}

/* 正文产物行（`OutputFile: <path>`）的解析已抽到 lib/butler/output-files（纯字符串逻辑，可单测）：
   管家是跨项目助手，除项目相对路径外还接受绝对路径（别的项目的材料要发给用户时用的就是绝对路径）。 */

/** 文件大小展示（微信式卡片副标题的一截） */
function formatFileBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 按扩展名给出卡片副标题用的类型名，以及图标纸面上的字标（留空 = 纯折角纸，如图片与未知类型） */
function fileKindMeta(name: string): { label: string; mark: string } {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return { label: 'Markdown', mark: 'MD' };
  if (ext === 'docx' || ext === 'doc') return { label: 'Word', mark: 'DOC' };
  if (ext === 'pdf') return { label: 'PDF', mark: 'PDF' };
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return { label: 'Excel', mark: 'XLS' };
  if (ext === 'pptx' || ext === 'ppt') return { label: 'PowerPoint', mark: 'PPT' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { label: 'Image', mark: '' };
  return { label: ext ? ext.toUpperCase() : 'File', mark: '' };
}

/**
 * 折角文档字标（自绘 SVG）：一张占满图标槽的折角纸，纸面印类型字标（MD / PDF / DOC…）。
 *
 * 为什么去掉灰底方块：36px 的灰底会把里面的纸压到 20px，折角与描边全都糊掉。去掉底色后
 * glyph 直接放大到 34px 贴着槽位，细节看得清，长列表里也更好认；字标沿用中性灰，
 * 颜色仍交给文件名与大小承载，图标本身不抢戏。
 */
function DocTypeGlyph({ mark }: { mark?: string }) {
  const ink = 'var(--ink-muted)';
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      {/* 纸身：右上角被切掉，留给折角 */}
      <path
        d="M4.5 2H14.5L21.5 9V19.5A2.5 2.5 0 0 1 19 22H4.5A2.5 2.5 0 0 1 2 19.5V4.5A2.5 2.5 0 0 1 4.5 2Z"
        stroke={ink}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 折起的一角 */}
      <path
        d="M14.5 2L21.5 9H14.5Z"
        fill={ink}
        fillOpacity={0.22}
        stroke={ink}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {mark ? (
        <text
          x="11.7"
          y="17.4"
          textAnchor="middle"
          fontSize="6.2"
          fontWeight={600}
          letterSpacing="0.3"
          fill={ink}
          style={{ fontFamily: 'inherit' }}
        >
          {mark}
        </text>
      ) : null}
    </svg>
  );
}

/**
 * 微信式文件卡片：左侧折角文档字标（无底色，占满图标槽）+ 右侧「文件名 / 类型 · 大小」，整卡可点。
 * 点击走 openDocInDrawer —— 在抽屉自己的右栏用 md 阅读器打开（画布面板被抽屉遮挡）。
 */
function WechatFileCard({ path, name }: { path: string; name: string }) {
  const [size, setSize] = useState<number | null>(null);
  const meta = fileKindMeta(name);
  const relPath = !(path.startsWith('/') || path.startsWith('~/'));

  useEffect(() => {
    if (!relPath) return;
    let cancelled = false;
    (async () => {
      try {
        const cur = await fetch('/api/projects').then((r) => r.json());
        const projectId = cur?.current_id || '';
        if (!projectId) return;
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stat', project_id: projectId, file_path: path }),
        });
        const data = await resp.json();
        if (!cancelled && data?.success && data.exists) setSize(data.size ?? 0);
      } catch { /* 拿不到大小就不显示，不影响打开 */ }
    })();
    return () => { cancelled = true; };
  }, [path, relPath]);

  const sub = [meta.label, size !== null ? formatFileBytes(size) : ''].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      onClick={() => openDocInDrawer(path)}
      className="flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-[var(--paper-hover)]"
      style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
      title={`Open ${name}`}
    >
      <DocTypeGlyph mark={meta.mark} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs" style={{ color: 'var(--ink-strong)' }}>{name}</span>
        <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>{sub}</span>
      </span>
    </button>
  );
}

/**
 * 助手气泡（含「朗读」按钮）。
 *
 * 为什么单独抽成一个组件：朗读状态是**组件内 hook**（useReadAloud），而气泡是在
 * `timeline.map(...)` 里就地渲染的 JSX——hook 不能写在回调里，必须落到一个真组件上。
 *
 * 朗读链路：引擎 = 设置里已选中的那一款 TTS（云端 / 本地离线引擎互斥单选，不另立一套真相）。
 * 分段合成与播放细节见 components/butler/useReadAloud.ts；Markdown 净化见 lib/tts/plain-text.ts。
 *
 * 按钮位置：贴气泡下沿、hover 显形（进行中/出错时常显，免得状态看不见）；不用绝对定位——
 * 绝对定位展开时会盖住下一条气泡的顶部，对话流里那比多占一行更难看。
 * 流式未完成（pending）时不渲染该行：正文还在长，念的是半句话。
 */
function AssistantBubble({
  message,
  title,
  personality,
  selectMode,
  selected,
  onToggleSelected,
  onDelete,
  onEnterSelect,
  onOpenCard,
  onOpenTrace,
  failedPaths,
}: {
  message: DialogMessage;
  title: string;
  personality?: string;
  /** 多选模式：气泡左侧出现勾选框，这条操作条常显（不再靠 hover） */
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  onDelete: (id: string) => void;
  onEnterSelect: (id: string) => void;
  /** 摘要消息携带的文章卡片：点击在 Hippo Browser 打开原文 */
  onOpenCard?: (url: string) => void;
  /** 摘要消息携带的检索实况账本：点开右栏回看这一轮「留了哪几篇、判掉了哪几篇」 */
  onOpenTrace?: () => void;
  /** 打不开的产物路径：这些路径的 `OutputFile:` 行还原回正文，保证路径仍可见、可复制 */
  failedPaths: Set<string>;
}) {
  const read = useReadAloud(message.id, () => message.content);
  const busy = read.phase === 'loading';
  const speaking = read.phase === 'playing' || read.phase === 'paused';
  /** 有正文 = 可以朗读；只有卡片（综述写失败的兜底）时朗读无意义，故两者分开判 */
  const hasText = !!message.content;
  const hasCards = !!message.cards?.length;
  /** 实况入口的计数（「留下 3 / 去除 14」是这一栏最有用的一句结论） */
  const traceKept = message.searchTrace?.items.filter((t) => t.verdict === 'kept').length ?? 0;
  const traceDropped = message.searchTrace?.items.filter((t) => t.verdict === 'dropped').length ?? 0;
  const hasTrace = traceKept + traceDropped > 0;
  /**
   * 文章卡片列表是否显示（2026-10-01 用户口径）。
   *
   * **有账本就只留「查看检索实况」一个入口**：右栏把每一篇（含被判掉的）都列全了，
   * 中栏再摆一遍卡片是同一份内容的第二个副本 —— 两处都要维护、还占掉对话框大半高度。
   * 只有**没有账本**的消息才退回卡片列表：那是今天之前落库的存量消息
   * （落库时还没有 `searchTrace` 字段），不兜底就会变成一条什么都看不到的空消息。
   */
  const showCards = hasCards && !hasTrace;
  const showControls = !message.pending && (hasText || hasCards || hasTrace);
  /** 复制 / 多选的操作对象：无正文时退化为卡片标题列表，免得「复制」复制出一段空串 */
  const actionText = message.content || (message.cards ?? []).map((c) => c.title).join('\n');

  /**
   * 正文里的产物文件（`OutputFile:` 行）→ 独立文件卡片。
   * 只在回复**完成后**解析：流式期间路径还可能是半行，先做卡会闪出一张坏卡；
   * 完成后把标记行从显示正文里剥离，改由卡片承载（正文只剩「说人话」的部分）。
   */
  const parsed = message.pending
    ? { files: [] as Array<{ path: string; name: string }>, clean: message.content }
    : extractOutputFiles(message.content);
  const outputFiles = parsed.files;
  /**
   * 读不出来的产物：把它的 `OutputFile:` 行还原回正文（2026-10-05）。
   * 卡片点不开时那一行已被剥离，用户连路径都看不到、文件等于凭空消失；还原后至少能复制路径。
   */
  const bodyContent = restoreOutputFileLines(
    parsed.clean,
    outputFiles.filter((f) => failedPaths.has(f.path)).map((f) => f.path),
  );
  const hasBody = !!bodyContent.trim();
  /** 纯文件消息（正文只剩空串）时不渲染空气泡，只留卡片；其余情况照常渲染 */
  const showBubble = hasBody || !!message.pending || outputFiles.length === 0;

  const Icon = busy ? Loader2 : read.phase === 'playing' ? Pause : read.phase === 'paused' ? Play : Volume2;
  const label = busy ? 'Preparing…' : read.phase === 'playing' ? 'Pause' : read.phase === 'paused' ? 'Resume' : 'Read aloud';

  return (
    <div className="group flex items-start gap-2">
      {selectMode && !message.pending && (
        <MsgCheckbox checked={selected} onToggle={() => onToggleSelected(message.id)} />
      )}
      <ContactAvatar name={title} personality={personality} size={BUBBLE_AVATAR_SIZE} />
      <div className="min-w-0 max-w-[80%]">
        {showBubble && (
          <div className="butler-md relative px-3 py-1.5 text-xs" style={bubbleOtherStyle}>
            {message.content ? (
              <StreamingMarkdown content={bodyContent} streaming={!!message.pending} onOpenDoc={openDocInDrawer} />
            ) : hasTrace ? (
              // 综述写失败但有账本：给一句落点并指向右栏，别留一排假 loading 点
              <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
                检索到 {traceKept} 篇文章 · 见右侧实况
              </span>
            ) : message.cards?.length ? (
              // 存量消息（无账本）：只有卡片、没有综述正文，同样给一句落点
              <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
                检索到 {message.cards.length} 篇文章
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-1 w-1 animate-pulse rounded-full"
                  style={{ backgroundColor: 'var(--primary)' }}
                />
                <span
                  className="h-1 w-1 animate-pulse rounded-full"
                  style={{ backgroundColor: 'var(--primary)', animationDelay: '150ms' }}
                />
                <span
                  className="h-1 w-1 animate-pulse rounded-full"
                  style={{ backgroundColor: 'var(--primary)', animationDelay: '300ms' }}
                />
              </span>
            )}
            <BubbleTail side="left" color={WECHAT_OTHER_BUBBLE} />
          </div>
        )}

        {/* 产物文件卡片（微信式）：正文 `OutputFile:` 行剥离后由这里承载，整卡点开右栏预览 */}
        {outputFiles.length > 0 && (
          <div className={hasBody ? 'mt-1.5 flex flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
            {outputFiles.map((f) => (
              <WechatFileCard key={f.path} path={f.path} name={f.name} />
            ))}
          </div>
        )}

        {/* 检索到的文章卡片：**只在没有实况账本时才显示**（存量消息的兜底，见 showCards）。
            有账本时这一整块让位给下方的单一入口 —— 右栏已经逐篇列全（含被判掉的），
            中栏再摆一份卡片就是同一内容两个副本。卡片本身仍随消息落库（lib/bus.ts ChatMessage.cards），
            只是不再在对话里渲染，故保留这段渲染分支给旧消息。 */}
        {showCards && message.cards && message.cards.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {message.cards.map((c, i) => (
              <button
                key={`${c.url}#${i}`}
                type="button"
                onClick={() => onOpenCard?.(c.url)}
                className="flex gap-2 rounded-xl border px-2.5 py-2 text-left transition-shadow"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
                title={c.title}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <span
                  className="mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold"
                  style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="min-w-0 truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
                      {c.title}
                    </span>
                    {c.keypoint && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-[1px] text-[9px]"
                        style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}
                      >
                        {c.keypoint}
                      </span>
                    )}
                  </span>
                  {c.account && (
                    <span className="mt-0.5 block truncate text-10" style={{ color: 'var(--ink-faint)' }}>
                      {c.account}
                    </span>
                  )}
                  {c.summary && (
                    <span className="mt-0.5 block text-10 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                      {c.summary}
                    </span>
                  )}
                </span>
                <span className="ml-1 flex shrink-0 items-center self-center text-10" style={{ color: 'var(--primary)' }}>
                  Hippo ↗
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 唯一入口（2026-10-01 用户口径）：打开右侧边栏看检索实况。
            文章链接**不再在这里重复一遍** —— 右栏已逐篇列全（含被判掉的），两处并列只是同一份内容两个副本。
            账本随这条消息落库（`ChatMessage.searchTrace`）→ 什么时候点开都能把右栏重新打开；
            消息被删 → 服务端整条删掉、前端同步清右栏，入口与账本一起消失。 */}
        {!selectMode && hasTrace && (
          <button
            type="button"
            onClick={() => onOpenTrace?.()}
            className="mt-1.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-10 transition-colors hover:bg-[var(--primary-soft)]"
            style={{ color: 'var(--primary)' }}
            title="打开右侧边栏，查看本轮召回的每一篇与精选判定（含被判定掉的）"
          >
            <ScanSearch className="h-3 w-3" />
            打开右侧检索实况 · 留下 {traceKept} / 去除 {traceDropped}
          </button>
        )}

        {showControls && (
          <div
            className={`mt-0.5 flex items-center gap-1 transition-opacity ${
              busy || speaking || read.error ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
            }`}
          >
            {/* 只留图标（2026-09-28）：文字标签（Read aloud / Pause / Resume）占宽，且和同行的
                复制 / 删除 / 多选（都是纯图标）不同款；状态与说明交给 title / aria-label。 */}
            {hasText && (
              <button
                type="button"
                onClick={read.toggle}
                disabled={busy}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-default"
                style={{ color: busy || speaking ? 'var(--primary)' : 'var(--ink-muted)' }}
                title={busy ? 'Synthesizing speech…' : label}
                aria-label={label}
              >
                <Icon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
              </button>
            )}
            {speaking && (
              <button
                type="button"
                onClick={read.stop}
                className="flex h-5 items-center gap-1 rounded px-1.5 text-11 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Stop"
                aria-label="Stop"
              >
                <Square className="h-3 w-3" />
                Stop
              </button>
            )}
            {/* 复制 / 删除 / 多选：与朗读同一行（hover 一起浮出）。多选期间收起——
                那会儿行首已经有勾选框，再摆一颗「多选」只会让人不知道点哪个 */}
            {!selectMode && (
              <MessageActions
                content={actionText}
                onDelete={() => onDelete(message.id)}
                onSelect={() => onEnterSelect(message.id)}
              />
            )}
          </div>
        )}

        {/* 失败绝不静默：未配置 TTS / 合成失败都把后端原话就地摆出来 */}
        {read.error && (
          <p className="mt-0.5 text-11 leading-snug" style={{ color: 'var(--danger)' }}>
            {read.error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 「小微正在检索」——检索进行中 / 失败时，内联在中栏会话流末尾的**临时**一块。
 *
 * 为什么这里只有过程、没有结果：结果（综述 + 文章卡片）已由服务端落库进小微线程
 * （见 lib/core/butler-search.ts 的 recordSearchExchange 与 lib/bus.ts 的 ChatMessage.cards），
 * 检索一结束就重载小微消息、以**真实对话消息**呈现（气泡 + 每篇卡片）。本组件只补
 * 「进行中」这段还没有消息可依的过程感知：当前阶段、验证码/失败兜底。
 * 它**不落库**——过程态不是对话内容。
 *
 * ⚠️ 「问题被拆成几个检索方向」原来在这里，2026-10-01 已**移交右栏 Search Live**
 * （贴在检索问题下方，见 WechatSearchTrace）：拆解与判定是同一件事的两步，
 * 同屏才读得出「这个方向对应哪几篇」。
 */
function WechatSearchLive({
  busy,
  captcha,
  status,
  notice,
  title,
  personality,
}: {
  busy: boolean;
  captcha: boolean;
  /** 当前阶段文案（Searching / Reading articles… / Writing summary… 等） */
  status: string;
  /** 非空 = 一条兜底说明（桥离线 / 未找到文章） */
  notice: string;
  title: string;
  personality?: string;
}) {
  const bubbleText = captcha
    ? '需要先通过验证：在 Hippo Browser 打开 weixin.sogou.com 完成验证后重试'
    : notice || status;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* 过程气泡：进行中 = 三点动画 + 阶段文案；验证码/失败 = 兜底说明 */}
      <div className="flex items-start gap-2">
        <ContactAvatar name={title} personality={personality} size={BUBBLE_AVATAR_SIZE} />
        <div className="min-w-0 max-w-[80%]">
          <div className="butler-md relative px-3 py-1.5 text-xs" style={bubbleOtherStyle}>
            <span className="inline-flex items-center gap-1">
              {busy && !captcha && !notice && (
                <>
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)' }} />
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)', animationDelay: '150ms' }} />
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)', animationDelay: '300ms' }} />
                </>
              )}
              <span className="text-11" style={{ color: 'var(--ink-faint)' }}>{bubbleText}</span>
            </span>
            <BubbleTail side="left" color={WECHAT_OTHER_BUBBLE} />
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * 实况一行 / 一轮账本的类型**定义在 lib/bus.ts**（`WechatSearchTraceItem` / `WechatSearchTrace`）——
 * 因为它要随综述消息落库（`ChatMessage.searchTrace`），前后端（服务端组装、抽屉渲染）
 * 必须共用同一份定义，否则字段一漂移就是「落库有、渲染无」的静默空面板。
 *
 * 为什么账本里把「去除的」也留着：AI 一次只精读 3 篇，剩下十几篇是**被判掉而不是没搜到**——
 * 用户被蒙在鼓里就无从判断这轮检索靠不靠谱。判掉的那几篇照样能点开，
 * 只是标一枚拇指向下，说明「模型看过它、没选它」。
 */

/* 检索实况（traceSubtitle / traceVerdictIcon / TraceRow / TraceSection / 面板本体）
   已于 2026-10-05 抽出到 ./ButlerSearchTrace —— 该面板完全受控，移动端 /butler 需复用同一份实现。
   下方 import 的 ButlerSearchTrace 即原 WechatSearchTrace 组件。 */



/**
 * 通知卡片的文本源（Copy 与朗读共用）：
 * 短回执有 body；报告类只有标题 + 待办清单，故 body 为空时退化为「标题 + 各项标题」拼接。
 */
function noticeText(n: ButlerNotice): string {
  const body = n.body?.trim();
  if (body) return body;
  return [n.title, ...(n.items ?? []).map((i) => i.title)].filter(Boolean).join('\n');
}

/**
 * 通知卡片（2026-09-28 起「普通消息化」）。
 *
 * 为什么单独抽成组件：与 AssistantBubble 同因 —— 朗读是组件内 hook（useReadAloud），
 * 而卡片是在 `timeline.map(...)` 里就地渲染的 JSX，hook 不能写在回调里。
 *
 * 语义：Bobby 的回执 = 微信里的「文件消息」——就是一条消息，点开在右栏看正文，
 * 卡片下沿浮出与气泡一致的操作条（朗读 / 复制 / 删除 / 多选）。
 * **未点开时卡片右上角亮一颗红点**（微信里没听过的语音那颗）：点开即灭，没有「标为已读」按钮；
 * 删除仍是唯一的清理入口（删了就没了，也谈不上未读）。
 */
function NoticeCard({
  notice,
  title,
  personality,
  selectMode,
  checked,
  onOpen,
  onToggleSelected,
  onEnterSelect,
  onDelete,
  onToggleItem,
}: {
  notice: ButlerNotice;
  title: string;
  personality?: string;
  /** 多选态（与对话气泡**共用**同一套）：整行 = 勾选这张卡 */
  selectMode: boolean;
  /** 多选态下这张卡片是否被勾上 */
  checked: boolean;
  onOpen: () => void;
  onToggleSelected: () => void;
  onEnterSelect: () => void;
  onDelete: () => void;
  onToggleItem: (item: ButlerNoticeItem) => void;
}) {
  const read = useReadAloud(notice.id, () => noticeText(notice));
  const busy = read.phase === 'loading';
  const speaking = read.phase === 'playing' || read.phase === 'paused';
  const Icon = busy ? Loader2 : read.phase === 'playing' ? Pause : read.phase === 'paused' ? Play : Volume2;
  const label = busy ? 'Preparing…' : read.phase === 'playing' ? 'Pause' : read.phase === 'paused' ? 'Resume' : 'Read aloud';

  const meta = kindMeta(notice.kind);
  /**
   * 待办项是否**直接摊在中栏**（在通知栏里就能勾选，不必打开右栏）：
   * 短回执（日历提醒等）就地摊开勾选，单条则并进头部行（见 singleItem）；
   * 报告类长文档（检查报告等）不摊 —— 它们要读的是**正文**，仍走「点开 → 右栏」，
   * 中栏只留一个「待办 N」徽标。
   */
  const todoItems = notice.items ?? [];
  const todoTotal = todoItems.length;
  const inlineItems = !isShareableReportKind(notice.kind) && todoTotal > 0;
  const todoLeft = todoItems.filter((x) => x.status !== 'done').length;
  /**
   * 只有一条待办项时，不再单起一行——日历提醒 / 单条日程查询的**头条就是这条待办**
   * （标题「调解方案」vs 待办「调解方案」），摊成两行等于同一件事说两遍。
   * 多条仍走下方清单（清单本身就是进度条）；报告类长文不走内联（inlineItems=false）。
   */
  const singleItem = inlineItems && todoTotal === 1 ? todoItems[0] : null;
  /** 头部整行点击：多选态 = 勾选这张卡，常态 = 打开右栏看正文 */
  const activateCard = () => (selectMode ? onToggleSelected() : onOpen());

  return (
    // 通知卡片也是「对方（Bobby）发来的消息」：与 AssistantBubble 同款左侧布局 ——
    // 头像在最外侧、卡片贴着头像，气泡与卡片在中栏是同一套「收到」观感。
    // 微信式「收到」：靠左 + 上限 85%（self-start 让宽度走 fit-content，短主题就短气泡，
    // 到 85% 才触发标题 truncate），右侧留白、不再通栏。
    <div className="group flex max-w-[85%] items-start gap-2 self-start">
      {/* 多选勾选框：**放在头像前**（圆圈 → 头像 → 卡片），与 AssistantBubble 收到的消息同一位置，
          也和右侧自己发的气泡对称。多选期间整片行外留出这一颗，卡片本体不再内嵌。 */}
      {selectMode && <MsgCheckbox checked={checked} onToggle={onToggleSelected} />}
      <ContactAvatar name={title} personality={personality} size={BUBBLE_AVATAR_SIZE} />
      <div className="relative min-w-0">
        {/* 未读红点（微信里「还没听过的语音」那颗）：**点开卡片**才灭。
            挂在卡片右上角外侧——卡片本体 overflow-hidden，放里面会被圆角裁掉。 */}
        {!notice.read && !selectMode && (
          <span
            className="pointer-events-none absolute -right-1 -top-1 z-10 h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: 'var(--danger)', boxShadow: '0 0 0 2px var(--paper)' }}
            aria-label="Unread"
          />
        )}
        <div
          id={`butler-notice-${notice.id}`}
          className="min-w-0 overflow-hidden rounded-xl text-left transition-colors"
          style={{
            backgroundColor: checked ? 'var(--paper-hover)' : 'var(--paper)',
            border: `1px solid ${checked ? 'var(--primary)' : 'var(--line)'}`,
          }}
        >
          {/* 头部：整行可点 → 右栏正文。用 div + role=button 而不是 <button>：
              卡片内还有待办项勾选等真按钮，嵌套 <button> 属非法结构，点击也会互相打架。
              多选态下整行改为「勾选这张卡」，不再打开右栏——批量清理时点哪儿都应该是选择。 */}
          <div
            role="button"
            tabIndex={0}
            onClick={activateCard}
            onKeyDown={(e) => {
              // 只认落在头部本行上的回车 / 空格：行内的待办项本身是 <button>，
              // 它们自己的键盘触发会冒泡上来，不拦就会顺带把右栏详情也打开。
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateCard();
              }
            }}
            className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2"
          >
            {/* 类型：只留图标 + 颜色（文字标签已省，hover 出全称）。
                右栏详情头部有完整类型标签，中栏重复没有信息增量。 */}
            <span className="shrink-0" title={meta.label} aria-label={meta.label}>
              <meta.Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
            </span>
            {/* 主题：单行截断。全文在右栏，中栏不做第二遍展示（原 body 两行预览已删）。 */}
            <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
              {notice.title}
            </span>
            {/* 待办进度徽标：不必点开就知道「这条有事可做」。
                行内已摊开待办项时不重复——摊开的清单本身就是进度。 */}
            {!inlineItems &&
              todoTotal > 0 &&
              (todoLeft > 0 ? (
                <span
                  className="shrink-0 rounded-full px-1 py-px text-9 font-semibold tabular-nums"
                  style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }}
                  title={`${todoLeft} to-dos still open`}
                >
                  To-do {todoLeft}
                </span>
              ) : (
                <span
                  className="shrink-0 rounded-full px-1 py-px text-9 font-semibold tabular-nums"
                  style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-faint)' }}
                  title={`All ${todoTotal} to-dos done`}
                >
                  ✓ {todoTotal}
                </span>
              ))}
            {/* 时间：单条待办合并后显示**事项时间**（原来在第二行，且日历项是裸 ISO 串），
                否则显示本条回执的时间 */}
            <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
              {formatTime(singleItem?.startMs || notice.time)}
            </span>
          </div>

          {/* 待办项（多条短回执）：在通知栏直接勾选，动作与右栏详情的待办 chip 同源（toggleItem）。
              单条时已并进头部行（singleItem），这里不再重复摊一行。 */}
          {inlineItems && !singleItem && (
            <div className="flex flex-col gap-0.5 px-2 pb-1.5">
              {todoItems.map((x) => {
                const itemDone = x.status === 'done';
                return (
                  <button
                    key={x.key}
                    type="button"
                    onClick={() => onToggleItem(x)}
                    className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                  >
                    <CheckCircle2
                      className="h-3 w-3 shrink-0"
                      style={{ color: itemDone ? 'var(--success)' : 'var(--ink-faint)' }}
                    />
                    <span
                      className="min-w-0 flex-1 text-11"
                      style={{
                        color: itemDone ? 'var(--ink-faint)' : 'var(--ink)',
                        textDecoration: itemDone ? 'line-through' : undefined,
                      }}
                    >
                      {x.title}
                    </span>
                    {x.time && (
                      <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                        {x.time}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 操作条：与助手气泡同一套（朗读图标键 + 朗读中的 Stop + 复制 / 删除 / 多选）。
            hover 浮出；朗读中 / 出错常显。多选期间收起复制 / 删除 / 多选——
            那会儿行首已经有勾选框，再摆一颗「多选」只会让人不知道点哪个。 */}
        <div
          className={`mt-0.5 flex items-center gap-1 transition-opacity ${
            busy || speaking || read.error ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
          {/* 只留图标（2026-09-28）：状态与说明交给 title / aria-label。 */}
          <button
            type="button"
            onClick={read.toggle}
            disabled={busy}
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-default"
            style={{ color: busy || speaking ? 'var(--primary)' : 'var(--ink-muted)' }}
            title={busy ? 'Synthesizing speech…' : label}
            aria-label={label}
          >
            <Icon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          </button>
          {speaking && (
            <button
              type="button"
              onClick={read.stop}
              className="flex h-5 items-center gap-1 rounded px-1.5 text-11 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Stop"
              aria-label="Stop"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          )}
          {!selectMode && (
            <MessageActions content={noticeText(notice)} onDelete={onDelete} onSelect={onEnterSelect} />
          )}
        </div>

        {/* 失败绝不静默：未配置 TTS / 合成失败都把后端原话就地摆出来 */}
        {read.error && (
          <p className="mt-0.5 text-11 leading-snug" style={{ color: 'var(--danger)' }}>
            {read.error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 窗口键：macOS 那种彩色圆点（对齐 hippo 的窗口观感 —— 它的三键就是原生 titleBar 的 traffic lights），
 * 本栏只用「关闭 / 放大-还原」两颗。
 * 只做 12px 圆点 + hover 提亮，不加悬停字形：这排键挤在 48px 的左栏顶部，字形只会更糊。
 * 拖动移动由父级（左栏 nav）统一处理，这里只需**不触发**它——startMove 会跳过所有 button。
 */
function WindowDot({ color, label, onClick }: { color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-3 w-3 shrink-0 rounded-full transition hover:brightness-110 active:scale-95"
      style={{ backgroundColor: color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.14)' }}
    />
  );
}

/**
 * 左栏功能键：**只留图标**（2026-09-26）。
 * 原来是「图标在上、文字在下」，这一栏被文字撑到 84px 宽；而「Buddy / Today / Memories / Calendar」
 * 这几个名字只在新手第一次用时才有价值，之后看图就够。改为悬停时在右侧弹出名字（白底英文，
 * 与全站 UI 文案一律英文的约定一致），栏宽随之收到 48px（与窄窗一致，抽屉整体也能窄 36px）。
 * 弹窗用 group-hover + opacity（不用 title）：title 有系统延迟、且样式不可控；
 * z-50 是为了盖住窄窗下 z-40 的联系人覆盖层。
 */
function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  dot,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  /** 右上角红点：栏里有新内容、用户还没看过（目前只有 Today 的 Report 摘要用） */
  dot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="group relative flex shrink-0 flex-col items-center rounded-xl px-1 transition-colors"
      style={{
        width: 40,
        paddingTop: 9,
        paddingBottom: 9,
        backgroundColor: active ? 'var(--primary-soft)' : 'transparent',
        color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
      }}
    >
      <Icon className="h-4 w-4" />
      {dot && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-[7px] top-[5px] h-2 w-2 rounded-full"
          // 外圈描一圈左栏底色：红点压在图标右上角时不会和线稿糊在一起
          style={{ backgroundColor: 'var(--danger)', boxShadow: '0 0 0 2px var(--paper-soft)' }}
        />
      )}
      <span
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md px-2 py-1 text-10 font-medium opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          // --panel-bg 是 #ffffff（比 --paper #f7f7f8 更亮的弹层专用色）：
          // 左栏底色是淡灰 --paper-soft (#efeff2)，用 --popover / --paper 都只比栏底亮一点点，
          // 只剩边框看得出来；纯白才稳稳浮在栏上。
          backgroundColor: 'var(--panel-bg)',
          color: 'var(--ink-strong)',
          border: '1px solid var(--line)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
        }}
      >
        {label}
      </span>
    </button>
  );
}

export function ButlerDrawer({ section, onSectionChange, docPath, onCloseDoc, onClose, focusNoticeId }: ButlerDrawerProps) {
  const winW = useWindowWidth();
  /** 窄窗：右栏不占位，改为点开回执才盖住列表的覆盖层 */
  const isNarrow = winW < NARROW_W;
  const isTight = winW < TIGHT_W;
  const winH = useWindowHeight();

  // ===== 手动几何（拖动移动 / 拖拽改尺寸）=====
  /** 面板容器 ref：起拖 / 起缩时实测它的矩形，作为这一轮的基准（避免「居中态」与「手动态」两套坐标打架） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 手动几何（null = 从未调整过 → 完全走原来的居中自适应）；初始值读盘 */
  const [geom, setGeom] = useState<DrawerGeom | null>(() => readDrawerGeom());
  /** 绿键：铺满可用区域（居中）；再按一次回到手动几何 / 自适应 */
  const [zoomed, setZoomed] = useState(false);
  /** 拖动 / 缩放过程中的最新几何（pointerup 时落盘，避免闭包里拿到旧值） */
  const geomRef = useRef<DrawerGeom | null>(null);

  // 窗口尺寸变化时把手动几何钳回视口（上次窗口更大时拖到的位置/尺寸不能留在屏幕外）
  useEffect(() => {
    setGeom((g) => {
      if (!g) return g;
      const maxW = Math.round(winW * DRAWER_W_RATIO);
      const maxH = Math.min(DRAWER_MAX_H, Math.round(winH * DRAWER_H_RATIO));
      const w = clampNum(g.w, DRAWER_MIN_W, maxW);
      const h = clampNum(g.h, DRAWER_MIN_H, maxH);
      const x = clampNum(g.x, DRAWER_EDGE, winW - w - DRAWER_EDGE);
      const y = clampNum(g.y, DRAWER_EDGE, winH - h - DRAWER_EDGE);
      return x === g.x && y === g.y && w === g.w && h === g.h ? g : { x, y, w, h };
    });
  }, [winW, winH]);

  /**
   * 起拖 / 起缩那一刻把面板的实测矩形冻结成手动几何：
   * 之后所有位移都以它为基准，「居中态」与「手动态」两套坐标就不会互相打架
   * （也是「最大化态下随手一拖即退出最大化」的实现——直接把当前矩形接管过来）。
   */
  const freezeBox = useCallback((): DrawerGeom | null => {
    const r = panelRef.current?.getBoundingClientRect();
    if (!r) return null;
    const g: DrawerGeom = { x: r.left, y: r.top, w: r.width, h: r.height };
    geomRef.current = g;
    setGeom(g);
    setZoomed(false);
    return g;
  }, []);

  /** 拖动移动：左栏按下（栏上的按钮除外）→ **位移过阈值**才冻结基准 → pointerup 落盘；只单击则什么都不发生 */
  const startMove = useCallback(
    (e: ReactPointerEvent) => {
      if ((e.target as Element).closest('button')) return; // 左栏的按钮（窗口键 / 功能键）不触发拖动
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      /** 冻结出来的基准几何：位移过阈值前保持 null —— 没拖动过就绝不产生手动几何 */
      let base: DrawerGeom | null = null;
      const move = (ev: PointerEvent) => {
        let b = base;
        if (!b) {
          if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
          b = freezeBox();
          if (!b) return;
          base = b;
        }
        const x = clampNum(b.x + ev.clientX - startX, DRAWER_EDGE, window.innerWidth - b.w - DRAWER_EDGE);
        const y = clampNum(b.y + ev.clientY - startY, DRAWER_EDGE, window.innerHeight - b.h - DRAWER_EDGE);
        const g = { ...b, x, y };
        geomRef.current = g;
        setGeom(g);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (base) writeDrawerGeom(geomRef.current); // 单击（没过阈值）不落盘
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [freezeBox],
  );

  /** 拖拽改尺寸：右缘改宽 / 下缘改高 / 右下角同时改；**位移过阈值**才冻结基准，pointerup 且真拖过才落盘 */
  const startResize = useCallback(
    (axis: 'x' | 'y' | 'xy') => (e: ReactPointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      /** 同 startMove：过阈值前保持 null，避免在把手上误点一下就把尺寸锁死 */
      let base: DrawerGeom | null = null;
      const move = (ev: PointerEvent) => {
        let b = base;
        if (!b) {
          if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
          b = freezeBox();
          if (!b) return;
          base = b;
        }
        const maxW = Math.max(DRAWER_EDGE, window.innerWidth - b.x - DRAWER_EDGE);
        const maxH = Math.max(DRAWER_EDGE, window.innerHeight - b.y - DRAWER_EDGE);
        const w = axis === 'y' ? b.w : clampNum(b.w + ev.clientX - startX, DRAWER_MIN_W, maxW);
        const h = axis === 'x' ? b.h : clampNum(b.h + ev.clientY - startY, DRAWER_MIN_H, maxH);
        const g = { ...b, w, h };
        geomRef.current = g;
        setGeom(g);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (base) writeDrawerGeom(geomRef.current); // 单击（没过阈值）不落盘
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [freezeBox],
  );

  /**
   * 红键 = 关掉这次查看：收起抽屉 + 清掉当前会话指针（下次打开是全新会话）。
   * 与黄键拉开差别（黄键纯收起、回来接着聊），语义对齐 hippo 的「关闭窗口 vs 最小化」。
   * 会话本身不删 —— 历史仍在联系人列里。
   */
  const closeWindow = useCallback(() => {
    // 抽屉若只是被隐藏（组件不卸载），卸载清理不会跑——关了窗口就先把声音停掉
    stopReadAloud();
    clearActiveThreadId();
    onClose();
  }, [onClose]);

  const [notices, setNotices] = useState<ButlerNotice[]>(() => getButlerNotices());
  /** 右栏详情：当前选中的回执 id */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * 右栏（预览区）是否展开 —— **默认 false**：四栏里右栏默认不占位，中栏因此更宽。
   * 三种打开方式：点左栏功能键（Today / 记忆 / 日历）、点中栏某条回执、点桌面通知；
   * 栏首自带关闭键，可**单独收起**（不关整个抽屉，见 closeRight）。
   */
  const [rightOpen, setRightOpen] = useState(false);
  /**
   * Today 面板的「这次打开」令牌，仅用作 key：每点一次左栏 Today 就 +1，强制面板重挂载。
   * 为什么需要：右栏收起 / 从别的分区切回时面板本就会卸载（rightMounted = rightVisible || meetingActive），
   * 页签自然回到 Report；唯独「右栏已停在 Today、再点一次 Today」不会卸载 ——
   * 不加 token 就会留在上次那一页（如 Schedule），与「点 Today 默认展示 Report」相悖。
   */
  const [todayOpenSeq, setTodayOpenSeq] = useState(0);
  /** Today 键红点：当日 Report 摘要的日期键（null = 今天还没生成 / 探针未返回） */
  const [todayDigestDate, setTodayDigestDate] = useState<string | null>(null);
  /** 红点已读标记：用户看过的摘要日期键（localStorage 同步过来） */
  const [todayDigestSeen, setTodayDigestSeen] = useState<string | null>(null);
  const [messages, setMessages] = useState<DialogMessage[]>([]);
  /**
   * 联系人列（chatSessions = 全部联系人的摘要行，含置顶的通知助理）。
   * 与 `messages` 的分工：`messages` 是**当前联系人**的气泡，chatSessions 是**联系人列**的数据源。
   * 窄窗（< TIGHT_W）下列收成覆盖层，`contactsOpen` 是它的开关。
   */
  const [contactsOpen, setContactsOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<ButlerThreadSummary[]>([]);
  /**
   * 人设弹窗：null = 关闭。
   * 创建态由左栏「Buddy」打开（确认后**立即落库**并进入该空会话）；
   * 编辑态由中栏工具行的「人设」键打开，或首次打开 Bobby（通知助理）未设人设时自动弹出。
   */
  const [personaDialog, setPersonaDialog] = useState<
    | { mode: 'create' }
    | { mode: 'edit'; threadId: string; systemRole?: 'notify' | 'search' }
    | null
  >(null);
  /** 人设保存中（禁用按钮，防重复提交） */
  const [personaSaving, setPersonaSaving] = useState(false);
  /** 人设保存失败原因（展示在弹窗页脚上方） */
  const [personaError, setPersonaError] = useState<string | null>(null);
  /** 当前会话 threadId（与 threadIdRef 同源；另存 state 只为让列表高亮跟着变） */
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // ===== 会话级选型（模型 / 思考档位）=====
  // 与 persona 同在**线程文件**里（一个联系人一套），切换联系人按线程回填、改动即落盘
  // （PATCH /api/butler/threads/session）；发送时随消息带上，服务端 entry.ts 用它调模型。
  /** 当前模型标签（`provider:modelId`）。**Auto 已下线**（见下方迁移 effect）：抽屉恒持具体模型，
   *  空串只出现在「模型池还没读回来 / 一个对话模型都没配」的瞬时态，此时发送留 null 由服务端兜底。 */
  /**
   * 会话级**工作区**（用户指定 · 锁定操作范围）：与选型同为「一个联系人一套」，
   * 真源在线程文件（见 lib/butler/threads.ts setThreadWorkspace），此处只是镜像。
   * ⚠️ 与 pendingAtts（一次性附件）**不是一回事**：发送后不清、切联系人按线程回填。
   */
  const [workspaceFolder, setWorkspaceFolder] = useState<ButlerWorkspaceFolder | null>(null);
  const [modelTag, setModelTag] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  /** 模型池的已配置厂商（下拉候选来源；改设置后重开抽屉生效，不额外订阅） */
  const [modelProviders, setModelProviders] = useState<ProviderConfig[]>([]);
  /** 主对话候选池顺序（设置 → 主对话模型）：空值/失效标签落默认模型时优先它，见迁移 effect */
  const [chatModelPool, setChatModelPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  /** 两个选型弹层共用的容器：点它外面收起（与画布对话节点同做法） */
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await loadSettings();
        if (!alive) return;
        setModelProviders(s.providers ?? []);
        setChatModelPool(s.chatModel?.pool ?? []);
      } catch {
        /* 读设置失败 → 下拉无候选，发送时由服务端兜底解析（不阻断对话） */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen, thinkingMenuOpen]);

  /**
   * 朗读是**模块级单例**（同一时刻只该有一个声音，见 useReadAloud）：切联系人、抽屉卸载时
   * 一条命令全停——否则换到别的联系人，上一个人的回复还在念。
   * 挂载时也会跑一次，此时本就没有声音，stop 是幂等的。
   */
  useEffect(() => {
    stopReadAloud();
  }, [activeThreadId]);
  useEffect(() => () => stopReadAloud(), []);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /**
   * 本轮提问的开始时刻 —— 只服务时间线末尾那条「等待行」（见 ButlerWaitingLine）：
   * 它按等待时长换口语，但**不展示秒表**，所以这里只存时刻、不做阶段状态机。
   */
  const [waitSince, setWaitSince] = useState(0);
  /**
   * 待发送附件（已上传到 Butler 存储空间，仅等随消息发出「资料列表」块）。
   * 上传即落盘：不随输入框清空而删除文件；移除 chip 只解除引用，不删盘上文件
   * （与画布 composer 同口径——避免误删用户刚传的资料）。
   */
  const [pendingAtts, setPendingAtts] = useState<MessageAttachment[]>([]);
  /** 有附件正在上传（禁用发送键与重复选择，避免同一文件被传两次） */
  const [attaching, setAttaching] = useState(false);
  /** 上传失败提示（一次展示一条，随下次上传清空） */
  const [attachError, setAttachError] = useState<string | null>(null);
  /** 拖拽悬停态（高亮输入区，给出「可放下」的反馈） */
  const [dragOver, setDragOver] = useState(false);
  /**
   * `/` 指令下拉：本抽屉是**唯一实现**（画布 `UnifiedPalette` 的指令态已于 2026-09 P1-c 移除）。
   * 纯逻辑抽在 `lib/core/commands.ts`，唯一真源 = `BUTLER_COMMANDS`，加指令不用改这里。
   *
   * 触发：光标所在行以 `/` 开头、且**尚未完整命中**某指令 → 列出候选（按个人使用量降序）。
   * 选中：**只把 `/keyword` 注入输入框，不直接执行**（执行仍由发送键负责）。
   * 形态差异：本处输入框在底栏，下拉**向上**展开（绝对定位覆盖消息区，不推挤布局）。
   */
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandHighlight, setCommandHighlight] = useState(0);
  const [commandUsage, setCommandUsage] = useState<Record<string, number>>(() => loadCommandUsage());
  /** 输入框光标位置（指令下拉按「光标所在行」判定，注入也回填到该行） */
  const [cursorPos, setCursorPos] = useState(0);
  // 搜索词（联系人列顶部的搜索栏，含类别过滤）
  const [searchQ, setSearchQ] = useState('');
  /** 常驻「小微」搜索助手线程 ID（与 lib/butler/storage.ts 的 SEARCH_THREAD_ID 同源；前端不引 server 模块，硬编码对齐） */
  const SEARCH_THREAD_ID = 'butler-search';
  /**
   * 跨会话命中的**历史消息**（服务端 /api/butler/search）：threadId → 该会话命中的消息（时间倒序）。
   * 联系人列把命中嵌在对应联系人行下面，形成微信式「聊天记录」结果。
   */
  const [searchHits, setSearchHits] = useState<Record<string, ThreadMessageHit[]>>({});
  /**
   * ⚠️ 2026-10-05 起，「公众号检索」的**全部状态与流程**（候选 / 阶段 / 逐篇账本 / 历史回看）
   * 已抽到 `./useWechatSearch`，桌面与移动端共用同一份判定逻辑（抽取原因见该文件头）。
   * 本文件不再内联任何检索状态；下方只保留与本检索无关的 `searchHits`（跨会话消息搜索）。
   */
  /** 当前会话 threadId（与 activeThreadId 同源）。起搜 / 收尾都要按它切换并回填。 */
  const threadIdRef = useRef<string | null>(null);
  /**
   * 「公众号检索」整条链路已抽到 `./useWechatSearch`（2026-10-05）：桌面与移动端共用同一份
   * 判定逻辑，本处只注入**抽屉才有的动作** ——
   *   - activateSearchThread：起搜 / 收尾都把「小微」切到中栏并加载其真源消息
   *     （只切 id 不加载 → 中栏会残留上一个会话的内容）
   *   - openTrace：起搜那一刻把右栏推到「检索实况」（文档预览优先占右栏，故先收掉它）
   */
  const activateSearchThread = useCallback(async () => {
    const st = await fetchSessionState(SEARCH_THREAD_ID).catch(() => null);
    threadIdRef.current = SEARCH_THREAD_ID;
    setActiveThreadId(SEARCH_THREAD_ID);
    writeActiveThreadId(SEARCH_THREAD_ID);
    if (st) setMessages(st.messages);
  }, []);

  const openSearchTrace = useCallback(() => {
    if (docPath) onCloseDoc();
    setRightOpen(true);
    onSectionChange('search');
  }, [docPath, onCloseDoc, onSectionChange]);

  /**
   * 检索状态全部来自 hook（命名逐项对齐改造前的本地 state，下游调用点零改动）。
   * loading / phase / failed 三项不进本文件 —— 它们只用于拼 `status`，由 hook 内部消费完毕。
   */
  const {
    captcha: wechatCaptcha,
    plan: wechatPlan,
    busy: wechatBusy,
    notice: wechatNotice,
    trace: wechatTrace,
    traceQuery: wechatTraceQuery,
    status: wechatSummaryStatus,
    openedTrace,
    run: runWechatSearchRaw,
    openTraceFromMessage,
    clearOpenedTraceIfDeleted,
    openHit: openWechatHit,
  } = useWechatSearch({ activateSearchThread, openTrace: openSearchTrace });

  /** 「Search WeChat Articles」入口：取搜索栏当前词发起（空词在 hook 内直接返回） */
  const runWechatSearch = useCallback(() => void runWechatSearchRaw(searchQ), [runWechatSearchRaw, searchQ]);
  /**
   * 跨会话消息搜索（联系人列嵌套「聊天记录」结果）：输入去抖 220ms 后打服务端，
   * 命中按 threadId 归组。清空搜索词 / 请求中断一律清空映射，不残留上一词的结果。
   */
  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      setSearchHits({});
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/butler/search?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = (await res.json()) as { hits?: ThreadMessageHit[] };
        const map: Record<string, ThreadMessageHit[]> = {};
        for (const h of data.hits ?? []) (map[h.threadId] ??= []).push(h);
        setSearchHits(map);
      } catch {
        /* 中断 / 失败：保留现状，下一次输入会覆盖 */
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [searchQ]);
  /** Butler 结构化确认卡（排程创建/改/删）：由服务端 butler_confirm 帧触发，用户确认后才真正执行 */
  const [butlerConfirm, setButlerConfirm] = useState<ButlerConfirmState | null>(null);
  /** 刚复制过链接的报告 id（1.6s 内显示 ✓ 反馈） */
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  /**
   * 通用工具确认挂起（SSE `tool_confirm`，「需手动确认名单」工具执行前）：
   * 服务端登记挂起项后 SSE 保持打开等确认（最长 CONFIRM_TIMEOUT_MS = 600s），前端必须
   * 消费该帧并回传 POST /api/chat/confirm。**漏接 = 用户侧「说完一句就卡住」**——
   * 与 butler_confirm / questions_request 同为挂起型，区别是它只问「允不允许」。
   * 复用画布同款 ConfirmDialog（portal 到 body，不受抽屉 transform 影响，z-9999 盖住抽屉）。
   */
  const { ask: confirmAsk, render: confirmRender } = useConfirm();
  /**
   * browser.login 登录挂起（SSE `login_required`）：
   * 用户在弹窗输入账号密码 → POST /api/chat/login → 服务端经 MCP→扩展代填。
   * 凭据不过模型上下文/日志。漏接同样会让服务端空等 600s。
   */
  const [loginPopup, setLoginPopup] = useState<{
    requestId: string;
    siteName: string;
    url: string;
    timeoutSec?: number;
  } | null>(null);
  /** 最新挂起登录（卸载时按「取消」回收，避免服务端空等） */
  const loginRef = useRef<{ requestId: string } | null>(null);
  useEffect(() => {
    loginRef.current = loginPopup;
  }, [loginPopup]);
  /**
   * 最近一次需要授权的 bobby 目标（SSE `grant_required`）。
   * 授权弹窗由全局 BobbyAuthHost（layout.tsx）承载，抽屉只负责把帧转成窗口事件；
   * 授权完成后 BobbyAuthHost 广播 `bobby:granted`，本组件匹配目标后自动补发「继续」。
   */
  const pendingGrantTargetRef = useRef<string | null>(null);
  /**
   * 结构化提问挂起（ask_user_questions → SSE `questions_request`）：
   * 模型按全局硬规则（「提问必须用 ask_user_questions，禁止自由文本拼接提问」）提问时，
   * 服务端会推 `questions_request` 帧并挂起等待回传（最长 QUESTIONS_TIMEOUT_MS = 600s）。
   * 抽屉原先**不认这个帧** → 什么都不弹、气泡永远 pending，用户看到的就是
   * 「Butler 说完『先跟你确认两个细节：』之后卡住」。这里接住它，用 docked 模式顶掉输入框。
   */
  const [pendingQuestion, setPendingQuestion] = useState<{
    requestId: string;
    questions: QuestionItem[];
    timeoutSec?: number;
  } | null>(null);
  /** 提问卡最小化为悬浮胶囊（「最小化」≠ 放弃，可点开继续作答） */
  const [questionMinimized, setQuestionMinimized] = useState(false);
  /** 最新挂起提问（卸载时按「未回答」回收，避免服务端空等 600s） */
  const questionRef = useRef<{ requestId: string } | null>(null);
  useEffect(() => {
    questionRef.current = pendingQuestion;
  }, [pendingQuestion]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 隐藏的 file input：回形针按钮点击时程序化触发（避免把原生控件暴露给样式） */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 在飞的流式请求：关闭抽屉时中止，避免留着无人消费的 SSE 连接与挂起任务 */
  const streamAbortRef = useRef<AbortController | null>(null);
  /** 最新确认卡（卸载时若仍挂起 → 主动拒绝，避免服务端干等到超时） */
  const confirmRef = useRef<ButlerConfirmState | null>(null);
  useEffect(() => {
    confirmRef.current = butlerConfirm;
  }, [butlerConfirm]);
  /** send 的稳定引用：供窗口事件监听（bobby:granted 自动补发）在空依赖下调用最新实现 */
  const sendRef = useRef<((textArg?: string) => Promise<void>) | null>(null);

  /**
   * 语音输入（微信式）：与画布聊天节点**同一个实现**（components/ui/voice-input.tsx）——
   * 点麦克风开始录 → 麦克风左侧就地展开录音条（实时音量波形 + ✕ 取消 / ✓ 完成，不覆盖输入框）
   * → 服务端转文字追加进草稿框。
   * 录音不落盘：音频只在内存里拼 Blob，转写完即丢；转写失败也丢弃，只弹一句失败原因。
   * 本抽屉特有的只有两件事：文字追加到哪个草稿框、失败走哪个弹层。
   */
  // 流式「边说边写」的草稿基线：null = 本次录音没有实时预填（走录制链路，或还没出字）
  const voiceBaseRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const voice = useVoiceInput({
    canStart: !sending,
    // 实时预填：第一次出字时快照住当前草稿，之后草稿一直是「基线 + 中间文本」
    onPartial: (text) => {
      if (voiceBaseRef.current === null) voiceBaseRef.current = draftRef.current;
      setDraft(appendVoiceText(voiceBaseRef.current, text));
    },
    // 作废（✕ / 没识别出文字 / 流式半途失败）：草稿还原成录音前的样子
    onDiscard: () => {
      const base = voiceBaseRef.current;
      voiceBaseRef.current = null;
      if (base !== null) setDraft(base);
    },
    // 定稿：流式链路草稿里已有预填 → 用定稿文本覆盖它；录制链路 → 追加到现有草稿之后（不自动发送）
    onText: (text) => {
      const base = voiceBaseRef.current;
      voiceBaseRef.current = null;
      setDraft((prev) => appendVoiceText(base ?? prev, text));
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    onError: (reason) => {
      void confirmAsk({
        title: 'Voice transcription failed',
        message: reason,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    },
    // 录音根本没起来（无麦克风权限 / 非安全上下文 / 被预览框架拦住）：原来只 console.warn，
    // 界面上表现为「点了没反应」——这里必须把原因讲出来
    onStartError: (reason) => {
      void confirmAsk({
        title: 'Microphone unavailable',
        message: reason,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    },
  });

  // 打开：拉历史（只取数据，不替用户置已读——未读态由「点开哪条」自己产生）
  useEffect(() => {
    void loadInboxHistory();
    inputRef.current?.focus();
  }, []);

  // 提问卡收起（提交 / 跳过 / 超时）后把焦点还给输入框，用户答完就能直接接着写
  useEffect(() => {
    if (!pendingQuestion) inputRef.current?.focus();
  }, [pendingQuestion]);

  /**
   * 点开一张通知卡片 = 「已点开」（read = 1），红点与好友头像角标的**唯一**清除口径。
   * 本地先置（不让红点在眼前闪一下）→ 落库；失败只吞掉——点开不是数据，
   * 下次再点会重试，不该因此弹错打扰用户（与 markThreadRead 同一取舍）。
   * 声明位置在「桌面通知定位」effect 之前：那个 effect 也要走同一条清零路径（const 不能用在其后）。
   */
  const markNoticeRead = useCallback((n: ButlerNotice): void => {
    if (n.read) return;
    patchButlerNotice(n.id, { read: true });
    void fetch('/api/butler/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [n.id], read: true }),
    })
      .then(() => notifyButlerUnreadChanged())
      .catch(() => undefined);
  }, []);

  /**
   * 桌面通知点击 → 定位该条。焦点由 ButlerHost 通过 focusNoticeId 传入
   * （宿主先开抽屉、事件后到达会漏收，故不在这里监听 window 事件）。
   * 真正「选中」交由下面的自动选中 effect 处理——它会把 ref 里的待办焦点优先兑现。
   */
  const focusNoticeRef = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!focusNoticeId) return;
    focusNoticeRef.current = { id: focusNoticeId, at: Date.now() };
    // 点桌面通知是「打开」右栏的三种方式之一：直接把回执详情展开（否则用户看到列表、还要再点一次）
    setRightOpen(true);
  }, [focusNoticeId]);

  /**
   * 常驻联系人线程 ID。取自列表接口的摘要身份标记（systemRole）而不是前端再写常量，
   * 保证前后端只认一个真源：
   *   - 'notify' = Bobby，通知助理（lib/core/butler-notify.ts）
   *   - 'recorder' = Recorder，会议记录员（lib/core/butler-recorder.ts）
   * 现在置顶行有两条，不能再用 find(pinned) 猜哪一个才是通知助理（会取到第一条）。
   */
  const notifyThreadId = useMemo(
    () => chatSessions.find((s) => s.systemRole === 'notify')?.threadId ?? null,
    [chatSessions],
  );
  /** 通知助理的显示名（= NOTIFY_TITLE，经列表接口带出）：人设弹窗据此锁定姓名 */
  const notifyTitle = useMemo(
    () => chatSessions.find((s) => s.threadId === notifyThreadId)?.title ?? 'Bobby',
    [chatSessions, notifyThreadId],
  );
  /** 小微（搜索助手）的显示名：人设弹窗据此锁定姓名 */
  const searchThreadId = useMemo(
    () => chatSessions.find((s) => s.systemRole === 'search')?.threadId ?? SEARCH_THREAD_ID,
    [chatSessions],
  );
  const searchTitle = useMemo(
    () => chatSessions.find((s) => s.threadId === searchThreadId)?.title ?? '小微',
    [chatSessions, searchThreadId],
  );
  /** 当前中栏看的是不是常驻「通知助理」（决定时间线要不要把通知行归并进来） */
  const isNotifyContact = !!notifyThreadId && activeThreadId === notifyThreadId;
  /**
   * 当前中栏看的是不是 Recorder —— 只对它隐藏「人设」入口、且后端也拒绝改人设。
   * 「通知助理」（Bobby）自 2026-09-28 起可设人设（首次打开该联系人时由用户设定），故不再算「不可改」。
   */
  const isRecorderContact = !!activeThreadId && chatSessions.some((s) => s.threadId === activeThreadId && s.systemRole === 'recorder');
  /**
   * 当前中栏看的是不是常驻「小微」（搜索助手）——只对它免掉搜索词过滤。
   * 原因：搜索栏那串字对小微来说是**待检索的关键词**（点按钮才发起），不是过滤条件。
   * 若照常过滤，起搜后刚落库的综述 / 卡片只要不含这串字就会被筛掉，会话看起来「一片空白」——
   * 这正是「检索了哪些文章没展示出来」的另一半成因。
   */
  const isSearchContact = activeThreadId === searchThreadId;
  /**
   * 检索过程块是否该出现：**只看「还在跑 / 要验证 / 有兜底说明」**，不含「已出结果」——
   * 结果落库成真消息，不在这一块里。跑完且无异常 → 整块卸载，不留「AI interpreting…」残影。
   */
  const wechatLiveOpen = isSearchContact && (wechatBusy || wechatCaptcha || !!wechatNotice);

  /** 中栏工具行的标题 = 当前联系人的名字（有会话时取会话标题，即人设姓名优先） */
  const currentContactTitle = useMemo(() => {
    if (activeThreadId) {
      const hit = chatSessions.find((s) => s.threadId === activeThreadId);
      if (hit) return hit.title;
    }
    return 'New chat';
  }, [activeThreadId, chatSessions]);

  /** 当前联系人的人设性格：中栏每条气泡 / 通知卡片的头像要拿它挑人物素材，须与联系人列的是同一张（见 ContactAvatar） */
  const currentContactPersonality = useMemo(
    () => chatSessions.find((s) => s.threadId === activeThreadId)?.persona?.personality,
    [activeThreadId, chatSessions],
  );

  /** 当前联系人的人设全量：等待行要说「与人设同口吻」的话，光有性格不够（还要称呼 / 说话风格） */
  const currentContactPersona = useMemo(
    () => chatSessions.find((s) => s.threadId === activeThreadId)?.persona ?? null,
    [activeThreadId, chatSessions],
  );

  /**
   * 联系人列：常驻联系人（通知助理 / Recorder）置顶 + 其余会话（服务端已按更新时间排序，这里只做置顶归位）。
   * 新建会话会**立即落库**（见 startNewChat），所以不再需要本地的「新会话」占位行——
   * 确认建好之后列表里就已经是一条真实行（标题 = 人设姓名）。
   * 与中栏时间线共用同一个搜索词（搜索栏已挪到本列顶部）：这里按 标题 / 预览 过滤，
   * 预览本身就是最近一条通知或消息的摘要，所以「搜通知」也能把人筛出来。
   * 另加一条：**跨会话命中历史消息**的会话也留下（微信式——联系人名不含关键词、
   * 但聊天记录里有时，仍要出现在结果里，命中消息嵌在本行下面，见 searchHits）。
   */
  const contactRows = useMemo<ButlerThreadSummary[]>(() => {
    const ordered = [...chatSessions.filter((s) => s.pinned), ...chatSessions.filter((s) => !s.pinned)];
    const q = searchQ.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (s) =>
        // 「小微」永不因搜索词被筛掉：同一个输入框既是跨会话过滤词、又是小微的检索关键词，
        // 起搜后会切到小微 —— 此时把它自己筛掉，用户就回不去了（也看不到刚落库的结果）。
        s.threadId === searchThreadId ||
        s.title.toLowerCase().includes(q) ||
        (s.preview ?? '').toLowerCase().includes(q) ||
        (searchHits[s.threadId]?.length ?? 0) > 0,
    );
  }, [chatSessions, searchQ, searchHits, searchThreadId]);

  /**
   * 各线程的**未点开卡片数**（inbox read = 0）。
   * 好友头像角标 = 会话未读消息（s.unread，打开会话即清）+ 本数（必须点开卡片才清）——
   * 就是微信里那条「还没听过的语音」：进了会话不等于听过它。
   * 归属口径与中栏时间线一致：threadId 命中，或（通知助理 + 系统推送类 kind）的存量空 threadId 行。
   */
  const unreadNoticesByThread = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notices) {
      if (n.read) continue;
      const tid = n.threadId || (NOTIFY_KINDS.has(n.kind) ? notifyThreadId : null);
      if (!tid) continue;
      m.set(tid, (m.get(tid) ?? 0) + 1);
    }
    return m;
  }, [notices, notifyThreadId]);

  /**
   * 中栏时间线：**只有当前这一个联系人**（原先每个联系人前面都叠着「全部回执行」，
   * 于是切换会话在视觉上几乎不可见）。
   *   - 普通联系人 = 该会话的消息气泡（openChatSession 已按逐条时间戳回填）
   *   - 通知助理 = 该线程的通知行 + 追问往返，按时间归并；通知行渲染成一张卡片。
   * 搜索框对两类内容都生效：通知走 matchesQuery（标题/正文/待办项/类别名），消息走正文包含。
   * 搜索栏本体在**联系人列顶部**（与「过滤联系人」共用同一个词，见 contactRows）。
   *
   * 2026-09-28 起**没有视图**：通知 = 普通消息，全部留在时间线（不再有 pending / archived 两段式）。
   * 「已读」也不再是可切的按钮/开关，而是**点开卡片**这一动作本身（卡片右上角的红点）；
   * 删除仍是唯一的清理入口；追问气泡属于对话，也一律混排在同一条流里。
   */
  const timeline = useMemo<TimelineItem[]>(() => {
    // 小微不打搜索词过滤：那是它的**检索关键词**，不是过滤器（见 isSearchContact）
    const q = isSearchContact ? '' : searchQ.trim().toLowerCase();
    const items: TimelineItem[] = [];
    if (isNotifyContact) {
      // 每条回执各成一张卡片（2026-09-27 起日报不再进通知中心，原先的「同日日报并卡」已取消）。
      for (const n of notices) {
        // 归属判定：线程一致（落库时兜底的新行），或 kind 属于系统推送类（存量行 / 刚落内存的实时推送）
        if (n.threadId !== notifyThreadId && !NOTIFY_KINDS.has(n.kind)) continue;
        if (q && !matchesQuery(n, q)) continue;
        items.push({ kind: 'notice', key: n.id, notice: n });
      }
    }
    // 追问气泡 = 对话正文，与通知卡片同处一条时间线（按时间归并）。
    for (const m of messages) {
      if (q && !m.content.toLowerCase().includes(q)) continue;
      items.push({ kind: 'msg', key: m.id, msg: m });
    }
    return items.sort((a, b) => timeOfItem(a) - timeOfItem(b));
  }, [isNotifyContact, notifyThreadId, notices, messages, searchQ, isSearchContact]);

  /**
   * 详情分区：`selectedId` 有值 = 右栏显示该条正文，无值 = 空态（提示从中栏点一条）。
   * 2026-09-26 去掉右栏的「列表层」后，右栏只剩阅读器一种形态——中栏时间线本身就是那份列表
   * （点卡片即看正文），右栏再放一份等于同一份东西说两遍。
   * 因此这里**不自动选中最新一条**（旧行为「打开即打开最近一条」会让空态永远进不去），
   * 只兑现桌面通知的「待办焦点」，且只在 4s 内有效——超时就不追了，避免把已切走的用户拽回来。
   * 焦点按**全量** notices 查找（不再按可见集合）：右栏已无列表，「这条在时间线里是否可见」与「能不能读它」无关。
   */
  useEffect(() => {
    const wanted = focusNoticeRef.current;
    if (!wanted) return;
    if (Date.now() - wanted.at >= 4000) {
      focusNoticeRef.current = null;
      return;
    }
    const hit = notices.find((n) => n.id === wanted.id);
    if (!hit) return;
    focusNoticeRef.current = null;
    // 点桌面通知 = 打开这条 → 与点卡片同一条清零路径（红点 / 好友角标）
    markNoticeRead(hit);
    setSelectedId(hit.id);
  }, [notices, focusNoticeId, markNoticeRead]);

  /**
   * 选中项按**全量** notices 派生，而不是按当前时间线过滤结果：
   * 搜索词一改（或这条被勾进多选批量删掉前）它可能已不在中栏列表里，但**不把右栏抽走**——
   * 用户点开后停在原地接着读，右栏不该无声退回空态（那会像是「点一下把详情弄丢了」）。
   */
  const selectedNotice = useMemo(
    () => notices.find((n) => n.id === selectedId) ?? null,
    [notices, selectedId],
  );

  /**
   * 该条通知是否指向**单个日程事件**（日历提醒）：是则取出事件 id，点开后到日历库现取完整信息。
   * 判定沿用 toggleItem 的口径：kind='calendar' 的条目 key 恒为事件 id，其余看 item.source='event'。
   * 多条待办（日报类清单）不在此列——它们要读的是清单而不是某一个事件的详情。
   */
  const scheduleEventId = useMemo(() => {
    const n = selectedNotice;
    if (!n) return null;
    const items = n.items ?? [];
    if (items.length !== 1) return null;
    const it = items[0];
    return it.source === 'event' || n.kind === 'calendar' ? it.key : null;
  }, [selectedNotice]);

  /** 日程完整信息（选中条目后现取；取不到时退化为原来的待办 chip） */
  const [scheduleDetail, setScheduleDetail] = useState<ScheduleDetail | null>(null);
  useEffect(() => {
    if (!scheduleEventId) {
      setScheduleDetail(null);
      return;
    }
    let alive = true;
    setScheduleDetail(null);
    fetch(`/api/calendar/events?event_id=${encodeURIComponent(scheduleEventId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.success && d.event) setScheduleDetail(d.event as ScheduleDetail);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [scheduleEventId]);

  /** 日程块对应的待办项（保留勾选完成能力）+ 完成态 */
  const scheduleItem = scheduleDetail ? (selectedNotice?.items?.[0] ?? null) : null;
  const scheduleDone = scheduleItem?.status === 'done';

  // 新内容到达时滚到底部（含流式增量：末条内容变长也要跟住）
  // 也跟住公众号检索的「过程块」：它挂在时间线末尾，起搜那一刻 timeline.length 不变（还没有新消息），
  // 不显式把它计入依赖就会停在旧位置、被上方内容挤出可视区 —— 用户于是「过程中没有任何感知」。
  // ⚠️ 不含 wechatPlan：检索方向的拆解 2026-10-01 已移到右栏 Search Live，中栏不再随它变高。
  const streamTailLen = messages.length > 0 ? (messages[messages.length - 1].content?.length ?? 0) : 0;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, streamTailLen, wechatBusy, wechatNotice, wechatCaptcha]);

  /**
   * 流式气泡是否**已经吐字**（末尾那条 assistant 占位气泡有正文了）。
   * 等待气泡只在还没吐字时显示（见时间线末尾 `sending && !draftStarted`，以及 `it.kind === 'msg'`
   * 里那条跳过空占位气泡的分支）：否则同一句话会出现两条——一条等待口语、一条正在长的正文。
   * 衔接就应该是——第一个字落下的同一刻，等待气泡让位，正文接着往下长。
   * （占位气泡由发送方在请求前就挂好，所以 sending 期间末条必然是 assistant，这里再挡一次 role 以防万一。）
   */
  const tailMsg = messages[messages.length - 1];
  const draftStarted = !!tailMsg && tailMsg.role === 'assistant' && !!tailMsg.content?.trim();

  /**
   * 「Buddy」（新建会话）是否生效中：没有指针、也没有气泡 = 正处于新会话。
   * 左栏该键据此点亮——点击「Buddy」的即时反馈就在这里（清空气泡是最容易被忽略的动作）。
   * 抽屉刚打开、恢复会话还没回来时也会短暂点亮。
   */
  const isNewChat = !activeThreadId && messages.length === 0;

  /**
   * 会议模式状态：抽屉打开期间轮询 /api/butler/meeting（3s 一次，单行 SQLite 读取，开销可忽略）。
   * 会议视图（开始面板 / 控制台）住在**右栏的 meeting 分区**；中栏恒为聊天，不再被接管。
   * 追加/结束由 MeetingConsole 触发 refreshMeeting 立即重取。
   */
  const [meeting, setMeeting] = useState<MeetingSnapshot | null>(null);
  const refreshMeeting = useCallback(async () => {
    try {
      const r = await fetch('/api/butler/meeting');
      const d = await r.json();
      setMeeting(d?.success && d.active ? (d as MeetingSnapshot) : null);
    } catch {
      /* 网络抖动：保留上一次状态，下一次轮询自愈 */
    }
  }, []);
  useEffect(() => {
    void refreshMeeting();
    const t = setInterval(() => void refreshMeeting(), 3000);
    return () => clearInterval(t);
  }, [refreshMeeting]);

  /** 会议是否进行中（快照每 3s 换新对象，故只取这个布尔量进 deps，避免把用户切走的分区又拉回来） */
  const meetingActive = !!meeting;
  /**
   * 会议一开始 → 右栏自动切到 meeting 分区并展开。
   * 这是「右栏默认不显示」的**唯一自动展开例外**；用户之后手动收起 / 切分区都不干预
   * （deps 只在 active 翻转时变化，3s 轮询不会反复触发）。
   */
  useEffect(() => {
    if (!meetingActive) return;
    setRightOpen(true);
    onSectionChange('meeting');
  }, [meetingActive, onSectionChange]);

  /** 按 id 批量删除（实现见 noticeActions：一条请求带全部 id） */
  const removeNotices = useCallback((ids: string[]) => removeNoticesByIds(ids), []);

  const removeNotice = useCallback((n: ButlerNotice) => removeNotices([n.id]), [removeNotices]);

  /** 待办项勾选（实现见 noticeActions：含日历事件 / 便签行的真实联动链路，移动端共用） */
  const toggleItem = useCallback((n: ButlerNotice, item: ButlerNoticeItem) => toggleNoticeItem(n, item), []);

  /** 报告类回执：把正文下载为 .md（实现见 noticeActions） */
  const downloadReportMd = useCallback((n: ButlerNotice) => downloadNoticeMd(n), []);

  /** 报告类回执：复制正文链接（实现见 noticeActions；「已复制」反馈仍由本组件计时器负责） */
  const copyReportLink = useCallback((id: string) => {
    const done = () => {
      setCopiedLinkId(id);
      window.setTimeout(() => setCopiedLinkId((c) => (c === id ? null : c)), 1600);
    };
    void copyNoticeReportLink(id).then(done).catch(() => undefined);
  }, []);

  /** 拉会话列表（打开抽屉 / 删除后刷新）；返回列表便于调用方接着用 */
  const refreshChatSessions = useCallback(async (): Promise<ButlerThreadSummary[]> => {
    try {
      const res = await fetch('/api/butler/threads');
      const data = (await res.json()) as { sessions?: ButlerThreadSummary[] };
      const list = data.sessions ?? [];
      setChatSessions(list);
      return list;
    } catch {
      return []; // 网络失败：列表保持原样，不阻断会话
    }
  }, []);

  /**
   * 未读口径变化（切走后落的回复终于落库 / 新回执 / 会话或卡片被读）→ 刷新联系人列，
   * **头像角标当场跟着变**。悬浮球由 ButlerOrb 自己订阅同一个事件；
   * 这里必须再听一次：角标数字在服务端，只有重新拉列表才能把某一行点亮。
   */
  useEffect(() => {
    const onUnreadChanged = () => void refreshChatSessions();
    window.addEventListener(BUTLER_UNREAD_CHANGED_EVENT, onUnreadChanged);
    return () => window.removeEventListener(BUTLER_UNREAD_CHANGED_EVENT, onUnreadChanged);
  }, [refreshChatSessions]);

  /**
   * 把某条会话置为已读：本地**先清零**（不让角标在眼前闪一下）→ 落库。
   *
   * 谁调用：① 打开 / 接回该会话（看了就算读了）；② 正在看这条会话时回复落地。
   * 反例也要守住：**折叠成悬浮球 / 切走之后落的回复不置已读**——那正是角标该亮的场景。
   * 落库失败只留日志：置已读不是数据，下次打开会再置一次，不该因此报错打扰用户。
   * 置已读成功后派一次 unread-changed：悬浮球的角标**当场回落**，不用等 120s 兜底轮询。
   */
  const markThreadRead = useCallback(async (threadId: string): Promise<void> => {
    setChatSessions((prev) =>
      prev.map((s) => (s.threadId === threadId && s.unread > 0 ? { ...s, unread: 0 } : s)),
    );
    try {
      await fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      });
      notifyButlerUnreadChanged();
    } catch {
      /* 见上：失败不改本地显示，下次打开重试 */
    }
  }, []);

  // ===== 会话级选型（模型 / 思考档位）=====

  /**
   * 模型下拉候选 = 模型池里**已勾选的对话模型**：purpose 为 'chat' 或未标，
   * 且不被 isChatModel 排除（视觉 / 音频 / 向量 / 重排不参与对话）。
   * 与 entry.ts 的自动选型共用同一判据，两处不会漂移；label 用预设里的友好名（无则回落模型 id）。
   */
  const modelOptions = useMemo<ModelOption[]>(() => {
    const meta = new Map(getAvailableModels(modelProviders).map((m) => [m.modelId, m]));
    const out: ModelOption[] = [];
    const seen = new Set<string>();
    for (const p of modelProviders) {
      for (const sel of p.selectedModels ?? []) {
        const modelId = typeof sel === 'string' ? sel : sel.modelId;
        if (!modelId) continue;
        const purpose = typeof sel === 'string' ? undefined : sel.purpose;
        if (purpose && purpose !== 'chat') continue;
        if (!isChatModel(modelId)) continue;
        const tag = `${p.type}:${modelId}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const info = meta.get(tag);
        out.push({
          tag,
          label: info?.label ?? modelId,
          thinking: typeof sel === 'string' ? (info?.thinking ?? true) : sel.thinking,
        });
      }
    }
    return out;
  }, [modelProviders]);

  /** 当前模型项；模型池尚未就绪（modelTag 为空）时无匹配 */
  const currentModelOption = modelOptions.find((o) => o.tag === modelTag);
  /** 模型不支持思考 → 档位不可点；模型池未就绪时放开（发送前必落成具体模型或由服务端兜底） */
  const modelSupportsThinking = modelTag ? (currentModelOption?.thinking ?? true) : true;
  const currentModelLabel = modelTag ? (currentModelOption?.label ?? modelTag) : 'Select model';

  /**
   * 选型改动即落盘（PATCH /api/butler/threads/session）。
   * 会话尚未落库（新会话发出首条消息前）时 threadIdRef 为空 → 跳过；
   * 那种情况由建会话 POST 或首条消息的 modelId/thinkingLevel 带上，不丢选择。
   */
  const persistModelSettings = useCallback(async (model: string, level: ThinkingLevel): Promise<void> => {
    const tid = threadIdRef.current;
    if (!tid) return;
    try {
      await fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(tid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: { modelId: model || null, thinkingLevel: level } }),
      });
    } catch {
      /* 落盘失败不打扰：本轮仍按界面选择发送，下次切回来退回线程里存的值 */
    }
  }, []);

  const changeModel = useCallback(
    (tag: string) => {
      setModelTag(tag);
      setModelMenuOpen(false);
      void persistModelSettings(tag, thinking);
    },
    [thinking, persistModelSettings],
  );

  const changeThinking = useCallback(
    (level: ThinkingLevel) => {
      setThinking(level);
      setThinkingMenuOpen(false);
      void persistModelSettings(modelTag, level);
    },
    [modelTag, persistModelSettings],
  );

  /**
   * Auto 下线迁移（与画布对话节点「Auto 下线迁移」同口径，见 ChatNodeKernel）：
   * 候选池就绪后把**空值 / 已失效的标签**落成具体模型 —— 存量会话存的是 Auto 时代的 null，
   * 或所选厂商被删、取消勾选导致标签失效；优先命中「设置 → 主对话候选池」的有序首选，
   * 池空则取下拉首项（与服务端 entry.ts 的自动选型口径一致，切换前后是同一个模型）。
   * 落库即改即存（persistModelSettings），切回该联系人仍是这个模型；
   * 一个对话模型都没配时保持空串，发送留 null 交服务端兜底（与节点同做法）。
   */
  useEffect(() => {
    if (modelOptions.length === 0) return;
    if (modelTag && modelOptions.some((o) => o.tag === modelTag)) return;
    const poolHit = chatModelPool.find((p) => modelOptions.some((o) => o.tag === `${p.provider}:${p.modelId}`));
    const target = poolHit ? `${poolHit.provider}:${poolHit.modelId}` : modelOptions[0].tag;
    setModelTag(target);
    void persistModelSettings(target, thinking);
  }, [modelOptions, modelTag, chatModelPool, thinking, persistModelSettings]);

  /**
   * 多选模式（气泡 / 通知卡片 **共用一套**）。
   * 2026-09-28 收口：卡片就是普通消息，原先并列的两套选择态（气泡 selectedMsgIds、
   * 卡片 selectedNoticeKeys）合并成一套 —— 否则「卡片和消息一起选中、一起删」做不到，
   * 与「卡片即普通消息」的定位自相矛盾。
   *
   * 勾选集合按**时间线条目 key** 记（气泡 = 消息 id，卡片 = 回执 id），中栏混排的两类都能勾；
   * 删除时按 kind 分流到两条接口（见 deleteSelected）。
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const leaveSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedKeys(new Set());
  }, []);

  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** 从某条气泡 / 某张卡片进多选：这条**默认勾上**（微信长按多选就是这个手感），否则进来先看到 0 条已选 */
  const enterSelectMode = useCallback((key: string) => {
    setSelectMode(true);
    setSelectedKeys(new Set([key]));
  }, []);

  /**
   * 可选的 = 中栏时间线里「看得见、点得动」的那些（计数 / 全选口径 = 它，与中栏看到的对齐）：
   *   - 通知卡片全都可以；
   *   - 气泡排除 pending（流式占位还没落库，选中它没有任何对应行为）；
   *   - 排除还没吐字的尾部气泡（它由 ButlerWaitingLine 渲染，中栏里并没有它）。
   * 气泡与卡片同处一条时间线，所以这里是**合并后**的集合，不再分两套。
   */
  const selectableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const it of timeline) {
      if (it.kind === 'notice') {
        keys.push(it.key);
        continue;
      }
      if (it.msg.pending) continue;
      if (sending && !draftStarted && it.msg.id === tailMsg?.id) continue;
      keys.push(it.key);
    }
    return keys;
  }, [timeline, sending, draftStarted, tailMsg]);

  /** 已选数：按**当前可选项**求交，切会话 / 搜索后残留的旧 key 不计数、也不会误删 */
  const selectedCount = useMemo(
    () => selectableKeys.reduce((n, k) => (selectedKeys.has(k) ? n + 1 : n), 0),
    [selectableKeys, selectedKeys],
  );

  /**
   * 删除消息（单条 / 多选批量）：**先本地移除**（点击当场生效）→ 再把要删的这批送去落库。
   *
   * 送给服务端的身份是 **role + 正文**（气泡上看得见的东西），`h-<下标>` 只是顺带给的提示：
   * 服务端会裁头（只留最近 N 轮），裁过之后下标就整体偏了，照着删会删错行——
   * 所以真正作数的是正文，下标只在重复正文里帮着认准是哪一条（见 threads.deleteThreadMessages）。
   * 落库失败**不回滚本地**：删了就该从眼前消失——重开这条会话它会复原，
   * 但也比「刚删掉的消息又自己冒回来」好接受。
   */
  const deleteMessages = useCallback(
    async (ids: string[]) => {
      const want = new Set(ids);
      const targets = messages.filter((m) => want.has(m.id));
      if (targets.length === 0) return;
      const items = targets.map((m) => ({
        role: m.role,
        content: m.content,
        index: m.id.startsWith('h-') ? Number(m.id.slice(2)) : undefined,
      }));
      setMessages((prev) => prev.filter((m) => !want.has(m.id)));
      // 删掉的若是「正被右栏回看的那一轮检索」→ 右栏一并清空（口径见 hook 内注释，桌面与移动端同源）。
      clearOpenedTraceIfDeleted(want);
      leaveSelectMode();
      const tid = threadIdRef.current;
      if (!tid) return;
      try {
        await fetch(`/api/butler/threads/messages?threadId=${encodeURIComponent(tid)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
      } catch {
        /* 见上：本地已移除，重开这条会话会复原 */
      }
      void refreshChatSessions();
    },
    [messages, leaveSelectMode, refreshChatSessions, clearOpenedTraceIfDeleted],
  );

  /**
   * 删除所选（卡片与气泡**混选**同一条时间线）：按类型分流到两条接口 ——
   * 气泡走会话消息删除（/api/butler/threads/messages，按 role + 正文认行），
   * 卡片走收件箱删除（/api/butler/inbox，按回执 id），两路并发，不必等谁先回来。
   * 先本地移除再落库、失败不回滚：与各自的单条删除同一取舍。
   */
  const deleteSelected = useCallback(() => {
    const keys = selectedKeys;
    const noticeIds: string[] = [];
    const msgIds: string[] = [];
    for (const it of timeline) {
      if (!keys.has(it.key)) continue;
      if (it.kind === 'notice') noticeIds.push(it.notice.id);
      else msgIds.push(it.msg.id);
    }
    leaveSelectMode();
    if (noticeIds.length > 0) removeNotices(noticeIds);
    if (msgIds.length > 0) void deleteMessages(msgIds);
  }, [selectedKeys, timeline, leaveSelectMode, removeNotices, deleteMessages]);

  /**
   * 复制所选：按**时间线顺序**拼成一段（气泡取正文，卡片取 noticeText ——
   * 回执正文就是右栏读的那份）；一条都没选时**不写剪贴板**（否则会拿空串把它清掉）。
   */
  const copySelected = useCallback(async (): Promise<boolean> => {
    const keys = selectedKeys;
    const parts: string[] = [];
    for (const it of timeline) {
      if (!keys.has(it.key)) continue;
      parts.push(it.kind === 'notice' ? noticeText(it.notice) : it.msg.content);
    }
    if (parts.length === 0) return false;
    return copyText(parts.join('\n\n'));
  }, [selectedKeys, timeline]);

  /**
   * 订阅通知 store：**只负责渲染，不替用户置已读**。
   *
   * 这里原本是「看着窗口 = 已读」（微信语义）：每次 store 变化就把未读的全部 PATCH 成已读。
   * 结果是打开抽屉看到的通知**全是「已读」**，角标等于摆设，
   * 用户也分不清「已读」和「完成（归档）」——故改为：未读就是未读，点开某一条才清零。
   *
   * 顺带做一件事：通知/会话在服务端变了（通知助理预备下一批回执、Recorder 侧来消息）
   * → **去抖重拉会话列表**。否则列表的预览与未读角标要等下次关开抽屉才刷新。
   * （本 effect 依赖 refreshChatSessions，故从原来靠前的位置下移到它之后。）
   */
  useEffect(() => {
    let timer = 0;
    const unsubscribe = subscribeButlerNotices((list) => {
      setNotices(list);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshChatSessions(), 600);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshChatSessions]);

  /**
   * 接收一批文件（选择 / 拖拽 / 粘贴三条入口共用）：逐个上传到 Butler 存储空间，
   * 成功即入待发列表。上传在**选择时**就落盘（不等发送）。
   * 失败给一次**可见提示**而非静默丢弃——静默失败会让用户以为「已经拖进来了」，
   * 实际消息里没有资料块，模型也读不到文件。
   */
  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachError(null);
    setAttaching(true);
    try {
      for (const f of list) {
        try {
          const att = await uploadButlerAttachment(threadIdRef.current, f);
          setPendingAtts((prev) => [...prev, att]);
        } catch (e) {
          setAttachError(`Failed to upload “${f.name}”: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      setAttaching(false);
    }
  }, []);

  /**
   * 选择一个**本地文件夹作为本会话的工作区**（用户指定 · 锁定操作范围）。
   *
   * 与回形针的文件附件**不是一回事**：附件只作用于发出去的那一条消息；工作区是**常驻**的
   * ——选定后每轮对话都随消息注入「锁定操作范围」，发送后不清、切联系人各自保留。真源在线程
   * 文件（唯一写入口 = `lib/butler/threads.ts setThreadWorkspace`），本组件只是镜像。
   *
   * 为什么不上传、不复制：一个目录可能有成千上万个文件，复制进 Butler 存储空间既不划算、
   * 也会在用户不知情时吃掉磁盘。只带**绝对路径**，模型侧靠 list_directory + read_file 取用。
   *
   * 选定后还要 `add_root` 登记一次：文件工具默认**只放行当前项目目录**、禁读个人目录
   * （profiles.ts:157），不登记 Butler 就会读不到用户刚亲手选的目录。这里刻意复用画布
   * LocalFileExplorer 的同一端点、同一份 browseRoots——两处口径不同会出现「Butler 侧选了
   * 目录、画布侧却不认」；端点幂等。
   */
  const attachFolder = useCallback(async () => {
    setAttachError(null);
    const threadId = threadIdRef.current;
    // 没有绑定会话就没有可挂工作区的对象（空白态下按钮本就该被拦住）
    if (!threadId) {
      setAttachError('Start a conversation before choosing a workspace folder');
      return;
    }
    // 浏览器 dev 下没有 Electron 的目录选择器：早退并给可见提示，别让用户点了没反应
    if (!isDesktop()) {
      setAttachError('Folder selection requires the desktop app');
      return;
    }
    setAttaching(true);
    try {
      const r = await desktop.selectDirectory();
      if (r.canceled) return;
      if (!r.success || !r.path) {
        setAttachError(r.error || 'Unable to open the folder picker');
        return;
      }
      const dirPath = r.path;
      // 授权登记（幂等）：不登记则文件工具读不到项目目录之外的这个目录
      const authResp = await fetch(`/api/local-files?action=add_root&path=${encodeURIComponent(dirPath)}`);
      const auth = (await authResp.json()) as { success?: boolean; error?: string };
      if (!authResp.ok || !auth.success) {
        setAttachError(auth.error || `Could not authorize folder (HTTP ${authResp.status})`);
        return;
      }
      const name = dirPath.split('/').filter(Boolean).pop() || dirPath;
      // 落盘：走 PATCH /session 的 workspace 分支（不进消息链路、不动 updatedAt）
      const resp = await fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: { path: dirPath, name } }),
      });
      const saved = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || !saved.success) {
        setAttachError(saved.error || `Could not set workspace (HTTP ${resp.status})`);
        return;
      }
      // **写盘成功才翻转本地**：与选型器、置已读同一取舍——宁可不显示，也不显示一个假的
      setWorkspaceFolder({ path: dirPath, name });
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  }, []);

  /** 清除会话级工作区（pill 上的 ×）：先落盘、成功才翻转本地，与 attachFolder 同一取舍 */
  const clearWorkspace = useCallback(async () => {
    const threadId = threadIdRef.current;
    if (!threadId) return;
    setAttachError(null);
    try {
      const resp = await fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: null }),
      });
      const saved = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || !saved.success) {
        setAttachError(saved.error || `Could not clear workspace (HTTP ${resp.status})`);
        return;
      }
      setWorkspaceFolder(null);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 移除一个待发附件（**只解除引用，不删盘上文件**：上传即落盘，避免误删用户刚传的资料） */
  const removePendingAtt = useCallback((id: string) => {
    setPendingAtts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /**
   * 切换联系人时不把上一会话的待发附件带过去：文件落在上一会话的 threadId 目录下，
   * 悄悄带过去用户看不出差别，模型却读到的是别处的文件。用 ref 跳过首次渲染。
   *
   * 顺带退出多选：勾选集合是按**当前会话**的消息 id 记的，带过去只会让底部操作条
   * 留着一个对不上任何气泡的计数。
   */
  const prevThreadRef = useRef<string | null>(activeThreadId);
  useEffect(() => {
    if (prevThreadRef.current === activeThreadId) return;
    prevThreadRef.current = activeThreadId;
    setPendingAtts([]);
    setAttachError(null);
    leaveSelectMode();
  }, [activeThreadId, leaveSelectMode]);

  /**
   * 向 Butler 提问 —— **流式**（SSE）。
   * 为什么不用聚合返回：butler 画像的排程三件套会挂起等待 butler_confirm 确认卡，
   * 聚合版要读到流结束才返回 → 卡片永远到不了用户手里，只能干等到服务端超时。
   * 这里边读边渲染：content 增量更新气泡，butler_confirm 帧弹可编辑确认卡（复用画布同款组件）。
   */
  const send = useCallback(
    async (textArg?: string) => {
      const text = (textArg ?? draft).trim();
      // 有附件但无文本也应可发（把文件甩给 Butler 让它读）；两者皆空才拦。
      // 上传中同样拦下：否则会发出一个「资料列表」里缺本次文件的块。
      if ((!text && pendingAtts.length === 0) || sending || attaching) return;
      // 实际发给会话层的文本：斜杠命令会被归一化成「意图：…」+ 正文（展示气泡仍用原文）
      let outgoing = text;

      // ── 斜杠指令（P0 统一入口）：一律交给**管家**（会话层）处理 ──
      // 宿主层不再确定性执行斜杠命令，只做归一化翻译（normalizeSlashInput）——
      // 命令表经动态注入给管家，管家按意图调用自己的工具（排程三件套弹可编辑确认卡；
      // /meeting 自 P1-b 工具化后同样落到会话层——meeting_start / meeting_append / meeting_end）。
      // ⚠️ 全量走下方 SSE 流式链路（非聚合版）：聚合版读到流结束才返回，
      //    排程确认卡/结构化提问这类挂起帧会让它一直转圈（见本函数上方注释）。
      // /chat 命令已退役（含更早退役的 /chat out、/chat new）：普通文本本就直连管家同一 agent，
      // 会话线程随当前联系人复用（reuseThreadId），切联系人即切线程。
      const cmd = detectCommand(text);
      if (cmd) {
        outgoing = normalizeSlashInput(text);
      }
      // 附件「资料列表」块追加在正文之后（与画布 `text + blocks` 同序）；
      // 路径是 Butler 存储空间的**绝对路径**，模型据此用 read_attachment 直读。
      outgoing += attachmentBlock(pendingAtts);
      // 工作区块**每轮都带**（常驻的操作范围，不是本轮附件）——放在附件之后，
      // 让「本轮资料」与「本会话操作范围」在正文里界限分明。
      outgoing += workspaceBlock(workspaceFolder);

      const uid = `u-${Date.now()}`;
      const aid = `a-${Date.now()}`;
      // 无正文时用附件名当气泡内容，避免出现一个空白气泡（用户看不出自己发了什么）
      const displayed = text || pendingAtts.map((a) => a.name).join('、');
      setMessages((prev) => [...prev, { id: uid, role: 'user', content: displayed, time: Date.now() }]);
      setDraft('');
      setCommandOpen(false);
      setPendingAtts([]);
      setAttachError(null);
      setSending(true);
      // 等待行从此刻起换口语（首 token 未到那段静默最像卡住，越早给交代越好）
      setWaitSince(Date.now());
      const ac = new AbortController();
      streamAbortRef.current = ac;
      // 流是否被主动打断（关闭抽屉 / 切会话）：决定回复落地时要不要置已读，见 finally
      let streamAborted = false;
      try {
        const res = await fetch('/api/butler/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            text: outgoing,
            source: 'panel',
            reuseThreadId: threadIdRef.current,
            stream: true,
            // 会话级选型随消息带上：Auto 已下线，这里正常是具体标签；
            // 仅「模型池未就绪 / 没配对话模型」才会是 ''，转 null 交服务端兜底解析
            modelId: modelTag || null,
            thinkingLevel: thinking,
          }),
        });

        // 非 SSE（模型未配置等 → 路由返回 JSON 错误）
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !res.body || !ctype.includes('text/event-stream')) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = (await res.json()) as { error?: string; message?: string };
            msg = j.error || j.message || msg;
          } catch {
            /* 非 JSON 响应体 */
          }
          setMessages((prev) => [...prev, { id: aid, role: 'assistant', content: `⚠ ${msg}`, time: Date.now() }]);
          return;
        }

        // 先落一个空气泡占位，随后按 content 帧增量填充
        setMessages((prev) => [...prev, { id: aid, role: 'assistant', content: '', time: Date.now(), pending: true }]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let d: Record<string, unknown>;
              try {
                d = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
              } catch {
                continue; // 心跳 / 非 JSON 帧
              }
              // 首帧 threadId（路由显式注入）→ 供续聊复用上下文，并落盘
              // （New chat 后新开的会话，靠这次写入才能在下次打开抽屉时被接回）
              if (typeof d.threadId === 'string' && d.threadId) {
                threadIdRef.current = d.threadId;
                setActiveThreadId(d.threadId);
                writeActiveThreadId(d.threadId);
              }
              // 排程确认卡：挂起等待用户编辑/确认（组件内部 POST /api/chat/confirm 后回调 onClose）
              if (d.butler_confirm) {
                setButlerConfirm(d.butler_confirm as ButlerConfirmState);
                continue;
              }
              // 结构化提问（ask_user_questions）：服务端已挂起等答复（最长 600s），此处顶掉输入框
              // 渲染 docked 表单。**不接这个帧就是「Butler 说一句『先跟你确认两个细节』然后卡住」**——
              // 与 butler_confirm 同为挂起型，区别是它要用户填答案而不是点确认。
              if (d.questions_request) {
                const qr = d.questions_request as {
                  requestId?: string;
                  questions?: QuestionItem[];
                  timeoutSec?: number;
                };
                if (qr.requestId && Array.isArray(qr.questions) && qr.questions.length > 0) {
                  setPendingQuestion({ requestId: qr.requestId, questions: qr.questions, timeoutSec: qr.timeoutSec });
                  setQuestionMinimized(false);
                }
                continue;
              }
              // 通用工具确认（需手动确认名单）：服务端已挂起等确认（最长 600s），
              // 必须弹框并回传 POST /api/chat/confirm —— 漏接就是「说完一句就卡住」。
              if (d.tool_confirm) {
                const cf = d.tool_confirm as {
                  confirmId?: string;
                  name?: string;
                  arguments?: Record<string, unknown>;
                  timeoutSec?: number;
                };
                if (cf.confirmId) {
                  const raw = cf.arguments ? JSON.stringify(cf.arguments, null, 2) : '{}';
                  const paramText = raw.length > 600 ? `${raw.slice(0, 600)}\n…(truncated)` : raw;
                  void (async () => {
                    const approved = await confirmAsk({
                      title: `Tool "${cf.name}" needs confirmation`,
                      message: `Params:\n${paramText}`,
                      confirmLabel: 'Allow',
                      cancelLabel: 'Deny',
                    }).catch(() => false);
                    try {
                      await fetch('/api/chat/confirm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ confirmId: cf.confirmId, approved }),
                      });
                    } catch {
                      /* 回传失败：服务端超时按拒绝处理 */
                    }
                  })();
                }
                continue;
              }
              // browser.login（BobWork 模式）：弹登录窗输入账号密码；
              // 凭据仅经 前端→服务端内存→MCP→扩展 直传，不过模型上下文/日志。
              if (d.login_required) {
                const lr = d.login_required as {
                  requestId?: string;
                  siteName?: string;
                  url?: string;
                  timeoutSec?: number;
                };
                if (lr.requestId) {
                  setLoginPopup({
                    requestId: lr.requestId,
                    siteName: lr.siteName || 'this site',
                    url: lr.url || '',
                    timeoutSec: lr.timeoutSec,
                  });
                }
                continue;
              }
              // bobby 授权拦截：转交全局授权宿主（layout.tsx 的 BobbyAuthHost 监听该事件弹授权框）。
              // 授权完成后宿主广播 bobby:granted，本组件匹配目标后自动补发「继续」。
              if (d.grant_required) {
                const gr = d.grant_required as { target?: string };
                if (typeof gr.target === 'string') {
                  pendingGrantTargetRef.current = gr.target;
                  if (typeof window !== 'undefined') {
                    window.dispatchEvent(
                      new CustomEvent('bobby:grant-required', { detail: { target: gr.target } }),
                    );
                  }
                }
                continue;
              }
              // ⚠️ 过程帧（reasoning / tool_call_update / tool_result）**一律不读**：
              // 等待行只说人话（见 ButlerWaitingLine），不报「正在思考」、不报正在调哪个工具——
              // 那是宿主在汇报工序，不是一个人在跟你说话（用户口径：不需要思考，只要像人类一样交流）。
              if (typeof d.error === 'string' && d.error) {
                acc += `${acc ? '\n\n' : ''}⚠ ${d.error}`;
              }
              if (typeof d.content === 'string' && d.content) {
                acc += d.content;
                // 逐帧就剥 think：若只在收尾剥，模型吐 think 标签时气泡会把思考块一并显示出来
                // （stripThinkTags 会把未闭合的 think 段截断到末尾，流式安全）
                const shown = stripThinkTags(acc);
                setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, content: shown } : m)));
              }
            }
          }
        }

        // 收尾：清 pending，兜底文案（只回 reasoning 没 content 时也要给个交代）
        const finalText = stripThinkTags(acc).trim();
        // 流已结束 → 挂起提问（若有）已由服务端超时/回灌处理完毕，本地一并收起
        setPendingQuestion(null);
        setQuestionMinimized(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aid ? { ...m, pending: false, content: finalText || '(Butler produced no text response this time)' } : m,
          ),
        );
      } catch (e) {
        const aborted = e instanceof DOMException && e.name === 'AbortError';
        streamAborted = aborted;
        // 流已断（网络错误 / 用户关闭抽屉）→ 挂起提问不可能再被作答，本地一并收起
        setPendingQuestion(null);
        setQuestionMinimized(false);
        if (!aborted) {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              content: `⚠ ${e instanceof Error ? e.message : String(e)}`,
              time: Date.now(),
            },
          ]);
        } else {
          setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, pending: false } : m)));
        }
      } finally {
        streamAbortRef.current = null;
        setSending(false);
        // 回复落地时**用户还停在这条会话上** = 已看过 → 置已读（角标当场清零）。
        // 打断（折叠成悬浮球 / 切走）时**不置**：那条回复是「你不在时来的」，正是角标该亮的场景。
        if (!streamAborted && threadIdRef.current) void markThreadRead(threadIdRef.current);
        // 打断（切走 / 折叠）时**不置已读**，只顺手派一次信号——注意这次问得偏早：
        // abort 只停了前端消费，服务端要等流结束才落库（entry.ts），所以真正的「落地」由
        // 切走时开的 watchForUnreadGrowth 追踪器在总数变化时补一发（见 openChatSession / 卸载 effect）。
        else notifyButlerUnreadChanged();
        // 等待行随 sending 一起卸载（不需要清 waitSince：下一轮开跑时会重新取值）
        // 新会话的首条消息会把会话落库（服务端在流关闭前写完）→ 刷新联系人列，
        // 让刚聊的这条立刻出现在列表里（标题 = 首条提问）。失败时刷新无害，忽略返回值。
        void refreshChatSessions();
      }
    },
    [draft, sending, attaching, pendingAtts, workspaceFolder, confirmAsk, refreshChatSessions, markThreadRead, modelTag, thinking],
  );

  // ===== `/` 指令下拉（纯逻辑在 lib/core/commands.ts，本抽屉是唯一渲染方） =====

  /**
   * 按光标所在行同步下拉状态。
   * 行内已**完整命中**某指令（如 `/todo`）→ 收起：否则用户打完指令名后下拉会一直挡住输入框。
   */
  const updateCommandState = useCallback((text: string, pos: number, keepHighlight = false) => {
    const { lineText } = getLineAtCursor(text, pos);
    if (!hasCommandIntent(lineText) || detectCommand(lineText)) {
      setCommandOpen(false);
      return;
    }
    setCommandOpen(true);
    if (!keepHighlight) setCommandHighlight(0);
  }, []);

  /** 光标同步：键盘移动需保留高亮，否则按 ↑↓ 会被自己重置回第一项 */
  const syncCaret = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.target as HTMLTextAreaElement;
      const pos = ta.selectionStart ?? 0;
      setCursorPos(pos);
      updateCommandState(ta.value, pos, (e.nativeEvent as Event).type === 'keyup');
    },
    [updateCommandState],
  );

  /** 选中指令：把 `/keyword` 写到光标所在行行首（其余行不动）；**只注入不执行** */
  const applyCommand = useCallback(
    (cmd: ButlerCommand) => {
      recordCommandUsage(cmd.id);
      setCommandUsage((prev) => ({ ...prev, [cmd.id]: (prev[cmd.id] ?? 0) + 1 }));
      const { text: newText, caret } = buildCommandTextAtLine(draft, cursorPos, cmd.keyword);
      setDraft(newText);
      setCursorPos(caret);
      setCommandOpen(false);
      setCommandHighlight(0);
      inputRef.current?.focus();
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(caret, caret));
    },
    [draft, cursorPos],
  );

  /** 下拉候选：仅在展开时计算（按行内已输入 token 过滤 + 使用量降序） */
  const commandCandidates = commandOpen
    ? filterCommands(getLineAtCursor(draft, cursorPos).lineText, commandUsage)
    : [];

  /** 下拉里的键盘导航（↑↓ 移动 / Enter 选中 / Esc 关闭），返回 true 表示已消费该按键 */
  const handleCommandKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!commandOpen || commandCandidates.length === 0) return false;
      const n = commandCandidates.length;
      if (e.key === 'ArrowDown') {
        setCommandHighlight((i) => (i + 1) % n);
      } else if (e.key === 'ArrowUp') {
        setCommandHighlight((i) => (i - 1 + n) % n);
      } else if (e.key === 'Enter') {
        applyCommand(commandCandidates[commandHighlight] ?? commandCandidates[0]);
      } else if (e.key === 'Escape') {
        setCommandOpen(false);
      } else {
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    [commandOpen, commandCandidates, commandHighlight, applyCommand],
  );

  /** 保持 sendRef 指向最新实现（bobby:granted 自动补发用） */
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /**
   * bobby 授权完成（全局 BobbyAuthHost 广播 `bobby:granted`）：
   * 与最近等待授权的目标匹配 → 自动补发「已授权，继续」，用户无需手动回复。
   * 与画布 ChatNodeKernel 同语义（若此刻仍在流式则跳过，下一轮会重新请求授权）。
   */
  useEffect(() => {
    const onBobbyGranted = (e: Event) => {
      const target = (e as CustomEvent<{ target?: string }>).detail?.target;
      if (!target) return;
      const pending = pendingGrantTargetRef.current;
      if (!pending) return;
      if (target.trim().toLowerCase() !== pending.trim().toLowerCase()) return;
      pendingGrantTargetRef.current = null;
      if (streamAbortRef.current) return; // 仍在流式：跳过
      void sendRef.current?.(`(Automatic) Authorization for ${target} is complete. Please continue the previously paused task.`);
    };
    window.addEventListener('bobby:granted', onBobbyGranted);
    return () => window.removeEventListener('bobby:granted', onBobbyGranted);
  }, []);

  /** 左栏功能键：切预览区分区，并**展开右栏**（右栏默认不占位，不展开等于点了没反应） */
  const pickSection = useCallback(
    (s: ButlerSection) => {
      // 点 Today = 「重新打开 Today」：换 token 强制面板重挂载，页签回到 Report（理由见 todayOpenSeq）。
      if (s === 'today') setTodayOpenSeq((n) => n + 1);
      setRightOpen(true);
      onSectionChange(s);
    },
    [onSectionChange],
  );

  /**
   * 收起右栏（栏首关闭键）—— **单独关闭，不关整个抽屉**；
   * 若正看文档预览，一并清掉该预览（文档预览由 ButlerHost 推入，得回调外层才能真的消失）。
   */
  const closeRight = useCallback(() => {
    setRightOpen(false);
    onCloseDoc();
  }, [onCloseDoc]);

  /**
   * 文档预览栏「编辑」：把文档转交画布右侧预览面板的 md 编辑器打开。
   * 抽屉是居中浮层（z-[1320]）会盖住画布，所以先发 file.open 让画布挂上文件标签，
   * 再收起抽屉（并清掉右栏 docPath），用户直接落到画布的编辑器里。
   */
  const handleEditDoc = useCallback(
    (path: string) => {
      openFileByProjectRelPath(path);
      onCloseDoc();
      onClose();
    },
    [onCloseDoc, onClose],
  );

  /** 右栏「就这条继续问」→ 把回执标题拼成提问并发送 */
  const askAboutNotice = useCallback(
    (n: ButlerNotice) => {
      const text = `About “${n.title}”: `;
      setDraft(text);
      setCursorPos(text.length);
      setCommandOpen(false);
      inputRef.current?.focus();
    },
    [],
  );

  /**
   * 回传结构化提问的答复。
   * answers 为空数组 = 按「未回答」解除挂起（服务端 resolvePendingQuestions → resolve([])，
   * 回灌文案「用户未回答你的提问…」让模型继续），用于跳过 / 关抽屉兜底。
   */
  const postQuestionAnswers = useCallback(
    (requestId: string, answers: AnswerEntry[] = [], supplement?: string) => {
      void fetch('/api/chat/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          answers: answers.map((a) => ({ questionId: a.questionId, selected: a.selected, custom: a.custom })),
          supplement: supplement?.trim() || undefined,
        }),
      }).catch(() => undefined);
    },
    [],
  );

  /** 提问卡：提交（末页可带补充说明）→ 服务端把答案作为 tool_result 回灌模型继续生成 */
  const handleQuestionSubmit = useCallback(
    (answers: AnswerEntry[], supplement: string) => {
      const rid = questionRef.current?.requestId;
      setPendingQuestion(null);
      setQuestionMinimized(false);
      if (!rid) return;
      postQuestionAnswers(rid, answers, supplement);
    },
    [postQuestionAnswers],
  );

  /** 提问卡：显式跳过 → 立即按未回答解除挂起（不必干等 10 分钟超时） */
  const handleQuestionSkip = useCallback(() => {
    const rid = questionRef.current?.requestId;
    setPendingQuestion(null);
    setQuestionMinimized(false);
    if (!rid) return;
    postQuestionAnswers(rid, []);
  }, [postQuestionAnswers]);

  /** 提问卡：倒计时归零 → 服务端已按未回答继续，本地清理即可（无需再回传） */
  const handleQuestionExpire = useCallback(() => {
    setPendingQuestion(null);
    setQuestionMinimized(false);
  }, []);

  /** 登录弹窗提交：凭据仅 POST /api/chat/login 回传服务端（→ MCP → 扩展代填），不落任何本地状态 */
  const handleLoginSubmit = useCallback((username: string, password: string) => {
    const lp = loginRef.current;
    setLoginPopup(null);
    if (!lp) return;
    void fetch('/api/chat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: lp.requestId, username, password }),
    }).catch(() => undefined);
  }, []);

  /** 登录弹窗关闭（未提交凭据）→ 按「取消」解除服务端挂起（否则空等 600s） */
  const handleLoginClose = useCallback(() => {
    const lp = loginRef.current;
    setLoginPopup(null);
    if (!lp) return;
    void fetch('/api/chat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: lp.requestId, cancelled: true }),
    }).catch(() => undefined);
  }, []);

  /**
   * 挂起回收：把三类「绑在当前会话上」的挂起帧按放弃处理并立即回传服务端。
   * 两个触发点共用：抽屉卸载（关闭）与**切换 / 新建会话**——切走之后已无人能作答，
   * 不回传就是服务端空等各自的 600s 超时（confirm / questions / login）。
   */
  const releasePendingInteractions = useCallback(() => {
    const c = confirmRef.current;
    if (c) {
      void fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmId: c.confirmId, approved: false }),
      }).catch(() => undefined);
    }
    setButlerConfirm(null);
    // 挂起的结构化提问同理：已无人能作答 → 按「未回答」立即解除
    // （否则服务端要空等 QUESTIONS_TIMEOUT_MS = 600s 才继续）
    const q = questionRef.current;
    if (q) postQuestionAnswers(q.requestId, []);
    setPendingQuestion(null);
    setQuestionMinimized(false);
    // 挂起的登录弹窗同理：已无人能填凭据 → 按「取消」立即解除
    const l = loginRef.current;
    if (l) {
      void fetch('/api/chat/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: l.requestId, cancelled: true }),
      }).catch(() => undefined);
    }
    setLoginPopup(null);
  }, [postQuestionAnswers]);

  // 关闭抽屉（折叠成悬浮球）：中止在飞的流 + 回收挂起（否则服务端干等到超时）。
  // 同样开一次未读追踪：abort 不打断服务端生成，回复落地时人已经不在这个会话里，
  // 正是「角标该亮」的场景（追踪器挂在 ButlerNoticeHost，卸载后仍能跑完）。
  useEffect(() => {
    return () => {
      if (streamAbortRef.current && threadIdRef.current) watchForUnreadGrowth();
      streamAbortRef.current?.abort();
      releasePendingInteractions();
    };
  }, [releasePendingInteractions]);

  // ===== 会话历史（Chats）=====

  /**
   * 切到某个联系人（= 一条会话）：中断在飞的流 → 回收挂起 → 取回该会话消息回填气泡 → 指针落盘。
   * 会话已被删/过期（404）时不改当前会话，只刷新列表把僵尸行剔掉。
   */
  const openChatSession = useCallback(
    async (threadId: string) => {
      releasePendingInteractions();
      // 切走时上一条会话可能还在回答：abort 掉的只是**前端消费**，服务端仍在生成、
      // 且在流结束时才落库（entry.ts 的 finally）→ 那一刻没有事件能通知我们。
      // 于是交给追踪器盯未读总数，一变就派 unread-changed，把角标点起来。
      if (streamAbortRef.current && threadIdRef.current && threadIdRef.current !== threadId) {
        watchForUnreadGrowth();
      }
      streamAbortRef.current?.abort();
      try {
        const state = await fetchSessionState(threadId);
        if (!state) {
          await refreshChatSessions();
          return;
        }
        threadIdRef.current = threadId;
        setActiveThreadId(threadId);
        writeActiveThreadId(threadId);
        setMessages(state.messages);
        // 会话级选型跟着联系人一起回填（存过就是具体模型；Auto 时代的 null 由迁移 effect 落成默认模型）
        setModelTag(state.modelId ?? '');
        setThinking(state.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
        // 工作区随联系人回填：各会话各自保留，互不串（这就是「常驻」的落点）
        setWorkspaceFolder(state.workspaceFolder);
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
        // 打开即已读（微信语义）：本地清零 + 落库，悬浮球与头像角标同步回落
        void markThreadRead(threadId);
        setContactsOpen(false);
        requestAnimationFrame(() => {
          if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
        });
      } catch {
        /* 读取失败：保持当前会话不动 */
      }
    },
    [releasePendingInteractions, refreshChatSessions, markThreadRead],
  );

  /**
   * 清空到「未绑定任何会话」的空白态（不弹窗）。仅用于「删掉最后一个会话」后的兜底：
   * 平时新建会话一律走 startNewChat 的人设弹窗，确认后才落库并进入该会话。
   */
  const clearChatState = useCallback(() => {
    releasePendingInteractions();
    streamAbortRef.current?.abort();
    threadIdRef.current = null;
    setActiveThreadId(null);
    clearActiveThreadId();
    setMessages([]);
    // 空白态 = 未绑定任何会话 → 工作区一并清空，别把它留在下一个会话上
    setWorkspaceFolder(null);
  }, [releasePendingInteractions]);

  /**
   * 新建会话：先弹**人设弹窗（创建态）**，确认后立即落库（POST /api/butler/threads/session）
   * → 联系人列出现一条以**姓名**为标题的助理行 → 中栏进入该空会话。
   * 取消不改变当前会话（不再有「点了新建就丢下当前会话」的副作用）。
   */
  const startNewChat = useCallback(() => {
    setPersonaError(null);
    setContactsOpen(false);
    setPersonaDialog({ mode: 'create' });
  }, []);

  /** 中栏「人设」键：编辑当前会话的人设（只有 Recorder 是系统身份，没有这个入口） */
  const openPersonaEditor = useCallback(() => {
    if (!activeThreadId || isRecorderContact) return;
    setPersonaError(null);
    // 常驻联系人（Bobby / 小微）：标 systemRole，弹窗据此锁名 + 不给删除入口
    const systemRole = isNotifyContact ? 'notify' : activeThreadId === searchThreadId ? 'search' : undefined;
    setPersonaDialog({ mode: 'edit', threadId: activeThreadId, systemRole });
  }, [activeThreadId, isRecorderContact, isNotifyContact, searchThreadId]);

  /**
   * 首次使用引导：第一次打开 Bobby（通知助理）且尚未设人设 → 自动弹人设弹窗让用户设定。
   * ref 保证「本次挂载只弹一次」（取消也不反复弹）；下次启动若仍未设定会再引导。
   */
  const notifySetupPromptedRef = useRef(false);
  useEffect(() => {
    if (notifySetupPromptedRef.current) return;
    if (!activeThreadId || activeThreadId !== notifyThreadId) return;
    const target = chatSessions.find((s) => s.threadId === activeThreadId);
    if (!target) return; // 列表还没回填，等下一次
    notifySetupPromptedRef.current = true;
    if (target.persona) return; // 已设过 → 不打扰
    setPersonaError(null);
    setPersonaDialog({ mode: 'edit', threadId: activeThreadId, systemRole: 'notify' });
  }, [activeThreadId, notifyThreadId, chatSessions]);

  /** 人设弹窗（编辑态）目标是不是常驻联系人（通知助理 Bobby / 小微）：是则锁名 + 展开完整字段 + 无删除键 */
  const personaDialogIsNotify = personaDialog?.mode === 'edit' && personaDialog.systemRole === 'notify';
  const personaDialogIsSearch = personaDialog?.mode === 'edit' && personaDialog.systemRole === 'search';
  const personaDialogIsResident = personaDialogIsNotify || personaDialogIsSearch;
  /** 人设弹窗回填（编辑态取列表摘要里的 persona；通知助理的人设与 chat_sessions 同行） */
  const personaDialogInitial = useMemo(
    () =>
      personaDialog?.mode === 'edit'
        ? (chatSessions.find((s) => s.threadId === personaDialog.threadId)?.persona ?? null)
        : null,
    [personaDialog, chatSessions],
  );

  /** 人设弹窗确认：创建态 → 建空会话并进入；编辑态 → 覆盖该会话人设（标题随之变） */
  const submitPersona = useCallback(
    async (persona: ButlerPersona) => {
      const dlg = personaDialog;
      if (!dlg) return;
      setPersonaSaving(true);
      setPersonaError(null);
      try {
        const res =
          dlg.mode === 'create'
            ? await fetch('/api/butler/threads/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // 新会话继承抽屉当前的选型：新助理不必再选一次模型 / 档位
                body: JSON.stringify({ persona, model: { modelId: modelTag || null, thinkingLevel: thinking } }),
              })
            : await fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(dlg.threadId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persona }),
              });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          threadId?: string;
          error?: string;
        };
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        await refreshChatSessions();
        if (dlg.mode === 'create' && data.threadId) void openChatSession(data.threadId);
        setPersonaDialog(null);
      } catch (e) {
        setPersonaError(e instanceof Error ? e.message : 'Save failed');
      } finally {
        setPersonaSaving(false);
      }
    },
    [personaDialog, refreshChatSessions, openChatSession, modelTag, thinking],
  );

  /** 删除会话；若删的正是当前会话 → 退到列表最新一条，没有就清成空白态 */
  const removeChatSession = useCallback(
    async (s: ButlerThreadSummary) => {
      if (s.pinned) return; // 常驻联系人（通知助理 / Recorder）不可删
      const ok = await confirmAsk({
        title: 'Delete this chat?',
        message: `“${s.title}” · ${s.messageCount} messages`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      }).catch(() => false);
      if (!ok) return;
      await fetch(`/api/butler/threads?threadId=${encodeURIComponent(s.threadId)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
      const list = await refreshChatSessions();
      if (threadIdRef.current === s.threadId) {
        const next = list[0];
        if (next) void openChatSession(next.threadId);
        else clearChatState();
      }
    },
    [confirmAsk, refreshChatSessions, openChatSession, clearChatState],
  );

  /**
   * 人设弹窗标题栏右侧的删除键（原先挂在联系人行的行尾）：
   * 只对「可删的好友」挂上 —— 编辑态 + 该会话确实在列表里 + 不是常驻联系人。
   * 先关弹窗、再交给 removeChatSession：确认弹窗与删除请求都走那一条既有路径，取消时也无副作用。
   */
  const removePersonaDialogSession = useCallback(() => {
    if (personaDialog?.mode !== 'edit') return;
    const target = chatSessions.find((s) => s.threadId === personaDialog.threadId);
    if (!target || target.pinned) return;
    setPersonaDialog(null);
    setPersonaError(null);
    void removeChatSession(target);
  }, [personaDialog, chatSessions, removeChatSession]);

  /**
   * 打开抽屉即接回会话：优先 localStorage 指针（上次聊的那条），否则列表最新一条。
   * 抽屉的「关—开」不再是断片（原先每次打开都是全新会话，旧对话只能靠列表翻回来）。
   */
  useEffect(() => {
    void (async () => {
      const list = await refreshChatSessions();
      if (list.length === 0) return;
      const pointer = readActiveThreadId();
      const target = pointer && list.some((s) => s.threadId === pointer) ? pointer : list[0].threadId;
      await openChatSession(target);
    })();
  }, [refreshChatSessions, openChatSession]);

  /**
   * 右栏顶部条的图标 / 标签：直接用该条自己的 kind。
   * （2026-09-27 起日报三页签已移交 Today 面板，原先按「日报组」统一 REPORT 图标 / 页名的逻辑一并移除。）
   */
  const selectedMeta = selectedNotice ? kindMeta(selectedNotice.kind) : null;

  /** 输入框当前命中的斜杠指令（命中即会走 executor 执行，而不是当问题问 Butler）——用于 placeholder 提示 */
  const draftCommand = detectCommand(draft);
  /**
   * 发送键可用态：**有正文 或 有待发附件**即可发（只甩一个文件让 Butler 读也成立）；
   * 上传中 / 正在发送时不可再发（避免发出一个缺本次文件的「资料列表」块）。
   */
  const canSend = (!!draft.trim() || pendingAtts.length > 0) && !sending && !attaching;
  /**
   * 点中栏消息区的**任何落点** → 把焦点交给输入框（微信 / Slack 的通行手势）。
   * 原先只判 `e.target === e.currentTarget`，只有点在滚动容器本身才生效；而消息区里
   * 气泡、气泡之间的空隙、铺满内容区的包裹层都是子元素，点在它们身上一律没反应，
   * 于是「点输入框上方那片区域不能打字」。
   * 只在按钮 / 链接 / role=button / 输入控件上放行不抢焦点——那些地方要能点开、
   * 要能接着在里面输入。气泡上照样抢：焦点移动不会清掉已选中的文字，选中照旧可用。
   */
  const focusComposerFromBlank = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, [role="button"]')) return;
    inputRef.current?.focus();
  }, []);
  /**
   * 打不开的产物卡片路径（2026-10-05）。ButlerDocPanel 读失败时回调上报，记在这里，
   * 由 AssistantBubble 把这些路径的 `OutputFile:` 行**还原回正文**——卡片点不开时
   * 用户至少还能看到并复制路径（原先该行被剥离，文件等于凭空消失）。
   */
  const [docOpenFailed, setDocOpenFailed] = useState<Set<string>>(() => new Set());
  const handleDocLoadResult = useCallback((path: string, ok: boolean) => {
    setDocOpenFailed((prev) => {
      if (ok === !prev.has(path)) return prev; // 状态没变：保持引用稳定，不触发重渲染
      const next = new Set(prev);
      if (ok) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /**
   * 右栏（预览区）可见性 —— **默认不显示**，与宽窄无关（`rightOpen` 默认 false）：
   *   - `rightOpen`：点左栏功能键 / 点中栏某条回执 / 点桌面通知 → true；栏首关闭键 → false
   *   - `docPath`：文档预览由 ButlerHost 从外部推入，推入即展开（用户在画布上点开了一个文档）
   * 隐藏时右栏完全不渲染 → 宽度让给中栏（中栏因此更宽）。
   */
  const rightVisible = rightOpen || !!docPath;

  /* ===== Today 键红点 =====
     Report 摘要每天 9:00 生成并落缓存；生成之后、用户点开 Today 之前，左栏 Today 键亮红点。
     宿主只负责「今天这份生成了没有」（探针只 stat 一个文件），已读记在 localStorage。 */
  const todayHasNew = !!todayDigestDate && todayDigestDate !== todayDigestSeen;

  /** 探针：取当日摘要的日期键（null = 今天还没生成 / 探针未返回） */
  const refreshTodayDigest = useCallback(async () => {
    try {
      const res = await fetch('/api/butler/today?status=1');
      const data = (await res.json()) as { success?: boolean; digestDate?: string | null };
      if (data?.success) setTodayDigestDate(data.digestDate ?? null);
    } catch {
      /* 探针失败保持原状：宁可少亮一次红点，也不要因一次请求抖动误报 */
    }
  }, []);

  // 已读标记读盘（localStorage 只能在客户端读，故放 effect 里）
  useEffect(() => {
    try {
      setTodayDigestSeen(localStorage.getItem(TODAY_SEEN_KEY));
    } catch {
      /* 隐私模式 / 存储被禁：退化成「每次打开都当没看过」，红点照亮 */
    }
  }, []);

  // 探针轮询 + 两个即时触发：回到前台（睡眠 / 切走期间生成的摘要）与面板自己加载到摘要时的喊话
  useEffect(() => {
    void refreshTodayDigest();
    const timer = window.setInterval(() => void refreshTodayDigest(), TODAY_BADGE_POLL_MS);
    const recheck = () => void refreshTodayDigest();
    window.addEventListener('focus', recheck);
    window.addEventListener('butler-today-digest-loaded', recheck);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('butler-today-digest-loaded', recheck);
    };
  }, [refreshTodayDigest]);

  /** 真正打开 Today 才算看过：记下这一份的日期键，红点熄灭（日期键相同 = 同一份，不重复写盘） */
  useEffect(() => {
    if (docPath || !rightVisible || section !== 'today' || !todayDigestDate || todayDigestDate === todayDigestSeen) return;
    setTodayDigestSeen(todayDigestDate);
    try {
      localStorage.setItem(TODAY_SEEN_KEY, todayDigestDate);
    } catch {
      /* 写不进去只影响跨次打开的记忆；本次会话内红点已灭 */
    }
  }, [docPath, rightVisible, section, todayDigestDate, todayDigestSeen]);
  /**
   * 右栏是否**挂载**：会议进行中即便收起右栏也必须保持挂载——
   * MeetingConsole 一挂载就开始采集/录音、卸载即停（见其挂载副作用），
   * 所以会议期间靠 `hidden` 控制显隐，而不是靠卸载。
   */
  const rightMounted = rightVisible || meetingActive;
  /** 文档预览需要更宽（md / 表格可读性），会议视图次之（控制条 + 字幕流），其余分区用 420 */
  const rightDesiredW = docPath ? 560 : section === 'meeting' ? 480 : 420;
  /** 会议视图是否正在右栏**可见**：停在 meeting 分区且没有文档预览抢位 */
  const meetingVisible = section === 'meeting' && !docPath;
  /** 左栏宽度：固定 48（文字已改为悬停弹窗，不再需要给文字留宽度） */
  const railW = 48;
  /**
   * 右栏是否**占位**：窄窗（< NARROW_W）下右栏是盖住中栏的覆盖层，
   * 不参与抽屉宽度计算，否则会算出一段谁也没用的空白。
   */
  const rightInFlow = rightVisible && !isNarrow;
  /** 左栏 + 联系人列的固定占位（窄窗下联系人列同为覆盖层，不占位） */
  const sideW = railW + (isTight ? 0 : CONTACTS_W);
  /** 抽屉可用宽度上限（按 vw 收口，四周留边距） */
  const availW = Math.round(winW * DRAWER_W_RATIO);
  /**
   * 右栏宽度 = **增量**：先按「中栏保持 CHAT_MAX_W」反推可用余量，再夹在 [RIGHT_MIN_W, desired]。
   * 于是宽窗下中栏宽度不变、抽屉整体向右加宽；窗口不够时先压右栏宽度，最后才动中栏。
   */
  const rightWidth = rightInFlow
    ? Math.max(RIGHT_MIN_W, Math.min(rightDesiredW, availW - sideW - CHAT_MAX_W))
    : 0;
  /** 中栏（对话）宽度：夹在 [0, CHAT_MAX_W] —— 余量优先给右栏，不够了才回落 */
  const chatW = Math.max(0, Math.min(CHAT_MAX_W, availW - sideW - rightWidth));
  /** 自适应宽 = 各栏之和；再夹一次 availW，防窄窗下各栏下限之和顶破可用宽度 */
  const autoW = Math.min(availW, sideW + chatW + rightWidth);
  /** 自适应高 = min(760px, 86vh) */
  const autoH = Math.min(DRAWER_MAX_H, Math.round(winH * DRAWER_H_RATIO));
  /**
   * 手动几何下的宽度下限：右栏占位时**必须至少容得下中栏 + 右栏**（= sideW + chatW + rightWidth）。
   * 为什么：geom 一旦存在，boxW 就由它定死；存的若是「右栏关闭时」的旧宽度（如 48+168+420=636），
   * 右栏展开便无处可加宽，只能靠 flex-1 的中栏让位 → 视觉上就是「右栏向内挤压对话区域」。
   * 这正是「安装版右栏向左挤压、dev 版向右展开」的成因：安装版 localStorage 背着这份旧几何，dev 是干净 origin。
   * 补上这条下限后，手动几何与「右栏是增量」不再互相矛盾：关右栏回到用户拖定的宽度，开右栏整体向右加宽。
   */
  const minPanelW = rightInFlow ? Math.max(DRAWER_MIN_W, sideW + chatW + rightWidth) : DRAWER_MIN_W;
  /**
   * 面板实际宽高。**从未手动调整过（geom 为 null）时严格等于自适应值**——不碰这两个新功能就零变化；
   * 手动几何只做夹取（不越出可用区域、不小于 minPanelW），最大化则直接铺满可用区域。
   * 宽度变化由中栏（flex-1）吸收，所以拖宽了就是中栏变宽，不需要另算各栏。
   */
  const boxW = zoomed ? availW : geom ? clampNum(geom.w, minPanelW, Math.max(minPanelW, availW)) : autoW;
  const boxH = zoomed ? autoH : geom ? clampNum(geom.h, DRAWER_MIN_H, Math.max(DRAWER_MIN_H, autoH)) : autoH;
  /**
   * 面板左上角：最大化 = 居中铺满；有手动几何 = 用它并钳回视口内；
   * 从未调整过 = null → 容器继续用 left/top 50% + translate(-50%,-50%) 保持原来的居中。
   */
  const boxPos = zoomed
    ? { x: Math.round((winW - boxW) / 2), y: Math.round((winH - boxH) / 2) }
    : geom
      ? {
          x: clampNum(geom.x, DRAWER_EDGE, winW - boxW - DRAWER_EDGE),
          y: clampNum(geom.y, DRAWER_EDGE, winH - boxH - DRAWER_EDGE),
        }
      : null;
  /** 右栏顶部条的标题（文档预览态不叠此条——ButlerDocPanel 自带 header）。
   *  文案与左栏 RailItem 保持一致（Memories / Calendar）：同一栏目在两处的名字必须同字，
   *  否则顶部条与左栏读起来像两个不同的地方。
   *  preferences 与 rules 是**同一个 Memories 面板**的两个段，顶栏统一写 Memories
   *  （2026-10-02 由 Customize 改名：这个面管的是「我记得你什么」，不是外观定制）。 */
  const rightTitle =
    section === 'today'
      ? 'Today'
      : section === 'rules' || section === 'preferences'
        ? 'Memories'
        : section === 'calendar'
          ? 'Calendar'
          : section === 'meeting'
            ? 'Meeting'
            : section === 'search'
              ? 'Search Live'
              : 'Bobby';
  /**
   * 顶部条最终显示的标题。
   *
   * `topTitleStrong`（加粗 / 深色）判定的是「**本栏唯一的一级标题**」：
   *   - Today：面板自己的标题已删（嵌入态不再重复一遍「Today」），标题也只在这里。
   * 记忆 / 日历 / 其余回执的正文里各自有标题，顶栏保持原样的浅色小字即可（相当于面包屑）。
   */
  const topTitle = rightTitle;
  const topTitleStrong = section === 'today';

  return (
    <>
      {/*
      点击抽屉外任意处 → 收起（2026-10-01）。
      为什么用「铺满视口的透明层」而不是 document 的 mousedown 监听：
        ① 语义要的是**吞掉**这次点击 —— 被点中的画布节点 / 侧栏 / 树节点不该同时响应。
           用监听器只能决定「收不收抽屉」，拦不住外部元素自己的动作；一层挡板天然吞掉。
        ② 层级高于抽屉的浮层（toast 1350 / 排程确认卡与 PersonaDialog 1400 / 画布侧栏弹窗 1600 /
           ConfirmDialog 9999）都在挡板**之上**，它们的点击不受影响，也就不必为
           「有弹窗时不要收起」逐项加判断（若用监听器，portal 到 body 的弹窗会被判成「外部」
           → 先卸载抽屉再丢掉弹窗，点确认按钮必然打空）。
      为什么 z 取 1299 而不是「贴着抽屉的 1319」：
        悬浮球是 z-1300。贴着抽屉取值会把它一起盖住 —— 球点不动、拖不动、hover 也没了。
        1299 = 高于全部常规页面内容（画布 UI z-40、旧面板 z-1200/1250）而低于悬浮球，
        于是「点页面任何地方收起」与「球照常可点可拖」同时成立。
      不做可见遮罩：抽屉刻意「无遮罩」，这里只挡事件、不压暗画面。
      只认主键：右键（button !== 0）放行，画布右键菜单等照常。
      */}
    <div
      aria-hidden
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onClose();
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 1299, background: 'transparent' }}
    />
    <div
      ref={panelRef}
      className="fixed z-[1320] flex overflow-hidden"
      style={{
        // 居中弹窗（原来是右侧全高抽屉）：没手动拖过时仍旧 left/top 50% + translate(-50%,-50%) 稳居中；
        // 手动拖过 / 最大化后改用实测左上角定位。宽 = boxW（自适应态 = 各栏之和，夹在 90vw 内），
        // 高 = boxH（自适应态 min(760px,86vh)），四周永远留出边距、不顶到屏幕边缘。
        left: boxPos ? boxPos.x : '50%',
        top: boxPos ? boxPos.y : '50%',
        transform: boxPos ? 'none' : 'translate(-50%, -50%)',
        width: boxW,
        height: boxH,
        backgroundColor: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.22), 0 6px 16px rgba(0,0,0,0.10)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ===== 左栏：预览区切换器（纯图标，名字走悬停弹窗） ===== */}
      <nav
        className="flex shrink-0 flex-col items-center gap-1 py-3"
        style={{
          width: railW,
          borderRight: DIVIDER_SOFT,
          // 淡灰底 --paper-soft (#efeff2)：原先与抽屉底 --popover (#f7f7f8) 同色，
          // 整栏只靠一条右分割线撑着，看不出是「侧栏」；压深一档后才和中栏纸面分出层次。
          backgroundColor: 'var(--paper-soft)',
          // 拖动移动的抓取区：这一栏既是标题栏（窗口键 + 圆标）也是空白抓取面。
          // 栏上的按钮由 startMove 里的 closest('button') 排除，不会误触；
          // touchAction 关掉滚动接管，否则触控板按下会被当成滚动（这栏本身不可滚动，无副作用）。
          touchAction: 'none',
        }}
        onPointerDown={startMove}
      >
        {/* 窗口键：只留「关闭 / 放大-还原」两颗（2026-09-26 去掉黄键「最小化」）——
            黄键原本做的事与红键完全相同（都收起抽屉，见 onClose），同一栏里并排两颗同义的键只是噪音。 */}
        <div className="mb-1.5 flex shrink-0 items-center gap-1.5" style={{ cursor: 'grab' }} title="Hold to drag the panel">
          <WindowDot color="#ff5f57" label="Close" onClick={closeWindow} />
          <WindowDot color="#28c840" label={zoomed ? 'Restore' : 'Zoom'} onClick={() => setZoomed((v) => !v)} />
        </div>
        {/* 助理标：用**悬浮球同一张河马线稿**（public/butler-orb.png），外裹一圈圆角方框。
            2026-09-26 收小 + 加框 + 下移：线稿原先按 36px 铺满整栏，在 48px 宽的栏里像块贴纸；
            缩到 20px 装进 36px 圆角格后，与联系人列的圆角方头像同属一套「图标都装在格子里」的语言。
            框色取 --panel-bg（#ffffff）而非栏底 --paper：同色的话就只剩一圈边框在飘。
            mt-3 把它从顶部红绿键拉开（原先紧贴，两团黑糊成一团）。 */}
        <div
          className="mt-3 mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ cursor: 'grab', backgroundColor: 'var(--panel-bg)', border: '1px solid var(--line)' }}
        >
          <img src="/butler-orb.png" alt="Butler" draggable={false} className="h-5 w-5 select-none" />
        </div>
        {/* Buddy：点亮 = 当前正是一条新会话（点击反馈）。原先藏在会话列表头部，2026-09-26 提到这里。
            图标用 UsersRound（两个人并排）：它画的是「关系」而不是「动作」——
            Handshake 是握手成交的一瞬，读不出「有个搭子」；Plus 更像「加一条记录」。
            人形轮廓在左栏 16px 下也不糊（同为候选的 message-circle-heart / hand-heart 会糊成一团）。 */}
        <RailItem icon={UsersRound} label="Buddy" active={isNewChat} onClick={startNewChat} />
        {/* 原「详情」键已删（2026-09-26）：它与联系人列置顶的常驻「通知助理」行重复，
            而右栏详情分区本身仍可由悬浮球 / 桌面通知 / 点通知卡片头部打开，能力没有丢。 */}
        <RailItem icon={Sun} label="Today" active={rightOpen && section === 'today'} dot={todayHasNew} onClick={() => pickSection('today')} />
        {/* 独立的 Memories 键已删（2026-09-29）：记忆并入 Memories 台的 Preferences 段，不再单占一个左栏键。
            外部的 `openButlerPreferences()`（旧名 `openButlerMemories()` 为兼容别名）事件仍可用——
            它落到 section='preferences'，由同一个 Memories 面板带 `initialSection='preferences'` 打开
            （见右栏渲染与 rightTitle）。 */}
        {/* Memories（2026-10-02 由 Customize 改名）：Butler 的记忆台，六段
            —— Preferences / Rules / Skills / Threads / Evidence / Knowledge（见 ButlerMemoryConsole 头注释；
            "don't …" 类否定式写入落 Rules 段，不落 Preferences）。
            图标沿用原 Memories 的 Brain（2026-09-29）：记忆已并入本页，
            「大脑 = 关于我的认知」这层含义跟着搬过来，比通用清单图标更贴。 */}
        <RailItem
          icon={Brain}
          label="Memories"
          active={rightOpen && (section === 'rules' || section === 'preferences')}
          onClick={() => pickSection('rules')}
        />
        <RailItem icon={CalendarDays} label="Calendar" active={rightOpen && section === 'calendar'} onClick={() => pickSection('calendar')} />
        {/* Meeting：会议视图（开始面板 / 控制台，录音 + 实时字幕 + 会后纪要）住在右栏的 meeting 分区。
            会议开始时右栏自动展开；进行中即使切到别的分区，控制台仍常驻挂载（隐藏），录音不中断。
            图标用 Video 而非 Mic（2026-09-29）：Mic 读作「一个麦克风 / 语音输入」，
            而这枚键通向的是**一场会议**（录像同款的会议键符号才是这个位置的通例）；
            至于「录音 / 实时字幕」这些具体动作，落在面板内部由 Mic / AudioLines 各自承担，不占键位。 */}
        <RailItem icon={Video} label="Meeting" active={rightOpen && section === 'meeting'} onClick={() => pickSection('meeting')} />
        {/* 「检索实况」刻意**不占左栏键**：它是**这次检索的附属视图**而不是一个独立去处——
            检索在联系人列顶部发起，回看也该在那里（见下方「检索实况」小键）。
            左栏管的是右栏分区（Today / Calendar / Meeting 这类常驻去处），两条轴各管一段。 */}
        <span className="flex-1" />
        {/* 原来的底部「关闭」功能键已移除：顶部红键承担同一件事，同一栏里放两个关闭只会互相打架 */}
      </nav>

      {/* ===== 联系人列：一条会话 = 一个联系人 = 一个助理 =====
          系统推送类（日程 / 待办 / 报告）全部归属置顶的常驻「通知助理」，不散落成独立会话。
          窄窗（< TIGHT_W）下中栏只剩 ~300px，此列不再常驻占位，改为绝对定位覆盖层，
          开关在中栏工具行（PanelLeft 图标）——宽窗下恒在，不提供开关。 */}
      <aside
        className="flex shrink-0 flex-col"
        style={{
          width: CONTACTS_W,
          borderRight: DIVIDER_SOFT,
          // 与左栏同底（--paper-soft）：两条侧栏同属「外壳」，一起压深才有整体感；
          // 中栏仍是 --popover 的纸面，行内搜索框也仍是 --paper，比本栏亮一档、正好浮起来。
          backgroundColor: 'var(--paper-soft)',
          ...(isTight
            ? {
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: railW,
                zIndex: 40,
                boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
                display: contactsOpen ? 'flex' : 'none',
              }
            : {}),
        }}
      >
        {/* 搜索栏（2026-09-26 自中栏工具行移来）——原来上面的「CHATS」标题栏已删：
            一列一眼就看出是会话列表，标题只是占地方。搜索栏直接顶到列的最上方。
            同一个词同时过滤**联系人列**与**中栏时间线**（+ 右栏回执列表），
            因为中栏只显示当前联系人，光筛内容会不知道筛的是谁。
            不写 placeholder（本项目搜索框一律不放提示文字），放大镜 + 清空键表达用途。 */}
        <div className="shrink-0 px-2 pt-2 pb-1.5">
          <div
            className="flex items-center gap-1 rounded-lg px-1.5"
            style={{ border: '1px solid var(--line)', backgroundColor: 'var(--paper)' }}
          >
            <Search className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              aria-label="Search chats and messages"
              className="min-w-0 flex-1 bg-transparent py-1 text-11 outline-none"
              style={{ color: 'var(--ink-strong)' }}
            />
            {searchQ && (
              <button
                type="button"
                onClick={() => setSearchQ('')}
                className="flex shrink-0 items-center"
                style={{ color: 'var(--ink-muted)' }}
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {/* 公众号检索只有点了按钮才发起（不再随输入自动搜）：检索要开专属后台标签、读正文耗时，
              交给用户显式触发。点下去即切到「小微」会话：过程块挂在它时间线末尾，跑完把
              「提问 + 综述 + 每篇卡片」作为小微的真实消息落库呈现（见 runWechatSearch）。
              右栏同步切到「检索实况」——召回的每一篇、留下 / 去除，从这一刻起逐篇可见。 */}
          {searchQ.trim().length > 0 && (
            <button
              type="button"
              onClick={() => void runWechatSearch()}
              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-11 font-medium transition-colors"
              style={{ border: '1px solid var(--line)', backgroundColor: 'var(--paper)', color: 'var(--primary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--primary-soft)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper)'; }}
            >
              <Sparkles className="h-3 w-3" />
              Search WeChat Articles
            </button>
          )}
          {/* 这里刻意**没有**第二个键：本按钮就是这套实时预览的唯一入口。
              小微执行检索任务时，右栏自动切到实况并逐篇刷新（见 runWechatSearch）；
              任务跑完账本留在右栏，翻篇即退出——「实时显示」依附于这次任务，不是一个单独的去处。 */}
        </div>
        {/* hide-scrollbar：侧边栏靠左贴边，原生滚动条会压在最左一列文字上（见 globals.css 工具类） */}
        <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {contactRows.length === 0 ? (
            <div className={`px-3 text-center text-xs ${searchQ ? 'py-3' : 'py-10'}`} style={{ color: 'var(--ink-faint)' }}>
              {searchQ ? 'No matching chats' : 'No chats yet — say something to Butler'}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {contactRows.map((s) => {
                const active = s.threadId === activeThreadId;
                // 行角标 = 未读**消息**数 + **未点开的卡片**数：
                // 文字消息打开会话即清零（s.unread）；卡片必须点开才清零（见 unreadNoticesByThread），
                // 所以「进了 Bobby 的会话、但没点开那张日程卡」角标会一直亮着 —— 微信里没听过的语音同理。
                const rowBadge = s.unread + (unreadNoticesByThread.get(s.threadId) ?? 0);
                const hits = searchHits[s.threadId] ?? [];
                const q = searchQ.trim().toLowerCase();
                return (
                  <div
                    key={s.threadId}
                    className="rounded-xl px-1.5 py-1.5"
                    style={{ backgroundColor: active ? 'var(--primary-soft)' : 'transparent' }}
                  >
                    <div className="flex items-center gap-1.5">
                    {/* 头像 + 未读角标（2026-09-27：角标自标题行尾挪到头像右上角，
                        与微信一致——标题行只留名字与时间，不再被角标挤窄）。
                        取接口/store 里的值而非等重拉列表：点开一条当场清零，角标不等下一轮。 */}
                    <span className="relative shrink-0">
                      <ContactAvatar name={s.title} personality={s.persona?.personality} size={30} />
                      {rowBadge > 0 && (
                        <span
                          className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-9 font-semibold tabular-nums"
                          style={{ backgroundColor: 'var(--danger)', color: '#fff' }}
                        >
                          {rowBadge > 99 ? '99+' : rowBadge}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void openChatSession(s.threadId)}
                      className="min-w-0 flex-1 text-left"
                      title={s.title}
                    >
                      <div className="flex items-center gap-1">
                        <div
                          className="min-w-0 flex-1 truncate text-xs font-medium"
                          style={{ color: active ? 'var(--primary-strong)' : 'var(--ink-strong)' }}
                        >
                          {s.title}
                        </div>
                        {/* 时间：贴在标题右侧（原先在预览行首）。当天给时间、更早只给日期 —— 见 formatListTime */}
                        <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                          {formatListTime(s.updatedAt)}
                        </span>
                      </div>
                      {/* 预览行只剩正文；没有预览就不占空行，行高才稳定 */}
                      {s.preview && (
                        <div className="mt-0.5 truncate text-10" style={{ color: 'var(--ink-faint)' }}>
                          {s.preview}
                        </div>
                      )}
                    </button>
                    {/* 行尾不留删除键：已挪到「编辑人设」弹窗的标题栏右侧（见 PersonaDialog）。
                        常驻联系人不给编辑入口，自然也就没有删除键 —— 协议层同样拒绝（DELETE 该线程返回 400）。 */}
                    </div>
                    {/* 微信式「聊天记录」：本会话命中的历史消息嵌在联系人行下面（最多 3 条，
                        点任意一条直接进该会话）。关键词按主色加粗标出，便于一眼定位。 */}
                    {q && hits.length > 0 && (
                      <div className="mt-1 flex flex-col gap-0.5 pl-[38px]">
                        {hits.slice(0, 3).map((h, i) => {
                          const ex = hitExcerpt(h.content, q);
                          return (
                            <button
                              key={`${s.threadId}-${i}`}
                              type="button"
                              onClick={() => void openChatSession(s.threadId)}
                              className="flex w-full items-baseline gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                              title={h.content}
                            >
                              <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>
                                {h.role === 'user' ? 'You' : s.title}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                                {ex.at >= 0 ? (
                                  <>
                                    {ex.text.slice(0, ex.at)}
                                    <span style={{ color: 'var(--primary-strong)', fontWeight: 600 }}>
                                      {ex.text.slice(ex.at, ex.at + q.length)}
                                    </span>
                                    {ex.text.slice(ex.at + q.length)}
                                  </>
                                ) : (
                                  ex.text
                                )}
                              </span>
                              <span className="shrink-0 text-9 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                                {formatListTime(h.time)}
                              </span>
                            </button>
                          );
                        })}
                        {hits.length > 3 && (
                          <div className="px-1.5 text-9" style={{ color: 'var(--ink-faint)' }}>
                            {hits.length - 3} more…
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 公众号检索结果不再内嵌于此：改为搜索栏按钮触发 + 右侧面板弹窗展示 */}
        </div>
      </aside>

      {/* ===== 中栏：Butler 会话（恒为聊天，不随左栏切换） =====
          栏底座用**白底**（--panel-bg #fff）：与抽屉底 / 两侧灰栏（#f7f7f8）拉开，聊天表面独立成一层；
          滚动区再压成灰（--paper-soft）当微信式聊天画布——白 / 绿气泡在这层灰上才浮得起来 */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ backgroundColor: 'var(--panel-bg)' }}>
            {/* 中栏恒为聊天：会议视图（开始面板 / 控制台）已迁到右栏 Meeting 分区，不再接管本栏 */}
            <>
            {/* 工具行：窄窗联系人列开关 + 当前联系人 + 通知助理的批量多选入口 */}
            <div
              className="flex shrink-0 items-center gap-1 px-3 py-2"
              style={{ borderBottom: DIVIDER_SOFT }}
            >
              {/* 窄窗才需要：联系人列成了覆盖层，得有个入口把它叫出来（点某条联系人后自动收起） */}
              {isTight && (
                <button
                  type="button"
                  onClick={() => setContactsOpen((v) => !v)}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: contactsOpen ? 'var(--primary-strong)' : 'var(--ink-muted)' }}
                  title="Contacts"
                  aria-label="Contacts"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </button>
              )}
              {/* 当前联系人标题：中栏恒为「某个联系人」的会话，不标出来会分不清左右栏说谁。
                  头像已去掉（2026-09-28）：中栏每条气泡 / 通知卡片自己就带头像，
                  工具行再摆一颗同款头像等于同一屏出现两张同一张脸，这里只留名字。 */}
              <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
                {currentContactTitle}
              </span>
              {/* 批量多选入口已移除（2026-09-29）：标题栏不再摆「Select」，
                  每条消息 / 每张卡片自己的操作条上就有一颗，从这里进多选更贴近「选中这条」的直觉。 */}
              {/* 人设：编辑当前会话的助理人设。只有 Recorder 是系统身份，不出现这个键 */}
              {activeThreadId && !isRecorderContact && (
                <button
                  type="button"
                  onClick={openPersonaEditor}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Persona"
                  aria-label="Persona"
                >
                  <UserRound className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* 时间线：只有当前这个联系人的内容（通知卡片 / 对话气泡，按时间归并）
                点这片区域的**空白处** = 「我要打字」→ 把焦点交给下面那个输入框
                （其他聊天软件的通行手势；此前点空白毫无反应，容易以为是「这块不能输入文字」）。
                判定收在 focusComposerFromBlank 里：气泡 / 通知卡片 / 按钮上不抢焦点
                （那些地方要能做选中文字、点开通知），其余落点（含气泡之间的空隙）都聚焦输入框。 */}
            <div
              ref={bodyRef}
              className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
              // 对话界面**白底**（--panel-bg #fff）：AI 回复的灰气泡靠这层白浮起来；
              // 工具行 / 输入区同属这一栏，也是白的，整片读起来就是一整块聊天画布。
              style={{ backgroundColor: 'var(--panel-bg)' }}
              onMouseDown={focusComposerFromBlank}
            >
              {/* 空态提示：**检索过程块在场时不出现** —— 否则两段话叠在一起，
                  且这块 h-full 会把紧跟其后的过程块顶到可视区之外（旧缺陷「没有任何感知」）。
                  小微的空态文案也另写：中栏对它不过滤搜索词（那是检索关键词），
                  所以不能沿用「No matching content — try clearing the search」。 */}
              {timeline.length === 0 && !wechatLiveOpen && (
                <div
                  className="flex h-full items-center justify-center px-4 text-center text-xs"
                  style={{ color: 'var(--ink-faint)' }}
                  // 空态这行提示占满整片空白（h-full），点击同样交给输入框——
                  // 否则用户点它一下、没反应，会误以为这片区域不能输入
                  onMouseDown={() => inputRef.current?.focus()}
                >
                  {isSearchContact
                    ? 'Type a keyword, then hit Search WeChat Articles'
                    : searchQ
                      ? 'No matching content — try clearing the search'
                      : isNotifyContact
                        ? 'Quiet today — I’ll speak up here if anything comes up'
                        : 'New chat started · tell me what you’d like to do below'}
                </div>
              )}

              <div className="flex flex-col gap-1.5" onMouseDown={focusComposerFromBlank}>
                {timeline.map((it, i) => {
                  // 微信式时间轴：本条与上一条相隔 >5 分钟（或它就是第一条）才在头上压一条时间分隔。
                  // 通知卡片自带时间（那是**事件时间**，不是消息时间），所以分隔条只挂在气泡上，免得同一时间说两遍。
                  const ts = timeOfItem(it);
                  const sep = i === 0 || ts - timeOfItem(timeline[i - 1]) > WECHAT_TIME_GAP_MS;

                  // ① 对话气泡（当前联系人自己的往返；通知助理里追问的答复也走这里）
                  if (it.kind === 'msg') {
                    const m = it.msg;
                    // 还没吐字的占位气泡由时间线末尾的 ButlerWaitingLine 渲染（它自带头像 + 灰底气泡）。
                    // 这里再画一次就会出现两颗头像；吐字后（draftStarted 为真）恢复正常渲染。
                    if (sending && !draftStarted && m.role === 'assistant' && m.id === tailMsg?.id) return null;
                    /**
                     * 微信式气泡布局：**头像在最外侧、气泡贴着头像、尖角朝头像**——
                     * 自己（绿气泡）在右：气泡 → 头像；对方（白气泡）在左：头像 → 气泡。
                     * 两侧头像同尺寸，气泡只贴头像那侧带一枚小尖角，这是微信最好认的一组特征。
                     */
                    return (
                      <Fragment key={it.key}>
                        {sep && <TimeSeparator ms={ts} />}
                        {m.role === 'user' ? (
                          <div className="group flex items-start justify-end gap-2">
                            {selectMode && !m.pending && (
                              <MsgCheckbox
                                checked={selectedKeys.has(it.key)}
                                onToggle={() => toggleSelected(it.key)}
                              />
                            )}
                            {/* 气泡与操作条同列：操作条挂在气泡**下方**（贴自己的气泡右对齐），
                                所以气泡那层 max-w 挪到列容器上——否则操作条会被气泡的宽度挤住 */}
                            <div className="flex min-w-0 max-w-[70%] flex-col items-end">
                              <div
                                className="relative px-3 py-1.5 text-xs whitespace-pre-wrap"
                                style={bubbleSelfStyle}
                              >
                                {m.content}
                                <BubbleTail side="right" color={WECHAT_SELF_BUBBLE} />
                              </div>
                              {/* 复制 / 删除 / 多选：鼠标移入这一行才浮出；多选期间收起（行首已有勾选框） */}
                              {!m.pending && !selectMode && (
                                <div className="mt-0.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                  <MessageActions
                                    content={m.content}
                                    onDelete={() => void deleteMessages([m.id])}
                                    onSelect={() => enterSelectMode(m.id)}
                                  />
                                </div>
                              )}
                            </div>
                            <SelfAvatar size={BUBBLE_AVATAR_SIZE} />
                          </div>
                        ) : (
                          <AssistantBubble
                            message={m}
                            title={currentContactTitle}
                            personality={currentContactPersonality}
                            selectMode={selectMode}
                            selected={selectedKeys.has(it.key)}
                            onToggleSelected={toggleSelected}
                            onDelete={(id) => void deleteMessages([id])}
                            onEnterSelect={enterSelectMode}
                            onOpenCard={openWechatHit}
                            onOpenTrace={() => openTraceFromMessage(m)}
                            failedPaths={docOpenFailed}
                          />
                        )}
                      </Fragment>
                    );
                  }

                  // ② 通知卡片（只出现在常驻「通知助理」的时间线里）
                  // 卡片本体与操作条收在 NoticeCard 里（朗读是 hook，必须落到真组件上）——
                  // 这里只负责把「打开右栏 / 勾选 / 进入多选 / 删除 / 勾待办」这五件事接线。
                  const n = it.notice;
                  return (
                    <NoticeCard
                      key={it.key}
                      notice={n}
                      title={currentContactTitle}
                      personality={currentContactPersonality}
                      selectMode={selectMode}
                      checked={selectMode && selectedKeys.has(it.key)}
                      // 点开 = 打开右栏看正文（日报类长文档只有这条路能读到全文）。
                      // 右栏可能正停在 Today / 记忆 / 日历 分区（点过左栏功能键，或文档预览关掉后留下的）：
                      // 点回执必须把分区一并切回「详情」，否则选中变了、右栏却仍是那块面板——
                      // 表现就是「在通知助理里点开 Daily Report，出来的却是 Today」。
                      onOpen={() => {
                        markNoticeRead(n);
                        setSelectedId(n.id);
                        setRightOpen(true);
                        onSectionChange('detail');
                      }}
                      onToggleSelected={() => toggleSelected(it.key)}
                      onEnterSelect={() => enterSelectMode(it.key)}
                      onDelete={() => removeNotice(n)}
                      onToggleItem={(item) => toggleItem(n, item)}
                    />
                  );
                })}

                {/* 等待气泡：**只活在「还没吐字」的这段时间**——发送中、且末尾占位气泡仍为空（见 draftStarted）。
                    它自己就长着头像 + 灰底气泡（见 ButlerWaitingLine），所以时间线里那条空占位气泡被跳过，
                    免得同一句话出现两颗头像。第一个字落下它就卸载、换回真正的助手气泡：文字接着往下长，不跳。
                    整轮收尾（sending=false）也卸载——等待中的碎句不写进消息列表、不进会话历史，刷新后不会带出这些字。 */}
                {sending && !draftStarted && (
                  <ButlerWaitingLine
                    persona={currentContactPersona}
                    since={waitSince}
                    title={currentContactTitle}
                    personality={currentContactPersonality}
                  />
                )}
              </div>
              {/* 公众号检索「过程块」：时间线末尾的一块，**只表达进行中**，检索一结束就退场。
                  它挂在会话流末尾（与真消息同一栏），所以必须靠滚动跟住它才能被看见 —— 见上方
                  「新内容到达时滚到底部」的 effect（旧缺陷「过程中用户没有任何感知」的直接成因）。
                  结果（综述 + 每篇卡片）不在这里：已由服务端落库，以小微的真实消息呈现。
                  门控只看「还在跑 / 要验证 / 有兜底说明」：跑完且无异常 → 整块卸载，不留残影。 */}
              {wechatLiveOpen && (
                <WechatSearchLive
                  busy={wechatBusy}
                  captcha={wechatCaptcha}
                  status={wechatSummaryStatus}
                  notice={wechatNotice}
                  title={currentContactTitle}
                  personality={currentContactPersonality}
                />
              )}
            </div>

            </>

            {/* 输入区：直接问 Butler。
                挂起结构化提问时，docked 提问卡**顶掉输入框**（同一位置、不遮挡正文）——
                与画布 ChatNodeKernel 的「底部停靠」形态同款，复用同一组件避免两套表单。 */}
            {pendingQuestion && !questionMinimized ? (
              <div className="shrink-0 px-3 py-2">
                <QuestionPopup
                  docked
                  questions={pendingQuestion.questions}
                  timeoutSec={pendingQuestion.timeoutSec}
                  onSubmit={handleQuestionSubmit}
                  onClose={() => setQuestionMinimized(true)}
                  onSkip={handleQuestionSkip}
                  onRestore={() => setQuestionMinimized(false)}
                  onExpire={handleQuestionExpire}
                />
              </div>
            ) : (
              <div className="relative shrink-0">
                {/* 多选操作条：以**圆角矩形浮层**压在输入框上方，宽度与输入框对齐
                    （left-3 / right-3 = 输入框容器的 px-3），只浮一层、不推挤时间线。
                    2026-09-28 集合一：气泡与通知卡片共用这一条（此前是两条互斥的浮层）——
                    计数 / 全选都按中栏**同一份可选集合**（selectableKeys），跟看到的对齐。
                    「复制所选」对两者都成立：气泡取正文，卡片取 noticeText。 */}
                {selectMode && (
                  <div className="absolute bottom-full left-3 right-3 z-30 mb-1">
                    <SelectActionBar
                      count={selectedCount}
                      total={selectableKeys.length}
                      allSelected={selectableKeys.length > 0 && selectedCount === selectableKeys.length}
                      onToggleAll={() => {
                        if (selectedCount === selectableKeys.length) setSelectedKeys(new Set());
                        else setSelectedKeys(new Set(selectableKeys));
                      }}
                      onCopy={copySelected}
                      onDelete={deleteSelected}
                      onCancel={leaveSelectMode}
                    />
                  </div>
                )}
                {/* `/` 指令下拉：输入框在底栏 → **向上**展开，绝对定位覆盖消息区（不推挤布局）。
                    行内用 onMouseDown + preventDefault：既保住输入框焦点（不触发 onBlur 把下拉关掉），
                    又能让点击真正落到菜单项上——用 onClick 会先 blur 再卸载，点击永远打空。 */}
                {commandOpen && commandCandidates.length > 0 && (
                  <div
                    className="absolute bottom-full left-3 right-3 z-20 overflow-y-auto rounded-xl"
                    style={{
                      maxHeight: 240,
                      backgroundColor: 'var(--popover)',
                      border: '1px solid var(--line)',
                      boxShadow: '0 10px 28px rgba(0,0,0,0.16)',
                    }}
                  >
                    <div
                      className="sticky top-0 px-3 py-1.5 text-[10px] font-semibold tracking-wide"
                      style={{
                        backgroundColor: 'var(--popover)',
                        color: 'var(--ink-faint)',
                        borderBottom: DIVIDER_SOFT,
                      }}
                    >
                      Commands · click to insert
                    </div>
                    {commandCandidates.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        title={c.description}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyCommand(c);
                        }}
                        onMouseEnter={() => setCommandHighlight(i)}
                        className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left"
                        style={{
                          backgroundColor: i === commandHighlight ? 'var(--paper-hover)' : 'transparent',
                          borderLeft: i === commandHighlight ? '2px solid var(--primary)' : '2px solid transparent',
                        }}
                      >
                        <span className="w-[74px] shrink-0 text-xs font-semibold" style={{ color: 'var(--primary)' }}>
                          /{c.keyword}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                          {c.label}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="px-3 py-2"
                  // 拖拽落点铺满整个输入区：悬停高亮，放下即上传（与回形针/粘贴同一入口 attachFiles）
                  onDragOver={(e) => {
                    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    if (e.dataTransfer.files.length === 0) return;
                    e.preventDefault();
                    setDragOver(false);
                    void attachFiles(e.dataTransfer.files);
                  }}
                >
                  {/* 待发附件 chips：上传即落盘，此处移除只解除引用、不删盘上文件 */}
                  {pendingAtts.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {pendingAtts.map((a) => (
                        <span
                          key={a.id}
                          className="flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 text-10"
                          style={{
                            backgroundColor: 'color-mix(in oklab, var(--primary) 10%, var(--popover))',
                            border: '1px solid color-mix(in oklab, var(--primary) 28%, var(--line))',
                            color: 'var(--ink-strong)',
                          }}
                        >
                          <span className="min-w-0 truncate" title={a.name}>
                            {a.name}
                          </span>
                          <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                            {formatFileSize(a.size)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removePendingAtt(a.id)}
                            className="flex shrink-0 items-center"
                            style={{ color: 'var(--ink-muted)' }}
                            title="Remove attachment"
                            aria-label={`Remove attachment ${a.name}`}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* 上传失败提示：一次一条，不静默——静默失败会让用户以为文件已随消息发出 */}
                  {attachError && (
                    <div className="mb-1.5 text-10" style={{ color: 'var(--danger)' }}>
                      {attachError}
                    </div>
                  )}
                  {/* 输入框底部按钮带（textarea 的 pb-9 = 36px 让出来）：**左** = 回形针（left-1.5）
                      + 工作区（left-10：未指定 = 文件夹图标按钮，已指定 = 常驻名称 pill，宽至 150px）；
                      **右**一簇 = 思考档位 + 模型（right-16 = 麦克风的 right-9 + 自身宽 w-7，正好贴在
                      麦克风左边）、麦克风（right-9）、发送（right-1.5）。各 26px 高，全在这条带内。
                      正文与 placeholder 因此**左右都顶格**（pl-3 / pr-3）——右侧原先留的 pr-[70px] 已删：
                      它是「pl-8 → pl-3」那次改造漏掉的对称项，且把每行右侧 70px 变成永久打不进字的死区
                      （2026-09-30 修，见 e2e 实测）。代价与左侧一致、可接受：草稿超过 3 行滚动时，
                      正文会从按钮带穿过图标（左侧一直如此）；按钮带要真正让开正文需把它移出滚动区。
                      拖拽悬停时整框虚线高亮 */}
                  <div
                    className="relative"
                    style={
                      dragOver
                        ? { borderRadius: 12, outline: '1px dashed var(--primary)', outlineOffset: 1 }
                        : undefined
                    }
                  >
                    <textarea
                      ref={inputRef}
                      value={draft}
                      onChange={(e) => {
                        const value = e.target.value;
                        const pos = e.target.selectionStart ?? value.length;
                        setCursorPos(pos);
                        setDraft(value);
                        updateCommandState(value, pos);
                      }}
                      onKeyDown={(e) => {
                        // 下拉展开时先由下拉消费 ↑↓ / Enter / Esc，避免把 Enter 当发送
                        if (handleCommandKey(e)) return;
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      onSelect={syncCaret}
                      onClick={syncCaret}
                      onKeyUp={syncCaret}
                      onBlur={() => setCommandOpen(false)}
                      // 粘贴文件（截图 / 剪贴板里的文件）→ 上传；不 preventDefault 的话浏览器可能
                      // 把图片当文本塞进 textarea（出现一堆乱码/路径）
                      onPaste={(e) => {
                        const files = e.clipboardData?.files;
                        if (files && files.length > 0) {
                          e.preventDefault();
                          void attachFiles(files);
                        }
                      }}
                      rows={3}
                      placeholder={
                        draftCommand
                          ? `Will run /${draftCommand.keyword} — ${draftCommand.label}`
                          : 'Ask Butler… (Enter to send; start with / for commands)'
                      }
                      className="max-h-[120px] min-h-[68px] w-full resize-none rounded-xl pt-1.5 pb-9 pl-3 pr-3 text-xs outline-none"
                      style={{
                        // 白底（--panel-bg #fff）：对话区已是白纸面，输入框再压灰会读成"洞里的一块"，
                        // 索性同白——靠 1px --line 描边 + rounded-xl 定出输入区。
                        backgroundColor: 'var(--panel-bg)',
                        border: '1px solid var(--line)',
                        color: 'var(--ink-strong)',
                      }}
                    />
                    {/* 回形针：与发送键对角（左下 / 右下），上传中转圈色（--primary）提示进行中 */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attaching}
                      className="absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                      style={{
                        backgroundColor: 'transparent',
                        color: attaching
                          ? 'var(--primary)'
                          : 'color-mix(in oklab, var(--ink-muted) 80%, transparent)',
                      }}
                      title={attaching ? 'Uploading…' : 'Add attachment'}
                      aria-label="Add attachment"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </button>
                    {/* 本地文件夹 / 会话级**工作区**：紧挨回形针右侧（left-10 = 回形针 left-1.5 + 自身 w-7 + 6px 间距）。
                        两种形态：
                          - 未指定 → 文件夹图标按钮，点开系统目录选择器（仅桌面端；浏览器 dev 给可见提示）
                          - 已指定 → **常驻名称 pill**：显示文件夹名（超长截断 max-w-[150px]，悬停给全名 + 路径）
                                     + × 清除。
                        为什么用 pill 而非一次性 chip：工作区是**会话级常驻状态**（见 attachFolder /
                        workspaceBlock），发送后不该消失；显示在按钮位是为了「当前工作区」一眼可见。 */}
                    {workspaceFolder ? (
                      <span
                        className="absolute bottom-1.5 left-10 flex h-7 max-w-[150px] items-center gap-1 rounded-md px-1.5"
                        style={{
                          backgroundColor: 'color-mix(in oklab, var(--primary) 10%, var(--panel-bg))',
                          border: '1px solid color-mix(in oklab, var(--primary) 28%, var(--line))',
                          color: 'var(--ink-strong)',
                        }}
                        title={`${workspaceFolder.name}\n${workspaceFolder.path}`}
                      >
                        <FolderOpen className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
                        <span className="min-w-0 truncate text-11 font-medium">{workspaceFolder.name}</span>
                        <button
                          type="button"
                          onClick={() => void clearWorkspace()}
                          className="flex shrink-0 items-center"
                          style={{ color: 'var(--ink-muted)' }}
                          title="Clear workspace"
                          aria-label="Clear workspace"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void attachFolder()}
                        disabled={attaching || !activeThreadId}
                        className="absolute bottom-1.5 left-10 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                        style={{
                          backgroundColor: 'transparent',
                          color: attaching
                            ? 'var(--primary)'
                            : 'color-mix(in oklab, var(--ink-muted) 80%, transparent)',
                        }}
                        title={attaching ? 'Working…' : 'Set workspace folder'}
                        aria-label="Set workspace folder"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {/* 会话级选型：思考档位 + 模型 —— 放在**右侧、紧邻麦克风左边**（右侧按钮簇为
                        [思考][模型][麦克风][发送]，回形针独占左下角）。
                        选哪个 = 这条会话的选型，改动即写回线程文件（PATCH /session），
                        下一条消息随 /api/butler/threads 带上；切联系人时按线程回填。
                        弹层向上展开（absolute bottom-full）且**右对齐**（right-0），向左长，
                        在输入框内展开、不推挤消息区。
                        **录音/转写期间整簇隐藏**：录音条（z-30，近不透明底）就锚在同一槽位（右起
                        约 64px 处、宽约 135px ≈ 本簇 136px），藏着不如让位；口述中这两个按钮也用不上
                        （麦克风此时本就禁用），说完再选模型即可。 */}
                    <div
                      ref={pickerRef}
                      className={`absolute bottom-1.5 right-16 flex items-center gap-0.5${voice.recording || voice.transcribing ? ' hidden' : ''}`}
                    >
                      {/* 思考档位（月相即档位，与画布对话节点同款） */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => {
                            setThinkingMenuOpen((v) => !v);
                            setModelMenuOpen(false);
                          }}
                          disabled={sending || !modelSupportsThinking}
                          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                          style={{ backgroundColor: 'transparent', color: 'var(--ink-muted)' }}
                          title={
                            modelSupportsThinking
                              ? `Thinking: ${THINKING_LEVELS.find((l) => l.value === thinking)?.label ?? thinking}`
                              : "Current model doesn't support thinking mode"
                          }
                          aria-label="Thinking level"
                        >
                          <MoonPhaseIcon level={thinking} size={15} className="shrink-0" />
                        </button>
                        {thinkingMenuOpen && (
                          <div
                            className="absolute bottom-full right-0 z-40 mb-1 w-32 rounded-xl border p-0.5 shadow-lg"
                            style={{
                              borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                              backgroundColor: 'var(--popover)',
                            }}
                          >
                            {/* legacy medium 仅存量显示，不进菜单（与画布一致） */}
                            {THINKING_LEVELS.filter((l) => l.value !== 'medium').map((lvl) => {
                              const selected = thinking === lvl.value;
                              return (
                                <button
                                  key={lvl.value}
                                  type="button"
                                  onClick={() => changeThinking(lvl.value)}
                                  className="flex w-full items-center justify-between rounded px-2 py-1 text-xs font-medium transition-colors"
                                  style={{
                                    color: selected ? 'var(--primary)' : 'var(--ink)',
                                    backgroundColor: selected ? 'var(--paper-hover)' : 'transparent',
                                  }}
                                >
                                  <span className="flex items-center gap-1.5">
                                    <MoonPhaseIcon level={lvl.value} size={14} className="shrink-0" />
                                    <span>{lvl.label}</span>
                                  </span>
                                  {selected && <Check className="h-2.5 w-2.5" />}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      {/* 模型（Auto 已下线：候选即模型池里已勾选的对话模型，必须手动选一个） */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => {
                            setModelMenuOpen((v) => !v);
                            setThinkingMenuOpen(false);
                          }}
                          disabled={sending}
                          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                          style={{ backgroundColor: 'transparent', color: 'var(--ink-muted)' }}
                          title={currentModelLabel}
                          aria-label="Model"
                        >
                          <ModelBrandLogo modelId={modelTag} size={13} />
                          <span className="max-w-[110px] truncate">{currentModelLabel}</span>
                          <ChevronDown className="h-2.5 w-2.5 opacity-50" />
                        </button>
                        {modelMenuOpen && (
                          <div
                            className="absolute bottom-full right-0 z-40 mb-1 max-h-64 w-44 overflow-y-auto rounded-xl border p-0.5 shadow-lg"
                            style={{
                              borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                              backgroundColor: 'var(--popover)',
                            }}
                          >
                            {modelOptions.length === 0 && (
                              <div className="px-2 py-2 text-10 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                                No chat model configured. Add one in Settings → Models.
                              </div>
                            )}
                            {modelOptions.map((m) => (
                              <button
                                key={m.tag}
                                type="button"
                                onClick={() => changeModel(m.tag)}
                                className="flex w-full items-center justify-between gap-1 rounded px-2 py-1 text-xs font-medium transition-colors"
                                style={{
                                  color: modelTag === m.tag ? 'var(--primary)' : 'var(--ink)',
                                  backgroundColor: modelTag === m.tag ? 'var(--paper-hover)' : 'transparent',
                                }}
                                title={m.tag}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <ModelBrandLogo modelId={m.tag} size={13} />
                                  <span className="truncate">{m.label}</span>
                                </span>
                                {modelTag === m.tag && <Check className="h-2.5 w-2.5 shrink-0" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* 麦克风：紧挨发送键左侧（语音输入 → 转文字进草稿框，不落盘、不自动发送）。
                        录音中/转写中由它左侧的录音条就地展开（absolute right-9 锚定右边缘 → 天然朝左长），
                        不覆盖输入框本体；只是 `sending` 期间禁用（与画布输入框同口径：执行中就别说下一句了）。 */}
                    <button
                      type="button"
                      onClick={() => voice.start()}
                      disabled={sending || voice.recording || voice.transcribing}
                      className="absolute bottom-1.5 right-9 flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                      style={{
                        backgroundColor: 'transparent',
                        color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)',
                      }}
                      title="Voice input (speech to text)"
                      aria-label="Voice input"
                    >
                      <Mic className="h-3.5 w-3.5" />
                    </button>
                    {/* 录音 / 转写条：锚在麦克风左边缘（right-9 + mr-8 = 麦克风按钮宽 28px），
                        向左展开；不透明底 + 描边 + 阴影，浮在正文之上也能读清。 */}
                    {(voice.recording || voice.transcribing) && (
                      <VoiceRecordBar voice={voice} className="absolute bottom-1.5 right-9 mr-8 z-30 shadow-sm" />
                    )}
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={!canSend}
                      className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                      style={{
                        // 透明底：只用图标颜色区分可用态（--primary）/ 空输入态（灰）
                        backgroundColor: 'transparent',
                        color: canSend ? 'var(--primary)' : 'color-mix(in oklab, var(--ink-muted) 50%, transparent)',
                      }}
                      title="Send"
                      aria-label="Send"
                    >
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                    </button>
                    {/* 隐藏的原生 file input：回形针程序化触发；change 后清空 value 以便重选同名文件 */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = e.target.files;
                        if (files && files.length > 0) void attachFiles(files);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
      </div>

      {/* ===== 右栏：预览区（窄窗改为盖住中栏的覆盖层） =====
          挂载条件放宽到「右栏可见 **或** 会议进行中」：会议控制台不可卸载（卸载即停录），
          会议期间收起右栏 / 切到别的分区时它仍在暗中挂载，只是 hidden。 */}
      {rightMounted && (
        <div
          className={
            rightVisible
              ? isNarrow ? 'absolute inset-y-0 z-[5] flex flex-col' : 'flex shrink-0 flex-col'
              : 'hidden'
          }
          style={{
            // 窄窗覆盖层只盖「中栏」，左栏（预览区切换器）必须保持可见可点；
            // 宽窗则是常规占位栏，宽度随内容（文档预览更宽）
            ...(isNarrow ? { left: railW, right: 0 } : { width: rightWidth }),
            borderLeft: DIVIDER_SOFT,
            backgroundColor: 'var(--popover)',
          }}
        >
          {/* 右栏顶部条：**宽窄统一** —— 右栏现在是默认隐藏、可单独收起的栏，两态各只出现一个关闭键：
              窄窗下右栏是覆盖层，用「返回会话」向左退出；宽窗下是占位栏，用 X 收起。
              文档预览态不叠此条（ButlerDocPanel 自带 header，标题 / 重新载入 / 关闭）。 */}
          {!docPath && (
            <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5" style={{ borderBottom: DIVIDER_SOFT }}>
              {isNarrow && (
                <button
                  type="button"
                  onClick={closeRight}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Back to chat"
                  aria-label="Back to chat"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              <span
                className={
                  topTitleStrong
                    ? 'min-w-0 flex-1 truncate text-xs font-semibold'
                    : 'min-w-0 flex-1 truncate text-11'
                }
                style={{ color: topTitleStrong ? 'var(--ink-strong)' : 'var(--ink-muted)' }}
                title={topTitleStrong ? topTitle : undefined}
              >
                {topTitle}
              </span>
              {/* 通知助理：选中那条的类型 + 时间挂在标题条右侧。
                  「已读」那颗开关 2026-09-26 挪去中栏工具行——它过滤的是中栏时间线，
                  留在右栏就是「控件在这栏、作用在那栏」，而且右栏默认不显示、根本够不着。 */}
              {section === 'detail' && selectedNotice && selectedMeta && (
                <>
                  <selectedMeta.Icon className="h-3.5 w-3.5 shrink-0" style={{ color: selectedMeta.color }} />
                  <span className="text-10 font-semibold tracking-wide" style={{ color: selectedMeta.color }}>
                    {selectedMeta.label}
                  </span>
                  <span className="text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                    {formatTime(selectedNotice.time)}
                  </span>
                </>
              )}
              {!isNarrow && (
                <button
                  type="button"
                  onClick={closeRight}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Close preview"
                  aria-label="Close preview"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          {/* 会议视图：开始面板 / 控制台。整块**常驻挂载**（不可见时 hidden），
              保证会议进行中切分区 / 收起右栏都不会卸载控制台（卸载 = 停录，见 MeetingConsole） */}
          <div className={meetingVisible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            {meeting ? (
              <MeetingConsole
                snapshot={meeting}
                onRefresh={refreshMeeting}
                onEnded={() => void refreshMeeting()}
                visible={meetingVisible}
              />
            ) : (
              <MeetingStart onStarted={() => void refreshMeeting()} />
            )}
          </div>
          {/* 其余分区：会议视图不可见时才渲染，避免与它同时占位 */}
          {!meetingVisible && (docPath ? (
            <ButlerDocPanel path={docPath} embedded onClose={closeRight} onEdit={handleEditDoc} onLoadResult={handleDocLoadResult} />
          ) : section === 'today' ? (
            /* key：点 Today 一律重挂载，页签回到 Report（理由见 pickSection / todayOpenSeq） */
            <ButlerTodayPanel key={`today-${todayOpenSeq}`} embedded />
          ) : section === 'rules' || section === 'preferences' ? (
            /* rules 与 preferences 同一面板（Memories 台），区别只在「一进来落在哪」：
               - rules        → 不给 initialSection，面板默认停在脑图落点
               - preferences  → 直接落到 Preferences 段（openButlerPreferences 走的也是这里）
               key 让两段之间切换时重挂载，initialSection 才会生效。 */
            <ButlerMemoryConsole
              key={section}
              embedded
              {...(section === 'preferences' ? { initialSection: 'preferences' as const } : {})}
            />
          ) : section === 'calendar' ? (
            <ButlerCalendarPanel />
          ) : section === 'search' ? (
            /* 检索实况：召回的逐篇账本（留下 / 判定中 / 去除）。两个来源、同一套渲染：
                 - openedTrace（点气泡下方入口回看的历史某一轮，落库那份；2026-10-01 起
                   账本自己也带 queries / intent，所以回看同样能显示检索方向 —— 老轮次没有这两个字段，
                   此时自然不显示，不必特殊处理）
                 - 否则 = 本轮实时预览（SSE 帧攒的，带检索方向拆解）
               **被判掉的那几篇照样能点开** —— 判定只是「模型没选它」。 */
            <ButlerSearchTrace
              query={openedTrace ? openedTrace.trace.query : wechatTraceQuery}
              plan={
                openedTrace
                  ? { queries: openedTrace.trace.queries, intent: openedTrace.trace.intent }
                  : wechatPlan
              }
              items={openedTrace ? openedTrace.trace.items : wechatTrace}
              busy={openedTrace ? false : wechatBusy}
              status={wechatSummaryStatus}
              notice={openedTrace ? '' : wechatNotice}
              onOpen={openWechatHit}
            />
          ) : (
            <div className="flex h-full flex-col">
              {selectedNotice ? (
                <>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                {/* 正文：通知标题（原「邮箱头」那一行）+ body —— **只在没有待办项时才出现**；
                    有待办项时清单本身就是正文内容（/inspect 与笔记整理类报告没有 items，正文照旧显示，
                    那才是它们唯一的内容）。
                    标题保留在这里：calendar 等回执的 body 往往把标题又写一遍，还带上推送当时才成立的
                    相对时间（in ~5 min 早已过期），标题放在这里反而最清楚。
                    （2026-09-27：日报三页签已移交 Today 面板，原先按日报页签 / 结构化待办分区渲染的
                    Schedule 与 Sticky 两个分支随之移除，右栏详情回归单一正文形态。） */}
                {
                  (selectedNotice.items?.length ?? 0) === 0 ? (
                    <>
                      <div className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
                        {selectedNotice.title}
                      </div>
                      <div className="butler-md mt-2 text-xs" style={{ color: 'var(--ink)' }}>
                        {selectedNotice.body ? (
                          <StreamingMarkdown content={selectedNotice.body} streaming={false} onOpenDoc={openDocInDrawer} />
                        ) : null}
                      </div>
                    </>
                  ) : null
                }

                {/* 日程提醒：点开后展示**完整事件信息** —— 通知条目只带 title + 开始时刻，
                    结束时间 / 全天 / 地点 / 备注 / 优先级 / 重复 / 提醒在选中时按事件 id 现取
                    （见上方 scheduleDetail effect）。勾选圆圈沿用 toggleItem 的真实链路。 */}
                {scheduleDetail && scheduleItem && (
                  <div
                    className="mt-2 flex flex-col gap-2 rounded-lg p-2.5"
                    style={{ backgroundColor: 'var(--paper-hover)' }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleItem(selectedNotice, scheduleItem)}
                      className="flex items-start gap-1.5 text-left"
                    >
                      <CheckCircle2
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        style={{ color: scheduleDone ? 'var(--success)' : 'var(--ink-faint)' }}
                      />
                      <span
                        className="min-w-0 flex-1 text-sm font-semibold"
                        style={{
                          color: scheduleDone ? 'var(--ink-faint)' : 'var(--ink-strong)',
                          textDecoration: scheduleDone ? 'line-through' : undefined,
                        }}
                      >
                        {scheduleDetail.title}
                      </span>
                    </button>

                    {scheduleDetail.start_time && (
                      <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink)' }}>
                        <CalendarDays className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                        <span className="tabular-nums">
                          {fmtEventWhen(scheduleDetail.start_time, scheduleDetail.end_time, scheduleDetail.all_day)}
                        </span>
                      </div>
                    )}

                    {scheduleDetail.priority === 'high' && (
                      <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--warn)' }}>
                        <Flag className="h-3 w-3 shrink-0" />
                        <span>High priority</span>
                      </div>
                    )}

                    {scheduleDetail.location && (
                      <div className="flex items-start gap-1.5 text-11" style={{ color: 'var(--ink)' }}>
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                        <span className="min-w-0 break-words">{scheduleDetail.location}</span>
                      </div>
                    )}

                    {recurrenceLabel(scheduleDetail.recurrence) && (
                      <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                        <Repeat className="h-3 w-3 shrink-0" />
                        <span>Repeats {recurrenceLabel(scheduleDetail.recurrence)}</span>
                      </div>
                    )}

                    {!scheduleDetail.reminder_disabled && scheduleDetail.reminder_minutes.length > 0 && (
                      <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                        <Bell className="h-3 w-3 shrink-0" />
                        <span>
                          {scheduleDetail.reminder_minutes.map((m) => `${fmtReminderMinutes(m)} before`).join(' · ')}
                        </span>
                      </div>
                    )}

                    {scheduleDetail.description && (
                      <div className="butler-md whitespace-pre-wrap break-words text-xs" style={{ color: 'var(--ink)' }}>
                        {scheduleDetail.description}
                      </div>
                    )}
                  </div>
                )}

                {/* 结构化待办项：点 chip 勾选。日程完整信息已在上方展示时不再重复同一件事。 */}
                {!scheduleDetail && (selectedNotice.items?.length ?? 0) > 0 && (
                  <div className="mt-3 flex flex-col gap-0.5">
                    <div className="mb-0.5 text-10 font-semibold" style={{ color: 'var(--ink-muted)' }}>
                      To-dos · {selectedNotice.items?.length}
                    </div>
                    {(selectedNotice.items ?? []).map((it) => {
                      const done = it.status === 'done';
                      return (
                        <button
                          key={it.key}
                          type="button"
                          onClick={() => toggleItem(selectedNotice, it)}
                          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                        >
                          <CheckCircle2
                            className="h-3 w-3 shrink-0"
                            style={{ color: done ? 'var(--success)' : 'var(--ink-faint)' }}
                          />
                          <span
                            className="min-w-0 flex-1 text-11"
                            style={{
                              color: done ? 'var(--ink-faint)' : 'var(--ink)',
                              textDecoration: done ? 'line-through' : undefined,
                            }}
                          >
                            {it.title}
                          </span>
                          {/* 时间取 startMs 再格式化：日历项的 it.time 是**事件开始时间的裸 ISO 串**
                              （2026-09-24T14:00:00+08:00），直接显示出来谁也不认识；中栏卡片同款处理
                              （formatTime(singleItem?.startMs || n.time)）。没有 startMs 的项沿用自带文案。 */}
                          {(it.startMs > 0 || it.time) && (
                            <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
                              {it.startMs > 0 ? formatTime(it.startMs) : it.time}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 对话存档（kind='web' 整理源 / 'info' 原始对话） */}
                {(selectedNotice.messages?.length ?? 0) > 0 && (
                  <div className="mt-3 flex flex-col gap-0.5 rounded-lg p-1.5" style={{ backgroundColor: 'var(--paper-hover)' }}>
                    <div className="mb-0.5 text-10 font-semibold" style={{ color: 'var(--ink-muted)' }}>
                      Chat archive · {selectedNotice.messages?.length}
                    </div>
                    {(selectedNotice.messages ?? []).map((m, i) => (
                      <div key={i} className="text-10" style={{ color: 'var(--ink-muted)' }}>
                        <span className="font-semibold" style={{ color: 'var(--ink)' }}>
                          {m.role === 'user' ? 'You' : 'Butler'}:
                        </span>{' '}
                        {m.content}
                      </div>
                    ))}
                  </div>
                )}

                {selectedNotice.source === 'wechat' && (
                  <div className="mt-3 text-10" style={{ color: 'var(--ink-faint)' }}>
                    via WeChat
                  </div>
                )}
              </div>

              {/* 详情动作 */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-2" style={{ borderTop: DIVIDER_SOFT }}>
                {/* 日程回执的「Calendar」→ 切到抽屉右栏的 **Butler 日历**分区（左栏功能键同款），
                    而不是弹画布那套完整日历面板：用户此刻就在助理里，就地看「这天还有什么没做」。
                    走 pickSection 与左栏功能键完全同源（切分区 + 展开右栏）。 */}
                {selectedNotice.actionType === 'open-calendar' && (
                  <button
                    type="button"
                    onClick={() => pickSection('calendar')}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-10 transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <CalendarDays className="h-2.5 w-2.5" />
                    Calendar
                  </button>
                )}
                {/* 报告类回执：下载 .md / 复制分享链接（放行 kind 见 lib/butler/report-share.ts） */}
                {isShareableReportKind(selectedNotice.kind) && (
                  <>
                    <button
                      type="button"
                      onClick={() => downloadReportMd(selectedNotice)}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-10 transition-colors hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)' }}
                      title="Download .md — save this report as a Markdown file"
                    >
                      <Download className="h-2.5 w-2.5" />
                      .md
                    </button>
                    <button
                      type="button"
                      onClick={() => copyReportLink(selectedNotice.id)}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-10 transition-colors hover:bg-[var(--paper-hover)]"
                      style={{
                        color: copiedLinkId === selectedNotice.id ? 'var(--success)' : 'var(--ink-muted)',
                      }}
                      title={
                        copiedLinkId === selectedNotice.id
                          ? 'Copied ✓'
                          : 'Copy report link — paste it into the chat to let Butler read and analyze it'
                      }
                    >
                      {copiedLinkId === selectedNotice.id ? (
                        <Check className="h-2.5 w-2.5" />
                      ) : (
                        <Link2 className="h-2.5 w-2.5" />
                      )}
                      {copiedLinkId === selectedNotice.id ? 'Copied' : 'Link'}
                    </button>
                  </>
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => removeNotice(selectedNotice)}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-faint)' }}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>

              <div className="shrink-0 px-3 pb-2">
                <button
                  type="button"
                  onClick={() => askAboutNotice(selectedNotice)}
                  className="w-full rounded-lg py-1.5 text-11 font-medium transition-colors"
                  style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
                >
                  Ask Butler about this
                </button>
              </div>
            </>
              ) : (
                /* 空态：右栏已无列表层（2026-09-26），只显示中栏点开的那一条 —— 通知列表只剩中栏时间线一份 */
                <div
                  className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-11"
                  style={{ color: 'var(--ink-faint)' }}
                >
                  Click a notice in the timeline to read it here
                </div>
              )}
            </div>
          ))}
        </div>
      )}


      {/* Butler 结构化确认卡（排程创建/改/删）：挂起式，用户确认后才真正执行。
          层级必须高于抽屉本体（z-[1320]），否则被自己的窗口盖住 */}
      {butlerConfirm && (
        <ButlerConfirmModal pending={butlerConfirm} zIndex={1400} onClose={() => setButlerConfirm(null)} />
      )}

      {/* 通用工具确认（SSE tool_confirm 挂起）：复用画布同款 ConfirmDialog
          （portal 到 body，z-[9999]，不受抽屉 transform 影响、盖住抽屉） */}
      {confirmRender}

      {/* browser.login 登录弹窗（SSE login_required 挂起）：凭据直传服务端，不进模型上下文 */}
      {loginPopup && (
        <LoginDialog
          siteName={loginPopup.siteName}
          url={loginPopup.url}
          timeoutSec={loginPopup.timeoutSec}
          onSubmit={handleLoginSubmit}
          onClose={handleLoginClose}
        />
      )}

      {/* 会话人设弹窗（新建助理 / 编辑人设）。portal 到 body（z-1400），不受抽屉 transform 影响。
          编辑态回填取自列表摘要里的 persona —— 与 chat_sessions 同行，删会话即随之消失 */}
      {personaDialog && (
        <PersonaDialog
          mode={personaDialog.mode}
          heading={
            personaDialogIsNotify
              ? personaDialogInitial
                ? '编辑 Bobby 的人设'
                : '设置 Bobby 的人设'
              : personaDialogIsSearch
                ? personaDialogInitial
                  ? '编辑 小微 的人设'
                  : '设置 小微 的人设'
                : undefined
          }
          fixedName={personaDialogIsNotify ? notifyTitle : personaDialogIsSearch ? searchTitle : undefined}
          expandAdvanced={personaDialogIsResident}
          initial={personaDialogInitial}
          saving={personaSaving}
          error={personaError}
          onCancel={() => {
            if (personaSaving) return;
            setPersonaDialog(null);
            setPersonaError(null);
          }}
          onSubmit={(p) => void submitPersona(p)}
          onDelete={personaDialog.mode === 'edit' && !personaDialogIsResident ? removePersonaDialogSession : undefined}
        />
      )}

      {/* ===== 拖拽改尺寸：右缘（宽） / 下缘（高） / 右下角（宽高同时）=====
          三条热区贴在面板边缘、z 高于各栏（窄窗覆盖层是 z-40）。
          **不加任何可见把手/纹理**：鼠标进入热区时光标自己变成双向箭头（ew / ns / nwse-resize）即提示，
          画出来的角标只会常年占在面板上抢视线。
          右缘热区刻意只做 4px —— 再宽会盖住右栏的滚动条。 */}
      <span
        aria-hidden
        onPointerDown={startResize('x')}
        style={{ position: 'absolute', top: 0, right: 0, bottom: DRAWER_GRIP, width: 4, cursor: 'ew-resize', zIndex: 80 }}
      />
      <span
        aria-hidden
        onPointerDown={startResize('y')}
        style={{ position: 'absolute', left: 0, right: DRAWER_GRIP, bottom: 0, height: 5, cursor: 'ns-resize', zIndex: 80 }}
      />
      <span
        aria-hidden
        onPointerDown={startResize('xy')}
        style={{ position: 'absolute', right: 0, bottom: 0, width: DRAWER_GRIP, height: DRAWER_GRIP, cursor: 'nwse-resize', zIndex: 81 }}
      />
    </div>
    </>
  );
}
