'use client';

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Check, X, Loader2, Zap, Image, Brain, Sparkles, FileText, AlertCircle, Search, ChevronRight, ChevronDown, ChevronUp, Eye, EyeOff, ExternalLink, Plug, MessageCircle, MessageSquare, Mail, Wrench, Palette, Rocket, Box, Info, ArrowUpCircle, Type, Keyboard, Trash, ClipboardCheck, BookOpen, CalendarDays, Gauge, Globe, FolderOpen, Bell, RefreshCw, RotateCcw, Mic, Network, Archive } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Callout } from '@/components/ui/callout';
import { Chip } from '@/components/ui/chip';
import { Badge } from '@/components/ui/badge';
import {
  PROVIDER_PRESETS,
  PROVIDER_VENDOR,
  VENDOR_BADGE_STYLE,
  sanitizeBaseUrl,
  type ProviderConfig,
  type ProviderType,
  type SelectedModel,
  type SearchConfig,
  type ModelSpec,
} from '@/lib/types';
import {
  loadSettings,
  updateSettingsFields,
  migrateOldSettingsIfNeeded,
  applyTheme,
  applyFontScale,
  getQuickPrompts,
  updateQuickPrompts,
  type AppSettings,
  type QuickPrompt,
} from '@/lib/settings';
import { inferModelSpec } from '@/lib/model-matcher';
import { VISION_MODEL_PATTERN, OCR_MODEL_PATTERN, MODEL_VENDOR_PATTERNS, normalizeVendorName, isTtsModel } from '@/lib/model-tags';
import { TemplateLibraryModal } from './TemplateLibraryModal';
import { WechatBindModal } from './WechatBindModal';
import { FeishuBindModal } from './FeishuBindModal';
import { MailBindModal } from './MailBindModal';
import { UsagePanel } from './UsagePanel';
import { ToggleSwitch } from './ToggleSwitch';
import { LocalSttPanel } from './LocalSttPanel';
import { LocalTtsPanel, type LocalTtsEngine } from './LocalTtsPanel';
import {
  DEFAULT_NAMING,
  PAD_OPTIONS,
  SEPARATOR_OPTIONS,
  SLOTS,
  SLOT_LABELS,
  isDefaultNaming,
  normalizeNaming,
  previewName,
  setSlotAt,
  todayStamp,
  type NameSlot,
  type NamingRule,
} from '@/lib/file-organizer/naming-rule';
import { desktop } from '@/lib/desktop-adapter';
import { notifyBrandLogoChanged } from './canvasHooks';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigsChange: (configs: ProviderConfig[]) => void;
  /** 打开时聚焦的区块（'chat' | 'roles' | 'icons' | 'theme' | 'diagram'），缺省 'chat' */
  initialSection?: 'chat' | 'roles' | 'icons' | 'theme' | 'diagram';
}

interface FetchedModel {
  modelId: string;
  ownedBy: string;
  /** 真实来源厂商（千问/DashScope 聚合平台下由模型 id 推断，如 DeepSeek/GLM/Kimi/MiniMax/Qwen） */
  vendor?: string;
  thinking: boolean;
  category: 'chat' | 'embedding' | 'vision' | 'ocr' | 'audio' | 'image' | 'rerank' | 'other';
  spec?: ModelSpec;
}

interface ModelDetailState {
  [key: string]: boolean;
}

/** API Key 获取地址（每个厂商） */
const PROVIDER_KEY_URLS: Record<ProviderType, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  glm: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshot: 'https://platform.moonshot.cn/docs/intro#%E4%B8%AD%E7%94%B3%E6%96%87%E6%A1%A3',
  qwen: 'https://dashscope.console.aliyun.com/apiKey',
  openai: 'https://platform.openai.com/api-keys',
  doubao: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  agentplan: 'https://www.volcengine.com/product/agent-plan',
  codingplan: 'https://www.volcengine.com/product/code-plan',
  // Ollama 本地服务无需 API Key，链接指向下载页/官网
  ollama: 'https://ollama.com',
  // BobMultimodal 本地多模态服务：无鉴权，链接指向本地服务状态页
  bobmultimodal: 'http://127.0.0.1:8080/api/status',
};

/** 绑定模式：通用（Fetch 自动发现）/ 混合（Fetch + 手动）/ 自定义（仅手动 Bind）/ 专用协议（非模型） */
type BindingMode = 'fetch' | 'hybrid' | 'custom' | 'dedicated';

/** 基于 PROVIDER_PRESETS（ProviderType 真源）构造所有 ProviderRecord，避免每加厂商改 N 处。 */
function buildProviderRecord<T>(factory: (type: ProviderType) => T): Record<ProviderType, T> {
  return PROVIDER_PRESETS.reduce((acc, preset) => {
    acc[preset.type] = factory(preset.type);
    return acc;
  }, {} as Record<ProviderType, T>);
}

/** Provider 绑定模式（决定 UI 区块 & 流程说明） */
const PROVIDER_BINDING_MODE: Record<ProviderType, BindingMode> = {
  deepseek: 'fetch',
  glm: 'fetch',
  moonshot: 'fetch',
  qwen: 'fetch',
  openai: 'fetch',
  doubao: 'fetch',
  siliconflow: 'fetch',
  // Agent Plan 官方订阅：不支持 /models 列表接口，手动 Add 添加模型
  agentplan: 'custom',
  // Coding Plan 官方订阅：同为订阅网关，手动 Add 添加模型
  codingplan: 'custom',
  // Ollama 本地模型：/v1/models 自动发现
  ollama: 'fetch',
  // BobMultimodal 本地多模态：/v1/models 自动发现（模型默认清空，由用户手动绑定）
  bobmultimodal: 'fetch',
};

const BINDING_MODE_LABEL: Record<BindingMode, string> = {
  fetch: 'Generic',
  hybrid: 'Hybrid',
  custom: 'Custom',
  dedicated: 'Dedicated',
};

const BINDING_MODE_STYLE: Record<BindingMode, { bg: string; fg: string }> = {
  fetch:    { bg: 'color-mix(in srgb, var(--info) 14%, transparent)',      fg: 'var(--info)' },
  hybrid:   { bg: 'color-mix(in srgb, var(--warning) 14%, transparent)',   fg: 'var(--warning)' },
  custom:   { bg: 'color-mix(in srgb, var(--primary) 14%, transparent)',   fg: 'var(--primary-strong)' },
  dedicated:{ bg: 'color-mix(in srgb, var(--ink-muted) 14%, transparent)', fg: 'var(--ink-muted)' },
};

/** 本地无鉴权厂商（BobMultimodal / Ollama）：无需 API Key，连接验证与模型列表拉取跳过 Key 校验 */
const NO_AUTH_LOCAL_PROVIDERS = new Set<ProviderType>(['bobmultimodal', 'ollama']);

/** BobMultimodal（Qwen3-TTS CustomVoice）的固定音色枚举，与服务端 GET /api/tts/voices 一致；传枚举外的值会 500 */
const BOBMULTIMODAL_TTS_VOICES = ['serena', 'vivian', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan'] as const;
/** 该厂商的服务端默认音色（voice 留空时引擎侧回落到它，见 lib/tts 的 TTS_PROVIDER_PRESETS） */
const BOBMULTIMODAL_DEFAULT_VOICE = 'vivian';

/** Provider 侧栏分组（视觉分组，不影响类型真源） */
const PROVIDER_SIDEBAR_GROUPS: Array<{ label: string; types: ProviderType[] }> = [
  { label: 'Mainland China', types: ['deepseek', 'glm', 'moonshot', 'qwen', 'siliconflow'] },
  { label: 'Volcengine Ark', types: ['doubao', 'agentplan', 'codingplan'] },
  { label: 'Others', types: ['openai', 'ollama', 'bobmultimodal'] },
];

/** 标题标签（已去除弹窗功能，仅渲染标题文本） */
function HintLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  icon?: boolean;
}) {
  return <span className={className || ''}>{children}</span>;
}

/** 用途标签（模型池统一仓库）：把 FetchedModel.category 映射为角色用途。
 *  chat=Chat / stt=STT / tts=TTS / image=Image / ocr=OCR（vision 角色已随视觉模型配置一并移除，由 bob-ocr-mcp 插件管理） */
type ModelPurpose = 'chat' | 'stt' | 'tts' | 'image' | 'ocr';

/** category + 模型名 → 用途。audio 是「识别 + 合成」混合分类，须按模型名再分：
 *  命中 TTS 关键词归 tts，其余归 stt——否则 TTS 模型会混进 STT 角色候选池（反之亦然）。 */
function categoryToPurpose(model: Pick<FetchedModel, 'category' | 'modelId'>): ModelPurpose | undefined {
  switch (model.category) {
    case 'chat': return 'chat';
    case 'ocr': return 'ocr';
    case 'audio': return isTtsModel(model.modelId) ? 'tts' : 'stt';
    case 'image': return 'image';
    case 'other': return 'image';
    default: return undefined; // vision / embedding / rerank 不参与角色
  }
}

const PURPOSE_TAG: Record<ModelPurpose, { label: string; bg: string; fg: string }> = {
  chat: { label: 'Chat', bg: 'var(--primary-soft)', fg: 'var(--primary-strong)' },
  stt: { label: 'STT', bg: 'var(--purple-soft)', fg: 'var(--purple)' },
  tts: { label: 'TTS', bg: 'var(--info-soft)', fg: 'var(--info)' },
  image: { label: 'Image', bg: 'var(--warn-soft)', fg: 'var(--warn)' },
  ocr: { label: 'OCR', bg: 'var(--success-soft)', fg: 'var(--success)' },
};

/** 按模型名关键词推断分类（与 /api/models 的 NON_CHAT_PATTERNS 共用 model-tags 单一来源，用于加载时恢复分类） */
function inferModelCategory(modelId: string): FetchedModel['category'] {
  const id = modelId.toLowerCase();
  // OCR 专用模型优先：它们只能转录文字，不能作为通用视觉模型（qwen-vl-ocr 同时含 vl 与 ocr）
  if (OCR_MODEL_PATTERN.test(id)) return 'ocr';
  if (VISION_MODEL_PATTERN.test(id)) return 'vision';
  if (/embedding|bge-/i.test(id)) return 'embedding';
  if (/tts|asr|whisper|speech|qwen-audio/i.test(id)) return 'audio';
  if (/dall-?e|qwen-image|wan[.\-]?2|wan[.\-]?3|z-image|flux|sdxl|stable-diffusion|image-2[.\-]|image-3[.\-]|seedream|seededit|image-edit|gpt-image|kolors|imagen|cogview|midjourney|recraft|hunyuan-image|sensecog/i.test(id)) return 'image';
  if (/moderation/i.test(id)) return 'other';
  if (/rerank/i.test(id)) return 'rerank';
  return 'chat';
}

/** 按模型 id 前缀/关键词推断真实来源厂商（千问/DashScope 是模型大融合聚合平台，owned_by 常为 system） */
function inferModelVendor(modelId: string): string {
  const id = modelId.toLowerCase();
  const hit = MODEL_VENDOR_PATTERNS.find((p) => p.pattern.test(id));
  return hit ? hit.vendor : '';
}

