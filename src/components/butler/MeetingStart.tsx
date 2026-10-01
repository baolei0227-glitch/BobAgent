'use client';

/**
 * MeetingStart —— 会议面板（Butler 抽屉中栏 · Meeting 入口）
 *
 * 信息架构：**主界面就是过往会议列表**（History 即家）——进面板先看到已有会议，
 * 可打开产物文件 / 回放录音（有录音时）/ 删除（行内二次确认）。
 * 标题栏右侧三枚入口按钮进入对应子流程（整块让位，带 Back 返回主界面）：
 *   - **Live meeting**：录音开始前的**极简**落点选择（一行当前目标 + Change + Start meeting），
 *     边录边转写由 MeetingConsole 接管；
 *   - **Transcribe audio**：把**已上传的录音**（项目 materials/ 下的音频——输入框附件的落点，也可用
 *     本子视图右上角 Upload 直接传）整理成会议纪要。长音频按 IMPORT_WINDOW_SEC 窗口**串行**转写
 *     （避免引擎 30 分钟上限），进度与取消都在本子视图内完成，产物口径与 Live 完全一致。
 *   - **Text to podcast**：挑一份 materials 下的 md/txt（同样可右上角直传）并选一种双主播互动形式
 *     （Q&A / Relay / Debate / Chat）与两位主播的音色（Host A / Host B，默认 Auto = 服务端按引擎自动派生），
 *     服务端把它改写成脚本并逐句合成（两位主播两条音色）成一段播客音频，
 *     音频落 butler/podcast/，伴生 md 写进落点目录——首行音频指针让它与会议产物一样出现在 History 并有 ▶ 回放。
 *
 * 设计取舍（与「配置界面极简」一致）：能自动生成的值一律不进表单——
 *   - 不设标题输入框：Live 标题由服务端自动生成「会议 MM-DD HH:mm」；Import 用音频文件名；
 *   - 默认目标固定为 Butler / meetings（全局 <APP_ROOT>/butler/meetings），无需用户先选；
 *   - Change 只在用户想改落点时才展开：列出**当前项目的顶层文件夹**（materials / homework / …），
 *     另给一枚 "Use Butler folder" 复位。
 *
 * 产物：纪要（md）+ 全文转写（+ Live 的录音分片 webm）都会写进该目录（见 MeetingConsole）。
 *
 * 实时会议结束 / 导入录音完成（或会议进行中控制台卸载）后，本面板**全新挂载**，
 * 默认视图即为主界面（过往会议列表）；实时纪要改为后台生成，期间列表顶部显示 "Generating…" 提示。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, AudioLines, Check, ChevronDown, FileText, FolderOpen, Loader2, Mic, Play, Podcast, Trash2, Upload } from 'lucide-react';
import { bus, BusEvents } from '@/lib/bus';
import { getMeetingWrapUp, safeName, subscribeMeetingWrapUp, writeOutput, type MeetingWrapUp } from './MeetingConsole';
import { MeetingReplay } from './MeetingReplay';
import type { MeetingSettings, MeetingRecordingSource, MeetingSpeakers } from '@/lib/settings';

/** 导入录音的分段窗口（秒）：引擎单次转写上限 30 分钟，取 25 分钟留安全余量 */
const IMPORT_WINDOW_SEC = 25 * 60;

/** Import 模式认可的音频扩展名（与 api/chat/tools/attachment.ts 的 audioExts 对齐，另加 Live 产出的 .webm） */
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.amr', '.webm'];

/** Text to podcast 认可的资料扩展名（与 api/butler/meeting 的 DOC_EXTS 口径一致） */
const DOC_EXTS = ['.md', '.markdown', '.txt'];

/**
 * 播客形式：两位主播的互动方式（与服务端 lib/core/podcast 的 PodcastForm 一一对应）。
 * 服务端不可被客户端 import（依赖 settings-server / tts），故这里单独列一份 UI 口径。
 */
type PodcastFormat = 'qa' | 'relay' | 'debate' | 'chat';

const PODCAST_FORMS: Array<{ id: PodcastFormat; label: string; hint: string }> = [
  { id: 'qa', label: 'Q&A', hint: 'One asks, one explains' },
  { id: 'relay', label: 'Relay', hint: 'Both carry the story forward' },
  { id: 'debate', label: 'Debate', hint: 'Opposing sides, no invented facts' },
  { id: 'chat', label: 'Chat', hint: 'Casual, faithful to the source' },
];

/**
 * 当前引擎的可选音色（镜像服务端 lib/core/podcast 的 PodcastVoiceChoices）。
 * 服务端不可被客户端 import（依赖 settings-server / tts），故这份清单只能通过 podcast_voices action 取回。
 */
interface PodcastVoiceChoices {
  provider: string;
  /** 可选音色；不足两条 = 该引擎无法给出两位不同主播，界面整块隐藏 */
  voices: Array<{ id: string; label: string }>;
  /** Auto 时两位主播各自的音色 id */
  autoA: string;
  autoB: string;
  note?: string;
}

/** Auto 选项的展示文案：把自动派生的音色 id 翻成展示名（清单里查不到就直接用 id） */
function autoVoiceLabel(choices: PodcastVoiceChoices, id: string): string {
  if (!id) return 'Auto';
  return `Auto (${choices.voices.find((v) => v.id === id)?.label || id})`;
}

/** 与 ButlerDrawer / MeetingConsole 同款分割线 */
const DIVIDER_SOFT = '1px solid color-mix(in oklab, var(--line-soft) 40%, transparent)';

interface Target {
  kind: 'project' | 'butler';
  /** project = 项目内相对路径；butler = butler 根下相对路径 */
  dir: string;
  /** 展示文案 */
  label: string;
}

/** 默认落点：全局 butler 根下的 meetings/ */
const BUTLER_TARGET: Target = { kind: 'butler', dir: 'meetings', label: 'Butler / meetings' };

interface FolderOption {
  rel: string;
  name: string;
}

/** materials 里的一条候选（录音 → Transcribe audio；文档 → Text to podcast，形态完全一致） */
interface MaterialOption {
  /** 项目内相对路径（materials/…），提交给服务端用 */
  rel: string;
  /** 主行展示名 = 文件名去扩展名（会议标题 / 播客标题也用它） */
  title: string;
  /** 副行：所在会话标题（list_files 挂的 title），缺省时用剥掉机器短 id 前缀的目录名 */
  sub: string;
}

/** 过往会议产物（/api/butler/meeting 的 history 动作返回；source + path 可直接打开文件） */
interface MeetingRecord {
  name: string;
  title: string;
  kind: 'minutes' | 'transcript' | 'podcast';
  source: 'project' | 'local';
  path: string;
  /** 落点说法（副行展示，如 Butler / meetings） */
  place: string;
  /** 文件 mtime（毫秒） */
  time: number;
  /** 是否有可回放的录音（服务端嗅探音频指针得出；仅决定本行是否出播放入口） */
  hasAudio?: boolean;
}

/** 产物类型的展示名（界面文案统一英文） */
const KIND_LABEL: Record<MeetingRecord['kind'], string> = {
  minutes: 'Minutes',
  transcript: 'Transcript',
  podcast: 'Podcast',
};