/** 模型拉取错误的友好提示：识别 401/403 等鉴权失败，直接引导用户去对应平台获取 API Key */
function friendlyModelFetchError(status: number, raw: string, provider: string): string {
  const apiMsg = (raw.match(/"message"\s*:\s*"([^"]*)"/)?.[1] || raw || '').slice(0, 150);
  const isAuthError =
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|permission|invalid.{0,12}key|api key (doesn'?t exist|not found|is incorrect|format is incorrect)|access.{0,10}(denied|forbidden)/i.test(raw);
  if (isAuthError) {
    const hintByProvider: Record<string, string> = {
      doubao: 'Get a new API Key in the Volcengine Ark console (console.volcengine.com/ark → API Key Management) and re-enter it',
      'doubao-stream': 'Get a new API Key in the Volcengine Ark console (console.volcengine.com/ark → API Key Management) and re-enter it',
      agentplan: 'Use the Agent Plan dedicated API Key (do not mix with other Ark platform keys) — get it in the Agent Plan console',
      codingplan: 'Use the Coding Plan dedicated API Key (do not mix with other Ark platform keys) — get it in the Coding Plan console',
      openai: 'Generate a new API Key at platform.openai.com/api-keys and re-enter it',
      qwen: 'Get an API Key at dashscope.console.aliyun.com/apiKey and re-enter it',
      dashscope: 'Get an API Key at dashscope.console.aliyun.com/apiKey and re-enter it',
      siliconflow: 'Get an API Key at cloud.siliconflow.cn/account/ak and re-enter it',
    };
    const hint = hintByProvider[provider] || 'Check that the API Key is correct (it may be mistyped, expired, or from another platform)';
    return `Invalid or missing API Key (${apiMsg || `HTTP ${status}`}). ${hint}.`;
  }
  return `API returned ${status}: ${apiMsg}`;
}

/** 厂商徽标配色（模型大融合：千问/DashScope 聚合的多家厂商）已移至 lib/types.ts 统一导出 */

export function SettingsModal({
  open,
  onOpenChange,
  onConfigsChange,
  initialSection,
}: SettingsModalProps) {
  // 初始区块 ref（外层通过 open-settings 事件指定聚焦区块，仅打开瞬间生效）
  const initialSectionRef = useRef<'chat' | 'roles' | 'icons' | 'theme' | 'diagram' | undefined>(initialSection);
  initialSectionRef.current = initialSection;
  // ===================== state =====================
  // 基于 PROVIDER_PRESETS 自动生成，扩展 provider 无需改此处
  const [apiKeys, setApiKeys] = useState<Record<ProviderType, string>>(() =>
    buildProviderRecord(() => ''),
  );
  // 自定义 baseUrl（每个厂商独立，空字符串=用默认）
  const [customBaseUrls, setCustomBaseUrls] = useState<Record<ProviderType, string>>(() =>
    buildProviderRecord(() => ''),
  );
  const [keyVisible, setKeyVisible] = useState<Record<ProviderType, boolean>>(() =>
    buildProviderRecord(() => false),
  );
  const [selectedModels, setSelectedModels] = useState<Record<ProviderType, Set<string>>>(() =>
    buildProviderRecord(() => new Set<string>()),
  );
  const [fetchedModels, setFetchedModels] = useState<Record<ProviderType, FetchedModel[]>>(() =>
    buildProviderRecord<FetchedModel[]>(() => []),
  );
  const [testing, setTesting] = useState<Record<ProviderType, boolean>>(() =>
    buildProviderRecord(() => false),
  );
  const [testError, setTestError] = useState<Record<ProviderType, string>>(() =>
    buildProviderRecord(() => ''),
  );
  const [testSuccess, setTestSuccess] = useState<Record<ProviderType, { msg: string; count: number } | null>>(() =>
    buildProviderRecord(() => null),
  );
  // 保存状态：设置已改为「改动即自动保存」，无 Save 按钮（idle=无提示 / saving / saved / error）
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  // 单模型添加验证中（勾选 / Add 时的连接测试），驱动 spinner 与防重复点击
  const [verifyingModelId, setVerifyingModelId] = useState<string | null>(null);
  // 统一导航：左栏目录选中项，右栏显示对应面板
  const [activeSection, setActiveSection] = useState<'chat' | 'roles' | 'web' | 'icons' | 'theme' | 'diagram' | 'quickprompts' | 'templates' | 'wechat' | 'feishu' | 'mail' | 'usage' | 'browser' | 'fileorganizer' | 'butlernotify' | 'remote'>('roles');
  // Hippo Browser：清除 Cookies 按钮状态
  const [browserClearBusy, setBrowserClearBusy] = useState(false);
  const [browserClearMsg, setBrowserClearMsg] = useState('');
  const [browserClearErr, setBrowserClearErr] = useState(false);
  // AI Browser 开关：开 = 任务执行只走应用内 Hippo（内置 browser_*），关 = 只走 Bob Browser 扩展通道
  const [aiBrowserHippo, setAiBrowserHippo] = useState(false);
  // 浏览器侧栏工具面：true = Core（默认，快），false = Full（全部浏览器工具）
  const [browserToolsetCore, setBrowserToolsetCore] = useState(true);
  // 文件自动整理投递箱：本地编辑态，改动后随自动保存落盘
  const [fileOrgEnabled, setFileOrgEnabled] = useState(false);
  const [fileOrgDir, setFileOrgDir] = useState('');
  const [fileOrgCategories, setFileOrgCategories] = useState<string[]>([]);
  const [fileOrgCategoryInput, setFileOrgCategoryInput] = useState('');
  const [fileOrgAutoCreate, setFileOrgAutoCreate] = useState(false);
  const [fileOrgPickErr, setFileOrgPickErr] = useState('');
  // 命名规则（受控选项：字段顺序 / 分隔符 / 版本号补零）
  const [fileOrgNaming, setFileOrgNaming] = useState<NamingRule>(DEFAULT_NAMING);

  // ---- File Organizer 运行状态（历史 / 失败原因 / 重试）：数据源见 /api/core/file-organizer ----
  type FoPendingItem = {
    name: string; path: string; size: number; mtime: string;
    failure: string; attempts: number; method: string; model: string; updatedAt: string;
  };
  type FoHistoryItem = {
    at: string; from: string; category: string; topic: string; version: string;
    verdict: string; note: string; model: string;
    tokens?: { prompt: number; completion: number; reasoning: number }; retries?: number;
  };
  const [foRuntime, setFoRuntime] = useState<{
    configured: boolean; enabled: boolean; root: string;
    categories: string[]; existing: string[]; pending: FoPendingItem[]; history: FoHistoryItem[];
  } | null>(null);
  const [foRuntimeLoading, setFoRuntimeLoading] = useState(false);
  const [foRuntimeErr, setFoRuntimeErr] = useState('');
  const [foRetrying, setFoRetrying] = useState('');
  // Butler 推送克制（B5）：免打扰时段 / 单日上限；本地编辑态，改动随自动保存落盘。
  // 口径见 lib/core/quiet-hours.ts —— 用户自订日历提醒永不被静默，只受单日上限。
  const [bnEnabled, setBnEnabled] = useState(true);
  const [bnQuietStart, setBnQuietStart] = useState('22:00');
  const [bnQuietEnd, setBnQuietEnd] = useState('08:00');
  const [bnDailyLimit, setBnDailyLimit] = useState('6');
  const [bnLimitErr, setBnLimitErr] = useState('');

  // 远程访问鉴权：手机经私有隧道远程操作本机 BobWork；桌面 localhost 豁免。
  const [raEnabled, setRaEnabled] = useState(false);
  const [raToken, setRaToken] = useState('');
  const [raMode, setRaMode] = useState<'loopback-exempt' | 'strict'>('loopback-exempt');
  const [raBusy, setRaBusy] = useState(false);
  const [raMsg, setRaMsg] = useState('');

  const loadRemoteAccess = useCallback(async () => {
    try {
      const r = await fetch('/api/remote-access');
      if (r.ok) {
        const d = await r.json();
        setRaEnabled(!!d.enabled);
        setRaToken(d.token || '');
        setRaMode(d.mode === 'strict' ? 'strict' : 'loopback-exempt');
      }
    } catch {
      /* 忽略读取失败 */
    }
  }, []);

  useEffect(() => {
    loadRemoteAccess();
  }, [loadRemoteAccess]);

  const applyRemoteAccess = useCallback(async (action: 'enable' | 'disable' | 'rotate') => {
    setRaBusy(true);
    setRaMsg('');
    try {
      const r = await fetch('/api/remote-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error('request failed');
      const d = await r.json();
      setRaEnabled(!!d.enabled);
      setRaToken(d.token || '');
      setRaMode(d.mode === 'strict' ? 'strict' : 'loopback-exempt');
      setRaMsg(action === 'disable' ? 'Remote access disabled' : 'Updated. Enter the Token in the mobile app.');
    } catch {
      setRaMsg('Operation failed. Please try again.');
    } finally {
      setRaBusy(false);
    }
  }, [raEnabled]);

  const setRemoteMode = useCallback(async (mode: 'loopback-exempt' | 'strict') => {
    setRaBusy(true);
    try {
      const r = await fetch('/api/remote-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setMode', mode }),
      });
      if (r.ok) {
        const d = await r.json();
        setRaMode(d.mode === 'strict' ? 'strict' : 'loopback-exempt');
      }
    } finally {
      setRaBusy(false);
    }
  }, [raMode]);

  const handleClearBrowserCookies = useCallback(async () => {
    setBrowserClearBusy(true);
    setBrowserClearMsg('');
    setBrowserClearErr(false);
    try {
      const r = await desktop.hippoBrowser.clearCookies();
      if (r.ok) {
        setBrowserClearErr(false);
        setBrowserClearMsg(`Cleared Hippo Browser site data${typeof r.clearedCount === 'number' ? ` (${r.clearedCount} cookies)` : ''}`);
      } else {
        setBrowserClearErr(true);
        setBrowserClearMsg(r.error || 'Failed to clear');
      }
    } catch (e) {
      setBrowserClearErr(true);
      setBrowserClearMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserClearBusy(false);
    }
  }, []);

  /** 选择投递箱目录（Electron 原生目录对话框；浏览器环境不可用） */
  const handlePickInboxDir = useCallback(async () => {
    setFileOrgPickErr('');
    try {
      const r = await desktop.selectDirectory();
      if (r.canceled) return;
      if (!r.success || !r.path) {
        setFileOrgPickErr(r.error || 'Unable to open the folder picker (desktop only)');
        return;
      }
      setFileOrgDir(r.path);
    } catch (e) {
      setFileOrgPickErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  /** 拉取整理运行状态（待处理清单 + 最近记录）：打开 File Organizer 面板 / 重试后调用 */
  const refreshFoRuntime = useCallback(async () => {
    setFoRuntimeLoading(true);
    setFoRuntimeErr('');
    try {
      const r = await fetch('/api/core/file-organizer', { cache: 'no-store' });
      const data = (await r.json()) as {
        ok?: boolean; configured?: boolean; enabled?: boolean; root?: string;
        categories?: string[]; existing?: string[];
        pending?: FoPendingItem[]; history?: FoHistoryItem[]; error?: string;
      };
      if (!data?.ok) throw new Error(data?.error || 'failed to load organizer status');
      setFoRuntime({
        configured: data.configured === true,
        enabled: data.enabled === true,
        root: data.root ?? '',
        categories: data.categories ?? [],
        existing: data.existing ?? [],
        pending: data.pending ?? [],
        history: data.history ?? [],
      });
    } catch (e) {
      setFoRuntimeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFoRuntimeLoading(false);
    }
  }, []);

  /** 重试：把 _待处理 里的文件搬回投递箱并清掉失败指纹，watcher 下一轮会重新判定 */
  const handleRetryPending = useCallback(async (path?: string) => {
    setFoRetrying(path || '*');
    setFoRuntimeErr('');
    try {
      const r = await fetch('/api/core/file-organizer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', path }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; moved?: number };
      if (!data?.ok) throw new Error(data?.error || 'retry failed');
      await refreshFoRuntime();
    } catch (e) {
      setFoRuntimeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFoRetrying('');
    }
  }, [refreshFoRuntime]);

  // 切到 File Organizer 分区时拉一次运行状态（重试按钮挂在设置面板里，随面板打开刷新）
  useEffect(() => {
    if (!open || activeSection !== 'fileorganizer') return;
    void refreshFoRuntime();
  }, [open, activeSection, refreshFoRuntime]);

  // Model Pool 以独立弹窗方式打开（从 Role Assignment 的按钮进入，左侧导航不再包含该项）
  const [modelPoolOpen, setModelPoolOpen] = useState(false);
  // 默认保存目录已固定为内置 BobWorkspace（~/BobWork/BobWorkspace），不提供自定义存储位置
  // 架构图全屏放大
  const [diagramZoom, setDiagramZoom] = useState(false);
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ apiKey: '', baseUrl: '' });
  // 联网搜索/抓取 provider（与聊天模型解耦）
  const [webSearchProvider, setWebSearchProvider] = useState('deepseek-search-api');
  const [webFetchProvider, setWebFetchProvider] = useState('deepseek-fetch-api');
  const [expandedModels, setExpandedModels] = useState<ModelDetailState>({});

  // 自动保存：debounce 计时器 + 「正在写盘」单飞标记（写盘期间不并发写同一 settings.json）
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveQueuedRef = useRef(false);
  // 始终指向最新一次渲染的保存实现，供 debounce / 补写调用，避免闭包内表单值过期
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRef = useRef(true);
  // Theme → Keyboard Shortcuts（只读清单，可折叠，默认折叠）
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // 角色派发区块折叠状态（默认全部折叠，点击标题展开/收起）
  const [rolesCollapsed, setRolesCollapsed] = useState<Record<string, boolean>>({
    chat: true, ocr: true, stt: true, image: true, task: true, outcome: true, tts: true,
  });
  // 模型管理界面单一真源：pickerSide = 当前选中厂商（selectedChatProvider 即它本身）
  const [pickerSide, setPickerSide] = useState<ProviderType>('deepseek');
  // 聊天气泡 / settings 里的「当前聊天厂商」（单一来源 = pickerSide）
  const selectedChatProvider: ProviderType = pickerSide;
  // 兼容旧调用点（极少位置需要主动设置聊天厂商→走派生源头）
  const setSelectedChatProvider = (value: ProviderType | ((prev: ProviderType) => ProviderType)) => {
    setPickerSide((prevSide) => {
      if (typeof value === 'function') return value(prevSide);
      return value;
    });
  };

  const toggleRoleSection = (key: string) =>
    setRolesCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  // 模型搜索 + 分类过滤（当前选中的聊天厂商）
  const [modelSearch, setModelSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'chat' | 'vision' | 'ocr' | 'audio' | 'other'>('all');
  // Agent Plan / Coding Plan 填表配置：模型 ID 手填输入框（Add 后进入候选清单并勾选），两者共用（同一时刻只显示一个 hybrid provider）
  const [planModelInput, setPlanModelInput] = useState('');
  // 统一模型 ID 输入框（所有厂商通用，Test & Add 流程使用）
  const [newModelIdInput, setNewModelIdInput] = useState('');
  // Test & Add 结果反馈
  const [testAddFeedback, setTestAddFeedback] = useState<{ provider: ProviderType; ok: boolean; msg: string } | null>(null);
  const [customBaseUrlMode, setCustomBaseUrlMode] = useState<Record<ProviderType, boolean>>(() =>
    buildProviderRecord(() => false),
  );


  // 模型分类覆盖（L3）：用户纠正自动分类，写入 settings.modelOverrides，运行时优先于命名正则
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});

  /** 纠正某模型的分类（''/auto = 清除覆盖回到自动推断）；同时同步 fetchedModels 让徽标/筛选即时生效 */
  const setModelOverride = (modelId: string, cat: string) => {
    setModelOverrides((prev) => {
      const next = { ...prev };
      if (!cat || cat === 'auto') delete next[modelId];
      else next[modelId] = cat;
      return next;
    });
    setFetchedModels((prev) => {
      const next: Record<ProviderType, FetchedModel[]> = { ...prev };
      (Object.keys(next) as ProviderType[]).forEach((t) => {
        next[t] = next[t].map((m) =>
          m.modelId === modelId
            ? { ...m, category: (!cat || cat === 'auto' ? inferModelCategory(modelId) : cat) as FetchedModel['category'] }
            : m,
        );
      });
      return next;
    });
  };

  // 模型管理（Model Pool）已作为设置弹窗的一级 section 内联渲染，不再使用独立 overlay 弹窗

  // 主对话模型（Role Assignment 指定）
  // - selectedChatModel：旧配置残留（历史"星标"模型，UI 已无标星入口，仅读取；空 = 用候选池首个）
  // - chatModelPool：主对话候选池（多个模型，自动并入厂商勾选，进入节点模型选择）
  const [selectedChatModel, setSelectedChatModel] = useState<string>('');
  const [chatModelPool, setChatModelPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  // Auto 模式「带图 → 优先视觉模型」开关（缺省开；true 对齐后端 isVisionModel 直连语义）
  const [chatAutoVisionOnImage, setChatAutoVisionOnImage] = useState<boolean>(true);

  // STT
  const [sttProvider, setSttProvider] = useState<'doubao-stream' | 'doubao' | 'dashscope' | 'siliconflow' | 'openai'>('doubao-stream');
  const [sttModel, setSttModel] = useState<string>('');
  // STT 候选池（与 Chat 统一：首个 model 为活动模型）
  const [sttPool, setSttPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  // 本地离线 STT（sherpa-onnx）：与云端**互斥单选**——非空即"本地模型为当前引擎"，空 = 未选本地
  const [localSttModel, setLocalSttModel] = useState<string>('');
  // 引擎互斥：往云端池加模型 → 清掉本地选择；选中本地模型 → 清空云端池（保存时据此决定 provider）
  const setSttPoolExclusive = (next: Array<{ provider: string; modelId: string }>) => {
    setSttPool(next);
    if (next.length > 0) setLocalSttModel('');
  };
  const selectLocalSttModel = (id: string) => {
    setLocalSttModel(id);
    if (id) setSttPool([]);
  };

  // TTS（语音合成，B4）：与 STT 同款——云端池与本地引擎互斥单选；音色/语速为云端补充字段
  const [ttsPool, setTtsPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  const [ttsVoice, setTtsVoice] = useState<string>('');
  const [ttsSpeed, setTtsSpeed] = useState<string>('');
  // 本地引擎二态：'' = 云端池；'sherpa-local' = 离线神经模型
  const [ttsLocalEngine, setTtsLocalEngine] = useState<LocalTtsEngine>('');
  // 本地引擎的独立参数（保存时只写当前引擎那份）
  const [ttsLocalModel, setTtsLocalModel] = useState<string>('');   // 离线神经模型 id
  // 零样本克隆（ZipVoice）的参考音：绝对路径 + 与之逐字一致的文本
  const [ttsLocalRefAudio, setTtsLocalRefAudio] = useState<string>('');
  const [ttsLocalRefText, setTtsLocalRefText] = useState<string>('');
  // 多音色预置模型的音色 id；'' = 用模型首条
  const [ttsLocalVoice, setTtsLocalVoice] = useState<string>('');
  // 引擎互斥：往云端池加模型 → 取消本地选择；选中本地引擎 → 清空云端池
  const setTtsPoolExclusive = (next: Array<{ provider: string; modelId: string }>) => {
    setTtsPool(next);
    if (next.length > 0) setTtsLocalEngine('');
  };
  const selectTtsEngine = (next: LocalTtsEngine) => {
    setTtsLocalEngine(next);
    if (next) setTtsPool([]);
  };

  // 图像编辑（Image Edit）：独立配置（图像编辑走 images API，与聊天模型不同形态）
  const [imageEditProvider, setImageEditProvider] = useState<'openai' | 'doubao' | 'qwen' | 'siliconflow' | 'bobmultimodal' | 'ollama'>('doubao');
  const [imageEditModel, setImageEditModel] = useState<string>('');
  // 已选模型 chips（同 Key 下多选，标题旁展示；ImageAiEditor 下拉候选 + 路由 fallback 依据）
  const [imageEditSelectedModels, setImageEditSelectedModels] = useState<string[]>([]);
  // 图像编辑候选池（与 Chat 统一：首个 model 为活动模型）
  const [imagePool, setImagePool] = useState<Array<{ provider: string; modelId: string }>>([]);

  // 任务模型（Task Model）：通用层，任务摘要/会议纪要/日程解析/AI 字段抽取等轻量任务（singleSelect）
  const [taskModelPool, setTaskModelPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  // 成果块模型（Outcome Model）：成果块（法律引用）专属，默认跟随主对话（singleSelect）
  const [outcomeModelPool, setOutcomeModelPool] = useState<Array<{ provider: string; modelId: string }>>([]);

  // 头像设置
  const [avatarMode, setAvatarMode] = useState<'random' | 'fixed'>('random');
  const [avatarSelected, setAvatarSelected] = useState<string>('');
  const [avatarList, setAvatarList] = useState<Array<{ id: string; name: string; dataUrl: string; builtin: boolean }>>([]);
  const [avatarAdding, setAvatarAdding] = useState(false);
  // 侧边栏品牌 logo（独立于欢迎头像选择）
  const [brandLogo, setBrandLogo] = useState<string>('');
  // 界面主题
  const [theme, setTheme] = useState<string>('warm');
  // 全局字号档位（'m' | 'l' | 'xl'，undefined = 'l' 默认）
  const [fontScale, setFontScale] = useState<'m' | 'l' | 'xl'>('l');
  // 思考档位策略开关（settings.thinking）：缺省均 true（harnessPure 默认=纯 DSH 固定档），
  // 与后端/默认设置语义一致（draft 加载时合并初始化）
  const [thinkingPolicy, setThinkingPolicy] = useState<{ harnessPure: boolean; downgradeOnExecution: boolean; trivialPromptOff: boolean }>({
    harnessPure: true,
    downgradeOnExecution: true,
    trivialPromptOff: true,
  });
  // Chat Model 卡片的高级区折叠（默认折叠；内含思考档位策略，仅在 harnessPure 关掉时才用得上）
  const [chatAdvancedOpen, setChatAdvancedOpen] = useState(false);
  // 左栏导航搜索词（P3）
  const [navQuery, setNavQuery] = useState<string>('');
  // 快捷指令全局库（Quick Prompts 页签：集中管理，节点按 id 选用）
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);
  /** 快捷指令新建/编辑草稿：null=关闭；mode='new' 新建；mode='edit' 编辑（含 id） */
  const [qpEditor, setQpEditor] = useState<{ mode: 'new' | 'edit'; id?: string; name: string; content: string; category: string } | null>(null);
  /** 快捷指令按分类筛选：'all' = 全部 */
  const [qpCategoryFilter, setQpCategoryFilter] = useState<string>('all');

  // 快捷指令可选分类去重列表 + 按分类过滤后的列表
  const qpCategories = useMemo(() => {
    const set = new Set<string>();
    quickPrompts.forEach((q) => { if (q.category) set.add(q.category); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [quickPrompts]);
  const filteredQuickPrompts = useMemo(() => {
    return qpCategoryFilter === 'all' ? quickPrompts : quickPrompts.filter((q) => q.category === qpCategoryFilter);
  }, [quickPrompts, qpCategoryFilter]);

  // 角色区块滚动锚点 ref
  const sttSectionRef = useRef<HTMLDivElement>(null);
  const imageEditSectionRef = useRef<HTMLDivElement>(null);

  // ===================== effects =====================
  useEffect(() => {
    if (open) {
      const load = async () => {
        // 整个回填过程都抑制自动保存：load 中间有 await，若中途解除抑制会把半加载的表单值写回盘
        isLoadingRef.current = true;
        const settings: AppSettings = await migrateOldSettingsIfNeeded() || await loadSettings();
        setSearchConfig(settings.search);
        setWebSearchProvider(settings.webSearch?.searchProvider ?? 'deepseek-search-api');
        setWebFetchProvider(settings.webSearch?.fetchProvider ?? 'deepseek-fetch-api');

        // 基于 PROVIDER_PRESETS 统一构造：扩展新 provider 时无需改此处
        const newKeys = buildProviderRecord(() => '');
        const newBaseUrls = buildProviderRecord(() => '');
        const newSelected = buildProviderRecord(() => new Set<string>());
        const newFetched = buildProviderRecord<FetchedModel[]>(() => []);
        const overrides = settings.modelOverrides || {};
        for (const cfg of settings.providers) {
          if (!(cfg.type in newKeys)) continue; // 兼容废弃 provider（未来可做迁移提示）
          newKeys[cfg.type] = cfg.apiKey;
          if (cfg.baseUrl) newBaseUrls[cfg.type] = sanitizeBaseUrl(cfg.baseUrl);
          newSelected[cfg.type] = new Set((cfg.selectedModels ?? []).map((s) => s.modelId));
          const saved = (cfg.selectedModels ?? []).map((s) => ({
            modelId: s.modelId,
            ownedBy: cfg.type,
            vendor: inferModelVendor(s.modelId),
            thinking: s.thinking,
            // L3：用户纠正的分类优先于命名推断
            category: (overrides[s.modelId] as FetchedModel['category']) || inferModelCategory(s.modelId),
          }));
          newFetched[cfg.type] = saved;
        }
        setModelOverrides(overrides);
        setApiKeys(newKeys);
        setCustomBaseUrls(newBaseUrls);
        setSelectedModels(newSelected);
        setFetchedModels(newFetched);
        setTestError(buildProviderRecord(() => ''));
        setTestSuccess(buildProviderRecord(() => null));
        setSaveStatus('idle');
        // Model Pool 不再是左侧 section：外部 initialSection='chat'（如节点模型选择器入口）改为弹窗方式打开
        const initSection = initialSectionRef.current;
        if (initSection === 'chat') {
          setActiveSection('roles');
          setModelPoolOpen(true);
        } else {
          setActiveSection(initSection || 'roles');
        }
        // 加载快捷指令全局库
        const qps = await getQuickPrompts();
        setQuickPrompts(qps);
        setQpEditor(null);

        if (settings.chatModel) {
          setSelectedChatModel(settings.chatModel.defaultModel || '');
          setChatModelPool(settings.chatModel.pool || []);
          setChatAutoVisionOnImage(settings.chatModel?.autoVisionOnImage !== false);
        }
        // 思考档位策略：settings.thinking 字段缺省均视为 true（与后端消费语义一致）
        const thinkingCfg = settings.thinking ?? {};
        setThinkingPolicy({
          harnessPure: thinkingCfg.harnessPure !== false,
          downgradeOnExecution: thinkingCfg.downgradeOnExecution !== false,
          trivialPromptOff: thinkingCfg.trivialPromptOff !== false,
        });
        // 笔记专属模型已随笔记系统拆分到 bob-notes-mcp 插件域（插件大脑自持模型配置），宿主不再维护
        if (settings.stt) {
          // 已知 STT 引擎白名单（本地 sherpa-local 由下方 localModel 分支单独承接）；
          // 不在表内的陈旧 provider 归一化为默认厂商，避免无效值沉淀
          const knownSttProviders = ['doubao-stream', 'doubao', 'dashscope', 'siliconflow', 'openai', 'bobmultimodal'];
          setSttProvider(knownSttProviders.includes(settings.stt.provider || '')
            ? (settings.stt.provider as typeof sttProvider)
            : 'doubao-stream');
          setSttModel(settings.stt.model || '');
          const sttPoolProv = settings.stt.provider === 'dashscope' ? 'qwen' : (settings.stt.provider === 'doubao-stream' || settings.stt.provider === 'doubao') ? 'doubao' : settings.stt.provider;
          setSttPool(settings.stt.pool?.length ? settings.stt.pool : (settings.stt.model ? [{ provider: (sttPoolProv as string) || 'qwen', modelId: settings.stt.model }] : []));
          setLocalSttModel(settings.stt.localModel || '');
        }
        if (settings.tts) {
          setTtsPool(settings.tts.pool?.length ? settings.tts.pool : (settings.tts.model ? [{ provider: settings.tts.provider || 'openai', modelId: settings.tts.model }] : []));
          setTtsVoice(settings.tts.voice || '');
          setTtsSpeed(typeof settings.tts.speed === 'number' ? String(settings.tts.speed) : '');
          // 本地引擎二态：provider 为本地标识时才算本地引擎
          const local = settings.tts.provider;
          setTtsLocalEngine(local === 'sherpa-local' ? local : '');
          setTtsLocalModel(settings.tts.localModel || '');
          setTtsLocalRefAudio(settings.tts.localRefAudio || '');
          setTtsLocalRefText(settings.tts.localRefText || '');
          setTtsLocalVoice(settings.tts.localVoice || '');
        }
        if (settings.imageEdit) {
          setImageEditProvider((settings.imageEdit.provider as typeof imageEditProvider) || 'doubao');
          setImageEditModel(settings.imageEdit.model || '');
          setImageEditSelectedModels(settings.imageEdit.selectedModels?.filter((s) => s.trim()) || []);
          setImagePool(settings.imageEdit.pool?.length ? settings.imageEdit.pool : (settings.imageEdit.model ? [{ provider: settings.imageEdit.provider || 'doubao', modelId: settings.imageEdit.model }] : []));
        }
        // 任务模型 / 成果块模型（分别单传给通用任务层与成果块专属层）
        if (settings.taskModel) {
          setTaskModelPool(settings.taskModel.pool?.length ? settings.taskModel.pool : (settings.taskModel.defaultModel ? [{ provider: (settings.taskModel.defaultProvider as string) || '', modelId: settings.taskModel.defaultModel }] : []));
        }
        if (settings.outcomeModel) {
          setOutcomeModelPool(settings.outcomeModel.pool?.length ? settings.outcomeModel.pool : (settings.outcomeModel.defaultModel ? [{ provider: (settings.outcomeModel.defaultProvider as string) || '', modelId: settings.outcomeModel.defaultModel }] : []));
        }
        // 头像设置
        setAvatarMode(settings.avatar?.mode ?? 'random');
        setAvatarSelected(settings.avatar?.selected ?? '');
        setBrandLogo(settings.brandLogo ?? '');
        setTheme(settings.theme ?? 'warm');
        setFontScale(settings.fontScale ?? 'l');
        // 文件自动整理投递箱
        const fo = settings.fileOrganizer ?? {};
        setFileOrgEnabled(fo.enabled === true);
        setFileOrgDir(fo.inboxDir ?? '');
        setFileOrgCategories(fo.categories ?? []);
        setFileOrgAutoCreate(fo.autoCreateCategories === true);
        setFileOrgNaming(normalizeNaming(fo.naming));
        setFileOrgCategoryInput('');
        setFileOrgPickErr('');
        // Butler 推送克制（B5）：缺省 = 开启（开箱即克制）；显式 enabled:false 才关
        const bn = settings.butlerNotify ?? {};
        setBnEnabled(bn.enabled !== false);
        setBnQuietStart(bn.quietStart ?? '22:00');
        setBnQuietEnd(bn.quietEnd ?? '08:00');
        setBnDailyLimit(String(typeof bn.dailyPushLimit === 'number' ? bn.dailyPushLimit : 6));
        setBnLimitErr('');
        // AI 浏览器通道（undefined = hippo，默认通道；仅显式 'chrome' 才显示为关）
        setAiBrowserHippo(settings.aiBrowser !== 'chrome');
        // 浏览器侧栏工具面（undefined = core，默认核心档；仅显式 full 才显示为全量）
        setBrowserToolsetCore(settings.browserToolset !== 'full');
        try {
          const api = (window as unknown as { api: { avatar: { list: () => Promise<Array<{ id: string; name: string; dataUrl: string; builtin: boolean }>> } } }).api;
          if (api?.avatar) {
            const avatars = await api.avatar.list();
            setAvatarList(avatars);
          }
        } catch { /* 非 Electron 环境无 avatar API */ }
      };
      const apply = () => load().then(() => {
        // 下一轮事件循环再解除抑制，确保上面所有 setState 批量完成后不会误触发自动保存
        setTimeout(() => { isLoadingRef.current = false; }, 0);
      });
      apply();
      // AI 对话配置工具写盘后自动刷新表单（仅弹窗打开时生效，关闭自动移除）。
      // 独立监听 app-config-changed：自身保存广播的 provider-configs-changed 不回灌刷新，
      // 避免把保存后的 Saved 状态覆盖掉。
      const handler = () => { apply(); };
      window.addEventListener('app-config-changed', handler);
      return () => window.removeEventListener('app-config-changed', handler);
    }
  }, [open]);

  // ===================== helpers =====================
  // 自动保存：依赖列表中的任一设置项变化后 debounce 500ms 落盘（加载/回填期间抑制）。
  // 依赖列表即「纳入自动保存的字段清单」；每次重跑先清掉上一轮计时器，天然实现 debounce。
  useEffect(() => {
    if (isLoadingRef.current) return;
    setSaveError('');
    setSaveStatus('saving');
    if (savedTimerRef.current) { clearTimeout(savedTimerRef.current); savedTimerRef.current = null; }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void saveRef.current();
    }, 500);
    return () => {
      if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    };
  }, [
    apiKeys, customBaseUrls, selectedModels, searchConfig,
    webSearchProvider, webFetchProvider,
    selectedChatModel, chatModelPool, chatAutoVisionOnImage,
    sttProvider, sttModel, sttPool, localSttModel,
    imageEditProvider, imageEditModel, imageEditSelectedModels, imagePool,
    taskModelPool, outcomeModelPool,
    ttsPool, ttsVoice, ttsSpeed, ttsLocalEngine, ttsLocalModel,
    ttsLocalRefAudio, ttsLocalRefText, ttsLocalVoice,
    // App Icons（欢迎窗口头像 / 侧边栏品牌 Logo；头像池增删走 Electron API 直接落盘，不需保存设置）
    avatarMode, avatarSelected, brandLogo,
    theme,
    thinkingPolicy,
    // 文件自动整理投递箱
    fileOrgEnabled, fileOrgDir, fileOrgCategories, fileOrgAutoCreate, fileOrgNaming,
    // Butler 推送克制（B5）
    bnEnabled, bnQuietStart, bnQuietEnd, bnDailyLimit,
    // AI 浏览器通道（开关切换 → 下一轮对话工具面自动按新通道裁剪）
    aiBrowserHippo,
    // 浏览器侧栏工具面（core / full，下一轮对话生效）
    browserToolsetCore,
    // 字体缩放（原先点击即独立落盘，现并入自动保存，避免与自动保存并发写同一 settings.json）
    fontScale,
  ]);

  // 组件卸载时清理定时器（本弹窗常驻挂载，关窗不卸载，故挂起的改动仍会落盘）
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  const resolveBaseUrl = (type: ProviderType): string => {
    // 清理误存的端点后缀（历史版本可能把完整 URL 如 .../images/generations 存进 Base URL），
    // 只保留网关根地址，避免拼接 /chat/completions 后变成 .../images/generations/chat/completions → 404
    const custom = sanitizeBaseUrl(customBaseUrls[type]);
    if (custom) return custom;
    return PROVIDER_PRESETS.find((p) => p.type === type)?.baseUrl || '';
  };

  /** OCR 凭据继承来源显示：显式厂商优先，否则按模型名前缀推断所在厂商 */
  const provKeyLabel = (prov: string, model: string): string => {
    const mLow = model.toLowerCase();
    const inferred = prov
      ? prov
      : mLow.startsWith('qwen') ? 'qwen'
      : mLow.startsWith('glm') ? 'glm'
      : mLow.startsWith('deepseek') ? 'deepseek'
      : mLow.startsWith('kimi') || mLow.startsWith('moonshot') ? 'moonshot'
      : mLow.startsWith('gpt') || /^o[134]/.test(mLow) ? 'openai'
      : mLow.startsWith('doubao') ? 'doubao'
      : '';
    if (inferred) return `Model Pool → ${PROVIDER_VENDOR[inferred as ProviderType] || inferred}`;
    return 'Not configured';
  };

  /** 单模型连接验证：发极简请求确认 API Key / Base URL / 模型名真实可用。
   * TRAE 式时机——在"添加模型到模型池"（勾选 / Add）那一刻验证，而非攒到保存时批量验证。
   * 图片生成模型（category='image'）走 images API，其余走 chat/completions（由 /api/test-model 分流）。 */
  const verifyModelConnection = async (type: ProviderType, modelId: string): Promise<{ ok: boolean; error?: string }> => {
    const apiKey = apiKeys[type].trim();
    if (!apiKey) return { ok: false, error: 'Please enter an API Key first' };
    const baseUrl = resolveBaseUrl(type);
    if (/[\u0080-\uFFFF]/.test(baseUrl)) return { ok: false, error: 'Base URL contains invalid characters' };
    try {
      const resp = await fetch('/api/test-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providers: [{ provider: type, apiKey, baseUrl, models: [modelId], category: fetchedModels[type]?.find((m) => m.modelId === modelId)?.category }],
        }),
      });
      const data = await resp.json().catch(() => ({}));
      const r = (data as { results?: Array<{ ok: boolean; error?: string }> }).results?.[0];
      return r ? { ok: r.ok, error: r.error } : { ok: resp.ok, error: `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** 模型列表勾选入口：新增勾选前先连接验证，通过才加入模型池；取消勾选直接移除，不验证 */
  const checkModelAdd = async (type: ProviderType, modelId: string) => {
    if (selectedModels[type].has(modelId)) {
      toggleModel(type, modelId);
      return;
    }
    setVerifyingModelId(modelId);
    setTestError((prev) => ({ ...prev, [type]: '' }));
    try {
      // 本地无鉴权厂商（BobMultimodal/Ollama）无需连接验证——后端调用失败时会给出明确报错
      const { ok, error } = NO_AUTH_LOCAL_PROVIDERS.has(type)
        ? { ok: true as const }
        : await verifyModelConnection(type, modelId);
      if (ok) {
        toggleModel(type, modelId);
      } else {
        setTestError((prev) => ({
          ...prev,
          [type]: `Model ${modelId} connection check failed; not added to Model Pool${error ? `: ${error}` : ''}`,
        }));
      }
    } finally {
      setVerifyingModelId(null);
    }
  };

  const toggleModel = (type: ProviderType, modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev[type]);
      next.has(modelId) ? next.delete(modelId) : next.add(modelId);
      return { ...prev, [type]: next };
    });
  };

  /** Agent Plan / Coding Plan 填表配置：手填模型 ID 直接加入候选清单并勾选（无需依赖 Fetch）。
   * 两订阅共用，provider 由调用方指定。添加前先做连接验证，通过才加入（TRAE 式）。 */
  const addPlanModel = async (provider: 'agentplan' | 'codingplan') => {
    const id = planModelInput.trim();
    if (!id) return;
    setVerifyingModelId(id);
    setTestError((prev) => ({ ...prev, [provider]: '' }));
    try {
      const { ok, error } = await verifyModelConnection(provider, id);
      if (!ok) {
        setTestError((prev) => ({
          ...prev,
          [provider]: `Model ${id} connection check failed; not added${error ? `: ${error}` : ''}`,
        }));
        return;
      }
      setSelectedModels((prev) => {
        const next = new Set(prev[provider]);
        next.add(id);
        return { ...prev, [provider]: next };
      });
      setFetchedModels((prev) => {
        if (prev[provider].some((m) => m.modelId === id)) return prev;
        return {
          ...prev,
          [provider]: [...prev[provider], {
            modelId: id,
            ownedBy: provider,
            vendor: inferModelVendor(id),
            thinking: true,
            category: inferModelCategory(id),
          }],
        };
      });
      setPlanModelInput('');
    } finally {
      setVerifyingModelId(null);
    }
  };

  /** 统一 Test & Add：所有厂商通用流程 — 填写 API Key + 模型 ID → 一键测试连接，通过后自动加入模型池。
   *  替代原"Fetch + 手动勾选"与"Add 按钮"的双路径，简化为单路径操作。 */
  const testAndAddModel = async (provider: ProviderType) => {
    const id = newModelIdInput.trim();
    if (!id) return;
    const apiKey = apiKeys[provider].trim();
    const preset = PROVIDER_PRESETS.find((p) => p.type === provider)!;

    // Ollama/BobMultimodal 本地服务无需 Key
    if (!apiKey && !NO_AUTH_LOCAL_PROVIDERS.has(provider)) {
      setTestAddFeedback({ provider, ok: false, msg: 'Please enter an API Key first' });
      return;
    }

    setVerifyingModelId(id);
    setTestAddFeedback(null);
    setTestError((prev) => ({ ...prev, [provider]: '' }));

    try {
      const { ok, error } = NO_AUTH_LOCAL_PROVIDERS.has(provider)
        ? { ok: true as const }
        : await verifyModelConnection(provider, id);

      if (!ok) {
        setTestAddFeedback({ provider, ok: false, msg: `Connection check failed${error ? `: ${error}` : ''}` });
        return;
      }

      // 测试通过 → 加入模型池并勾选
      setSelectedModels((prev) => {
        const next = new Set(prev[provider]);
        next.add(id);
        return { ...prev, [provider]: next };
      });
      setFetchedModels((prev) => {
        if (prev[provider]?.some((m) => m.modelId === id)) return prev;
        const isLocalNoAuth = NO_AUTH_LOCAL_PROVIDERS.has(provider);
        return {
          ...prev,
          [provider]: [
            ...(prev[provider] || []),
            {
              modelId: id,
              ownedBy: isLocalNoAuth ? provider : preset.type,
              vendor: inferModelVendor(id),
              thinking: true,
              category: inferModelCategory(id),
            },
          ],
        };
      });
      setTestAddFeedback({ provider, ok: true, msg: `Added ${id} to Model Pool` });
      setNewModelIdInput('');
    } finally {
      setVerifyingModelId(null);
    }
  };

  // 批量选择：按分类过滤后全选/反选/清空
  const applyBatchAction = (action: 'invert') => {
    const type = selectedChatProvider;
    const models = fetchedModels[type];
    if (!models.length) return;
    setSelectedModels((prev) => {
      const curr = new Set(prev[type]);
      models.forEach((m) => (curr.has(m.modelId) ? curr.delete(m.modelId) : curr.add(m.modelId)));
      return { ...prev, [type]: curr };
    });
  };

  // 一键清除当前厂商的所有模型选择
  const clearAllSelections = () => {
    setSelectedModels((prev) => ({ ...prev, [selectedChatProvider]: new Set() }));
  };

  // ===================== actions =====================
  const testConnection = async (type: ProviderType, preset: typeof PROVIDER_PRESETS[0]): Promise<boolean> => {
    // 外层兜底：无论是同步异常 / fetch 异常 / 非 JSON 响应 / 上游超时，都必须释放 isTesting，
    // 避免"Fetching..."卡住后按钮永远 disabled（用户感知为"输入 API 后获取按钮无法操作"）
    try {
      const apiKey = apiKeys[type].trim();
      // 本地无鉴权厂商（BobMultimodal/Ollama）无需 API Key
      if (!apiKey && !NO_AUTH_LOCAL_PROVIDERS.has(type)) return false;

      const baseUrl = resolveBaseUrl(type);
      if (/[\u0080-\uFFFF]/.test(baseUrl)) {
        setTestError((prev) => ({ ...prev, [type]: 'Request URL / Base URL contains invalid characters (e.g. non-ASCII). Fix it before fetching models.' }));
        return false;
      }

      setTesting((prev) => ({ ...prev, [type]: true }));
      setTestError((prev) => ({ ...prev, [type]: '' }));
      setTestSuccess((prev) => ({ ...prev, [type]: null }));

      // 前端请求侧也加 30s 绝对超时：后端即便因 thinking 探测或外部网络长时间挂起，
      // 前端也能自行释放按钮；同时部分网关（智谱/火山）在弱网环境下 fetch 可能久挂不抛
      let ctrl: AbortController | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timeoutId = setTimeout(() => ctrl?.abort(new DOMException('Aborted', 'AbortError')), 30000);
      }

      try {
        const resp = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: type,
            apiKey,
            baseUrl,
          }),
          signal: ctrl?.signal,
        });
        const data = await resp.json();

        if (!resp.ok) {
          setTestError((prev) => ({ ...prev, [type]: data.error || 'Connection failed' }));
          setFetchedModels((prev) => ({ ...prev, [type]: [] }));
          return false;
        }

        const models: FetchedModel[] = (data.models || []).map((m: { modelId: string; ownedBy?: string; vendor?: string; thinking?: boolean; type?: string }) => {
          const modelId = m.modelId;
          const thinking = m.thinking ?? true;
          const presetModel = preset.models.find((pm) => pm.modelId === modelId);
          let spec: ModelSpec | undefined = presetModel?.spec;
          if (!spec) spec = inferModelSpec(modelId, thinking);
          return {
            modelId,
            ownedBy: m.ownedBy || '',
            vendor: m.vendor || inferModelVendor(modelId),
            thinking,
            // L3：用户纠正的分类优先于 /api/models 返回的类型
            // 后端 image-gen → 前端 image 统一映射（避免 categoryToPurpose 不识别 image-gen）
            category: (modelOverrides[modelId] as FetchedModel['category']) || (m.type === 'image-gen' ? 'image' : m.type as FetchedModel['category']) || 'chat',
            spec,
          };
        });

        setFetchedModels((prev) => ({ ...prev, [type]: models }));
        setTestSuccess((prev) => ({
          ...prev,
          [type]: {
            msg: 'Connection OK',
            count: models.length,
          },
        }));
        return true;
      } catch (err) {
        // 区分：AbortError（前端 30s 超时兜底）给用户明确提示，其余归为网络失败
        const isAbort =
          (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && /abort|timeout/i.test(err.message));
        setTestError((prev) => ({
          ...prev,
          [type]: isAbort
            ? 'Request timed out (30s): automatically cancelled. Check your network or try again later.'
            : 'Network request failed',
        }));
        setFetchedModels((prev) => ({ ...prev, [type]: prev[type] ?? [] }));
        return false;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    } catch (syncErr) {
      // 同步入口 / 外层兜底（理论上不应触发，作为最终保险）
      const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
      setTestError((prev) => ({
        ...prev,
        [type]: msg && msg !== 'undefined' ? msg : 'Network request failed',
      }));
      return false;
    } finally {
      setTesting((prev) => ({ ...prev, [type]: false }));
    }
  };

  const handleSave = async () => {
    // 单飞：写盘期间又有新改动时先记账，本次写完后补一轮，避免并发写同一 settings.json 互相覆盖
    if (savingRef.current) { saveQueuedRef.current = true; return; }
    savingRef.current = true;
    setSaveStatus('saving');
    setSaveError('');
    try {
      const newConfigs: ProviderConfig[] = [];
      (Object.keys(apiKeys) as ProviderType[]).forEach((type) => {
        const key = apiKeys[type].trim();
        if (!key) return;
        const ids = Array.from(selectedModels[type]);
        const sel: SelectedModel[] = ids.map((id) => {
          const fetched = fetchedModels[type].find((m) => m.modelId === id);
          return {
            modelId: id,
            thinking: true,
            // 用途标签：按分类推断（chat/stt/image/ocr），角色区据此过滤
            purpose: fetched ? categoryToPurpose(fetched) : undefined,
          };
        });
        const baseUrl = sanitizeBaseUrl(customBaseUrls[type]) || undefined;
        newConfigs.push({ type, apiKey: key, selectedModels: sel, baseUrl });
      });

      const resolveRoleFromChat = (modelId: string): {
        provider: ProviderType; apiKey: string; baseUrl: string;
      } | null => {
        if (!modelId) return null;
        for (const cfg of newConfigs) {
          if (cfg.selectedModels?.some((m) => m.modelId === modelId)) {
            return {
              provider: cfg.type,
              apiKey: cfg.apiKey,
              baseUrl: cfg.baseUrl || (PROVIDER_PRESETS.find((p) => p.type === cfg.type)?.baseUrl || ''),
            };
          }
        }
        return null;
      };

      // 各角色候选池模型自动并入对应厂商勾选（进入节点模型选择列表，无需再去 Chat Models 手动勾选）
      const allRolePools = [
        ...chatModelPool,
      ];
      for (const item of allRolePools) {
        const cfg = newConfigs.find((c) => c.type === item.provider);
        if (cfg) {
          const existing = new Set((cfg.selectedModels || []).map((m) => m.modelId));
          if (!existing.has(item.modelId)) {
            const fetched = fetchedModels[item.provider as ProviderType]?.find((m) => m.modelId === item.modelId);
            cfg.selectedModels = [...(cfg.selectedModels || []), { modelId: item.modelId, thinking: true }];
          }
        }
      }

      // 历史"星标"功能已移除：主对话模型默认取候选池首个；
      // selectedChatModel 为旧配置残留（只读），仅在仍有值且存在于候选池时优先使用
      const chatRole = resolveRoleFromChat(selectedChatModel || chatModelPool[0]?.modelId || '');

      /**
       * Butler 推送克制（B5）入参校验。
       * 非法输入**不静默丢弃**：回落默认值 + 内联提示，避免用户以为改成功了
       * （quiet-hours 侧也会二次兜底，两侧都拦才不会把策略写坏）。
       */
      const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
      const notifyCheck = (() => {
        const problems: string[] = [];
        const start = bnQuietStart.trim();
        const end = bnQuietEnd.trim();
        const startOk = HM_RE.test(start);
        const endOk = HM_RE.test(end);
        if (!startOk) problems.push(`Quiet start "${bnQuietStart}" is not HH:mm`);
        if (!endOk) problems.push(`Quiet end "${bnQuietEnd}" is not HH:mm`);
        if (startOk && endOk && start === end) {
          // 零长度窗口会被 quiet-hours 判为「不静默」，等于开关失效 → 明确提示
          problems.push('Quiet start and end are identical — the window would be empty');
        }
        const rawLimit = bnDailyLimit.trim();
        let limit: number | undefined;
        if (rawLimit === '') {
          limit = undefined; // 留空 = 用默认 6
        } else {
          const n = Number(rawLimit);
          if (Number.isInteger(n) && n >= 0) limit = n;
          else problems.push(`Daily push limit "${bnDailyLimit}" must be an integer ≥ 0 (0 = unlimited)`);
        }
        return { problems, startOk, endOk, start, end, limit };
      })();
      setBnLimitErr(notifyCheck.problems.join(' · '));

      // 连接验证已前移到"添加模型到模型池"时（勾选 checkbox / Add 即测，TRAE 式），
      // 保存时不再批量测试，避免一个失效模型阻塞整次配置保存。

      // 一次读 + 一次写，避免并发写同一 settings.json 互相覆盖（否则后写者用旧值覆盖新加的 provider）
      await updateSettingsFields({
        providers: newConfigs,
        search: { apiKey: searchConfig.apiKey.trim(), baseUrl: searchConfig.baseUrl.trim() },
        webSearch: { searchProvider: webSearchProvider, fetchProvider: webFetchProvider },
        taskModel: taskModelPool[0] ? { defaultProvider: taskModelPool[0].provider, defaultModel: taskModelPool[0].modelId, pool: taskModelPool } : undefined,
        outcomeModel: outcomeModelPool[0] ? { defaultProvider: outcomeModelPool[0].provider, defaultModel: outcomeModelPool[0].modelId, pool: outcomeModelPool } : undefined,
        chatModel: {
          defaultProvider: chatRole?.provider ?? '',
          defaultModel: selectedChatModel || chatModelPool[0]?.modelId || '',
          apiKey: chatRole?.apiKey ?? '',
          baseUrl: chatRole?.baseUrl ?? '',
          autoVisionOnImage: chatAutoVisionOnImage,
          pool: chatModelPool,
        },
        // 笔记专属模型已随笔记系统拆分到 bob-notes-mcp 插件域，宿主不再写 notesModel
        // 引擎单选：选中本地模型 → provider='sherpa-local'（清空云端池）；否则用云端池首个
        stt: localSttModel
          ? { provider: 'sherpa-local', model: undefined, pool: [], localModel: localSttModel }
          : {
              provider: sttPool[0]?.provider || sttProvider,
              model: sttPool[0]?.modelId || undefined,
              pool: sttPool,
              localModel: undefined,
            },
        // TTS（语音合成）：始终输出对象——本地引擎与云端池互斥单选，选中本地时写对应 provider
        // （引擎侧据此走本地引擎）；Key/BaseUrl 从厂商角色继承（引擎侧 resolve）
        tts: {
          provider: ttsLocalEngine || ttsPool[0]?.provider,
          model: ttsLocalEngine ? undefined : ttsPool[0]?.modelId,
          pool: ttsLocalEngine ? [] : ttsPool,
          voice: ttsVoice.trim() || undefined,
          speed: ttsSpeed.trim() ? Number(ttsSpeed) : undefined,
          localModel: ttsLocalEngine === 'sherpa-local' ? (ttsLocalModel || undefined) : undefined,
          // 零样本克隆（ZipVoice）的参考音与逐字文本：内置/自定义统一为绝对路径
          localRefAudio: ttsLocalEngine === 'sherpa-local' ? (ttsLocalRefAudio.trim() || undefined) : undefined,
          localRefText: ttsLocalEngine === 'sherpa-local' ? (ttsLocalRefText.trim() || undefined) : undefined,
          // 多音色预置的音色 id：'' 时由合成层回落模型首条
          localVoice: ttsLocalEngine === 'sherpa-local' ? (ttsLocalVoice || undefined) : undefined,
        },
        imageEdit: {
          // 与 STT 一致：默认 provider/model 取候选池首个（池为空时回退旧字段），保证后端默认路径可解析
          provider: imagePool[0]?.provider || imageEditProvider,
          model: imagePool[0]?.modelId || imageEditModel.trim() || undefined,
          selectedModels: imageEditSelectedModels.filter((s) => s.trim()),
          pool: imagePool,
        },
        // 识别配置（onlineOcr / glmOcr）已收敛到 Bob OCR 插件（bob-ocr-mcp）管理，
        // BobWork 不再保存/覆盖这两个字段（updateSettingsFields merge 语义 → 保留插件主导的原值）
        // L3：模型分类覆盖持久化（用户纠正的分类，运行时优先于命名正则）
        modelOverrides,
        avatar: { mode: avatarMode, selected: avatarMode === 'fixed' ? avatarSelected : undefined },
        brandLogo: brandLogo || undefined,
        fontScale,
        theme: 'warm',
        // 思考档位策略：显式写三值（缺省语义已由初始化时归一，确保开关与后端一致；harnessPure=true=纯固定档）
        thinking: {
          harnessPure: thinkingPolicy.harnessPure,
          downgradeOnExecution: thinkingPolicy.downgradeOnExecution,
          trivialPromptOff: thinkingPolicy.trivialPromptOff,
        },
        // 文件自动整理投递箱（分类清单为空 = 用内置默认分类）
        fileOrganizer: {
          enabled: fileOrgEnabled,
          inboxDir: fileOrgDir.trim() || undefined,
          categories: fileOrgCategories,
          // AI 自动新建分类文件夹（关 = 严格限定在清单内）
          autoCreateCategories: fileOrgAutoCreate || undefined,
          // 默认规则不落盘：留空即默认，日后调整默认形态也能生效
          naming: isDefaultNaming(fileOrgNaming) ? undefined : fileOrgNaming,
        },
        // AI 浏览器通道：显式写单值（互斥，不做 auto 判据）
        aiBrowser: aiBrowserHippo ? 'hippo' : 'chrome',
        // 浏览器侧栏工具面：显式写单值（core = 默认核心档；full = 全量）
        browserToolset: browserToolsetCore ? 'core' : 'full',
        // Butler 推送克制（B5）：非法项回落默认（不写该字段 = quiet-hours 用默认值），
        // 并在面板上给出内联提示（见 notifyCheck）。
        butlerNotify: {
          enabled: bnEnabled,
          ...(notifyCheck.startOk ? { quietStart: notifyCheck.start } : {}),
          ...(notifyCheck.endOk ? { quietEnd: notifyCheck.end } : {}),
          ...(typeof notifyCheck.limit === 'number' ? { dailyPushLimit: notifyCheck.limit } : {}),
        },
      });

      // 立即应用主题（data-theme 写入 document.documentElement），无需重启
      applyTheme('warm');
      onConfigsChange(newConfigs);
      window.dispatchEvent(new Event('provider-configs-changed'));
      // 主题变更：通知 sandbox 预览刷新注入的 CSS 变量
      window.dispatchEvent(new Event('theme-changed'));
      // 品牌 logo 变更：侧边栏底部图标据此即时跟随（无需重启/重挂载）
      notifyBrandLogoChanged();
      setSaveStatus('saved');
      // 2.5s 后自动隐藏"Saved"提示
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (e) {
      console.error('Save settings error:', e);
      setSaveError(e instanceof Error ? e.message : 'Save failed');
      setSaveStatus('error');
    } finally {
      savingRef.current = false;
      // 写盘期间积压的改动：重新走一轮 debounce，等最新表单值就绪后再落盘
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => {
          autoSaveTimerRef.current = null;
          void saveRef.current();
        }, 500);
      }
    }
  };

  // 保持 saveRef 指向最新一次渲染的保存实现（debounce / 补写均通过它调用，避免闭包过期）
  useEffect(() => { saveRef.current = handleSave; });

  const paperInputStyle = {
    backgroundColor: 'var(--paper)',
    borderColor: 'var(--line)',
    color: 'var(--ink-strong)',
  } as const;

  // ===================== render =====================
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 rounded-xl p-0"
        style={{
          width: '60rem',
          maxWidth: '60rem',
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderColor: 'var(--line)',
          backgroundColor: 'var(--paper)',
          boxShadow: '0 24px 70px -20px rgba(0, 0, 0, 0.35), 0 0 0 0.5px rgba(0, 0, 0, 0.10)',
        }}
      >
        <TooltipProvider delayDuration={150}>
        {/* macOS 风格标题栏：左侧标题 + 右侧关闭按钮 + 底部发丝分隔线 */}
        <div
          className="flex h-12 shrink-0 items-center justify-between border-b px-4"
          style={{ borderColor: 'var(--line-soft)' }}
        >
          <DialogTitle className="text-13 font-semibold" style={{ color: 'var(--ink-strong)' }}>
            Settings
          </DialogTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-faint)' }}
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ===== P0 首次设置向导：三步动线引导条（首次设置完成即隐藏，不再显示"Setup complete"提示） ===== */}
        {(() => {
          const hasKey = (Object.keys(apiKeys) as ProviderType[]).some((t) => apiKeys[t].trim());
          const hasModels = (Object.keys(selectedModels) as ProviderType[]).some((t) => selectedModels[t].size > 0);
          const hasChatRole = !!(selectedChatModel || chatModelPool.length > 0);
          if (hasKey && hasModels && hasChatRole) return null;
          const steps = [
            { label: 'Add API Key', done: hasKey, go: () => setModelPoolOpen(true) },
            { label: 'Fetch & Select Models', done: hasModels, go: () => setModelPoolOpen(true) },
            { label: 'Set Chat Model', done: hasChatRole, go: () => setActiveSection('roles') },
          ];
          return (
            <div className="shrink-0 border-b px-4 py-2.5" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--primary-soft)' }}>
              <div className="mb-1.5 flex items-center gap-1.5 text-11 font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
                <Zap className="h-3 w-3" /> Quick Start
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {steps.map((s, i) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={s.go}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: s.done ? 'var(--success)' : 'var(--ink)' }}
                    title={`Go to: ${s.label}`}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-11 font-bold"
                      style={{
                        backgroundColor: s.done ? 'var(--success)' : 'var(--paper)',
                        border: s.done ? 'none' : '1px solid var(--line)',
                        color: s.done ? '#fff' : 'var(--ink-muted)',
                      }}
                    >
                      {s.done ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap">{s.label}</span>
                    {i < steps.length - 1 && <ChevronRight className="h-3 w-3" style={{ color: 'var(--ink-faint)' }} />}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="flex min-h-0 flex-1">
          {/* ========== 左栏导航 ========== */}
          <div
            className="hide-scrollbar w-52 shrink-0 overflow-y-auto border-r px-2 py-3"
            style={{
              borderColor: 'var(--line-soft)',
              backgroundColor: 'var(--paper-soft)',
              maxHeight: '100%',
            }}
          >
            {/* P3 搜索框：按名称/关键词过滤导航项（含扩展项） */}
            <div className="mb-1 px-0.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--ink-faint)' }} />
                <input
                  value={navQuery}
                  onChange={(e) => setNavQuery(e.target.value)}
                  placeholder="Search settings…"
                  className="h-7 w-full rounded-md border pl-7 pr-6 text-xs outline-none transition-colors"
                  style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                />
                {navQuery && (
                  <button
                    type="button"
                    onClick={() => setNavQuery('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                    style={{ color: 'var(--ink-faint)' }}
                    title="Clear search"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* P1 扁平导航：全部设置项依次平铺（无分组），搜索按名称/关键词过滤 */}
            {(() => {
              const q = navQuery.trim().toLowerCase();
              const match = (label: string, keywords: string[]) =>
                !q || label.toLowerCase().includes(q) || keywords.some((k) => k.includes(q));
              const groups: Array<{
                label: string;
                note?: string;
                items: Array<{
                  id: string;
                  label: string;
                  icon: React.ReactNode;
                  keywords: string[];
                  ext?: boolean;
                }>;
              }> = [
                {
                  label: 'Models',
              items: [
                {
                  id: 'roles',
                  label: 'Role Assignment',
                  icon: <Sparkles className="h-3.5 w-3.5" />,
                  keywords: ['role', 'task', 'outcome', 'stt', 'image', 'edit', 'chat model', 'assign', 'model', 'api key', 'provider', 'fetch', 'base url', 'pool', 'candidate pool', 'manage models'],
                },
                {
                  id: 'web',
                  label: 'Web Search',
                  icon: <Globe className="h-3.5 w-3.5" />,
                  keywords: ['web', 'search', 'fetch', 'deepseek', 'http', 'provider', '联网', '搜索', '抓取', '网页'],
                },
                {
                  id: 'usage',
                  label: 'Model Usage',
                  icon: <Gauge className="h-3.5 w-3.5" />,
                  keywords: ['usage', 'token', 'cost', 'spend', 'model usage', '用量', 'token 消耗', '费用'],
                },
              ],
                },
                {
                  label: 'Appearance',
                  items: [
                    {
                      id: 'theme',
                      label: 'Appearance',
                      icon: <Palette className="h-3.5 w-3.5" />,
                      keywords: ['color', 'skin', 'dark', 'light', 'appearance'],
                    },
                    {
                      id: 'icons',
                      label: 'Icons & Avatars',
                      icon: <Image className="h-3.5 w-3.5" />,
                      keywords: ['avatar', 'icon', 'logo', 'welcome'],
                    },
                  ],
                },
                {
                  label: 'Prompts',
                  items: [
                    {
                      id: 'quickprompts',
                      label: 'Quick Prompts',
                      icon: <Zap className="h-3.5 w-3.5" />,
                      keywords: ['quick', 'prompt', 'shortcut', '指令', '快捷', '提示词'],
                    },
                  ],
                },
                {
                  label: 'Extensions',
                  items: [
                    {
                      id: 'templates',
                      label: 'Templates',
                      icon: <FileText className="h-3.5 w-3.5" />,
                      keywords: ['template', 'item', 'docx', 'word', 'fill', '模板', '合同'],
                    },
                    {
                      id: 'wechat',
                      label: 'WeChat Bind',
                      icon: <MessageCircle className="h-3.5 w-3.5" />,
                      keywords: ['wechat', 'bind', 'qr', 'weixin', '微信'],
                    },
                    {
                      id: 'feishu',
                      label: 'Feishu Bot',
                      icon: <MessageSquare className="h-3.5 w-3.5" />,
                      keywords: ['feishu', 'lark', 'bot', '飞书', '机器人'],
                    },
                    {
                      id: 'mail',
                      label: 'Email Inbox',
                      icon: <Mail className="h-3.5 w-3.5" />,
                      keywords: ['mail', 'email', 'imap', 'inbox', '邮箱', '邮件', '收件箱'],
                    },
                    {
                      id: 'browser',
                      label: 'Hippo Browser',
                      icon: <Globe className="h-3.5 w-3.5" />,
                      keywords: ['browser', 'Hippo Browser', 'cookie', 'cookies', '站点数据', '登录态', '侧边栏浏览器'],
                    },
                    {
                      id: 'fileorganizer',
                      label: 'File Organizer',
                      icon: <FolderOpen className="h-3.5 w-3.5" />,
                      keywords: ['file', 'folder', 'inbox', 'organize', 'rename', 'archive', '文件整理', '投递箱', '归档', '分类', '命名', '自动整理'],
                    },
                  ],
                },
                {
                  label: 'Butler',
                  items: [
                    {
                      id: 'butlernotify',
                      label: 'Butler Notify',
                      icon: <Bell className="h-3.5 w-3.5" />,
                      keywords: ['butler', 'notify', 'notification', 'quiet', 'dnd', 'do not disturb', 'push', '免打扰', '推送', '克制', '通知', '提醒'],
                    },
                    {
                      id: 'remote',
                      label: 'Remote Access',
                      icon: <Globe className="h-3.5 w-3.5" />,
                      keywords: ['remote', 'access', 'token', 'bearer', 'tailscale', 'tunnel', '远程访问', '手机', '隧道', '鉴权'],
                    },
                  ],
                },
                {
                  label: 'Overview',
                  items: [
                    {
                      id: 'diagram',
                      label: 'Architecture',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><path d="M10 6.5h4M17 10v4M10 17.5h4M6.5 10v4" /></svg>
                      ),
                      keywords: ['architecture', 'diagram', 'flow', 'overview'],
                    },
                  ],
                },
              ];
              // 图标砖配色：沿用现有设计 token，不新增色值
              const ITEM_TINT: Record<string, string> = {
                roles: 'var(--primary)',
                usage: 'var(--info)',
                theme: 'var(--purple)',
                icons: 'var(--warn)',
                quickprompts: 'var(--danger)',
                templates: 'var(--info)',
                wechat: 'var(--success)',
                feishu: 'var(--info)',
                browser: 'var(--teal)',
                fileorganizer: 'var(--warn)',
                butlernotify: 'var(--success)',
                remote: 'var(--teal)',
                diagram: 'var(--ink-faint)',
              };
              const filteredGroups = groups
                .map((g) => ({ ...g, items: g.items.filter((it) => match(it.label, it.keywords)) }))
                .filter((g) => g.items.length > 0);
              if (filteredGroups.length === 0) {
                return (
                  <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                    No settings found
                  </div>
                );
              }
              return filteredGroups.map((g) => (
                <div key={g.label} className="mb-1.5">
                  {/* 分组标题 */}
                  <div
                    className="px-2.5 pb-1 pt-2 text-11 font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--ink-faint)' }}
                  >
                    {g.label}
                  </div>
                  {g.items.map((it) => {
                    const active = activeSection === it.id;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => setActiveSection(it.id as typeof activeSection)}
                        className="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                        style={{
                          backgroundColor: active ? 'var(--primary)' : 'transparent',
                          color: active ? '#fff' : 'var(--ink)',
                        }}
                      >
                        {/* 图标砖 */}
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] [&_svg]:h-3 [&_svg]:w-3"
                          style={{
                            backgroundColor: active ? 'rgba(255, 255, 255, 0.24)' : ITEM_TINT[it.id] || 'var(--ink-faint)',
                            color: '#fff',
                          }}
                        >
                          {it.icon}
                        </span>
                        <span className="flex-1 truncate text-13 font-medium">{it.label}</span>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>

          {/* ========== 右栏面板容器 ========== */}
          <div
            className="hide-scrollbar flex-1 min-w-0 overflow-y-auto"
            style={{ maxHeight: '100%' }}
          >
        {activeSection === 'icons' && (
          /* ========== 应用图标 ========== */
          <div className="px-5 py-4">
            {/* 应用图标（欢迎窗口 + 侧边栏，共用头像池） */}
            <div className="mb-4">
              {/* ── 欢迎窗口头像 ── */}
              <div className="mb-2 rounded-lg p-2.5" style={{ backgroundColor: 'var(--paper)' }}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
                    Welcome Window
                    <span className="ml-1.5 text-sm" style={{ color: 'var(--ink-muted)' }}>{avatarMode === 'random' ? 'Random' : 'Fixed'}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { setAvatarMode(avatarMode === 'random' ? 'fixed' : 'random'); }}
                    className="rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
                    style={{
                      backgroundColor: avatarMode === 'fixed' ? 'var(--primary-soft)' : 'var(--paper-hover)',
                      color: avatarMode === 'fixed' ? 'var(--primary-strong)' : 'var(--ink-muted)',
                    }}
                  >
                    {avatarMode === 'random' ? 'Switch to Fixed' : 'Switch to Random'}
                  </button>
                </div>
                {avatarList.length === 0 ? (
                  <div className="rounded border px-3 py-3 text-center" style={{ borderColor: 'var(--line-soft)', borderStyle: 'dashed' }}>
                    <span className="text-sm" style={{ color: 'var(--ink-muted)' }}>No avatars yet. Add one first.</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {avatarList.map((av) => {
                      const isSelected = avatarMode === 'fixed' && avatarSelected === av.id;
                      return (
                        <button
                          key={av.id}
                          type="button"
                          onClick={() => { setAvatarMode('fixed'); setAvatarSelected(av.id); }}
                          className="overflow-hidden rounded-md border-2 transition-all"
                          style={{ width: 40, height: 40, borderColor: isSelected ? 'var(--primary)' : 'transparent', backgroundColor: '#fff' }}
                          title={av.name + (av.builtin ? ' (Built-in)' : ' (Custom)')}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={av.dataUrl} alt={av.name} className="h-full w-full object-contain" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── 侧边栏品牌图标 ── */}
              <div className="mb-2 rounded-lg p-2.5" style={{ backgroundColor: 'var(--paper)' }}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
                    Sidebar
                    <span className="ml-1.5 text-sm" style={{ color: 'var(--ink-muted)' }}>{brandLogo ? 'Custom' : 'Default'}</span>
                  </span>
                  <button
                    type="button"
                    disabled={!brandLogo}
                    onClick={() => { setBrandLogo(''); }}
                    className="rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
                    style={{
                      backgroundColor: brandLogo ? 'var(--paper-hover)' : 'var(--paper-soft)',
                      color: brandLogo ? 'var(--ink-muted)' : 'var(--line)',
                      cursor: brandLogo ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Restore Default
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* 默认 Logo */}
                  <button
                    type="button"
                    onClick={() => { setBrandLogo(''); }}
                    className="overflow-hidden rounded-md border-2 transition-all"
                    style={{ width: 40, height: 40, borderColor: !brandLogo ? 'var(--purple)' : 'transparent', backgroundColor: '#fff' }}
                    title="Default Logo"
                  >
                    <img src="/hippo-line.png" alt="Default" className="h-full w-full object-contain" />
                  </button>
                  {avatarList.map((av) => {
                    const isSelected = brandLogo === av.id;
                    return (
                      <button
                        key={av.id}
                        type="button"
                        onClick={() => { setBrandLogo(av.id); }}
                        className="overflow-hidden rounded-md border-2 transition-all"
                        style={{ width: 40, height: 40, borderColor: isSelected ? 'var(--purple)' : 'transparent', backgroundColor: '#fff' }}
                        title={av.name + (av.builtin ? ' (Built-in)' : ' (Custom)')}
                      >
                        <img src={av.dataUrl} alt={av.name} className="h-full w-full object-contain" />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── 头像池管理（添加 / 删除自定义） ── */}
              {avatarList.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {avatarList.map((av) => (
                    <div key={av.id} className="group relative">
                      <div className="overflow-hidden rounded-md border" style={{ width: 36, height: 36, borderColor: 'var(--line-soft)', backgroundColor: '#fff' }}>
                        <img src={av.dataUrl} alt={av.name} className="h-full w-full object-contain" />
                      </div>
                      {!av.builtin && (
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const api = (window as unknown as { api: { avatar: { delete: (id: string) => Promise<{ success: boolean; avatars?: typeof avatarList }> } } }).api;
                              const res = await api.avatar.delete(av.id);
                              if (res.success && res.avatars) {
                                setAvatarList(res.avatars);
                                if (avatarSelected === av.id) setAvatarSelected('');
                                if (brandLogo === av.id) setBrandLogo('');
                              }
                            } catch { /* ignore */ }
                          }}
                          className="absolute -right-1 -top-1 hidden rounded-full p-0.5 group-hover:flex"
                          style={{ backgroundColor: 'var(--primary-strong)', color: '#fff' }}
                          title="Delete Custom Avatar"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {/* 添加自定义头像 */}
                  <button
                    type="button"
                    disabled={avatarAdding}
                    onClick={async () => {
                      setAvatarAdding(true);
                      try {
                        const api = (window as unknown as { api: { avatar: { add: () => Promise<{ success: boolean; avatars?: typeof avatarList; canceled?: boolean }> } } }).api;
                        const res = await api.avatar.add();
                        if (res.success && res.avatars) setAvatarList(res.avatars);
                      } catch { /* ignore */ }
                      setAvatarAdding(false);
                    }}
                    className="flex items-center justify-center rounded-md border-2 border-dashed transition-colors"
                    style={{ width: 36, height: 36, borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
                    title="Add Custom Avatar"
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--purple)'; e.currentTarget.style.color = 'var(--purple)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.color = 'var(--ink-muted)'; }}
                  >
                    {avatarAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="text-lg leading-none">+</span>}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeSection === 'quickprompts' && (
          /* ========== 快捷指令全局库 ========== */
          <div className="px-5 py-4">
            {/* 新建/编辑表单 */}
            {qpEditor && (
              <div className="mb-4 flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: 'color-mix(in oklab, var(--purple) 30%, transparent)', backgroundColor: 'var(--purple-soft)' }}>
                <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  {qpEditor.mode === 'new' ? 'New quick prompt' : 'Edit quick prompt'}
                </span>
                <input
                  value={qpEditor.name}
                  onChange={(e) => setQpEditor({ ...qpEditor, name: e.target.value })}
                  placeholder="Name"
                  className="rounded-md border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink-strong)' }}
                />
                <input
                  value={qpEditor.category}
                  onChange={(e) => setQpEditor({ ...qpEditor, category: e.target.value })}
                  placeholder="Category (optional)"
                  className="rounded-md border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink-strong)' }}
                />
                <textarea
                  value={qpEditor.content}
                  onChange={(e) => setQpEditor({ ...qpEditor, content: e.target.value })}
                  placeholder="Prompt content — inserted into the input box on click"
                  rows={3}
                  className="w-full resize-none rounded-md border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink-strong)' }}
                />
                <div className="flex justify-end gap-1.5">
                  <Button type="button" onClick={() => setQpEditor(null)} variant="ghost" tone="neutral" size="sm">
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={async () => {
                      if (!qpEditor || !qpEditor.name.trim() || !qpEditor.content.trim()) return;
                      const now = new Date().toISOString();
                      let next: QuickPrompt[];
                      if (qpEditor.mode === 'new') {
                        next = [...quickPrompts, { id: 'qp-' + Date.now().toString(36), name: qpEditor.name.trim(), content: qpEditor.content.trim(), category: qpEditor.category.trim() || undefined, updatedAt: now }];
                      } else {
                        next = quickPrompts.map((q) => q.id === qpEditor.id ? { ...q, name: qpEditor.name.trim(), content: qpEditor.content.trim(), category: qpEditor.category.trim() || undefined, updatedAt: now } : q);
                      }
                      await updateQuickPrompts(next);
                      setQuickPrompts(next);
                      setQpEditor(null);
                      window.dispatchEvent(new Event('provider-configs-changed'));
                    }}
                    disabled={!qpEditor.name.trim() || !qpEditor.content.trim()}
                    variant="solid"
                    tone="brand"
                    size="sm"
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}

            <div className="mb-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setQpEditor({ mode: 'new', name: '', content: '', category: '' })}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ borderColor: 'color-mix(in oklab, var(--purple) 40%, transparent)', color: 'var(--purple)' }}
              >
                <ClipboardCheck className="h-3.5 w-3.5" /> New prompt
              </button>
              {qpCategories.length > 0 && (
                <select
                  value={qpCategoryFilter}
                  onChange={(e) => setQpCategoryFilter(e.target.value)}
                  className="rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
                >
                  <option value="all">All categories</option>
                  {qpCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
            </div>

            {/* 指令列表 */}
            <div className="grid grid-cols-2 gap-1.5">
              {quickPrompts.length === 0 && (
                <div className="col-span-2 rounded-xl border p-4 text-xs" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
                  No quick prompts yet. Create one with the button above.
                </div>
              )}
              {quickPrompts.length > 0 && filteredQuickPrompts.length === 0 && (
                <div className="col-span-2 rounded-xl border p-4 text-xs" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
                  No prompts in this category.
                </div>
              )}
              {filteredQuickPrompts.map((q, idx) => {
                const origIdx = quickPrompts.findIndex((x) => x.id === q.id);
                return (
                <div key={q.id} className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>{q.name}</span>
                      {q.category && (
                        <span className="shrink-0 rounded px-1.5 py-px text-10" style={{ backgroundColor: 'var(--purple-soft)', color: 'var(--purple)' }}>{q.category}</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>{q.content}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      onClick={async () => {
                        if (origIdx <= 0) return;
                        const next = [...quickPrompts];
                        [next[origIdx - 1], next[origIdx]] = [next[origIdx], next[origIdx - 1]];
                        await updateQuickPrompts(next);
                        setQuickPrompts(next);
                        window.dispatchEvent(new Event('provider-configs-changed'));
                      }}
                      disabled={origIdx === 0}
                      variant="ghost"
                      tone="neutral"
                      size="icon-sm"
                      title="Move up"
                      aria-label="Move up"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      onClick={async () => {
                        if (origIdx >= quickPrompts.length - 1) return;
                        const next = [...quickPrompts];
                        [next[origIdx + 1], next[origIdx]] = [next[origIdx], next[origIdx + 1]];
                        await updateQuickPrompts(next);
                        setQuickPrompts(next);
                        window.dispatchEvent(new Event('provider-configs-changed'));
                      }}
                      disabled={origIdx === quickPrompts.length - 1}
                      variant="ghost"
                      tone="neutral"
                      size="icon-sm"
                      title="Move down"
                      aria-label="Move down"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      onClick={() => setQpEditor({ mode: 'edit', id: q.id, name: q.name, content: q.content, category: q.category || '' })}
                      variant="ghost"
                      tone="neutral"
                      size="sm"
                      title="Edit"
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      onClick={async () => {
                        const next = quickPrompts.filter((x) => x.id !== q.id);
                        await updateQuickPrompts(next);
                        setQuickPrompts(next);
                        window.dispatchEvent(new Event('provider-configs-changed'));
                      }}
                      variant="ghost"
                      tone="danger"
                      size="sm"
                      title="Delete"
                      aria-label="Delete"
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {activeSection === 'theme' && (
          /* ========== 界面主题 ========== */
          <div className="px-5 py-4">
            {/* 统一主题：单一品牌色 Purple（对齐 dynamic-ui Token，App/小程序/Widget 同源） */}
            <div className="flex items-center gap-3 rounded-xl border-2 p-3" style={{ borderColor: 'var(--line)', backgroundColor: '#fff' }}>
              {/* 迷你预览 */}
              <div className="flex h-[52px] items-stretch overflow-hidden rounded-lg" style={{ backgroundColor: '#efeff2' }}>
                <div className="flex w-4 shrink-0 flex-col items-center gap-1 py-1.5" style={{ backgroundColor: '#e8e8ec' }}>
                  <span className="h-1 w-2 rounded-full" style={{ backgroundColor: '#4b3fe3', opacity: 0.9 }} />
                  <span className="h-1 w-1.5 rounded-full" style={{ backgroundColor: '#171717', opacity: 0.35 }} />
                </div>
                <div className="relative w-14">
                  <div className="absolute left-1 top-1.5 h-7 w-9 rounded border p-1" style={{ backgroundColor: '#f7f7f8', borderColor: '#e4e4e7' }}>
                    <span className="block h-1 w-3 rounded-full" style={{ backgroundColor: '#4b3fe3' }} />
                  </div>
                  <span className="absolute bottom-1 left-1 h-2.5 w-5 rounded" style={{ backgroundColor: '#4b3fe3' }} />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>Purple · Unified theme</span>
                  <span className="shrink-0 rounded px-1 py-px text-10 font-semibold uppercase tracking-wide" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }}>Live</span>
                </div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Single brand color — App / Mini Programs / Widgets share the same token set.
                </p>
              </div>
            </div>

            {/* ========== 全局字号档位 ========== */}
            <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--line)' }}>
              <div className="mb-3 flex items-center gap-2">
                <Type className="h-4 w-4" style={{ color: 'var(--purple)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                  Font Size
                </span>
              </div>
              <div className="flex gap-2">
                {(
                  [
                    { id: 'm' as const, label: 'M', desc: 'Small' },
                    { id: 'l' as const, label: 'L', desc: 'Default' },
                    { id: 'xl' as const, label: 'XL', desc: 'Extra Large' },
                  ]
                ).map((opt) => {
                  const selected = fontScale === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        if (fontScale === opt.id) return;
                        setFontScale(opt.id);
                        applyFontScale(opt.id);
                      }}
                      className="flex flex-1 flex-col items-center gap-0.5 rounded-xl border-2 px-3 py-2.5 transition-all"
                      style={{
                        borderColor: selected ? 'var(--purple)' : 'var(--line)',
                        boxShadow: selected ? '0 2px 10px var(--purple-soft)' : 'none',
                        backgroundColor: selected ? 'var(--purple-soft)' : 'transparent',
                        cursor: 'pointer',
                      }}
                      title={`${opt.label} — ${opt.desc} font size`}
                    >
                      <span className="text-base font-bold leading-tight" style={{ fontSize: opt.id === 'm' ? 15 : opt.id === 'l' ? 17 : 19, color: selected ? 'var(--purple)' : 'var(--ink)' }}>
                        A
                      </span>
                      <span className="text-xs font-semibold" style={{ color: selected ? 'var(--purple)' : 'var(--ink)' }}>
                        {opt.label}
                      </span>
                      <span className="text-10" style={{ color: 'var(--ink-muted)' }}>
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ========== 键盘快捷键（只读清单，可折叠，默认折叠） ========== */}
            <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--line)' }}>
              <button
                type="button"
                onClick={() => setShortcutsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2"
                title={shortcutsOpen ? 'Collapse keyboard shortcuts' : 'Expand keyboard shortcuts'}
              >
                <span className="flex items-center gap-2">
                  <Keyboard className="h-4 w-4" style={{ color: 'var(--purple)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    Keyboard Shortcuts
                  </span>
                </span>
                <ChevronDown
                  className="h-3.5 w-3.5 shrink-0 transition-transform"
                  style={{ color: 'var(--ink-muted)', transform: shortcutsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                />
              </button>
              {shortcutsOpen && (
                <div className="mt-3 divide-y rounded-xl border" style={{ borderColor: 'var(--line)' }}>
                  {(
                    [
                      { keys: ['⌘', 'F'], label: 'Open global search panel' },
                      { keys: ['⌘', 'G'], label: 'Open Project Board' },
                      { keys: ['⌘', 'R'], label: 'Auto arrange nodes (Node Map)' },
                      { keys: ['⌘', 'S'], label: 'Save document' },
                      { keys: ['⌘', '⇧', 'F'], label: 'Find / replace in document & PDF' },
                      { keys: ['⌘', 'Z'], label: 'Undo (document editor)' },
                      { keys: ['⇧', '⌘', 'Z'], label: 'Redo (document editor)' },
                      { keys: ['⌘', 'Enter'], label: 'Send message (in input fields)' },
                      { keys: ['⌘/Ctrl', 'Scroll'], label: 'Zoom canvas' },
                      { keys: ['⌘', '⇧', 'O'], label: 'Screenshot OCR (macOS only)' },
                      { keys: ['⌘', '⇧', 'B'], label: 'Show / hide Hippo Browser' },
                      // 2026-09-25：收件箱已从邮件式通知中心（WantedNoticeCenter，已删）迁入 Butler 抽屉，
                      // 原 J/K · R · E · S · ⌘⇧D 五条邮件快捷键随组件一并消失 → 换成对话框的真实键位
                      { keys: ['Enter'], label: 'Send question (Butler dialog)' },
                      { keys: ['⇧', 'Enter'], label: 'New line in input (Butler dialog)' },
                      { keys: ['Esc'], label: 'Close Butler dialog' },
                    ]
                  ).map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {item.label}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {item.keys.map((k) => (
                          <kbd
                            key={k}
                            className="rounded border px-1.5 py-0.5 text-10 font-semibold"
                            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeSection === 'diagram' && (
          /* ========== Space Station: global capability map ========== */
          <div className="px-5 py-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                BobWork · Space Station
              </h3>
              <button
                type="button"
                onClick={() => setDiagramZoom(true)}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-90"
                style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
              >
                <ExternalLink className="h-3 w-3" /> Zoom
              </button>
            </div>

            {(() => {
              // ===== 空间站舱段布局：顶部接入舱 → Command Core → 底部动力/输出舱 =====
              const canvasW = 1100;
              const canvasH = 700;
              const coreRect = { x: 30, y: 210, w: 1040, h: 250 };

              // Command Core 乘员：画布上可创建的 Agent 节点舱（内置 Chat / Coding，官方包 Kar / Buzan / Archivist）
              // 2026-09-25：Butler 已不再是画布节点（能力融合进悬浮球 Butler 抽屉），从乘员表移除
              const crew = [
                { id: 'crew-chat', title: 'Chat', icon: <MessageSquare className="h-4 w-4" /> },
                { id: 'crew-coding', title: 'Coding', icon: <Wrench className="h-4 w-4" /> },
                { id: 'crew-kar', title: 'Kar', icon: <BookOpen className="h-4 w-4" /> },
                { id: 'crew-buzan', title: 'Buzan', icon: <Network className="h-4 w-4" /> },
                { id: 'crew-archivist', title: 'Archivist', icon: <Archive className="h-4 w-4" /> },
              ];
              // 乘员按数量在核心舱内水平居中（成员数变化时不必手改坐标）
              const crewPos = (() => {
                const spacing = 180;
                const w = 132;
                const groupW = (crew.length - 1) * spacing + w;
                const startX = coreRect.x + (coreRect.w - groupW) / 2;
                return crew.map((_, i) => ({ x: startX + i * spacing, y: coreRect.y + 46, w, h: 150 }));
              })();

              // 舱段卡：顶部为接入外部能力的模块，底部为动力与产出系统
              const modules: {
                id: string;
                name: string;
                icon: React.ReactNode;
                power?: boolean;
                x: number;
                y: number;
                w: number;
                h: number;
              }[] = [
                { id: 'comms', name: 'Communications', icon: <MessageCircle className="h-4 w-4" />, x: 30, y: 52, w: 176, h: 96 },
                { id: 'dock', name: 'Docking Port', icon: <Plug className="h-4 w-4" />, x: 246, y: 52, w: 176, h: 96 },
                { id: 'lab', name: 'Science Lab', icon: <Box className="h-4 w-4" />, x: 462, y: 52, w: 176, h: 96 },
                { id: 'sensing', name: 'Sensing Array', icon: <Zap className="h-4 w-4" />, x: 678, y: 52, w: 176, h: 96 },
                { id: 'meeting', name: 'Meeting Deck', icon: <Mic className="h-4 w-4" />, x: 894, y: 52, w: 176, h: 96 },
                { id: 'energy', name: 'Energy Core', icon: <Brain className="h-4 w-4" />, power: true, x: 30, y: 560, w: 176, h: 96 },
                { id: 'knowledge', name: 'Knowledge Bay', icon: <FileText className="h-4 w-4" />, x: 246, y: 560, w: 176, h: 96 },
                { id: 'media', name: 'Media Bay', icon: <Image className="h-4 w-4" />, x: 462, y: 560, w: 176, h: 96 },
                { id: 'schedule', name: 'Schedule Deck', icon: <CalendarDays className="h-4 w-4" />, x: 678, y: 560, w: 176, h: 96 },
                { id: 'support', name: 'Support Systems', icon: <Palette className="h-4 w-4" />, x: 894, y: 560, w: 176, h: 96 },
              ];

              const stationSvg = (
                <svg
                  viewBox={`0 0 ${canvasW} ${canvasH}`}
                  style={{
                    display: 'block',
                    margin: '0 auto',
                    width: '100%',
                    height: 'auto',
                    maxWidth: canvasW,
                    aspectRatio: `${canvasW} / ${canvasH}`,
                  }}
                >
                  <defs>
                    <marker id="arrow-gray" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L0,6 L9,3 z" fill="var(--ink-faint)" />
                    </marker>
                    <marker id="arrow-accent" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L0,6 L9,3 z" fill="var(--primary)" />
                    </marker>
                  </defs>

                  {/* === 连线：顶部模块 → Command Core === */}
                  {modules.filter((m) => m.y < coreRect.y).map((m) => {
                    const sx = m.x + m.w / 2;
                    const tx = Math.min(Math.max(sx, coreRect.x + 44), coreRect.x + coreRect.w - 44);
                    return (
                      <line
                        key={`in-${m.id}`}
                        x1={sx}
                        y1={m.y + m.h}
                        x2={tx}
                        y2={coreRect.y}
                        stroke="var(--ink-faint)"
                        strokeWidth="1.3"
                        strokeDasharray="3 2"
                        markerEnd="url(#arrow-gray)"
                      />
                    );
                  })}

                  {/* === 连线：Command Core → 底部模块 === */}
                  {modules.filter((m) => m.y > coreRect.y + coreRect.h).map((m) => {
                    const sx = Math.min(Math.max(m.x + m.w / 2, coreRect.x + 44), coreRect.x + coreRect.w - 44);
                    const tx = m.x + m.w / 2;
                    return (
                      <line
                        key={`out-${m.id}`}
                        x1={sx}
                        y1={coreRect.y + coreRect.h}
                        x2={tx}
                        y2={m.y}
                        stroke={m.power ? 'var(--primary)' : 'var(--ink-faint)'}
                        strokeWidth="1.3"
                        strokeDasharray={m.power ? 'none' : '3 2'}
                        markerEnd={m.power ? 'url(#arrow-accent)' : 'url(#arrow-gray)'}
                      />
                    );
                  })}

                  {/* === 舱段卡 === */}
                  {modules.map((m) => {
                    const isPower = !!m.power;
                    const chipTop = m.y + (m.h - 24) / 2;
                    return (
                      <g key={m.id}>
                        <rect
                          x={m.x} y={m.y} width={m.w} height={m.h} rx={14}
                          fill={isPower ? 'var(--primary-soft)' : 'var(--paper)'}
                          stroke={isPower ? 'var(--primary)' : 'var(--line)'}
                          strokeWidth={isPower ? 1.4 : 1.2}
                        />
                        <rect
                          x={m.x + 14} y={chipTop} width={24} height={24} rx={7}
                          fill="var(--primary-soft)"
                        />
                        <g transform={`translate(${m.x + 18}, ${chipTop + 4})`} style={{ color: 'var(--primary-strong)' }}>
                          {m.icon}
                        </g>
                        <text
                          x={m.x + 52}
                          y={m.y + m.h / 2 + 4.5}
                          fontSize="13"
                          fontWeight="700"
                          fill="var(--ink)"
                        >
                          {m.name}
                        </text>
                      </g>
                    );
                  })}

                  {/* === Command Core（节点画布） === */}
                  <g>
                    <rect
                      x={coreRect.x} y={coreRect.y} width={coreRect.w} height={coreRect.h} rx={20}
                      fill="var(--paper)"
                      stroke="var(--primary)"
                      strokeWidth="1.4"
                      strokeDasharray="8 4"
                    />
                    {/* 头部标题带 */}
                    <rect x={coreRect.x} y={coreRect.y} width={coreRect.w} height={44} rx={20} fill="var(--primary-soft)" />
                    <rect x={coreRect.x} y={coreRect.y + 26} width={coreRect.w} height={18} fill="var(--primary-soft)" />
                    <circle cx={coreRect.x + 24} cy={coreRect.y + 22} r={5} fill="var(--primary)" />
                    <text x={coreRect.x + 42} y={coreRect.y + 27} fontSize="13.5" fontWeight="800" fill="var(--primary-strong)">
                      Command Core · Node Canvas
                    </text>

                    {/* === Command Core 乘员舱 === */}
                    {crew.map((s, i) => {
                      const p = crewPos[i];
                      const cx = p.x + p.w / 2;
                      const chipTop = p.y + 26;
                      return (
                        <g key={s.id}>
                          <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={14} fill="var(--paper)" stroke="var(--line)" strokeWidth="1.2" />
                          <rect x={cx - 17} y={chipTop} width={34} height={34} rx={10} fill="var(--primary-soft)" />
                          <g transform={`translate(${cx - 8}, ${chipTop + 9})`} style={{ color: 'var(--primary-strong)' }}>
                            {s.icon}
                          </g>
                          <text x={cx} y={p.y + p.h - 28} textAnchor="middle" fontSize="12.5" fontWeight="700" fill="var(--ink)">
                            {s.title}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                </svg>
              );

              return (
                <>
                  <div className="overflow-x-auto">
                    {/* 可点击放大的空间站图（按容器宽度等比缩放） */}
                    <div className="cursor-zoom-in" onClick={() => setDiagramZoom(true)} title="Click to zoom">
                      {stationSvg}
                    </div>
                  </div>

                  {/* === 空间站图全屏放大 overlay === */}
                  {diagramZoom && (
                    <div
                      className="fixed inset-0 z-[2000] flex items-center justify-center"
                      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
                      onClick={() => setDiagramZoom(false)}
                    >
                      <div
                        className="relative max-h-[92vh] max-w-[96vw] overflow-auto rounded-xl p-5"
                        style={{ backgroundColor: 'var(--paper)' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setDiagramZoom(false)}
                          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold transition-colors hover:bg-[var(--paper-hover)]"
                          style={{ backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                          title="Close"
                        >
                          ✕
                        </button>
                        <div className="pt-6" style={{ maxWidth: 960, margin: '0 auto' }}>
                          {stationSvg}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ===== 角色派发（主对话 / 视觉 / OCR / STT / 图像编辑，从已勾选聊天模型下拉选择；任务归纳与成果编辑复用 chatModel） ===== */}
        {activeSection === 'roles' && (() => {
                const selectedOptions: { modelId: string; provider: ProviderType; apiKey: string; baseUrl: string; category: string }[] = [];
                (Object.keys(selectedModels) as ProviderType[]).forEach((type) => {
                  const key = apiKeys[type].trim();
                  if (!key) return;
                  const baseUrl = resolveBaseUrl(type);
                  selectedModels[type].forEach((modelId) => {
                    const fetched = fetchedModels[type].find((m) => m.modelId === modelId);
                    selectedOptions.push({ modelId, provider: type, apiKey: key, baseUrl, category: fetched?.category ?? 'chat' });
                  });
                });

                /** 角色候选池渲染：singleSelect 模式下一键替换，多选模式追加 */
                const renderRolePool = (
                  label: string,
                  color: string,
                  pool: Array<{ provider: string; modelId: string }>,
                  setPool: (next: Array<{ provider: string; modelId: string }>) => void,
                  purpose?: ModelPurpose,
                  singleSelect?: boolean,
                ) => {
                  return (
                    <>
                      {pool.length > 0 && (
                        <div className="mb-2 grid grid-cols-2 gap-1.5">
                          {pool.map((item) => {
                            const preset = PROVIDER_PRESETS.find((p) => p.type === item.provider as ProviderType);
                            return (
                              <Chip
                                key={`${item.provider}-${item.modelId}`}
                                variant="paper"
                                size="md"
                                dismissible
                                onDismiss={() => {
                                  setPool(pool.filter((p) => !(p.provider === item.provider && p.modelId === item.modelId)));
                                }}
                                className="w-full rounded-md"
                                title={`Remove ${item.modelId} from pool`}
                                label={
                                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                      {item.modelId}
                                    </span>
                                    <Badge variant="primary" size="sm" label={preset?.label || item.provider} />
                                  </span>
                                }
                              />
                            );
                          })}
                        </div>
                      )}
                      <select
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          const idx = v.indexOf('|');
                          if (idx === -1) return;
                          const provider = v.slice(0, idx);
                          const modelId = v.slice(idx + 1);
                          if (singleSelect) {
                            if (pool.some((p) => p.provider === provider && p.modelId === modelId)) return;
                            setPool([{ provider, modelId }]);
                          } else {
                            setPool(pool.some((p) => p.provider === provider && p.modelId === modelId)
                              ? pool
                              : [...pool, { provider, modelId }]);
                          }
                        }}
                        className="h-8 w-full rounded-md border px-3 text-sm"
                        style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                      >
                        <option value="">+ Add model to {label} pool…</option>
                        {(() => {
                          const added = new Set(pool.map((p) => `${p.provider}|${p.modelId}`));
                          // 本地无鉴权厂商（BobMultimodal / Ollama）无需 API Key 即可加入角色池
                          const noAuthLocal = NO_AUTH_LOCAL_PROVIDERS;
                          return (Object.keys(fetchedModels) as ProviderType[]).flatMap((type) => {
                            const key = apiKeys[type].trim();
                            if (!key && !noAuthLocal.has(type)) return [];
                            const preset = PROVIDER_PRESETS.find((p) => p.type === type);
                            // 仅显示模型池内（Manage Models 勾选）的模型
                            const selected = selectedModels[type] || new Set<string>();
                            const list = (fetchedModels[type] || []).filter((m) => selected.has(m.modelId));
                            return list
                              .filter((m) => !added.has(`${type}|${m.modelId}`))
                              .filter((m) => {
                                if (purpose) return categoryToPurpose(m) === purpose;
                                return true;
                              })
                              .map((m) => (
                                <option key={`${type}|${m.modelId}`} value={`${type}|${m.modelId}`}>
                                  {m.modelId} — {preset?.label || type}
                                </option>
                              ));
                          });
                        })()}
                      </select>
                    </>
                  );
                };

                /** 行首摘要：当前角色已选模型（池首个 + 其余数量），未配置显示 Not set */
                const renderRoleSummary = (pool: Array<{ provider: string; modelId: string }>) => (
                  pool.length === 0 ? (
                    <span className="text-11 italic" style={{ color: 'var(--ink-faint)' }}>Not set</span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="max-w-[132px] truncate text-11" style={{ color: 'var(--ink-muted)' }}>{pool[0].modelId}</span>
                      {pool.length > 1 && <Badge variant="primary" size="sm" label={`+${pool.length - 1}`} />}
                    </span>
                  )
                );

                /** STT 行首摘要：本地与云端互斥，本地模型非空即当前引擎（带 Local 标签），否则回落到云端池 */
                const renderSttSummary = () => (
                  localSttModel ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="max-w-[132px] truncate text-11" style={{ color: 'var(--ink-muted)' }}>{localSttModel}</span>
                      <Badge variant="primary" size="sm" label="Local" />
                    </span>
                  ) : renderRoleSummary(sttPool)
                );

                /** TTS 行首摘要：本地与云端互斥，选中本地引擎即当前引擎（带 Local 标签），否则回落到云端池 */
                const renderTtsSummary = () => (
                  ttsLocalEngine ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="max-w-[132px] truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                        {ttsLocalModel || 'Offline neural'}
                      </span>
                      <Badge variant="primary" size="sm" label="Local" />
                    </span>
                  ) : renderRoleSummary(ttsPool)
                );

                return (
                  <div className="px-5 py-4">
                    {/* 一级菜单入口：以弹窗方式打开 Model Pool（配 API Key、fetch、勾选候选） */}
                    <div className="mb-4">
                      <button
                        type="button"
                        onClick={() => { setModelSearch(''); setCategoryFilter('all'); setModelPoolOpen(true); }}
                        className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)]"
                        style={{ color: 'var(--primary-strong)' }}
                        title="Open Model Pool — add API Keys, fetch models, and check candidates"
                      >
                        <Brain className="h-3.5 w-3.5" /> Model Pool
                      </button>
                    </div>

                    {/* P2 dependency hint: guide to Model Pool when no models available */}
                    {selectedOptions.length === 0 && (
                      <Callout
                        variant="warn"
                        className="mb-4"
                        icon={<AlertCircle className="h-4 w-4" />}
                        title="Model pool is empty"
                        description="Configure an API Key and check models in Manage Models first."
                        action={
                          <button
                            type="button"
                            onClick={() => { setModelSearch(''); setCategoryFilter('all'); setModelPoolOpen(true); }}
                            className="btn btn-primary btn-sm"
                          >
                            Go to Model Pool
                          </button>
                        }
                      />
                    )}

                    {/* 角色模型分配：单卡片行式列表——每行一个角色，行首显示当前模型，展开后增删 */}
                    <div className="rounded-lg border" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}>

                    {/* 主对话模型（Chat Model）：候选池，首个模型为默认主对话模型 */}
                    <div className="scroll-mt-2">
                      <button type="button" onClick={() => toggleRoleSection('chat')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel icon={false} hint="Add to chat pool. Pool models are auto-checked in their provider and visible in every node's model selector.">Chat Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderRoleSummary(chatModelPool)}
                          {rolesCollapsed.chat
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.chat && (
                      <div className="px-3 pb-3">
                      {/* 候选池列表 */}
                      {chatModelPool.length === 0 ? (
                        <p className="mb-2 text-sm italic" style={{ color: 'var(--ink-muted)' }}>
                          No models in chat pool yet. Add models below — they will be auto-checked in their provider and appear in every node&apos;s model selector.
                        </p>
                      ) : (
                        <div className="mb-2 grid grid-cols-2 gap-1.5">
                          {chatModelPool.map((item) => {
                            const preset = PROVIDER_PRESETS.find((p) => p.type === item.provider as ProviderType);
                            return (
                              <Chip
                                key={`${item.provider}-${item.modelId}`}
                                variant="paper"
                                size="md"
                                dismissible
                                onDismiss={() => {
                                  setChatModelPool((prev) => prev.filter((p) => !(p.provider === item.provider && p.modelId === item.modelId)));
                                  if (selectedChatModel === item.modelId) setSelectedChatModel('');
                                }}
                                title={`Remove ${item.modelId} from pool`}
                                className="w-full rounded-md"
                                label={
                                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                      {item.modelId}
                                    </span>
                                    <Badge variant="primary" size="sm" label={preset?.label || item.provider} />
                                  </span>
                                }
                              />
                            );
                          })}
                        </div>
                      )}

                      {/* 添加模型到候选池（仅模型池内：Manage Models 已勾选的模型） */}
                      <div className="flex items-center gap-2">
                        <select
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            const idx = v.indexOf('|');
                            if (idx === -1) return;
                            const provider = v.slice(0, idx);
                            const modelId = v.slice(idx + 1);
                            setChatModelPool((prev) =>
                              prev.some((p) => p.provider === provider && p.modelId === modelId)
                                ? prev
                                : [...prev, { provider, modelId }],
                            );
                            // 首个加入候选池的模型作为默认主对话模型（历史标星入口已移除，不再单独指定）
                          }}
                          title="Only models in the Model Pool (checked in Manage Models) can be added"
                          className="h-8 w-full rounded-md border px-3 text-sm"
                          style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                        >
                          <option value="">+ Add model to chat pool…</option>
                          {(() => {
                            const added = new Set(chatModelPool.map((p) => `${p.provider}|${p.modelId}`));
                            return (Object.keys(fetchedModels) as ProviderType[]).flatMap((type) => {
                              const key = apiKeys[type].trim();
                              if (!key) return [];
                              const preset = PROVIDER_PRESETS.find((p) => p.type === type);
                              // 仅显示模型池内（Manage Models 勾选）的模型
                              const selected = selectedModels[type] || new Set<string>();
                              return (fetchedModels[type] || [])
                                .filter((m) => selected.has(m.modelId))
                                .filter((m) => !added.has(`${type}|${m.modelId}`))
                                .map((m) => (
                                  <option key={`${type}|${m.modelId}`} value={`${type}|${m.modelId}`}>
                                    {m.modelId} — {preset?.label || type}
                                  </option>
                                ));
                            });
                          })()}
                        </select>
                      </div>

                      {/* ── Smart Model Routing（Auto 视觉优先；随主表单 Save 统一落盘）── */}
                      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-soft)' }}>
                        <div className="mb-1 text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>Smart Model Routing</div>
                        <div className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Prefer vision model when images are attached</div>
                            <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                              When the turn carries image attachments but the selected model cannot read images, switch that turn to a vision-capable model from the pool so images reach it directly as pixels instead of the OCR-description fallback. No vision model in the pool → keep the selected model.
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setChatAutoVisionOnImage((v) => !v)}
                            className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
                            style={{
                              backgroundColor: chatAutoVisionOnImage ? 'var(--primary-soft)' : 'var(--paper-hover)',
                              color: chatAutoVisionOnImage ? 'var(--primary-strong)' : 'var(--ink-muted)',
                            }}
                          >
                            {chatAutoVisionOnImage ? 'On' : 'Off'}
                          </button>
                        </div>
                      </div>

                      {/* ── Advanced（默认折叠）：思考档位策略，随主表单 Save 统一落盘 ── */}
                      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-soft)' }}>
                        <button
                          type="button"
                          onClick={() => setChatAdvancedOpen((v) => !v)}
                          className="flex w-full items-center justify-between text-left"
                        >
                          <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>Advanced</span>
                          {chatAdvancedOpen
                            ? <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </button>
                        {chatAdvancedOpen && (
                        <>
                        {/* S2b：harnessPure = 纯 DSH 固定档总开关（默认 On）；Off = 启用下方执行轮降级 + C1 省 token */}
                        <div className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Pure DSH tiers (harnessPure)</div>
                            <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                              On = fixed reasoning tier every round (DSH native, no downgrade / no trivial-off). Off = legacy plugin behavior: tool-round downgrade + C1 skip-thinking to save tokens.
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setThinkingPolicy((p) => ({ ...p, harnessPure: !p.harnessPure }))}
                            className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
                            style={{
                              backgroundColor: thinkingPolicy.harnessPure ? 'var(--primary-soft)' : 'var(--paper-hover)',
                              color: thinkingPolicy.harnessPure ? 'var(--primary-strong)' : 'var(--ink-muted)',
                            }}
                          >
                            {thinkingPolicy.harnessPure ? 'On' : 'Off'}
                          </button>
                        </div>
                        {/* 以下两条仅在「纯固定档」关掉后才有语义，故条件渲染，避免看起来能用其实无效 */}
                        {!thinkingPolicy.harnessPure && (
                        <>
                        <div className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Downgrade thinking during tool execution</div>
                            <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>Lower reasoning tier on tool-loop rounds — saves reasoning tokens (planning and final rounds keep the selected tier).</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setThinkingPolicy((p) => ({ ...p, downgradeOnExecution: !p.downgradeOnExecution }))}
                            className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
                            style={{
                              backgroundColor: thinkingPolicy.downgradeOnExecution ? 'var(--primary-soft)' : 'var(--paper-hover)',
                              color: thinkingPolicy.downgradeOnExecution ? 'var(--primary-strong)' : 'var(--ink-muted)',
                            }}
                          >
                            {thinkingPolicy.downgradeOnExecution ? 'On' : 'Off'}
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Skip thinking on trivial prompts</div>
                            <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>No reasoning for greetings, acknowledgements and similar trivial turns. Tiers you set to High/Max are never skipped.</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setThinkingPolicy((p) => ({ ...p, trivialPromptOff: !p.trivialPromptOff }))}
                            className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
                            style={{
                              backgroundColor: thinkingPolicy.trivialPromptOff ? 'var(--primary-soft)' : 'var(--paper-hover)',
                              color: thinkingPolicy.trivialPromptOff ? 'var(--primary-strong)' : 'var(--ink-muted)',
                            }}
                          >
                            {thinkingPolicy.trivialPromptOff ? 'On' : 'Off'}
                          </button>
                        </div>
                        </>
                        )}
                        </>
                        )}
                      </div>
                      </div>
                      )}
                    </div>

                    {/* 任务模型（Task Model）：通用任务层，任务摘要/会议纪要/日程解析/AI 字段抽取等轻量任务 */}
                    <div className="border-t scroll-mt-2" style={{ borderColor: 'var(--line-soft)' }}>
                      <button type="button" onClick={() => toggleRoleSection('task')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel icon={false} hint="For light tasks like task summary / meeting notes / schedule parsing / AI field extraction. Defaults to the main chat model when unset; configure to route these to a cheaper or preferred model.">Task Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderRoleSummary(taskModelPool)}
                          {rolesCollapsed.task
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.task && (
                      <div className="px-3 pb-3">
                      {renderRolePool('Task Model', 'var(--primary-strong)', taskModelPool, setTaskModelPool, 'chat', true)}
                      </div>
                      )}
                    </div>

                    {/* 成果块模型（Outcome Model）：成果块（法律引用）专属，默认跟随主对话 */}
                    <div className="border-t scroll-mt-2" style={{ borderColor: 'var(--line-soft)' }}>
                      <button type="button" onClick={() => toggleRoleSection('outcome')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel icon={false} hint="For outcome blocks (legal citations — quality-sensitive). Defaults to the main chat model, then the Task Model; configure to pin a dedicated model.">Outcome Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderRoleSummary(outcomeModelPool)}
                          {rolesCollapsed.outcome
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.outcome && (
                      <div className="px-3 pb-3">
                      {renderRolePool('Outcome Model', 'var(--primary-strong)', outcomeModelPool, setOutcomeModelPool, 'chat', true)}
                      </div>
                      )}
                    </div>

                    {/* 音频转写模型（STT） */}
                    <div ref={sttSectionRef} className="border-t scroll-mt-2" style={{ borderColor: 'var(--line-soft)' }}>
                      <button type="button" onClick={() => toggleRoleSection('stt')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel>Audio STT Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderSttSummary()}
                          {rolesCollapsed.stt
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.stt && (
                      <div className="px-3 pb-3">
                      {renderRolePool('STT', 'var(--purple)', sttPool, setSttPoolExclusive, 'stt', true)}
                      {/* 本地离线（sherpa-onnx）：与云端互斥单选，选中即切换引擎；引擎/模型按需下载 */}
                      <LocalSttPanel
                        model={localSttModel}
                        onModelChange={selectLocalSttModel}
                      />
                      </div>
                      )}
                    </div>

                    {/* 语音合成模型（TTS，B4）：文字 → 语音，走 OpenAI 兼容 /audio/speech（见 lib/tts） */}
                    <div className="border-t scroll-mt-2" style={{ borderColor: 'var(--line-soft)' }}>
                      <button type="button" onClick={() => toggleRoleSection('tts')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel>Audio TTS Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderTtsSummary()}
                          {rolesCollapsed.tts
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.tts && (
                      <div className="px-3 pb-3">
                      {renderRolePool('TTS', 'var(--purple)', ttsPool, setTtsPoolExclusive, 'tts', true)}
                      {/* 本地引擎（离线神经模型）：与云端互斥单选，选中即切换引擎 */}
                      <LocalTtsPanel
                        engine={ttsLocalEngine}
                        onEngineChange={selectTtsEngine}
                        localModel={ttsLocalModel}
                        onLocalModelChange={setTtsLocalModel}
                        refAudio={ttsLocalRefAudio}
                        onRefAudioChange={setTtsLocalRefAudio}
                        refText={ttsLocalRefText}
                        onRefTextChange={setTtsLocalRefText}
                        voice={ttsLocalVoice}
                        onVoiceChange={setTtsLocalVoice}
                      />
                      {/* 音色 / 语速：云端专属补充字段，仅当云端模型为当前引擎时出现 */}
                      {ttsPool.length > 0 && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Voice (optional)</label>
                          {/* BobMultimodal 音色是固定枚举，传枚举外的值会 500 —— 用下拉限定；其余厂商仍为自由输入 */}
                          {ttsPool[0]?.provider === 'bobmultimodal' ? (
                            <select
                              value={ttsVoice || BOBMULTIMODAL_DEFAULT_VOICE}
                              onChange={(e) => setTtsVoice(e.target.value)}
                              className="h-8 w-full rounded-md border px-2 text-sm outline-none"
                              style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                            >
                              {BOBMULTIMODAL_TTS_VOICES.map((v) => (
                                <option key={v} value={v}>{v}</option>
                              ))}
                            </select>
                          ) : (
                          <input
                            value={ttsVoice}
                            onChange={(e) => setTtsVoice(e.target.value)}
                            placeholder="e.g. alloy / nova / fishaudio…:alex"
                            className="h-8 w-full rounded-md border px-3 text-sm"
                            style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                          />
                          )}
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Speed (optional)</label>
                          <input
                            value={ttsSpeed}
                            onChange={(e) => setTtsSpeed(e.target.value)}
                            placeholder="0.25 – 4.0, empty = default"
                            inputMode="decimal"
                            className="h-8 w-full rounded-md border px-3 text-sm"
                            style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                          />
                        </div>
                      </div>
                      )}
                      </div>
                      )}
                    </div>

                    {/* 图像编辑模型（Image Edit） */}
                    <div ref={imageEditSectionRef} className="border-t scroll-mt-2" style={{ borderColor: 'var(--line-soft)' }}>
                      <button type="button" onClick={() => toggleRoleSection('image')} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                          <HintLabel icon={false} hint="AI image editing for the preview panel. Image-edit models (e.g. Doubao SeedEdit / OpenAI gpt-image-1 / Qwen qwen-image-edit) use the images API — independent from chat models, so they are configured separately. Local no-auth providers (BobMultimodal SDXL / Ollama) also work here — base URL is auto-filled from the provider preset or inherited from the Model Pool when left empty.">Image Edit Model</HintLabel>
                        </span>
                        <span className="ml-auto flex min-w-0 items-center gap-1.5">
                          {renderRoleSummary(imagePool)}
                          {rolesCollapsed.image
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                        </span>
                      </button>
                      {!rolesCollapsed.image && (
                      <div className="px-3 pb-3">
                      {/* 已选模型 chips：同 Key 下多选 */}
                      {imageEditSelectedModels.length > 0 && (
                        <div className="-mt-1 mb-2 flex flex-wrap items-center gap-1">
                          {imageEditSelectedModels.map((m) => {
                            const isDefault = m === imageEditModel.trim();
                            return (
                              <span
                                key={m}
                                title={isDefault ? `${m} (default)` : m}
                                className="inline-flex max-w-[160px] items-center gap-1 rounded border px-1.5 py-px text-11 font-medium"
                                style={{
                                  backgroundColor: 'color-mix(in oklab, var(--purple) 10%, transparent)',
                                  borderColor: isDefault ? 'var(--purple)' : 'color-mix(in oklab, var(--purple) 28%, transparent)',
                                  color: 'var(--purple)',
                                  boxShadow: isDefault ? '0 0 0 1px color-mix(in oklab, var(--purple) 30%, transparent)' : undefined,
                                }}
                              >
                                <span className="truncate">{m}</span>
                                <button
                                  type="button"
                                  onClick={() => setImageEditSelectedModels((prev) => prev.filter((x) => x !== m))}
                                  className="shrink-0 rounded-full p-px transition-colors hover:bg-[var(--paper-hover)]"
                                  title={`Remove ${m}`}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {renderRolePool('Image Edit', 'var(--warn)', imagePool, setImagePool, 'image')}
                      </div>
                      )}
                    </div>

                    </div>
                  </div>
                );
              })()}

      {activeSection === 'web' && (
        <div className="px-6 py-5">
          <h2 className="text-17 font-semibold" style={{ color: 'var(--ink-strong)' }}>Web Search</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Search and fetch providers are independent of the chat model. Any model with tool calling can use
            {' '}<code className="text-11">web_search</code> / <code className="text-11">web_fetch</code>.
          </p>
          <div className="mt-4 overflow-hidden rounded-lg border" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}>
            <div className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-13 font-medium" style={{ color: 'var(--ink)' }}>Search provider</div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  DeepSeek Search API uses the DeepSeek provider key. Auto picks the first available provider.
                </p>
              </div>
              <select
                value={webSearchProvider}
                onChange={(e) => setWebSearchProvider(e.target.value)}
                className="h-8 w-56 shrink-0 rounded-md border px-3 text-sm"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
              >
                <option value="deepseek-search-api">DeepSeek Search API</option>
                <option value="auto">Auto (DeepSeek first)</option>
              </select>
            </div>
            <div className="border-t" style={{ borderColor: 'var(--line-soft)' }} />
            <div className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-13 font-medium" style={{ color: 'var(--ink)' }}>Fetch provider</div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Local HTTP fetches public pages without a key; it cannot bypass anti-bot sites.
                </p>
              </div>
              <select
                value={webFetchProvider}
                onChange={(e) => setWebFetchProvider(e.target.value)}
                className="h-8 w-56 shrink-0 rounded-md border px-3 text-sm"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
              >
                <option value="deepseek-fetch-api">DeepSeek Fetch API</option>
                <option value="http">Local HTTP (no key)</option>
                <option value="auto">Auto (DeepSeek first)</option>
              </select>
            </div>
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
            DeepSeek providers reuse the DeepSeek key from Models. Changes apply from the next tool call.
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
            DeepSeek Search / Fetch are billed per successful request (¥5 per 1,000; empty or failed calls are free)
            and are counted under Model Usage → Web tools.
          </p>
        </div>
      )}

      {/* Templates / WeChat Bind 等：直接在右侧面板内嵌显示（不再弹窗） */}
      {activeSection === 'templates' && (
        <TemplateLibraryModal embedded open onOpenChange={() => {}} />
      )}
      {activeSection === 'wechat' && (
        <WechatBindModal embedded open onOpenChange={() => {}} />
      )}
      {activeSection === 'feishu' && (
        <FeishuBindModal embedded open onOpenChange={() => {}} />
      )}
      {activeSection === 'mail' && (
        <MailBindModal embedded open onOpenChange={() => {}} />
      )}
      {activeSection === 'usage' && (
        <UsagePanel embedded onClose={() => setActiveSection('roles')} />
      )}

      {/* ============ File Organizer（文件自动整理投递箱） ============ */}
      {activeSection === 'fileorganizer' && (
        <div className="space-y-6 p-6">
          <div>
            <h3 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>File Organizer</h3>
          </div>

          {/* 开关 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Enable Auto-organize</h4>
              </div>
              <ToggleSwitch
                checked={fileOrgEnabled}
                onChange={() => setFileOrgEnabled((v) => !v)}
                title={fileOrgEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>
          </div>

          {/* 投递箱目录 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Inbox Folder</h4>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={fileOrgDir}
                onChange={(e) => setFileOrgDir(e.target.value)}
                placeholder="No folder selected"
              />
              <Button variant="outline" size="sm" onClick={handlePickInboxDir} className="shrink-0">
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                Choose Folder
              </Button>
            </div>
            <div className="mt-2 min-h-4">
              {fileOrgPickErr && (
                <p className="text-xs" style={{ color: 'var(--danger)' }}>{fileOrgPickErr}</p>
              )}
            </div>
          </div>

          {/* 分类目录清单 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Categories</h4>
            {fileOrgCategories.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {fileOrgCategories.map((c) => (
                  <Chip
                    key={c}
                    variant="paper"
                    size="sm"
                    dismissible
                    onDismiss={() => setFileOrgCategories((prev) => prev.filter((x) => x !== c))}
                    label={c}
                  />
                ))}
              </div>
            )}
            <div className="mt-3">
              <Input
                value={fileOrgCategoryInput}
                onChange={(e) => setFileOrgCategoryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = fileOrgCategoryInput.trim();
                  if (!v) return;
                  setFileOrgCategories((prev) => (prev.includes(v) ? prev : [...prev, v]));
                  setFileOrgCategoryInput('');
                }}
                placeholder="Type a category, press Enter"
              />
            </div>

            {/* AI 自动新建分类文件夹：关 = 模型只能在上面清单里择一，越界落末位兜底项 */}
            <div
              className="mt-3 flex items-start justify-between gap-4 border-t pt-3"
              style={{ borderColor: 'var(--line-soft)' }}
            >
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Auto-create Categories</p>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Let the AI create a new folder when none of the categories above fit.
                </p>
              </div>
              <ToggleSwitch
                checked={fileOrgAutoCreate}
                onChange={() => setFileOrgAutoCreate((v) => !v)}
                title={fileOrgAutoCreate ? 'Enabled' : 'Disabled'}
              />
            </div>

          </div>

          {/* 命名规则（受控选项：顺序 / 分隔符 / 版本号补零，拼名与反解共用同一规则） */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Naming Rule</h4>
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Field Order</span>
                <div className="flex items-center gap-1.5">
                  {fileOrgNaming.order.map((slot, i) => (
                    <select
                      key={i}
                      value={slot}
                      onChange={(e) =>
                        setFileOrgNaming((n) => ({ ...n, order: setSlotAt(n.order, i, e.target.value as NameSlot) }))
                      }
                      className="rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
                    >
                      {SLOTS.map((s) => (
                        <option key={s} value={s}>{SLOT_LABELS[s]}</option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Separator</span>
                <select
                  value={fileOrgNaming.separator}
                  onChange={(e) => setFileOrgNaming((n) => ({ ...n, separator: e.target.value }))}
                  className="rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
                >
                  {SEPARATOR_OPTIONS.map((s) => (
                    <option key={s || 'none'} value={s}>
                      {s === '' ? 'None' : s === ' ' ? 'Space' : s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Version</span>
                <select
                  value={String(fileOrgNaming.padVersion)}
                  onChange={(e) => setFileOrgNaming((n) => ({ ...n, padVersion: Number(e.target.value) }))}
                  className="rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
                >
                  {PAD_OPTIONS.map((p) => (
                    <option key={p} value={String(p)}>{`v${'0'.repeat(p - 1)}1`}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 所见即所得预览：顺序 / 分隔符 / 版本号补零任一变化都立刻反映到下方结果 */}
            <div className="mt-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <span className="text-11" style={{ color: 'var(--ink-muted)' }}>Preview</span>

              {/* 当前组合顺序（随下拉实时重排） */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {fileOrgNaming.order.map((slot, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>+</span>
                    )}
                    <span
                      className="rounded px-1.5 py-0.5 text-xs"
                      style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink-strong)' }}
                    >
                      {SLOT_LABELS[slot]}
                    </span>
                  </span>
                ))}
              </div>

              {/* 组合后的文件名（用占位主题与当天日期实时拼出） */}
              <p className="mt-2 break-all font-mono text-xs" style={{ color: 'var(--ink-strong)' }}>
                {previewName(fileOrgNaming, todayStamp(), 'Lease Agreement')}
              </p>
            </div>
            {!isDefaultNaming(fileOrgNaming) && (
              <p className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>
                Naming rule differs from the default: existing files named by the default rule no longer count toward version numbering, so numbering restarts at v01.
              </p>
            )}
          </div>

          {/* 整理历史 / 失败原因 / 一键重试：让每次判定可解释、可补救 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Activity</h4>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Why files landed in _待处理, and what was filed recently.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void refreshFoRuntime()} disabled={foRuntimeLoading}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${foRuntimeLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                {foRuntime && foRuntime.pending.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRetryPending()}
                    disabled={foRetrying !== ''}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Retry all ({foRuntime.pending.length})
                  </Button>
                )}
              </div>
            </div>

            {foRuntimeErr && (
              <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{foRuntimeErr}</p>
            )}

            {foRuntime && !foRuntime.configured && (
              <p className="mt-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Set an Inbox Folder above to see what has been organized.
              </p>
            )}

            {foRuntime && foRuntime.configured && (
              <>
                {/* 分类结构：既有目录就是模型的词表，列出来便于判断是否在长同义目录 */}
                {foRuntime.existing.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-11" style={{ color: 'var(--ink-muted)' }}>Categories in use</span>
                    {foRuntime.existing.map((c) => (
                      <Chip key={c} variant="paper" size="sm" label={`${c}`} />
                    ))}
                  </div>
                )}

                {/* 待处理清单：失败原因 + 重试次数 + 单项重试 */}
                <div className="mt-3">
                  <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                    Needs attention ({foRuntime.pending.length})
                  </p>
                  {foRuntime.pending.length === 0 ? (
                    <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>Nothing pending.</p>
                  ) : (
                    <div className="mt-1.5 max-h-56 space-y-1.5 overflow-auto pr-1">
                      {foRuntime.pending.map((it) => (
                        <div
                          key={it.path}
                          className="flex items-start justify-between gap-3 rounded-lg px-2.5 py-2"
                          style={{ backgroundColor: 'var(--paper-soft)' }}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs" style={{ color: 'var(--ink-strong)' }} title={it.name}>
                              {it.name}
                            </p>
                            <p className="mt-0.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                              {it.failure || '（老记录没有原因，重新判定即可看到）'}
                              {it.attempts > 0 ? ` · 判过 ${it.attempts} 次` : ''}
                              {it.method ? ` · ${it.method}` : ''}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            disabled={foRetrying !== ''}
                            onClick={() => void handleRetryPending(it.path)}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            Retry
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 最近整理记录 */}
                <div className="mt-4">
                  <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                    Recent activity ({foRuntime.history.length})
                  </p>
                  {foRuntime.history.length === 0 ? (
                    <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>No files organized yet.</p>
                  ) : (
                    <div className="mt-1.5 max-h-72 space-y-1 overflow-auto pr-1">
                      {foRuntime.history.map((h, i) => (
                        <div key={`${h.at}-${i}`} className="flex items-start gap-2 text-xs">
                          <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
                            {h.at.slice(5, 16).replace('T', ' ')}
                          </span>
                          <span
                            className="w-16 shrink-0 truncate"
                            style={{ color: h.category === '_待处理' ? 'var(--warn)' : 'var(--ink-strong)' }}
                            title={h.category}
                          >
                            {h.category}
                          </span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }} title={h.from}>
                            {h.topic || h.from}
                          </span>
                          {h.retries ? (
                            <span className="shrink-0" style={{ color: 'var(--ink-muted)' }} title="截断后重试过">
                              ↻{h.retries}
                            </span>
                          ) : null}
                          {h.tokens && h.tokens.completion > 0 ? (
                            <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-muted)' }} title="本次判定 token">
                              {h.tokens.completion}t
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============ Butler Notify（主动推送克制，B5） ============ */}
      {activeSection === 'butlernotify' && (
        <div className="space-y-6 p-6">
          <div>
            <h3 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>Butler Notify</h3>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              How much Butler is allowed to interrupt you. Quiet hours silence proactive pushes
              (morning / evening reports to WeChat); the report is never lost — it still lands in the drawer inbox.
            </p>
          </div>

          {/* 总开关 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Stay quiet</h4>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Off = push everything, always (previous behaviour).
                </p>
              </div>
              <ToggleSwitch
                checked={bnEnabled}
                onChange={() => setBnEnabled((v) => !v)}
                title={bnEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>
          </div>

          {/* 免打扰时段 */}
          <div
            style={{ borderColor: 'var(--line)', opacity: bnEnabled ? 1 : 0.5 }}
            className="rounded-xl border p-4"
          >
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Quiet Hours</h4>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Proactive pushes sent inside this window are held back and resume when it ends.
              A window that runs past midnight is fine (e.g. 22:00 → 08:00).
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={bnQuietStart}
                onChange={(e) => setBnQuietStart(e.target.value)}
                placeholder="22:00"
                disabled={!bnEnabled}
                className="w-24"
              />
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>→</span>
              <Input
                value={bnQuietEnd}
                onChange={(e) => setBnQuietEnd(e.target.value)}
                placeholder="08:00"
                disabled={!bnEnabled}
                className="w-24"
              />
            </div>
          </div>

          {/* 单日上限 */}
          <div
            style={{ borderColor: 'var(--line)', opacity: bnEnabled ? 1 : 0.5 }}
            className="rounded-xl border p-4"
          >
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Daily Push Limit</h4>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Max proactive pushes per day. Leave empty for the default (6) — enter 0 for no limit.
            </p>
            <div className="mt-3 w-24">
              <Input
                value={bnDailyLimit}
                onChange={(e) => setBnDailyLimit(e.target.value)}
                placeholder="6"
                disabled={!bnEnabled}
              />
            </div>
          </div>

          {/* 永远不静默的项：说明口径，避免用户以为闹钟会被吞掉 */}
          <div style={{ borderColor: 'var(--line-soft)' }} className="rounded-xl border p-4">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Never silenced</h4>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Calendar reminders you set yourself are always delivered — quiet hours never
              suppress them. They only count toward the daily push limit above.
            </p>
          </div>

          {bnLimitErr && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>{bnLimitErr}</p>
          )}
        </div>
      )}

      {/* ============ Remote Access（手机远程操作本机，Bearer 鉴权） ============ */}
      {activeSection === 'remote' && (
        <div className="space-y-6 p-6">
          <div>
            <h3 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>Remote Access</h3>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Let your phone remotely control this Mac&apos;s BobWork over a private tunnel (Tailscale / Cloudflare Tunnel). Once enabled, all non-local requests must carry a Bearer Token; the desktop app (localhost) is exempt and unaffected.
            </p>
          </div>

          {/* 总开关 */}
          <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Enable Remote Access</h4>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Turn this on only when a private tunnel is configured and the Mac stays powered on. The Token is the only key — leaking it is equivalent to exposing this Mac.
                </p>
              </div>
              <ToggleSwitch
                checked={raEnabled}
                onChange={() => applyRemoteAccess(raEnabled ? 'disable' : 'enable')}
                title={raEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>
          </div>

          {raEnabled && (
            <>
              {/* Token */}
              <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Access Token</h4>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Copy this into the Token field of the BobWork Remote app on your phone. Each rotation invalidates the old Token.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Input value={raToken} readOnly className="flex-1 font-mono text-xs" />
                  <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(raToken)}>Copy</Button>
                  <Button variant="ghost" size="sm" onClick={() => applyRemoteAccess('rotate')} disabled={raBusy}>Rotate</Button>
                </div>
              </div>

              {/* 鉴权模式 */}
              <div style={{ borderColor: 'var(--line)' }} className="rounded-xl border p-4">
                <h4 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Auth Mode</h4>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Loopback-exempt (default): only non-local requests need a Token — a precise fit for direct Tailscale / WireGuard connections. Strict: all requests (including local) require a Token — use this for Cloudflare Tunnel (its local hop is loopback and would bypass the exemption); in Strict mode the desktop app must be configured to auto-attach the Token.
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <ToggleSwitch
                    checked={raMode === 'strict'}
                    onChange={() => setRemoteMode(raMode === 'strict' ? 'loopback-exempt' : 'strict')}
                    title={raMode === 'strict' ? 'Strict' : 'Loopback-exempt'}
                  />
                  <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {raMode === 'strict' ? 'Strict (enforced on all requests)' : 'Loopback-exempt (default)'}
                  </span>
                </div>
              </div>
            </>
          )}

          {raMsg && <p className="text-xs" style={{ color: 'var(--info)' }}>{raMsg}</p>}
        </div>
      )}

      {/* ============ Hippo Browser ============ */}
      {activeSection === 'browser' && (
        <div className="px-6 py-5">
          {/* 面板标题 */}
          <h2 className="text-17 font-semibold" style={{ color: 'var(--ink-strong)' }}>Hippo Browser</h2>

          {/* 设置行分组容器：圆角卡片 + 发丝分隔线（左标签 / 右控件） */}
          <div
            className="mt-4 overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}
          >
            {/* AI Browser：全局互斥开关（开 = 只走 Hippo，关 = 只走 Bob Browser 扩展通道） */}
            <div className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-13 font-medium" style={{ color: 'var(--ink)' }}>
                  AI Browser
                </div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {aiBrowserHippo
                    ? 'Browser tasks run inside Hippo Browser (built-in browser_* tools, no extension needed). The Bob Browser channel is hidden from the model.'
                    : 'Browser tasks use the Bob Browser channel with your real Chrome (sign-ins, bookmarks, extensions). Turn on to run them inside Hippo Browser instead — no extension needed.'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 pt-0.5">
                <ToggleSwitch
                  checked={aiBrowserHippo}
                  onChange={() => setAiBrowserHippo((v) => !v)}
                  title={aiBrowserHippo ? 'Hippo Browser' : 'Bob Browser'}
                />
              </div>
            </div>

            <div className="border-t" style={{ borderColor: 'var(--line-soft)' }} />

            {/* Browse toolset：Hippo 侧栏工具面 Core / Full（仅 Hippo 通道生效） */}
            {aiBrowserHippo && (
              <>
                <div className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-13 font-medium" style={{ color: 'var(--ink)' }}>
                      Browse toolset
                    </div>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {browserToolsetCore
                        ? 'Core: everyday browse / download / PDF tools only — smaller context, faster first token. Turn off for all advanced browser tools.'
                        : 'Full: all browser tools, including cookies/storage, network/console and drag/coordinate/viewport controls.'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {browserToolsetCore ? 'Core' : 'Full'}
                    </span>
                    <ToggleSwitch
                      checked={browserToolsetCore}
                      onChange={() => setBrowserToolsetCore((v) => !v)}
                      title={browserToolsetCore ? 'Core toolset' : 'Full toolset'}
                    />
                  </div>
                </div>
                <div className="border-t" style={{ borderColor: 'var(--line-soft)' }} />
              </>
            )}

            <div className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1 text-13 font-medium" style={{ color: 'var(--ink)' }}>
                Cookies &amp; Site Data
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {browserClearMsg && (
                  <span className="text-xs" style={{ color: browserClearErr ? 'var(--danger)' : 'var(--success)' }}>
                    {browserClearMsg}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={browserClearBusy}
                  onClick={handleClearBrowserCookies}
                >
                  {browserClearBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash className="mr-1.5 h-3.5 w-3.5" />}
                  Clear
                </Button>
              </div>
            </div>

            <div className="border-t" style={{ borderColor: 'var(--line-soft)' }} />

            <div className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1 text-13 font-medium" style={{ color: 'var(--ink)' }}>
                Agent Default Behavior
              </div>
              <span className="shrink-0 text-13" style={{ color: 'var(--ink-muted)' }}>
                Current tab
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Templates / WeChat Bind 等：直接在右侧面板内嵌显示（不再弹窗） */}

      {/* Model Pool（Manage Models）：从 Role Assignment 的按钮以独立弹窗方式打开（左侧导航不包含该项） */}
      <Dialog open={modelPoolOpen} onOpenChange={setModelPoolOpen}>
        <DialogContent className="flex flex-col gap-0 p-0" style={{ width: '60rem', maxWidth: '60rem', height: '70vh' }}>
        <DialogTitle className="sr-only">Manage Models</DialogTitle>
        {(() => {
        const preset = PROVIDER_PRESETS.find((p) => p.type === selectedChatProvider)!;
        const pickerAll = fetchedModels[selectedChatProvider] || [];
        const searchLower = modelSearch.trim().toLowerCase();
        const pickerList = pickerAll.filter((m) => {
          if (categoryFilter !== 'all') {
            if (categoryFilter === 'other' && (['chat', 'vision', 'ocr', 'audio'].includes(m.category))) return false;
            if (categoryFilter !== 'other' && m.category !== categoryFilter) return false;
          }
          if (searchLower && !m.modelId.toLowerCase().includes(searchLower)) return false;
          return true;
        })
        .sort((a, b) => {
          const presetOrder = new Map(PROVIDER_PRESETS.find((p) => p.type === selectedChatProvider)?.models.map((pm, i) => [pm.modelId, i]) || []);
          const ai = presetOrder.has(a.modelId) ? presetOrder.get(a.modelId)! : Infinity;
          const bi = presetOrder.has(b.modelId) ? presetOrder.get(b.modelId)! : Infinity;
          return ai - bi;
        });
        const isTesting = testing[selectedChatProvider];
        // 本地无鉴权厂商（BobMultimodal/Ollama）无 Key 也可 Fetch Models
        const hasKey = apiKeys[selectedChatProvider].trim().length > 0 || NO_AUTH_LOCAL_PROVIDERS.has(selectedChatProvider);
        // 跨厂商候选池聚合（原 Model Pool 弹窗的概览，合并到本弹窗顶部，避免多层嵌套）
        const poolItems: { provider: ProviderType; modelId: string }[] = [];
        (Object.keys(selectedModels) as ProviderType[]).forEach((type) => {
          selectedModels[type].forEach((modelId) => poolItems.push({ provider: type, modelId }));
        });
        const poolCount = poolItems.length;
        return (
          <div className="flex min-h-0 flex-1 flex-col" style={{ overflow: 'hidden' }}>
              {/* Header：弹窗顶栏，仅保留关闭按钮 */}
              <div className="flex items-center justify-end border-b px-4 py-3" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}>
                <button type="button" onClick={() => setModelPoolOpen(false)} className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]" style={{ color: 'var(--ink-muted)' }} title="Close Model Pool">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Candidate pool overview（原 Model Pool 弹窗概览，合并至此） */}
              <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    Candidate Pool ({poolCount})
                  </span>
                  <span className="text-11" style={{ color: 'var(--ink-faint)' }}>— checked models across all providers</span>
                </div>
                {poolCount === 0 ? (
                  <p className="text-xs italic" style={{ color: 'var(--ink-muted)' }}>Pool is empty — check models below to add them.</p>
                ) : (
                  <div className="flex max-h-[72px] flex-wrap gap-1 overflow-y-auto">
                    {poolItems.map(({ provider, modelId }) => {
                      const fetched = fetchedModels[provider]?.find((m) => m.modelId === modelId);
                      const preset = PROVIDER_PRESETS.find((p) => p.type === provider);
                      const vendorLabel = fetched?.vendor || preset?.label || provider;
                      return (
                        <span key={`${provider}-${modelId}`} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}>
                          <span className="max-w-[140px] truncate font-medium">{modelId}</span>
                          <span className="shrink-0 rounded px-1 text-10 font-semibold" style={{ backgroundColor: VENDOR_BADGE_STYLE[vendorLabel]?.bg || 'var(--line-soft)', color: VENDOR_BADGE_STYLE[vendorLabel]?.fg || 'var(--ink-muted)' }}>{vendorLabel}</span>
                          <button type="button" onClick={() => toggleModel(provider, modelId)} title="Remove" className="shrink-0 transition-colors hover:opacity-70" style={{ color: 'var(--ink-muted)' }}>
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Body: compact stacked layout */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                    {/* Provider selector */}
                    <div>
                      <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Provider</label>
                      <select
                        value={pickerSide}
                        onChange={(e) => { setPickerSide(e.target.value as ProviderType); setModelSearch(''); setCategoryFilter('all'); }}
                        className="h-9 w-full rounded-md border px-2 text-sm"
                        style={paperInputStyle}
                      >
                        {PROVIDER_SIDEBAR_GROUPS.map((group) => (
                          <optgroup key={group.label} label={group.label}>
                            {group.types.map((t) => {
                              const p = PROVIDER_PRESETS.find((pp) => pp.type === t);
                              if (!p) return null;
                              return (
                                <option key={t} value={t}>
                                  {p.label}
                                </option>
                              );
                            })}
                          </optgroup>
                        ))}
                      </select>
                    </div>

                    {/* Base URL */}
                    <div>
                      <label className="mb-1 flex items-center justify-between text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                        <span>Base URL</span>
                        <button
                          type="button"
                          onClick={() => setCustomBaseUrlMode((prev) => ({ ...prev, [selectedChatProvider]: !prev[selectedChatProvider] }))}
                          className="text-xs font-medium transition-colors hover:underline"
                          style={{ color: 'var(--primary-strong)' }}
                        >
                          {customBaseUrlMode[selectedChatProvider] ? 'Reset' : 'Customize'}
                        </button>
                      </label>
                      {customBaseUrlMode[selectedChatProvider] ? (
                        <Input
                          type="text"
                          placeholder={preset.baseUrl}
                          value={customBaseUrls[selectedChatProvider]}
                          onChange={(e) => setCustomBaseUrls((prev) => ({ ...prev, [selectedChatProvider]: e.target.value }))}
                          className="h-9 w-full text-sm"
                          style={paperInputStyle}
                        />
                      ) : (
                        <div className="flex h-9 items-center rounded-md border px-2 font-mono text-sm" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}>
                          {resolveBaseUrl(selectedChatProvider)}
                        </div>
                      )}
                    </div>

                    {/* API Key */}
                    <div>
                      <label className="mb-1 flex items-center justify-between text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                        <span className="flex items-center gap-2">
                          <span>API Key</span>
                          <span
                            className="rounded-full px-1.5 py-0.5 text-10 font-medium"
                            style={{
                              backgroundColor: BINDING_MODE_STYLE[PROVIDER_BINDING_MODE[selectedChatProvider]].bg,
                              color: BINDING_MODE_STYLE[PROVIDER_BINDING_MODE[selectedChatProvider]].fg,
                            }}
                          >
                            {BINDING_MODE_LABEL[PROVIDER_BINDING_MODE[selectedChatProvider]]}
                          </span>
                        </span>
                        <a
                          href={PROVIDER_KEY_URLS[selectedChatProvider]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs transition-colors hover:underline"
                          style={{ color: 'var(--primary-strong)' }}
                        >
                          <ExternalLink className="h-3 w-3" />
                          {NO_AUTH_LOCAL_PROVIDERS.has(selectedChatProvider) ? 'No Key Needed' : 'Get Key'}
                        </a>
                      </label>
                      <div className="relative">
                        <Input
                          type={keyVisible[selectedChatProvider] ? 'text' : 'password'}
                          placeholder={NO_AUTH_LOCAL_PROVIDERS.has(selectedChatProvider) ? 'Local service — any value works' : `Enter ${preset.label} API Key`}
                          value={apiKeys[selectedChatProvider]}
                          onChange={(e) => setApiKeys((prev) => ({ ...prev, [selectedChatProvider]: e.target.value }))}
                          className="h-9 w-full pr-9 text-sm"
                          style={paperInputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => setKeyVisible((prev) => ({ ...prev, [selectedChatProvider]: !prev[selectedChatProvider] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-[var(--line-soft)]"
                          style={{ color: 'var(--ink-muted)' }}
                          title={keyVisible[selectedChatProvider] ? 'Hide' : 'Show'}
                        >
                          {keyVisible[selectedChatProvider] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Model ID + Test & Add */}
                    <div>
                      <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Model ID</label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          placeholder="e.g. deepseek:deepseek-flash"
                          value={newModelIdInput}
                          onChange={(e) => setNewModelIdInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && newModelIdInput.trim() && !verifyingModelId) { e.preventDefault(); testAndAddModel(selectedChatProvider); } }}
                          className="h-9 flex-1 text-sm"
                          style={paperInputStyle}
                        />
                        <Button
                          variant="solid"
                          tone="brand"
                          size="sm"
                          onClick={() => testAndAddModel(selectedChatProvider)}
                          disabled={!newModelIdInput.trim()}
                          loading={!!verifyingModelId}
                        >
                          {verifyingModelId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                          <span>{verifyingModelId ? 'Testing…' : 'Test & Add'}</span>
                        </Button>
                      </div>
                      {testAddFeedback && testAddFeedback.provider === selectedChatProvider && (
                        <p className="mt-1 text-xs" style={{ color: testAddFeedback.ok ? 'var(--success)' : 'var(--danger)' }}>
                          {testAddFeedback.ok ? <Check className="mr-0.5 inline h-3 w-3" /> : <AlertCircle className="mr-0.5 inline h-3 w-3" />}
                          {testAddFeedback.msg}
                        </p>
                      )}
                    </div>




              </div>

              {/* Footer: selected count + done */}
              <div className="flex items-center justify-between border-t px-4 py-3" style={{ borderColor: 'var(--line)' }}>
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {selectedModels[selectedChatProvider].size} selected
                </span>
                <Button variant="solid" tone="brand" size="sm" onClick={() => setModelPoolOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
        );
      })()}
        </DialogContent>
      </Dialog>
          </div>
        </div>

        {(saveError || saveStatus === 'saved' || saveStatus === 'saving') && (
        <div
          className="flex shrink-0 items-center gap-2 border-t px-4 py-3"
          style={{ borderColor: 'var(--line-soft)' }}
        >
          {saveError && (
            <div className="min-w-0 max-w-[360px]">
              <Callout
                variant="danger"
                size="sm"
                description={`${saveError}（改动将在下次修改时重试保存）`}
                icon={<AlertCircle className="h-4 w-4" />}
              />
            </div>
          )}
          {!saveError && saveStatus === 'saved' && (
            <div className="min-w-0 max-w-[200px]">
              <Callout variant="success" size="sm" title="Saved" icon={<Check className="h-4 w-4" />} />
            </div>
          )}
          {!saveError && saveStatus === 'saving' && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </div>
          )}
        </div>
        )}
        </TooltipProvider>



      </DialogContent>
    </Dialog>
  );
}