/** 同一场会议内的展示顺序：先读结论（纪要），再读原文（转写），播客排最后 */
const KIND_ORDER: Record<MeetingRecord['kind'], number> = { minutes: 0, transcript: 1, podcast: 2 };

/** 取所在目录（butler 侧是绝对路径、项目侧是相对路径，各自取 dirname 即可用于比较） */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * 一场会议 = 同落点 + 同标题的若干产物（纪要 / 全文转写 / 播客）。
 * 为什么这样聚合：这两个文件出自同一次会议（一次落盘同时写转写与纪要），
 * 平铺成两行会让人以为录了两场；聚成一行后展开即可看到「同一场会议的两种产物」。
 */
interface MeetingGroup {
  /** `source:目录:标题`（唯一键，也用作展开态的 key） */
  key: string;
  title: string;
  place: string;
  /** 组内最新 mtime（组之间新→旧排序用） */
  time: number;
  /** 组内产物，已按 KIND_ORDER 排序 */
  items: MeetingRecord[];
  /** 回放入口挂在这一份上（优先转写：纪要无时间戳，回放的字幕源是转写那份） */
  audio: MeetingRecord | null;
}

/**
 * 把扁平产物列表折叠成「会议」列表。
 * 为什么在客户端聚合而不动服务端 history 契约：记录员的 search 也走 listMeetingHistory，
 * 改契约会连带影响它；而聚拢纯属 History 列表的展示层事情。
 * 只有一条产物的会议（如单独的播客、或「会后自动整理」关闭时只有转写）不聚合，
 * 仍是改动前的一行，避免为单文件凭空多一层展开。
 */
function groupMeetings(list: MeetingRecord[]): MeetingGroup[] {
  const map = new Map<string, MeetingGroup>();
  for (const r of list) {
    const key = `${r.source}:${dirOf(r.path)}:${r.title}`;
    const hit = map.get(key);
    if (hit) {
      hit.items.push(r);
      hit.time = Math.max(hit.time, r.time);
    } else {
      map.set(key, { key, title: r.title, place: r.place, time: r.time, items: [r], audio: null });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    g.audio = g.items.find((i) => i.hasAudio && i.kind === 'transcript')
      ?? g.items.find((i) => i.hasAudio)
      ?? null;
  }
  return groups.sort((a, b) => b.time - a.time);
}

/** 项目文件树节点（只取用得到的字段；树来自 /api/projects?action=list_files 的 files） */
interface TreeNode {
  name?: string;
  rel?: string;
  type?: string;
  /** materials/<短id_标题> 会话目录的展示标题（服务端按 notes-memory 挂上） */
  title?: string;
  children?: TreeNode[];
}

/**
 * 从项目文件树里挑出 materials/ 下指定扩展名的文件（录音候选与文档候选共用一套筛法，避免两处漂移）。
 * 为什么前端筛而不是新开接口：树本来就要拉（Change 列表已用同一接口），再开一条只读接口没必要；
 * 同时兼容「嵌套树」与「扁平 rel 列表」两种返回，避免接口形态变化时静默筛空。
 */
function collectMaterials(
  nodes: TreeNode[],
  exts: string[],
  out: MaterialOption[] = [],
  dirTitle = '',
): MaterialOption[] {
  for (const n of nodes) {
    if (n.type === 'directory') {
      if (Array.isArray(n.children) && n.children.length > 0) collectMaterials(n.children, exts, out, String(n.title || ''));
      continue;
    }
    const rel = String(n.rel || '');
    if (!rel.startsWith('materials/')) continue;
    const dot = rel.lastIndexOf('.');
    if (dot < 0 || !exts.includes(rel.slice(dot).toLowerCase())) continue;
    const base = String(n.name || rel.slice(rel.lastIndexOf('/') + 1) || rel);
    // 副行优先用会话标题；没有则退回目录名，并剥掉 `短id_` 机器前缀（对用户无信息量）
    const folder = rel.slice('materials/'.length, rel.lastIndexOf('/'));
    const sub = dirTitle || folder.replace(/^[0-9a-zA-Z]{4}_/, '');
    out.push({ rel, title: base.slice(0, base.lastIndexOf('.')) || base, sub });
  }
  return out;
}

/** Transcribe audio 的音频候选 */
const collectAudio = (nodes: TreeNode[]) => collectMaterials(nodes, AUDIO_EXTS);
/** Text to podcast 的资料候选（md/txt） */
const collectDocs = (nodes: TreeNode[]) => collectMaterials(nodes, DOC_EXTS);

/** 秒 → `mm:ss`（与引擎转写时间戳同口径；>99 分钟自然进位成三位，不做特殊处理） */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 毫秒 → `MM-DD HH:mm`（历史列表副行的时间戳；取不到 mtime 时返回空串，由调用方略过） */
function stamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 调 /api/butler/meeting 的薄封装（失败返回 null，由调用方转成一句可读错误） */
async function postMeeting(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch('/api/butler/meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

/** 拉当前项目的文件树（Change 列表 / 录音候选 / 资料候选共用：同一接口、同一口径） */
async function fetchProjectTree(): Promise<TreeNode[]> {
  const pd = await fetch('/api/projects').then((r) => r.json());
  const pid = String(pd?.current_id || '');
  if (!pid) return [];
  const data = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list_files', project_id: pid }),
  }).then((r) => r.json());
  return (data?.files || []) as TreeNode[];
}

/** 播客生成的服务端进度帧（NDJSON，见 api/butler/meeting 的 podcast_generate） */
interface PodcastProgress {
  phase: 'script' | 'tts' | 'concat';
  /** phase='tts' 时的已合成段数/总段数；其余阶段为 0 */
  done: number;
  total: number;
}

/** 播客流式结局：done = 拿到伴生 md；error = 服务端明确报错；none = 取消/流中断（不当作失败） */
type PodcastOutcome =
  | { kind: 'done'; title: string; md: string; note?: string }
  | { kind: 'error'; error: string }
  | { kind: 'none' };

/**
 * 读服务端 podcast_generate 的 **NDJSON 流**（读法与 MeetingConsole.readRetranscribe 一致）。
 * 行缓冲负责粘包——网络分块可能把一行截断在两块之间，故最后一段半行留到下一轮。
 */
async function readPodcastStream(
  resp: Response,
  onProgress: (p: PodcastProgress) => void,
): Promise<PodcastOutcome> {
  if (!resp.ok || !resp.body) return { kind: 'error', error: `Podcast generation failed (HTTP ${resp.status})` };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let outcome: PodcastOutcome = { kind: 'none' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(s) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.t === 'progress') {
        const phase = msg.phase === 'tts' ? 'tts' : msg.phase === 'concat' ? 'concat' : 'script';
        onProgress({
          phase,
          done: typeof msg.done === 'number' ? msg.done : 0,
          total: typeof msg.total === 'number' ? msg.total : 0,
        });
      } else if (msg.t === 'done') {
        outcome = {
          kind: 'done',
          title: String(msg.title || ''),
          md: String(msg.md || ''),
          ...(msg.note ? { note: String(msg.note) } : {}),
        };
      } else if (msg.t === 'error') {
        outcome = { kind: 'error', error: String(msg.error || 'Podcast generation failed') };
      }
    }
  }
  return outcome;
}

export function MeetingStart({ onStarted }: { onStarted: () => void }) {
  const [target, setTarget] = useState<Target>(BUTLER_TARGET);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 会议专属设置（录音源 / 参会人数 / 会后自动整理）；null = 未读到（不显示该区块，不影响开始） */
  const [settings, setSettings] = useState<MeetingSettings | null>(null);
  /** 折叠状态：默认折叠（极简——设置项不抢占「开始会议」的视觉焦点） */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 过往会议（null = 还没加载过）；进入主视图时才拉，避免每次进面板都扫盘 */
  const [history, setHistory] = useState<MeetingRecord[] | null>(null);
  /** 面板视图：main = 主界面（过往会议列表 + 三个入口按钮）；live / import / podcast = 对应子流程整块让位 */
  const [view, setView] = useState<'main' | 'live' | 'import' | 'podcast'>('main');
  const [loadingHistory, setLoadingHistory] = useState(false);
  /** 待二次确认删除的那条（`source:path`；点垃圾桶先落这里，再点 Delete 才真删） */
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  /** 正在删除的那条（`source:path`），用于行内转圈 + 禁用重复点击 */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** 已展开的会议（MeetingGroup.key）：默认折叠成一行，点父行才展开出纪要/转写子行 */
  const [expanded, setExpanded] = useState<string[]>([]);
  /** 会议收尾状态（模块级，跨控制台卸载）：progress=重转百分比、summarizing=出纪要，任一非空即在 History 顶部显示占位 */
  const [wrapUp, setWrapUp] = useState<MeetingWrapUp | null>(() => getMeetingWrapUp());
  /** 正在回放的产物（非 null 时本面板整块让位给回放视图，Back 返回） */
  const [replay, setReplay] = useState<{ source: 'local' | 'project'; path: string; name: string } | null>(null);

  /** Import 子视图：materials 下的音频候选（null = 还没加载过） */
  const [audioList, setAudioList] = useState<MaterialOption[] | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  /** Import：正在上传一段音频（选文件 → POST /api/materials → 刷新候选并选中） */
  const [uploading, setUploading] = useState(false);
  /** Import：选中的音频（项目内相对路径） */
  const [audioRel, setAudioRel] = useState('');
  /** Import：转写 / 整理进行中（用 done/total 展示「第几段」进度）；
   *  phase='speakers' = 探时长阶段正在对整段音频做说话人分离（长音频这步可能要等一会儿） */
  const [progress, setProgress] = useState<{ done: number; total: number; phase?: 'speakers' } | null>(null);
  /** Import：取消标志（串行循环每段边界检查一次，不打断进行中的那一段） */
  const cancelRef = useRef(false);
  const importing = progress !== null;

  /** Podcast 子视图：materials 下的文档候选（null = 还没加载过）+ 选中的一份 */
  const [docList, setDocList] = useState<MaterialOption[] | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [docRel, setDocRel] = useState('');
  /** 播客来源行内删除：待二次确认的 rel + 正在删的 rel（就地替换成确认行，不弹原生对话框，与 History 删除同款） */
  const [confirmDelDoc, setConfirmDelDoc] = useState<string | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<string | null>(null);
  /** Podcast：两位主播的互动方式（默认 Q&A，与历史行为一致） */
  const [podcastForm, setPodcastForm] = useState<PodcastFormat>('qa');
  /** Podcast：当前引擎的可选音色（null = 还没加载过，懒加载）+ 两位主播的选择（'' = Auto） */
  const [voiceChoices, setVoiceChoices] = useState<PodcastVoiceChoices | null>(null);
  const [voiceA, setVoiceA] = useState('');
  const [voiceB, setVoiceB] = useState('');
  /** Podcast：生成进行中的阶段进度（null = 空闲） */
  const [podcast, setPodcast] = useState<PodcastProgress | null>(null);
  /** Podcast：取消用（abort 那条流式请求，服务端在段边界收手并清中间产物） */
  const podcastAbortRef = useRef<AbortController | null>(null);
  const generating = podcast !== null;
  /** 需要用户知道、但不算失败的一句提示（如「引擎只有一条音色，两位主播同声」） */
  const [notice, setNotice] = useState<string | null>(null);

  // 读一次会议设置（全局持久化在 settings.json 的 meeting 字段）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetch('/api/butler/meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'settings_get' }),
        }).then((r) => r.json());
        if (!cancelled && d?.success && d.settings) setSettings(d.settings as MeetingSettings);
      } catch { /* 读不到不显示设置区块 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  /** 改一项：本地即时生效 + 落盘（失败静默，下次进面板仍读回旧值） */
  const patch = useCallback((p: Partial<MeetingSettings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    void fetch('/api/butler/meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'settings_set', settings: p }),
    }).catch(() => undefined);
  }, []);

  /** 拉取当前项目的顶层文件夹（展开时才拉，避免无谓请求） */
  const loadFolders = useCallback(async () => {
    setLoadingList(true);
    try {
      const dirs: FolderOption[] = (await fetchProjectTree())
        .filter((n) => n.type === 'directory')
        .map((n) => ({ rel: String(n.rel), name: String(n.name) }));
      setFolders(dirs);
    } catch {
      setFolders([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (open && folders.length === 0) void loadFolders();
  }, [open, folders.length, loadFolders]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const resp = await fetch('/api/butler/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', outputKind: target.kind, outputDir: target.dir }),
      });
      const data = await resp.json();
      if (!data?.success) {
        setError(String(data?.error || 'Failed to start the meeting'));
        setStarting(false);
        return;
      }
      onStarted();
      setStarting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network request failed');
      setStarting(false);
    }
  }, [target, onStarted]);

  /** 拉取 materials 下的音频候选（切到 Import 时懒加载一次） */
  const loadAudio = useCallback(async () => {
    setLoadingAudio(true);
    try {
      setAudioList(collectAudio(await fetchProjectTree()));
    } catch {
      setAudioList([]);
    } finally {
      setLoadingAudio(false);
    }
  }, []);

  /** 拉取 materials 下的文档候选（切到 Text to podcast 时懒加载一次） */
  const loadDocs = useCallback(async () => {
    setLoadingDocs(true);
    try {
      setDocList(collectDocs(await fetchProjectTree()));
    } catch {
      setDocList([]);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  /** 拉取当前 TTS 引擎的可选音色（切到 Text to podcast 时懒加载一次）；失败按「无可选」处理（只留 Auto） */
  const loadVoices = useCallback(async () => {
    const d = await postMeeting({ action: 'podcast_voices' });
    if (d?.success) {
      setVoiceChoices({
        provider: String(d.provider || ''),
        voices: Array.isArray(d.voices) ? (d.voices as Array<{ id: string; label: string }>) : [],
        autoA: String(d.autoA || ''),
        autoB: String(d.autoB || ''),
        ...(d.note ? { note: String(d.note) } : {}),
      });
    } else {
      setVoiceChoices({ provider: '', voices: [], autoA: '', autoB: '' });
    }
  }, []);

  useEffect(() => {
    if (view === 'import' && audioList === null) void loadAudio();
  }, [view, audioList, loadAudio]);

  useEffect(() => {
    if (view === 'podcast' && docList === null) void loadDocs();
  }, [view, docList, loadDocs]);

  useEffect(() => {
    if (view === 'podcast' && voiceChoices === null) void loadVoices();
  }, [view, voiceChoices, loadVoices]);

  /**
   * 直接上传一个附件（录音或文档）：走 POST /api/materials 的 FormData 分支——与画布输入框附件**同一落点**
   * （项目 materials/，同样异步建内容索引），回传的 file.path 即 materials 内相对路径。
   * 上传完刷新对应候选并**自动选中**这一条：用户接着点按钮即可，不必再去列表里找。
   */
  const uploadMaterial = useCallback(async (files: FileList | null, kind: 'audio' | 'doc') => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/materials', { method: 'POST', body: fd });
      const data = await resp.json();
      const rel = data?.file?.path ? `materials/${String(data.file.path)}` : '';
      if (!data?.success || !rel) throw new Error(String(data?.error || 'Upload failed'));
      if (kind === 'audio') {
        await loadAudio();
        setAudioRel(rel);
      } else {
        await loadDocs();
        setDocRel(rel);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [loadAudio, loadDocs]);

  /**
   * 删除一条播客来源：走 DELETE /api/materials?scope=materials&path=…——与文件管理器同一个接口，
   * 删的是 materials/ 下的真实文件（连带回收内容索引 / 标签 / 标注 sidecar），不是只把这一行藏起来。
   * rel 形如 materials/xxx.md，接口要的是相对 scope 根的路径，故先剥掉前缀。
   */
  const removeDoc = useCallback(async (rel: string) => {
    setError(null);
    setDeletingDoc(rel);
    try {
      const resp = await fetch(
        `/api/materials?scope=materials&path=${encodeURIComponent(rel.replace(/^materials\//, ''))}`,
        { method: 'DELETE' },
      );
      const d = await resp.json().catch(() => null);
      if (!resp.ok || !d?.success) throw new Error(String(d?.error || 'Failed to delete the source'));
      setDocList((list) => (list ? list.filter((x) => x.rel !== rel) : list));
      // 删掉的正好是当前选中项：清空选择，避免把已不存在的路径提交给生成
      setDocRel((cur) => (cur === rel ? '' : cur));
      setConfirmDelDoc(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the source');
    } finally {
      setDeletingDoc(null);
    }
  }, []);

  /** 拉过往会议产物（进入主视图时懒加载一次；服务端扫 butler 根 + 当前项目根） */
  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    const d = await postMeeting({ action: 'history' });
    setHistory(d?.success && Array.isArray(d.meetings) ? (d.meetings as MeetingRecord[]) : []);
    setLoadingHistory(false);
  }, []);

  useEffect(() => {
    if (view === 'main' && history === null) void loadHistory();
  }, [view, history, loadHistory]);

  /** 删除一条历史产物（只删这一份 md）：成功后本地摘掉该行，不必重扫盘 */
  const removeRecord = useCallback(async (h: MeetingRecord) => {
    const key = `${h.source}:${h.path}`;
    setError(null);
    setDeleting(key);
    const d = await postMeeting({ action: 'delete', source: h.source, path: h.path });
    setDeleting(null);
    if (!d?.success) {
      setError(String(d?.error || 'Failed to delete the record'));
      return;
    }
    setHistory((list) => (list ? list.filter((x) => !(x.source === h.source && x.path === h.path)) : list));
    setConfirmDel(null);
  }, []);

  // 订阅收尾状态：后台收尾（重转 + 纪要生成）**全部**结束时重拉列表，让新产物出现在过往会议里。
  // 重转过程中会不断推进度（summarizing 可能已是 false），故必须等 progress 也清空才刷新，否则每推一次都白拉一通。
  useEffect(() => subscribeMeetingWrapUp(() => {
    const w = getMeetingWrapUp();
    setWrapUp(w);
    if (w && !w.summarizing && !w.progress) void loadHistory();
  }), [loadHistory]);

  /** 取消导入：置标志，串行循环在下一段边界退出（整体作废，不落任何产物） */
  const cancelImport = useCallback(() => {
    cancelRef.current = true;
  }, []);

  /**
   * 导入一段录音 → 会议纪要。
   * 为什么客户端驱动循环：长音频必须按窗口串行转写（引擎单次上限 30 分钟），
   * 一次请求跑完整场既看不到进度也无法取消。
   * 时间戳由引擎给出（60s 分块，绝对 `[mm:ss]`），这里不再叠窗口头；
   * 最后走与实时模式**同一个**收尾出口（同样尊重「会后自动整理」与参会人数口径）。
   */
  const runImport = useCallback(async () => {
    const option = (audioList || []).find((a) => a.rel === audioRel);
    if (!option) return;
    setError(null);
    cancelRef.current = false;
    try {
      // 1) 探时长 → 切窗口；ffmpeg 不可用（null）时退化为「单次整段」，由引擎决定成败。
      //    这一步服务端还会对整段音频跑一次说话人分离（结果缓存复用），长录音会明显耗时，故先给阶段提示。
      setProgress({ done: 0, total: 0, phase: 'speakers' });
      const probe = await postMeeting({ action: 'import_probe', audioPath: option.rel });
      if (!probe?.success) throw new Error(String(probe?.error || 'Could not read the recording'));
      const durationSec = typeof probe.durationSec === 'number' && probe.durationSec > 0 ? probe.durationSec : null;
      const windows: Array<{ start: number; end: number } | null> = [];
      if (durationSec) {
        for (let s = 0; s < durationSec; s += IMPORT_WINDOW_SEC) {
          windows.push({ start: s, end: Math.min(s + IMPORT_WINDOW_SEC, durationSec) });
        }
      } else {
        windows.push(null);
      }
      setProgress({ done: 0, total: windows.length });
      // 2) 串行转写（一段一次请求；中途取消则整体作废）
      // 时间戳已由引擎给出（按 60s 分块，窗口请求下是**绝对** [mm:ss]）：
      // 只有末窗不足一块、引擎不回戳时才补窗口起点；送模型的纯文本一律剥掉戳行。
      const plain: string[] = [];
      const stamped: string[] = [];
      for (let i = 0; i < windows.length; i++) {
        if (cancelRef.current) {
          setProgress(null);
          return;
        }
        setProgress({ done: i, total: windows.length });
        const w = windows[i];
        const seg = await postMeeting({
          action: 'import_segment',
          audioPath: option.rel,
          ...(w ? { startSec: w.start, endSec: w.end } : {}),
        });
        if (!seg?.success) throw new Error(String(seg?.error || 'Transcription failed'));
        const text = String(seg.text || '').trim();
        if (!text) continue;
        plain.push(text.replace(/^\[\d{1,3}:\d{2}\]\s*$/gm, '').replace(/\n{2,}/g, '\n').trim());
        stamped.push(/^\[\d{1,3}:\d{2}\]/.test(text) || !w ? text : `[${mmss(w.start)}]\n${text}`);
      }
      if (cancelRef.current) {
        setProgress(null);
        return;
      }
      const transcript = plain.join('\n\n').trim();
      if (!transcript) throw new Error('No speech was recognized in this recording');
      // 3) 出纪要（「会后自动整理」关闭时只留档全文转写）
      setProgress({ done: windows.length, total: windows.length });
      const fin = await postMeeting({ action: 'import_finish', title: option.title, text: transcript });
      if (!fin?.success) throw new Error(String(fin?.error || 'Failed to generate the minutes'));
      const summarized = fin.summarized !== false;
      const minutes = String(fin.minutes || '').trim();
      // 4) 落盘 + 跳历史：口径与实时模式 doEnd 一致——**总是**写全文转写（首行音频指针供回放配对），
      //    自动整理开启时再另写一份纪要（纪要不含时间戳，回放的字幕源是转写那份）。
      //    导入是同步流程（上面的 import_finish 已把纪要生成完），因此无需「生成中」提示，直接进 History。
      const stem = safeName(option.title);
      const hint = `<!-- bob-audio: project:${option.rel} -->\n\n`;
      const recordName = `会议记录 - ${stem}.md`;
      const recordContent = `${hint}# 会议记录：${option.title}\n\n## 全文转写\n\n${stamped.join('\n\n') || '（EMPTY）'}\n`;
      const summaryName = `会议纪要 - ${stem}.md`;
      const summaryContent = `# 会议纪要：${option.title}\n\n${minutes || '（No summary was generated.）'}\n`;
      await writeOutput(target.kind, target.dir, recordName, recordContent);
      if (summarized) await writeOutput(target.kind, target.dir, summaryName, summaryContent);
      // 不自动打开 md：回到主界面（过往会议列表）；先清历史缓存，保证列表含本轮产物
      setHistory(null);
      setView('main');
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      setProgress(null);
    }
  }, [audioList, audioRel, target]);

  /**
   * 文本 → 播客：把选中的 md/txt 交给服务端改写成双主播脚本（form 决定互动方式）、逐句合成并拼接。
   * 为什么用流式：一轮可能跑好几分钟（脚本生成 + 逐段 TTS），进度帧让用户看得见，
   * Cancel 直接 abort 这条请求——服务端在段边界收手，音频只在拼接成功那一刻才写出，
   * 故不会留下半个成品（中间分片由服务端清理）。
   */
  const runPodcast = useCallback(async () => {
    const option = (docList || []).find((d) => d.rel === docRel);
    if (!option) return;
    setError(null);
    setNotice(null);
    const ac = new AbortController();
    podcastAbortRef.current = ac;
    setPodcast({ phase: 'script', done: 0, total: 0 });
    try {
      const resp = await fetch('/api/butler/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'podcast_generate',
          sourcePath: option.rel,
          title: option.title,
          form: podcastForm,
          // 空串 = Auto：不传字段，服务端走自动派生（与历史行为一致）
          ...(voiceA ? { voiceA } : {}),
          ...(voiceB ? { voiceB } : {}),
        }),
        signal: ac.signal,
      });
      const outcome = await readPodcastStream(resp, setPodcast);
      if (outcome.kind === 'error') throw new Error(outcome.error);
      if (outcome.kind === 'none') {
        // 取消 / 流中断：不当作失败，回到可重试态
        setPodcast(null);
        return;
      }
      // 落盘伴生 md（首行含音频指针，History 据此出 ▶ 回放），再回主界面让它出现
      await writeOutput(target.kind, target.dir, `播客 - ${safeName(outcome.title || option.title)}.md`, outcome.md);
      setHistory(null);
      setView('main');
      setPodcast(null);
      if (outcome.note) setNotice(outcome.note);
    } catch (e) {
      // abort 抛出的 AbortError 不当作失败（用户主动取消）
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPodcast(null);
        return;
      }
      setError(e instanceof Error ? e.message : 'Podcast generation failed');
      setPodcast(null);
    } finally {
      podcastAbortRef.current = null;
    }
  }, [docList, docRel, podcastForm, voiceA, voiceB, target]);

  /** 取消播客生成：abort 流式请求（服务端在段边界收手并清中间产物） */
  const cancelPodcast = useCallback(() => {
    podcastAbortRef.current?.abort();
  }, []);

  /** 展开 / 收起一场会议（默认折叠，故只需记「已展开」的那些） */
  const toggleExpand = useCallback((key: string) => {
    setExpanded((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  }, []);

  /**
   * 单条产物行。
   * flat = 只有一份产物的会议（独立成行，与聚合改动前完全一致）；
   * child = 展开后的子行——主行已经是会议标题，这里改为展示**产物类型**，
   * 副行给真实文件名，一眼就能看清这场会议落了「会议纪要 / 会议记录」两份文件。
   */
  const renderRecord = (h: MeetingRecord, variant: 'flat' | 'child') => {
    const key = `${h.source}:${h.path}`;
    const busy = deleting === key;
    const pad = variant === 'child' ? ' pl-4' : '';
    if (confirmDel === key) {
      // 二次确认：就地替换该行（不弹原生对话框，保持面板内一致观感）
      return (
        <div key={key} className={`flex items-center gap-1 rounded-md px-1 py-1.5${pad}`}>
          <span className="min-w-0 flex-1 truncate px-1 text-10" style={{ color: 'var(--danger)' }} title={h.title}>
            Delete “{h.title}”?
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void removeRecord(h)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
            style={{ color: 'var(--danger)' }}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Delete
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDel(null)}
            className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
            style={{ color: 'var(--ink-muted)' }}
          >
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div
        key={key}
        className={`flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--paper-hover)]${pad}`}
      >
        <button
          type="button"
          // 点开即打开产物文件（source + path 与落盘时的 fileOpen 口径一致）
          onClick={() => bus.publish(BusEvents.fileOpen, { source: h.source, path: h.path, name: h.name })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs" style={{ color: 'var(--ink)' }}>
              {variant === 'child' ? KIND_LABEL[h.kind] : h.title}
            </span>
            <span className="block truncate text-10" style={{ color: 'var(--ink-faint)' }}>
              {variant === 'child' ? h.name : [stamp(h.time), h.place].filter(Boolean).join(' · ')}
            </span>
          </span>
          {/* 子行已用主文案标明类型，不再重复右上角标签 */}
          {variant === 'flat' && (
            <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>{KIND_LABEL[h.kind]}</span>
          )}
        </button>
        {/* 单独的「打开」入口：用 BobWork 内置阅读器打开这份 md
            （fileOpen → openFileTab → UnifiedViewer，与行本身点击同一路径；这里给一个明确的按钮） */}
        <button
          type="button"
          aria-label="Open in BobWork"
          title="Open in BobWork"
          onClick={() => bus.publish(BusEvents.fileOpen, { source: h.source, path: h.path, name: h.name })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <FileText className="h-3 w-3" />
        </button>
        {/* 有录音才出播放入口（行本身的点击仍是「打开文件」，不制造回归）；
            展开成子行时回放入口统一挂在父行（同一段录音，避免两处入口） */}
        {h.hasAudio && variant === 'flat' && (
          <button
            type="button"
            aria-label="Replay recording"
            title="Replay recording"
            onClick={() => setReplay({ source: h.source, path: h.path, name: h.name })}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)]"
            style={{ color: 'var(--primary-strong)' }}
          >
            <Play className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="Delete record"
          title="Delete record"
          onClick={() => { setError(null); setConfirmDel(key); }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)]"
          style={{ color: 'var(--ink-faint)' }}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  // 回放：主界面行点 ▶ 进入（回放在 meeting 分区内部切换，不动 ButlerDrawer 的结构）
  if (replay) {
    return (
      <MeetingReplay
        source={replay.source}
        path={replay.path}
        name={replay.name}
        onBack={() => setReplay(null)}
      />
    );
  }

  // 主界面（History 即家）：过往会议列表 + 标题栏右侧三枚入口按钮
  // （Live meeting / Transcribe audio / Text to podcast）。
  // 列表项：点开 = 打开产物文件，▶ = 回放录音，🗑 = 删除（行内二次确认，避免误删）。
  if (view === 'main') {
    return (
      <div className="flex min-h-0 flex-1 flex-col" style={{ backgroundColor: 'var(--panel-bg)' }}>
        <div className="flex shrink-0 items-center gap-1.5 px-6 pb-2 pt-6" style={{ color: 'var(--ink-strong)' }}>
          <FolderOpen className="h-4 w-4" style={{ color: 'var(--primary-strong)' }} />
          <span className="text-sm font-semibold">Meeting</span>
          <span className="ml-auto flex items-center gap-1">
            {/* 三枚入口：整块让位进入对应子流程（任一进行中则禁用，避免打断当前流程） */}
            <button
              type="button"
              onClick={() => { setView('live'); setError(null); setNotice(null); setConfirmDel(null); }}
              disabled={starting || importing}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
            >
              <Mic className="h-3 w-3" />
              Live meeting
            </button>
            <button
              type="button"
              onClick={() => { setView('import'); setError(null); setNotice(null); setConfirmDel(null); }}
              disabled={starting || importing}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
            >
              <AudioLines className="h-3 w-3" />
              Transcribe audio
            </button>
            <button
              type="button"
              onClick={() => { setView('podcast'); setError(null); setNotice(null); setConfirmDel(null); }}
              disabled={starting || importing || generating}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
            >
              <Podcast className="h-3 w-3" />
              Text to podcast
            </button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {error && (
            <div className="mb-2 rounded-md px-2 py-1 text-10" style={{ color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)' }}>
              {error}
            </div>
          )}
          {/* 需要用户知道但不算失败的一句提示（如同音色兜底），回到主界面后仍可见，点开别的入口即清 */}
          {notice && (
            <div
              className="mb-2 rounded-md px-2 py-1 text-10 leading-relaxed"
              style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper-soft)', border: DIVIDER_SOFT }}
            >
              {notice}
            </div>
          )}
          {/* 刚结束的会议仍在后台收尾：重转（带百分比）/ 出纪要各给一条占位提示，完成自动换成真实记录 */}
          {(wrapUp?.progress || wrapUp?.summarizing) && (
            <div
              className="mb-2 flex items-center gap-1.5 rounded-lg px-3 py-2 text-10"
              style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {wrapUp.progress
                ? `Re-transcribing “${wrapUp.title}”… ${Math.min(99, Math.max(1, Math.round((wrapUp.progress.doneSec / wrapUp.progress.totalSec) * 100)))}%`
                : `Generating minutes for “${wrapUp.title}”…`}
            </div>
          )}
          {history === null || loadingHistory ? (
            <div className="flex items-center gap-1.5 px-1 py-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : history.length === 0 ? (
            <div className="px-1 py-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
              No past meetings yet.
            </div>
          ) : (
            <div className="rounded-lg p-1" style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}>
              {groupMeetings(history).map((g) => {
                // 只有一份产物的会议不聚合（如单独的播客、或「会后自动整理」关闭时只有转写），
                // 与聚合前完全一样；两份及以上才出可展开的会议行
                const single = g.items.length === 1;
                const isOpen = single || expanded.includes(g.key);
                const audio = g.audio;
                return (
                  <div key={g.key}>
                    {!single && (
                      <div className="flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--paper-hover)]">
                        {/* 整行可点：展开 / 收起这场会议的两份产物（默认折叠成一行） */}
                        <button
                          type="button"
                          onClick={() => toggleExpand(g.key)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left"
                        >
                          <ChevronDown
                            className={`h-3 w-3 shrink-0 transition-transform${isOpen ? '' : ' -rotate-90'}`}
                            style={{ color: 'var(--ink-faint)' }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs" style={{ color: 'var(--ink)' }}>{g.title}</span>
                            <span className="block truncate text-10" style={{ color: 'var(--ink-faint)' }}>
                              {[stamp(g.time), g.place].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          {/* 右侧直接列出这场会议落了哪几份产物，折叠时也能一眼看清「纪要 + 转写」 */}
                          <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>
                            {g.items.map((i) => KIND_LABEL[i.kind]).join(' · ')}
                          </span>
                        </button>
                        {/* 回放只出一处：同一段录音挂在会议行上，字幕源取带时间戳的转写那份 */}
                        {audio && (
                          <button
                            type="button"
                            aria-label="Replay recording"
                            title="Replay recording"
                            onClick={() => setReplay({ source: audio.source, path: audio.path, name: audio.name })}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)]"
                            style={{ color: 'var(--primary-strong)' }}
                          >
                            <Play className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )}
                    {isOpen && g.items.map((h) => renderRecord(h, single ? 'flat' : 'child'))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    // 内容随模式/设置展开会变高：外层可滚动 + 内层 my-auto，保证既居中又不会被裁掉
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-6" style={{ backgroundColor: 'var(--panel-bg)' }}>
      <div className="my-auto w-full max-w-sm">
        {/* 标题区：Back 返回主界面 + 子流程名（Live meeting / Transcribe audio / Text to podcast） */}
        <div className="mb-1 flex items-center gap-1.5" style={{ color: 'var(--ink-strong)' }}>
          <button
            type="button"
            aria-label="Back"
            title="Back"
            onClick={() => { setView('main'); setError(null); setNotice(null); setConfirmDel(null); }}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          {view === 'live' ? (
            <Mic className="h-4 w-4" style={{ color: 'var(--primary-strong)' }} />
          ) : view === 'podcast' ? (
            <Podcast className="h-4 w-4" style={{ color: 'var(--primary-strong)' }} />
          ) : (
            <AudioLines className="h-4 w-4" style={{ color: 'var(--primary-strong)' }} />
          )}
          <span className="text-sm font-semibold">
            {view === 'live' ? 'Live meeting' : view === 'podcast' ? 'Text to podcast' : 'Transcribe audio'}
          </span>
        </div>
        <p className="mb-4 text-xs" style={{ color: 'var(--ink-muted)' }}>
          {view === 'live'
            ? 'Records the microphone; saves notes and audio below.'
            : view === 'podcast'
              ? 'Markdown or text file → two-host podcast.'
              : 'Audio file → meeting minutes.'}
        </p>

        {/* 目标行：当前落点 + Change */}
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ backgroundColor: 'var(--paper-soft)', border: DIVIDER_SOFT }}
        >
          <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>Save to</span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }} title={target.label}>
            {target.label}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={starting || importing || generating}
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
            style={{ color: 'var(--primary-strong)' }}
          >
            Change
            <ChevronDown className={`h-3 w-3 transition-transform${open ? ' rotate-180' : ''}`} />
          </button>
        </div>

        {/* 展开：文件夹列表 */}
        {open && (
          <div
            className="mt-1.5 max-h-52 overflow-y-auto rounded-lg p-1"
            style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}
          >
            <FolderRow
              label="Butler / meetings"
              hint="Default"
              selected={target.kind === 'butler'}
              onClick={() => { if (importing || generating) return; setTarget(BUTLER_TARGET); setOpen(false); }}
            />
            {loadingList && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
                <Loader2 className="h-3 w-3 animate-spin" /> Loading folders…
              </div>
            )}
            {!loadingList && folders.length === 0 && (
              <div className="px-2 py-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                No project folders found.
              </div>
            )}
            {folders.map((f) => (
              <FolderRow
                key={f.rel}
                label={`Project / ${f.rel}`}
                selected={target.kind === 'project' && target.dir === f.rel}
                onClick={() => { if (importing || generating) return; setTarget({ kind: 'project', dir: f.rel, label: `Project / ${f.rel}` }); setOpen(false); }}
              />
            ))}
          </div>
        )}

        {/* Transcribe audio：从 materials 里挑一段录音（= 输入框附件落点；也可由右上角 Upload 直接传进来） */}
        {view === 'import' && (
          <div className="mt-2">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>Recording</span>
              {/* 直接上传入口：不先去画布输入框传附件时用这个；落点与附件相同（项目 materials/） */}
              <label
                className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: importing || uploading ? 'var(--ink-muted)' : 'var(--primary-strong)' }}
                title="Upload an audio file into this project’s materials"
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Upload
                <input
                  type="file"
                  accept={[...AUDIO_EXTS, 'audio/*'].join(',')}
                  className="hidden"
                  disabled={importing || uploading}
                  onChange={(e) => { void uploadMaterial(e.target.files, 'audio'); e.target.value = ''; }}
                />
              </label>
            </div>
            {/* 三态：未加载/加载中 → 空 → 列表。audioList === null 兜住首次进入，避免闪一帧「无音频」 */}
            {audioList === null || loadingAudio ? (
              <div
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-10"
                style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}
              >
                <Loader2 className="h-3 w-3 animate-spin" /> Loading recordings…
              </div>
            ) : audioList.length === 0 ? (
              <p
                className="rounded-lg px-3 py-2 text-10 leading-relaxed"
                style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}
              >
                No audio — upload above.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg p-1" style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}>
                {audioList.map((a) => (
                  <button
                    key={a.rel}
                    type="button"
                    disabled={importing}
                    onClick={() => setAudioRel(a.rel)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-60"
                  >
                    {/* 主行 = 文件名（即会议标题）；副行 = 所在会话/目录，机器短 id 已剥掉 */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs" style={{ color: a.rel === audioRel ? 'var(--primary-strong)' : 'var(--ink)' }}>
                        {a.title}
                      </span>
                      {a.sub && (
                        <span className="block truncate text-10" style={{ color: 'var(--ink-faint)' }}>{a.sub}</span>
                      )}
                    </span>
                    {a.rel === audioRel && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Text to podcast：挑一份文档（md/txt；也可由右上角 Upload 直接传进来），再选一种双主播互动形式 */}
        {view === 'podcast' && (
          <div className="mt-2">
            {/* 形式：只改脚本里两人的互动方式，音色与拼接不变（故不放进下面的会议 Settings 区） */}
            <div className="mb-1 flex items-center gap-1.5">
              <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>Format</span>
            </div>
            <div className="mb-3 flex flex-wrap gap-1">
              {PODCAST_FORMS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={generating}
                  onClick={() => setPodcastForm(f.id)}
                  title={f.hint}
                  className="rounded-md px-2 py-1 text-10 font-medium transition-colors disabled:opacity-60"
                  style={podcastForm === f.id
                    ? { backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary-strong)' }
                    : { border: DIVIDER_SOFT, color: 'var(--ink-muted)' }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {/* 音色：两位主播各挑一条，默认 Auto（= 服务端按引擎自动派生，与历史行为一致）；
                清单由服务端 podcast_voices 列举（客户端拿不到 TTS 配置与本地模型），不足两条时整块隐藏 */}
            {voiceChoices && voiceChoices.voices.length >= 2 && (
              <>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>Voices</span>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-1.5">
                  <VoicePicker
                    label="Host A"
                    value={voiceA}
                    autoLabel={autoVoiceLabel(voiceChoices, voiceChoices.autoA)}
                    options={voiceChoices.voices}
                    disabled={generating}
                    onChange={setVoiceA}
                  />
                  <VoicePicker
                    label="Host B"
                    value={voiceB}
                    autoLabel={autoVoiceLabel(voiceChoices, voiceChoices.autoB)}
                    options={voiceChoices.voices}
                    disabled={generating}
                    onChange={setVoiceB}
                  />
                </div>
              </>
            )}
            <div className="mb-1 flex items-center gap-1.5">
              <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>Source</span>
              <label
                className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: generating || uploading ? 'var(--ink-muted)' : 'var(--primary-strong)' }}
                title="Upload a Markdown or text file into this project’s materials"
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Upload
                <input
                  type="file"
                  accept={DOC_EXTS.join(',')}
                  className="hidden"
                  disabled={generating || uploading}
                  onChange={(e) => { void uploadMaterial(e.target.files, 'doc'); e.target.value = ''; }}
                />
              </label>
            </div>
            {/* 三态：未加载/加载中 → 空 → 列表。docList === null 兜住首次进入，避免闪一帧「无文档」 */}
            {docList === null || loadingDocs ? (
              <div
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-10"
                style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}
              >
                <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
              </div>
            ) : docList.length === 0 ? (
              <p
                className="rounded-lg px-3 py-2 text-10 leading-relaxed"
                style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}
              >
                No documents — upload above.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg p-1" style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}>
                {docList.map((d) => (
                  confirmDelDoc === d.rel ? (
                    // 二次确认：就地替换成确认行（与 History 删除同款），确认后才真删 materials 里的文件
                    <div key={d.rel} className="flex items-center gap-1 rounded-md px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-10" style={{ color: 'var(--danger)' }} title={d.title}>
                        Delete “{d.title}”?
                      </span>
                      <button
                        type="button"
                        disabled={deletingDoc === d.rel}
                        onClick={() => void removeDoc(d.rel)}
                        className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-10 font-medium transition-colors hover:bg-[var(--paper)] disabled:opacity-50"
                        style={{ color: 'var(--danger)' }}
                      >
                        {deletingDoc === d.rel && <Loader2 className="h-3 w-3 animate-spin" />}
                        Delete
                      </button>
                      <button
                        type="button"
                        disabled={deletingDoc === d.rel}
                        onClick={() => setConfirmDelDoc(null)}
                        className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-10 font-medium transition-colors hover:bg-[var(--paper)] disabled:opacity-50"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div key={d.rel} className="flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-[var(--paper-hover)]">
                      <button
                        type="button"
                        disabled={generating}
                        onClick={() => setDocRel(d.rel)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs" style={{ color: d.rel === docRel ? 'var(--primary-strong)' : 'var(--ink)' }}>
                            {d.title}
                          </span>
                          {d.sub && (
                            <span className="block truncate text-10" style={{ color: 'var(--ink-faint)' }}>{d.sub}</span>
                          )}
                        </span>
                        {d.rel === docRel && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />}
                      </button>
                      {/* 删除这一条来源：删的是 materials 下的真实文件（同一接口也用于文件管理器），故需二次确认 */}
                      <button
                        type="button"
                        aria-label="Delete source"
                        title="Delete source"
                        disabled={generating || deletingDoc !== null}
                        onClick={() => { setError(null); setConfirmDelDoc(d.rel); }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)] disabled:opacity-50"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        {deletingDoc === d.rel ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </button>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-md px-2 py-1 text-10" style={{ color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)' }}>
            {error}
          </div>
        )}

        {/* 会议专属设置：默认折叠（不抢「Start meeting」的视觉焦点），展开后改录音源/参会人数/会后自动整理。
            Text to podcast 与这些设置无关（音色取自 Settings → Audio TTS），该子视图下整块隐藏 */}
        {settings && view !== 'podcast' && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              disabled={starting}
              className="flex w-full items-center gap-1 text-10 font-medium transition-colors hover:opacity-80 disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
            >
              Settings
              <ChevronDown className={`h-3 w-3 transition-transform${settingsOpen ? ' rotate-180' : ''}`} />
            </button>
            {settingsOpen && (
              <div className="mt-2 space-y-2.5 rounded-lg px-3 py-2.5" style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}>
                {/* 录音源只对 Live 有意义（Transcribe audio 转写的是已有文件），该子视图下隐藏该行 */}
                {view === 'live' && (
                  <Field label="Audio source">
                    <Segmented<MeetingRecordingSource>
                      value={settings.recordingSource}
                      onChange={(v) => patch({ recordingSource: v })}
                      options={[
                        { v: 'microphone', l: 'Mic' },
                        { v: 'system', l: 'System' },
                        { v: 'both', l: 'Both' },
                      ]}
                    />
                  </Field>
                )}
                <Field label="Speakers">
                  <Segmented<MeetingSpeakers>
                    value={settings.speakers}
                    onChange={(v) => patch({ speakers: v })}
                    options={[
                      { v: 'auto', l: 'Auto' },
                      { v: 'solo', l: '1' },
                      { v: 'duo', l: '2' },
                      { v: 'group', l: '3+' },
                    ]}
                  />
                </Field>
                <Field label="Auto-summarize">
                  <button
                    type="button"
                    onClick={() => patch({ autoSummarize: !settings.autoSummarize })}
                    className="rounded-md px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: settings.autoSummarize ? 'var(--primary-strong)' : 'var(--ink-muted)' }}
                  >
                    {settings.autoSummarize ? 'On' : 'Off'}
                  </button>
                </Field>
                {/* 仅选了系统音频时才提一句前提，避免常态下多一行噪音 */}
                {view === 'live' && settings.recordingSource !== 'microphone' && (
                  <p className="text-10 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                    Captures what this computer plays (macOS 14.2+).
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 底部动作：Live meeting = 开一场实时会议；Transcribe audio = 转写并整理；Text to podcast = 生成播客
            （后两者进行中时按钮变 Cancel） */}
        {view === 'import' && progress && (
          <div className="mt-4 flex items-center justify-center gap-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress.phase === 'speakers'
              ? 'Analyzing speakers…'
              : progress.total > 0 && progress.done < progress.total
                ? `Transcribing ${progress.done + 1}/${progress.total}…`
                : 'Generating minutes…'}
          </div>
        )}
        {view === 'podcast' && podcast && (
          <div className="mt-4 flex items-center justify-center gap-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>
            <Loader2 className="h-3 w-3 animate-spin" />
            {podcast.phase === 'script'
              ? 'Writing the script…'
              : podcast.phase === 'concat'
                ? 'Merging…'
                : podcast.total > 0 && podcast.done < podcast.total
                  ? `Synthesizing ${podcast.done + 1}/${podcast.total}…`
                  : 'Synthesizing…'}
          </div>
        )}
        <button
          type="button"
          onClick={() => void (view === 'live'
            ? start()
            : view === 'podcast'
              ? generating ? cancelPodcast() : runPodcast()
              : importing ? cancelImport() : runImport())}
          disabled={view === 'live' ? starting : view === 'podcast' ? (!docRel && !generating) : !audioRel}
          className={`${(view === 'import' && progress) || (view === 'podcast' && podcast) ? 'mt-2' : 'mt-4'} flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60`}
          style={
            (view === 'import' && importing) || (view === 'podcast' && generating)
              ? { backgroundColor: 'var(--paper-soft)', color: 'var(--ink)', border: DIVIDER_SOFT }
              : { backgroundColor: 'var(--primary)', color: '#fff' }
          }
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {view === 'live'
            ? starting ? 'Starting…' : 'Start meeting'
            : view === 'podcast'
              ? generating ? 'Cancel' : 'Generate podcast'
              : importing ? 'Cancel' : 'Transcribe & summarize'}
        </button>
      </div>
    </div>
  );
}

/** 单个文件夹选项行（选中态给一枚对勾） */
function FolderRow({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
    >
      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: selected ? 'var(--primary-strong)' : 'var(--ink)' }}>
        {label}
      </span>
      {hint && <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>{hint}</span>}
      {selected && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />}
    </button>
  );
}

/** 设置项一行：左标签 + 右控件（控件保持原尺寸，不被标签挤压） */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-10" style={{ color: 'var(--ink-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

/** 分段单选：选中项用主色底衬托；选项文案极短（Mic/System/Both、Auto/1/2/3+） */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; l: string }>;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5" style={{ backgroundColor: 'var(--paper)' }}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className="rounded px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
            style={{
              color: on ? 'var(--primary-strong)' : 'var(--ink-muted)',
              backgroundColor: on ? 'color-mix(in oklab, var(--primary) 12%, transparent)' : undefined,
            }}
          >
            {o.l}
          </button>
        );
      })}
    </div>
  );
}

/** 一位主播的音色下拉：Auto（= 服务端按引擎自动派生）+ 该引擎的可选音色清单 */
function VoicePicker({
  label,
  value,
  autoLabel,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  autoLabel: string;
  options: Array<{ id: string; label: string }>;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label
      className="flex items-center gap-1.5 rounded-md px-2 py-1"
      style={{ border: DIVIDER_SOFT, backgroundColor: 'var(--paper-soft)' }}
    >
      <span className="shrink-0 text-10" style={{ color: 'var(--ink-muted)' }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={`${label} voice`}
        className="min-w-0 flex-1 bg-transparent text-10 outline-none disabled:opacity-60"
        style={{ color: 'var(--ink)' }}
      >
        <option value="">{autoLabel}</option>
        {options.map((v) => (
          <option key={v.id} value={v.id}>{v.label}</option>
        ))}
      </select>
    </label>
  );
}