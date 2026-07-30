'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Check, X, Loader2, Zap, Image, ArrowLeft, Pencil, Brain, Sparkles, ChevronRight, Plus, Wrench, Trash2, Plug } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  PROVIDER_PRESETS,
  type ProviderConfig,
  type ProviderType,
  type SelectedModel,
  type SearchConfig,
  type ModelSpec,
} from '@/lib/types';
import {
  loadSettings,
  updateProviders,
  updateSearch,
  updateVision,
  updateTaskModel,
  updateTextEditModel,
  updateCustomTools,
  updateMcpServers,
  migrateOldSettingsIfNeeded,
  type AppSettings,
  type CustomToolDef,
} from '@/lib/settings';
import type { McpServerConfig } from '@/lib/mcp/types';
import { MCP_PRESETS } from '@/lib/mcp/types';
import { inferModelSpec } from '@/lib/model-matcher';

/** 高权限 MCP 服务器：启用时弹确认，防止误开 */
const HIGH_RISK_MCP: Record<string, { title: string; message: string }> = {
  playwright: {
    title: '启用 Playwright？',
    message:
      'Playwright 可以完全控制你的浏览器：访问所有打开的网站、读取 Cookie、提交表单、下载文件，包括 localhost 管理面板。仅在你信任当前对话的前提下启用。确认启用吗？',
  },
  filesystem: {
    title: '启用 Filesystem MCP？',
    message:
      'Filesystem MCP 可读取和修改指定目录下的任意文件。默认限制为 ~/BobAgent/sandbox，但操作错误仍可能覆盖重要数据。确认启用吗？',
  },
  github: {
    title: '启用 GitHub MCP？',
    message:
      'GitHub MCP 持有 GITHUB_PERSONAL_ACCESS_TOKEN，可以代表你创建 Issue、提交代码、修改仓库设置。请确认 Token 权限范围最小化。确认启用吗？',
  },
  'brave-search': {
    title: '启用 Brave Search？',
    message:
      'Brave Search MCP 会把 AI 生成的搜索关键词发送到 Brave 服务器。虽然搜索本身是匿名的，但关键词可能包含敏感信息。确认启用吗？',
  },
  notion: {
    title: '启用 Notion MCP？',
    message:
      'Notion MCP 可以读写你授权的所有 Notion 页面和数据库，包括私人笔记。请确认已在 Notion 控制台限制了集成范围。确认启用吗？',
  },
};

function isHighRisk(server: McpServerConfig): { id: string; title: string; message: string } | null {
  if (HIGH_RISK_MCP[server.id]) return { id: server.id, ...HIGH_RISK_MCP[server.id] };
  // 非预置、名字里带 filesystem / shell / exec / playwright / browser 的也提示
  const name = (server.name || '').toLowerCase();
  const custom = [
    { kw: 'filesystem', title: '启用文件系统 MCP？', message: `即将启用 "${server.name}"，可能具备读取和修改本地文件的能力，请确认来源可信。确认启用吗？` },
    { kw: 'shell', title: '启用 Shell MCP？', message: `即将启用 "${server.name}"，它可能可以执行任意终端命令。请非常小心，仅对完全信任的 MCP 启用。确认启用吗？` },
    { kw: 'exec', title: '启用执行类 MCP？', message: `即将启用 "${server.name}"，名称中含 exec，可能可以执行本地命令。确认启用吗？` },
    { kw: 'playwright', title: '启用浏览器控制 MCP？', message: `即将启用 "${server.name}"，它可以控制你的浏览器访问任意网页。确认启用吗？` },
    { kw: 'browser', title: '启用浏览器控制 MCP？', message: `即将启用 "${server.name}"，它可以控制你的浏览器访问任意网页。确认启用吗？` },
  ].find((x) => name.includes(x.kw));
  if (custom) return { id: server.id, title: custom.title, message: custom.message };
  return null;
}

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigsChange: (configs: ProviderConfig[]) => void;
}

interface FetchedModel {
  modelId: string;
  ownedBy: string;
  thinking: boolean;
  category: 'chat' | 'embedding' | 'vision' | 'audio' | 'rerank' | 'other';
  spec?: ModelSpec;
}

interface ModelDetailState {
  [key: string]: boolean;
}

export function SettingsModal({
  open,
  onOpenChange,
  onConfigsChange,
}: SettingsModalProps) {
  const [apiKeys, setApiKeys] = useState<Record<ProviderType, string>>({
    deepseek: '',
    glm: '',
    moonshot: '',
    qwen: '',
    openai: '',
    doubao: '',
  });
  const [selectedModels, setSelectedModels] = useState<Record<ProviderType, Set<string>>>({
    deepseek: new Set(),
    glm: new Set(),
    moonshot: new Set(),
    qwen: new Set(),
    openai: new Set(),
    doubao: new Set(),
  });
  const [fetchedModels, setFetchedModels] = useState<Record<ProviderType, FetchedModel[]>>({
    deepseek: [],
    glm: [],
    moonshot: [],
    qwen: [],
    openai: [],
    doubao: [],
  });
  const [testing, setTesting] = useState<Record<ProviderType, boolean>>({
    deepseek: false,
    glm: false,
    moonshot: false,
    qwen: false,
    openai: false,
    doubao: false,
  });
  const [testError, setTestError] = useState<Record<ProviderType, string>>({
    deepseek: '',
    glm: '',
    moonshot: '',
    qwen: '',
    openai: '',
    doubao: '',
  });
  const [saved, setSaved] = useState(false);
  const [view, setView] = useState<'home' | 'add'>('home');
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ apiKey: '', baseUrl: '' });
  const [expandedModels, setExpandedModels] = useState<ModelDetailState>({});

  // 视觉模型状态（与普通模型设置一致的模式）
  const [visionProvider, setVisionProvider] = useState<ProviderType>('glm');
  const [visionApiKey, setVisionApiKey] = useState<string>('');
  const [visionFetchedModels, setVisionFetchedModels] = useState<FetchedModel[]>([]);
  const [visionTesting, setVisionTesting] = useState(false);
  const [visionTestError, setVisionTestError] = useState('');
  const [selectedVisionModel, setSelectedVisionModel] = useState<string>('');

  // 辅助视觉模型状态（主模型失败时自动切换）
  const [auxVisionProvider, setAuxVisionProvider] = useState<ProviderType>('qwen');
  const [auxVisionApiKey, setAuxVisionApiKey] = useState<string>('');
  const [auxVisionFetchedModels, setAuxVisionFetchedModels] = useState<FetchedModel[]>([]);
  const [auxVisionTesting, setAuxVisionTesting] = useState(false);
  const [auxVisionTestError, setAuxVisionTestError] = useState('');
  const [selectedAuxVisionModel, setSelectedAuxVisionModel] = useState<string>('');

  // 任务归纳模型（与视觉模型同结构）
  const [taskModelProvider, setTaskModelProvider] = useState<ProviderType>('glm');
  const [taskModelApiKey, setTaskModelApiKey] = useState<string>('');
  const [taskModelFetchedModels, setTaskModelFetchedModels] = useState<FetchedModel[]>([]);
  const [taskModelTesting, setTaskModelTesting] = useState(false);
  const [taskModelTestError, setTaskModelTestError] = useState('');
  const [selectedTaskModel, setSelectedTaskModel] = useState<string>('');

  // 文本编辑模型（独立于 Wanted）
  const [editModelProvider, setEditModelProvider] = useState<ProviderType>('glm');
  const [editModelApiKey, setEditModelApiKey] = useState<string>('');
  const [editModelFetchedModels, setEditModelFetchedModels] = useState<FetchedModel[]>([]);
  const [editModelTesting, setEditModelTesting] = useState(false);
  const [editModelTestError, setEditModelTestError] = useState('');
  const [selectedEditModel, setSelectedEditModel] = useState<string>('');

  // 自定义工具列表
  const [customTools, setCustomTools] = useState<CustomToolDef[]>([]);

  // MCP 服务器列表
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);

  useEffect(() => {
    if (open) {
      const load = async () => {
        // 先尝试迁移旧数据
        let settings: AppSettings = await migrateOldSettingsIfNeeded() || await loadSettings();

        setSearchConfig(settings.search);

        const newKeys: Record<ProviderType, string> = { deepseek: '', glm: '', moonshot: '', qwen: '', openai: '', doubao: '' };
        const newSelected: Record<ProviderType, Set<string>> = {
          deepseek: new Set(),
          glm: new Set(),
          moonshot: new Set(),
          qwen: new Set(),
          openai: new Set(),
          doubao: new Set(),
        };
        for (const cfg of settings.providers) {
          newKeys[cfg.type] = cfg.apiKey;
          newSelected[cfg.type] = new Set((cfg.selectedModels ?? []).map((s) => s.modelId));
        }
        const newFetched: Record<ProviderType, FetchedModel[]> = {
          deepseek: [],
          glm: [],
          moonshot: [],
          qwen: [],
          openai: [],
          doubao: [],
        };
        for (const cfg of settings.providers) {
          newFetched[cfg.type] = (cfg.selectedModels ?? []).map((s) => ({
            modelId: s.modelId,
            ownedBy: cfg.type,
            thinking: s.thinking,
            category: 'chat' as const,
          }));
        }
        setApiKeys(newKeys);
        setSelectedModels(newSelected);
        setFetchedModels(newFetched);
        setTestError({ deepseek: '', glm: '', moonshot: '', qwen: '', openai: '', doubao: '' });
        setSaved(false);
        setView('home');

        // 视觉模型配置从全局 settings 读取
        if (settings.vision) {
          setVisionApiKey(settings.vision.apiKey || '');
          setSelectedVisionModel(settings.vision.defaultModel || '');
          if (settings.vision.defaultProvider) {
            setVisionProvider(settings.vision.defaultProvider as ProviderType);
          }
        }

        // 辅助视觉模型配置
        if (settings.vision) {
          setAuxVisionApiKey(settings.vision.auxiliaryApiKey || '');
          setSelectedAuxVisionModel(settings.vision.auxiliaryModel || '');
          if (settings.vision.auxiliaryProvider) {
            setAuxVisionProvider(settings.vision.auxiliaryProvider as ProviderType);
          }
        }

        // 任务归纳模型配置
        if (settings.taskModel) {
          setTaskModelApiKey(settings.taskModel.apiKey || '');
          setSelectedTaskModel(settings.taskModel.defaultModel || '');
          if (settings.taskModel.defaultProvider) {
            setTaskModelProvider(settings.taskModel.defaultProvider as ProviderType);
          }
        }
        // 文本编辑模型配置
        if (settings.textEditModel) {
          setEditModelApiKey(settings.textEditModel.apiKey || '');
          setSelectedEditModel(settings.textEditModel.defaultModel || '');
          if (settings.textEditModel.defaultProvider) {
            setEditModelProvider(settings.textEditModel.defaultProvider as ProviderType);
          }
        }

        // 自定义工具
        setCustomTools(settings.customTools || []);

        // MCP 服务器：合并已保存配置 + 新增预置（按 id 去重，用户自定义的在前，保留 enabled 状态）
        const saved = settings.mcpServers && settings.mcpServers.length > 0 ? settings.mcpServers : [];
        const savedIds = new Set(saved.map((s) => s.id));
        const newPresets = MCP_PRESETS.filter((p) => !savedIds.has(p.id));
        setMcpServers([...saved, ...newPresets]);
      };
      load();
    }
  }, [open]);

  const toggleModel = (type: ProviderType, modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev[type]);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return { ...prev, [type]: next };
    });
  };

  const testConnection = async (type: ProviderType, preset: typeof PROVIDER_PRESETS[0]) => {
    const apiKey = apiKeys[type].trim();
    if (!apiKey) return;

    setTesting((prev) => ({ ...prev, [type]: true }));
    setTestError((prev) => ({ ...prev, [type]: '' }));

    try {
      const resp = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: type,
          apiKey,
          baseUrl: preset.baseUrl,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setTestError((prev) => ({ ...prev, [type]: data.error || 'Connection failed' }));
        setFetchedModels((prev) => ({ ...prev, [type]: [] }));
        return;
      }

      const models: FetchedModel[] = (data.models || []).map((m: { modelId: string; ownedBy?: string; thinking?: boolean; type?: string }) => {
        const modelId = m.modelId;
        const thinking = m.thinking || false;
        const presetModel = preset.models.find((pm) => pm.modelId === modelId);
        let spec: ModelSpec | undefined = presetModel?.spec;

        if (!spec) {
          spec = inferModelSpec(modelId, thinking);
        }

        return {
          modelId,
          ownedBy: m.ownedBy || '',
          thinking,
          category: (m.type as FetchedModel['category']) || 'chat',
          spec,
        };
      });

      setFetchedModels((prev) => ({ ...prev, [type]: models }));

      // 默认选中所有 chat 类模型
      setSelectedModels((prev) => {
        const chatModels = models.filter((m) => m.category === 'chat');
        if (prev[type].size === 0 && chatModels.length > 0) {
          return { ...prev, [type]: new Set(chatModels.map((m) => m.modelId)) };
        }
        return prev;
      });
    } catch {
      setTestError((prev) => ({ ...prev, [type]: 'Network request failed' }));
    } finally {
      setTesting((prev) => ({ ...prev, [type]: false }));
    }
  };

  // 视觉模型获取列表
  const testVisionConnection = async () => {
    const apiKey = visionApiKey.trim();
    if (!apiKey) return;

    const preset = PROVIDER_PRESETS.find((p) => p.type === visionProvider);
    if (!preset) return;

    setVisionTesting(true);
    setVisionTestError('');

    try {
      const resp = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: visionProvider,
          apiKey,
          baseUrl: preset.baseUrl,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setVisionTestError(data.error || 'Connection failed');
        setVisionFetchedModels([]);
        return;
      }

      const models: FetchedModel[] = (data.models || [])
        .filter((m: { type?: string }) => m.type === 'vision')
        .map((m: { modelId: string; ownedBy?: string; thinking?: boolean; type?: string }) => {
          const modelId = m.modelId;
          const thinking = m.thinking || false;
          return {
            modelId,
            ownedBy: m.ownedBy || '',
            thinking,
            category: (m.type as FetchedModel['category']) || 'chat',
            spec: inferModelSpec(modelId, thinking),
          };
        });

      setVisionFetchedModels(models);
    } catch {
      setVisionTestError('Network request failed');
    } finally {
      setVisionTesting(false);
    }
  };

  // 辅助视觉模型获取列表
  const testAuxVisionConnection = async () => {
    const apiKey = auxVisionApiKey.trim();
    if (!apiKey) return;

    const preset = PROVIDER_PRESETS.find((p) => p.type === auxVisionProvider);
    if (!preset) return;

    setAuxVisionTesting(true);
    setAuxVisionTestError('');

    try {
      const resp = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: auxVisionProvider,
          apiKey,
          baseUrl: preset.baseUrl,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setAuxVisionTestError(data.error || 'Connection failed');
        setAuxVisionFetchedModels([]);
        return;
      }

      const models: FetchedModel[] = (data.models || [])
        .filter((m: { type?: string }) => m.type === 'vision')
        .map((m: { modelId: string; ownedBy?: string; thinking?: boolean; type?: string }) => {
          const modelId = m.modelId;
          const thinking = m.thinking || false;
          return {
            modelId,
            ownedBy: m.ownedBy || '',
            thinking,
            category: (m.type as FetchedModel['category']) || 'chat',
            spec: inferModelSpec(modelId, thinking),
          };
        });

      setAuxVisionFetchedModels(models);
    } catch {
      setAuxVisionTestError('Network request failed');
    } finally {
      setAuxVisionTesting(false);
    }
  };

  // 任务归纳模型获取列表（过滤 chat 类模型）
  const testTaskModelConnection = async () => {
    const apiKey = taskModelApiKey.trim();
    if (!apiKey) return;

    const preset = PROVIDER_PRESETS.find((p) => p.type === taskModelProvider);
    if (!preset) return;

    setTaskModelTesting(true);
    setTaskModelTestError('');

    try {
      const resp = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: taskModelProvider,
          apiKey,
          baseUrl: preset.baseUrl,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setTaskModelTestError(data.error || 'Connection failed');
        setTaskModelFetchedModels([]);
        return;
      }

      const models: FetchedModel[] = (data.models || [])
        .filter((m: { type?: string }) => m.type === 'chat' || !m.type || m.type === 'other')
        .filter((m: { modelId: string }) => !/vision|vl|embedding|rerank|audio/i.test(m.modelId))
        .map((m: { modelId: string; ownedBy?: string; thinking?: boolean; type?: string }) => {
          const modelId = m.modelId;
          const thinking = m.thinking || false;
          return {
            modelId,
            ownedBy: m.ownedBy || '',
            thinking,
            category: (m.type as FetchedModel['category']) || 'chat',
            spec: inferModelSpec(modelId, thinking),
          };
        });

      setTaskModelFetchedModels(models);
    } catch {
      setTaskModelTestError('Network request failed');
    } finally {
      setTaskModelTesting(false);
    }
  };

  // 文本编辑模型获取列表（同任务归纳模型逻辑）
  const testEditModelConnection = async () => {
    const apiKey = editModelApiKey.trim();
    if (!apiKey) return;

    const preset = PROVIDER_PRESETS.find((p) => p.type === editModelProvider);
    if (!preset) return;

    setEditModelTesting(true);
    setEditModelTestError('');

    try {
      const resp = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: editModelProvider,
          apiKey,
          baseUrl: preset.baseUrl,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setEditModelTestError(data.error || 'Connection failed');
        setEditModelFetchedModels([]);
        return;
      }

      const models: FetchedModel[] = (data.models || [])
        .filter((m: { type?: string }) => m.type === 'chat' || !m.type || m.type === 'other')
        .filter((m: { modelId: string }) => !/vision|vl|embedding|rerank|audio/i.test(m.modelId))
        .map((m: { modelId: string; ownedBy?: string; thinking?: boolean; type?: string }) => {
          const modelId = m.modelId;
          const thinking = m.thinking || false;
          return {
            modelId,
            ownedBy: m.ownedBy || '',
            thinking,
            category: (m.type as FetchedModel['category']) || 'chat',
            spec: inferModelSpec(modelId, thinking),
          };
        });

      setEditModelFetchedModels(models);
    } catch {
      setEditModelTestError('Network request failed');
    } finally {
      setEditModelTesting(false);
    }
  };

  const handleSave = async () => {
    // 保存前风险确认（有自定义工具或开启了高风险 MCP）
    const activeCustomTools = customTools.filter((t) => t.enabled);
    const activeHighRiskMcp = mcpServers.filter((s) => s.enabled && isHighRisk(s));
    let confirmed = true;
    if (activeCustomTools.length > 0 || activeHighRiskMcp.length > 0) {
      const lines: string[] = [];
      if (activeCustomTools.length > 0)
        lines.push(`• ${activeCustomTools.length} 个启用的自定义 HTTP 工具：${activeCustomTools.map((t) => t.name || '(unnamed)').join('、')}`);
      if (activeHighRiskMcp.length > 0)
        lines.push(`• ${activeHighRiskMcp.length} 个启用的高权限 MCP：${activeHighRiskMcp.map((s) => s.name || s.id).join('、')}`);
      const msg =
        '保存并启用以下高权限功能？\n\n' +
        lines.join('\n') +
        '\n\nAI 在对话中会根据描述自动调用这些功能，可能把对话数据发送到外部服务器或修改本地文件。请确认完全理解风险后再保存。';
      confirmed = window.confirm(msg);
    }
    if (!confirmed) return;

    const newConfigs: ProviderConfig[] = [];
    (Object.keys(apiKeys) as ProviderType[]).forEach((type) => {
      const key = apiKeys[type].trim();
      if (!key) return;
      const ids = Array.from(selectedModels[type]);
      const sel: SelectedModel[] = ids.map((id) => {
        const fetched = fetchedModels[type].find((m) => m.modelId === id);
        return { modelId: id, thinking: fetched?.thinking ?? false };
      });
      newConfigs.push({
        type,
        apiKey: key,
        selectedModels: sel,
      });
    });

    // 保存到统一 settings
    await updateProviders(newConfigs);
    await updateSearch({
      apiKey: searchConfig.apiKey.trim(),
      baseUrl: searchConfig.baseUrl.trim(),
    });
    await updateVision({
      defaultProvider: visionProvider,
      defaultModel: selectedVisionModel,
      apiKey: visionApiKey.trim(),
      baseUrl: PROVIDER_PRESETS.find((p) => p.type === visionProvider)?.baseUrl || '',
      auxiliaryProvider: auxVisionProvider,
      auxiliaryModel: selectedAuxVisionModel,
      auxiliaryApiKey: auxVisionApiKey.trim(),
      auxiliaryBaseUrl: PROVIDER_PRESETS.find((p) => p.type === auxVisionProvider)?.baseUrl || '',
    });

    await updateTaskModel({
      defaultProvider: taskModelProvider,
      defaultModel: selectedTaskModel,
      apiKey: taskModelApiKey.trim(),
      baseUrl: PROVIDER_PRESETS.find((p) => p.type === taskModelProvider)?.baseUrl || '',
    });

    await updateTextEditModel({
      defaultProvider: editModelProvider,
      defaultModel: selectedEditModel,
      apiKey: editModelApiKey.trim(),
      baseUrl: PROVIDER_PRESETS.find((p) => p.type === editModelProvider)?.baseUrl || '',
    });

    await updateCustomTools(customTools);

    await updateMcpServers(mcpServers);

    onConfigsChange(newConfigs);
    window.dispatchEvent(new Event('provider-configs-changed'));

    setSaved(true);
    setTimeout(() => onOpenChange(false), 600);
  };

  const paperInputStyle = {
    fontFamily: "'Noto Serif SC', serif",
    backgroundColor: 'oklch(0.97 0.008 80)',
    borderColor: 'oklch(0.85 0.01 70)',
    color: 'oklch(0.25 0.02 50)',
  } as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0" style={{ fontFamily: "'Noto Serif SC', serif" }}>
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base" style={{ color: 'oklch(0.30 0.015 50)' }}>
            <KeyRound className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
            Model Providers
          </DialogTitle>
          <DialogDescription className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
            Enter your API Key and click 'Fetch Models' to auto-discover available models. Keys are stored locally only.
          </DialogDescription>
        </DialogHeader>

        {view === 'home' ? (
          /* ========== 首页：已安装模型总览 ========== */
          <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
            {/* 已安装聊天模型 */}
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    Installed Models
                  </span>
                </div>
              </div>

              {(() => {
                const installedProviders = (Object.keys(apiKeys) as ProviderType[]).filter(
                  (type) => apiKeys[type].trim() && selectedModels[type].size > 0
                );
                if (installedProviders.length === 0) {
                  return (
                    <div
                      className="rounded-lg border px-3 py-4 text-center"
                      style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed' }}
                    >
                      <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        No models installed
                      </span>
                    </div>
                  );
                }
                return installedProviders.map((type) => {
                  const preset = PROVIDER_PRESETS.find((p) => p.type === type);
                  const models = Array.from(selectedModels[type]);
                  const fetched = fetchedModels[type];
                  return (
                    <div
                      key={type}
                      className="mb-2 rounded-lg border px-3 py-2"
                      style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                    >
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-xs font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                          {preset?.label || type}
                        </span>
                        <span className="text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                          {models.length} model{models.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {models.map((modelId) => {
                          const info = fetched.find((m) => m.modelId === modelId);
                          const presetModel = preset?.models.find((pm) => pm.modelId === modelId);
                          const label = presetModel?.label || modelId;
                          return (
                            <span
                              key={modelId}
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                              style={{
                                backgroundColor: 'oklch(0.90 0.02 80)',
                                color: 'oklch(0.35 0.02 50)',
                              }}
                            >
                              <span
                                className="inline-block h-1 w-1 rounded-full"
                                style={{
                                  backgroundColor: (info?.thinking ?? false)
                                    ? 'oklch(0.55 0.15 45)'
                                    : 'oklch(0.65 0.02 55)',
                                }}
                              />
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* 视觉模型 */}
            <div className="mb-4 border-t pt-4" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Image className="h-4 w-4" style={{ color: 'oklch(0.50 0.12 45)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    Vision Model
                  </span>
                </div>
              </div>

              {selectedVisionModel ? (
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                        {selectedVisionModel}
                      </span>
                      <span className="ml-2 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {PROVIDER_PRESETS.find((p) => p.type === visionProvider)?.label || visionProvider}
                      </span>
                    </div>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px]"
                      style={{
                        backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                        color: 'oklch(0.50 0.12 45)',
                      }}
                    >
                      Primary
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-lg border px-3 py-4 text-center"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed' }}
                >
                  <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                    No vision model configured
                  </span>
                </div>
              )}

              {selectedAuxVisionModel && (
                <div
                  className="mt-2 rounded-lg border px-3 py-2"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                        {selectedAuxVisionModel}
                      </span>
                      <span className="ml-2 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {PROVIDER_PRESETS.find((p) => p.type === auxVisionProvider)?.label || auxVisionProvider}
                      </span>
                    </div>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px]"
                      style={{
                        backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
                        color: 'oklch(0.50 0.12 220)',
                      }}
                    >
                      Backup
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 任务归纳模型 */}
            <div className="border-t pt-4" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 220)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    Wanted
                  </span>
                </div>
              </div>

              {selectedTaskModel ? (
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                        {selectedTaskModel}
                      </span>
                      <span className="ml-2 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {PROVIDER_PRESETS.find((p) => p.type === taskModelProvider)?.label || taskModelProvider}
                      </span>
                    </div>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px]"
                      style={{
                        backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
                        color: 'oklch(0.50 0.12 220)',
                      }}
                    >
                      Active
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-lg border px-3 py-4 text-center"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed' }}
                >
                  <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                    No Wanted model configured
                  </span>
                </div>
              )}
            </div>

            {/* 文本编辑模型 */}
            <div className="border-t pt-4" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Pencil className="h-4 w-4" style={{ color: 'oklch(0.50 0.12 180)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    Text Edit
                  </span>
                </div>
              </div>

              {selectedEditModel ? (
                <div
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                        {selectedEditModel}
                      </span>
                      <span className="ml-2 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {PROVIDER_PRESETS.find((p) => p.type === editModelProvider)?.label || editModelProvider}
                      </span>
                    </div>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px]"
                      style={{
                        backgroundColor: 'oklch(0.50 0.12 180 / 0.12)',
                        color: 'oklch(0.50 0.12 180)',
                      }}
                    >
                      Active
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-lg border px-3 py-4 text-center"
                  style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed' }}
                >
                  <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                    No text edit model configured (falls back to Wanted / chat)
                  </span>
                </div>
              )}
            </div>

            {/* 自定义工具 */}
            <div className="mb-4 border-t pt-4" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    Custom Tools
                  </span>
                </div>
                {customTools.filter((t) => t.enabled).length > 0 && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.50 0.12 45)' }}>
                    <Check className="h-3 w-3" />
                    {customTools.filter((t) => t.enabled).length} active
                  </span>
                )}
              </div>
              {customTools.length === 0 ? (
                <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  No custom tools configured
                </span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {customTools.map((tool, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: tool.enabled ? 'oklch(0.62 0.17 45 / 0.08)' : 'oklch(0.95 0.005 80)',
                        color: tool.enabled ? 'oklch(0.50 0.12 45)' : 'oklch(0.55 0.02 50 / 0.5)',
                        border: `1px solid ${tool.enabled ? 'oklch(0.62 0.17 45 / 0.2)' : 'oklch(0.88 0.01 70)'}`,
                      }}
                    >
                      {tool.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* MCP 服务器 */}
            <div className="mb-4 border-t pt-4" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Plug className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                    MCP Servers
                  </span>
                </div>
                {mcpServers.filter((s) => s.enabled).length > 0 && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.50 0.12 45)' }}>
                    <Check className="h-3 w-3" />
                    {mcpServers.filter((s) => s.enabled).length} connected
                  </span>
                )}
              </div>
              {mcpServers.length === 0 ? (
                <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  No MCP servers configured
                </span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {mcpServers.map((server) => (
                    <span
                      key={server.id}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: server.enabled ? 'oklch(0.62 0.17 45 / 0.08)' : 'oklch(0.95 0.005 80)',
                        color: server.enabled ? 'oklch(0.50 0.12 45)' : 'oklch(0.55 0.02 50 / 0.5)',
                        border: `1px solid ${server.enabled ? 'oklch(0.62 0.17 45 / 0.2)' : 'oklch(0.88 0.01 70)'}`,
                      }}
                    >
                      {server.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 修改按钮 */}
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setView('add')}
                className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45 / 0.1)',
                  color: 'oklch(0.50 0.12 45)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'oklch(0.62 0.17 45 / 0.18)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'oklch(0.62 0.17 45 / 0.1)';
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Modify
              </button>
            </div>
          </div>
        ) : (
          /* ========== 第二级：添加/管理模型 ========== */
          <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
            {/* 返回按钮 */}
            <button
              type="button"
              onClick={() => setView('home')}
              className="mb-2 flex items-center gap-1 text-xs transition-colors hover:underline"
              style={{ color: 'oklch(0.55 0.02 50)' }}
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>

            {PROVIDER_PRESETS.map((preset) => {
            const hasKey = apiKeys[preset.type].trim().length > 0;
            const models = fetchedModels[preset.type];
            const isTesting = testing[preset.type];
            const error = testError[preset.type];

            return (
              <div key={preset.type} className="border-b py-4 last:border-b-0" style={{ borderColor: 'oklch(0.88 0.01 70)' }}>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                      {preset.label}
                    </span>
                    <span className="ml-2 text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                      {preset.description}
                    </span>
                  </div>
                  {hasKey && models.length > 0 && (
                    <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.50 0.12 45)' }}>
                      <Check className="h-3 w-3" />
                      {models.length} models
                    </span>
                  )}
                </div>

                {/* API Key 输入 */}
                <div className="relative">
                  <Input
                    type="text"
                    placeholder={`Enter ${preset.label} API Key`}
                    value={apiKeys[preset.type]}
                    onChange={(e) =>
                      setApiKeys((prev) => ({ ...prev, [preset.type]: e.target.value }))
                    }
                    className="h-8 pr-9 text-xs"
                    style={paperInputStyle}
                  />
                </div>

                {/* 获取模型按钮 */}
                {hasKey && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => testConnection(preset.type, preset)}
                      disabled={isTesting}
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
                      style={{
                        backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                        color: 'oklch(0.50 0.12 45)',
                      }}
                    >
                      {isTesting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Zap className="h-3 w-3" />
                      )}
                      {isTesting ? 'Fetching...' : 'Fetch Models'}
                    </button>

                    {hasKey && (
                      <button
                        type="button"
                        onClick={() => {
                          setApiKeys((prev) => ({ ...prev, [preset.type]: '' }));
                          setSelectedModels((prev) => ({ ...prev, [preset.type]: new Set() }));
                          setFetchedModels((prev) => ({ ...prev, [preset.type]: [] }));
                          setTestError((prev) => ({ ...prev, [preset.type]: '' }));
                        }}
                        className="flex items-center gap-1 text-[10px] transition-colors hover:underline"
                        style={{ color: 'oklch(0.55 0.02 50)' }}
                      >
                        <X className="h-2.5 w-2.5" />
                        Clear
                      </button>
                    )}
                  </div>
                )}

                {/* 错误提示 */}
                {error && (
                  <p className="mt-2 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>
                    {error}
                  </p>
                )}

                {/* 获取到的模型列表 */}
                {models.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      Select Model ({models.filter((m) => m.category === 'chat').length} chat / {models.filter((m) => m.category !== 'chat').length} other)
                    </p>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {models.map((m) => {
                        const checked = selectedModels[preset.type].has(m.modelId);
                        const key = `${preset.type}-${m.modelId}`;
                        const isExpanded = expandedModels[key];
                        const presetModel = preset.models.find((pm) => pm.modelId === m.modelId);
                        const spec: ModelSpec | undefined = presetModel?.spec;

                        return (
                          <div key={key}>
                            <label
                              className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                            >
                              <button
                                type="button"
                                onClick={() => toggleModel(preset.type, m.modelId)}
                                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
                                style={{
                                  backgroundColor: checked ? 'oklch(0.62 0.17 45)' : 'transparent',
                                  borderColor: checked ? 'oklch(0.62 0.17 45)' : 'oklch(0.75 0.02 60)',
                                }}
                              >
                                {checked && <Check className="h-3 w-3 text-white" />}
                              </button>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                                    {m.modelId}
                                  </span>
                                  {m.thinking && (
                                    <span
                                      className="shrink-0 rounded px-1 py-px text-[9px] leading-tight"
                                      style={{
                                        backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                                        color: 'oklch(0.50 0.12 45)',
                                      }}
                                    >
                                      Thinking
                                    </span>
                                  )}
                                  {m.category !== 'chat' && (
                                    <span
                                      className="shrink-0 rounded px-1 py-px text-[9px] leading-tight"
                                      style={{
                                        backgroundColor: 'oklch(0.70 0.01 60 / 0.15)',
                                        color: 'oklch(0.50 0.01 50)',
                                      }}
                                    >
                                      {m.category === 'embedding' ? 'Embedding' : m.category === 'vision' ? 'Vision' : m.category === 'audio' ? 'Voice' : 'Other'}
                                    </span>
                                  )}
                                </div>
                                {m.ownedBy && (
                                  <span className="text-[10px]" style={{ color: 'oklch(0.60 0.015 50)' }}>
                                    {m.ownedBy}
                                  </span>
                                )}
                              </div>
                              {spec && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedModels((prev) => ({ ...prev, [key]: !isExpanded }));
                                  }}
                                  className="mt-0.5 text-[10px] transition-colors"
                                  style={{ color: 'oklch(0.55 0.02 50)' }}
                                >
                                  {isExpanded ? 'Collapse' : 'Details'}
                                </button>
                              )}
                            </label>

                            {isExpanded && spec && (
                              <div className="ml-6 mt-1 rounded-md border p-2" style={{ backgroundColor: 'oklch(0.97 0.008 80)', borderColor: 'oklch(0.85 0.01 70)' }}>
                                {spec.capabilities && spec.capabilities.length > 0 && (
                                  <div className="mb-1.5">
                                    <span className="text-[9px] font-semibold" style={{ color: 'oklch(0.50 0.02 50)' }}>Capabilities:</span>
                                    <div className="flex flex-wrap gap-1">
                                      {spec.capabilities.map((cap) => (
                                        <span
                                          key={cap}
                                          className="rounded px-1 py-px text-[9px]"
                                          style={{ backgroundColor: 'oklch(0.90 0.02 80)', color: 'oklch(0.45 0.02 50)' }}
                                        >
                                          {cap === 'reasoning' ? 'Reasoning' : cap === 'conversation' ? 'Chat' : cap === 'coding' ? 'Code' : cap === 'creative' ? 'Creativity' : cap === 'analysis' ? 'Analysis' : cap === 'multilingual' ? 'Multilingual' : cap === 'long-context' ? 'Long Context' : cap}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {spec.strengths && spec.strengths.length > 0 && (
                                  <div className="mb-1.5">
                                    <span className="text-[9px] font-semibold" style={{ color: 'oklch(0.50 0.12 45)' }}>Advantages:</span>
                                    <div className="flex flex-wrap gap-1">
                                      {spec.strengths.map((s) => (
                                        <span key={s} className="text-[9px]" style={{ color: 'oklch(0.45 0.02 50)' }}>• {s}</span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {spec.useCases && spec.useCases.length > 0 && (
                                  <div>
                                    <span className="text-[9px] font-semibold" style={{ color: 'oklch(0.50 0.02 50)' }}>Use Cases:</span>
                                    <div className="flex flex-wrap gap-1">
                                      {spec.useCases.map((uc) => (
                                        <span key={uc} className="text-[9px]" style={{ color: 'oklch(0.50 0.02 50)' }}>• {uc}</span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {spec.contextWindow && (
                                  <div className="mt-1.5 text-[9px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                                    Context Window:{(spec.contextWindow / 1000).toFixed(0)}K
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* 视觉模型设置（与普通模型设置一致的模式） */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Image className="h-4 w-4" style={{ color: 'oklch(0.50 0.12 45)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  Vision Model
                </span>
              </div>
              {visionApiKey.trim() && visionFetchedModels.length > 0 && (
                <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.50 0.12 45)' }}>
                  <Check className="h-3 w-3" />
                  {visionFetchedModels.length} models
                </span>
              )}
            </div>

            {/* 提供商选择 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                Select Provider
              </label>
              <select
                value={visionProvider}
                onChange={(e) => {
                  setVisionProvider(e.target.value as ProviderType);
                  setVisionFetchedModels([]);
                  setVisionTestError('');
                  setSelectedVisionModel('');
                }}
                className="w-full h-8 rounded-md border px-3 text-xs"
                style={{
                  fontFamily: "'Noto Serif SC', serif",
                  backgroundColor: 'oklch(0.97 0.008 80)',
                  borderColor: 'oklch(0.85 0.01 70)',
                  color: 'oklch(0.25 0.02 50)',
                }}
              >
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.type} value={preset.type}>
                    {preset.label} ({preset.description})
                  </option>
                ))}
              </select>
            </div>

            {/* API Key 输入 */}
            <div className="relative">
              <Input
                type="text"
                placeholder={`Enter ${PROVIDER_PRESETS.find((p) => p.type === visionProvider)?.label || ''} API Key`}
                value={visionApiKey}
                onChange={(e) => setVisionApiKey(e.target.value)}
                className="h-8 pr-9 text-xs"
                style={paperInputStyle}
              />
            </div>

            {/* 获取模型按钮 */}
            {visionApiKey.trim() && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={testVisionConnection}
                  disabled={visionTesting}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                    color: 'oklch(0.50 0.12 45)',
                  }}
                >
                  {visionTesting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                  {visionTesting ? 'Fetching...' : 'Fetch Models'}
                </button>

                {visionApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setVisionApiKey('');
                      setVisionFetchedModels([]);
                      setSelectedVisionModel('');
                      setVisionTestError('');
                    }}
                    className="flex items-center gap-1 text-[10px] transition-colors hover:underline"
                    style={{ color: 'oklch(0.55 0.02 50)' }}
                  >
                    <X className="h-2.5 w-2.5" />
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* 错误提示 */}
            {visionTestError && (
              <p className="mt-2 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>
                {visionTestError}
              </p>
            )}

            {/* 获取到的模型列表（单选） */}
            {visionFetchedModels.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                  Select Vision Model (single)
                </p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {visionFetchedModels.map((m) => {
                    const checked = selectedVisionModel === m.modelId;
                    const key = `vision-${m.modelId}`;

                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedVisionModel(m.modelId)}
                          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors"
                          style={{
                            borderColor: checked ? 'oklch(0.62 0.17 45)' : 'oklch(0.75 0.02 60)',
                          }}
                        >
                          {checked && (
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: 'oklch(0.62 0.17 45)' }}
                            />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                              {m.modelId}
                            </span>
                            {m.category !== 'chat' && (
                              <span
                                className="shrink-0 rounded px-1 py-px text-[9px] leading-tight"
                                style={{
                                  backgroundColor: 'oklch(0.70 0.01 60 / 0.15)',
                                  color: 'oklch(0.50 0.01 50)',
                                }}
                              >
                                {m.category === 'embedding' ? 'Embedding' : m.category === 'vision' ? 'Vision' : m.category === 'audio' ? 'Voice' : 'Other'}
                              </span>
                            )}
                          </div>
                          {m.ownedBy && (
                            <span className="text-[10px]" style={{ color: 'oklch(0.60 0.015 50)' }}>
                              {m.ownedBy}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          {/* 辅助视觉模型设置（主模型失败时自动切换） */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Image className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 220)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  Vision Model (Backup)
                </span>
              </div>
              {auxVisionApiKey.trim() && auxVisionFetchedModels.length > 0 && (
                <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.55 0.15 220)' }}>
                  <Check className="h-3 w-3" />
                  {auxVisionFetchedModels.length} models
                </span>
              )}
            </div>
            <p className="mb-3 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
              Automatically switches to this model when the primary vision model fails.
            </p>

            {/* 提供商选择 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                Select Provider
              </label>
              <select
                value={auxVisionProvider}
                onChange={(e) => {
                  setAuxVisionProvider(e.target.value as ProviderType);
                  setAuxVisionFetchedModels([]);
                  setAuxVisionTestError('');
                  setSelectedAuxVisionModel('');
                }}
                className="w-full h-8 rounded-md border px-3 text-xs"
                style={{
                  fontFamily: "'Noto Serif SC', serif",
                  backgroundColor: 'oklch(0.97 0.008 80)',
                  borderColor: 'oklch(0.85 0.01 70)',
                  color: 'oklch(0.25 0.02 50)',
                }}
              >
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.type} value={preset.type}>
                    {preset.label} ({preset.description})
                  </option>
                ))}
              </select>
            </div>

            {/* API Key 输入 */}
            <div className="relative">
              <Input
                type="text"
                placeholder={`Enter ${PROVIDER_PRESETS.find((p) => p.type === auxVisionProvider)?.label || ''} API Key`}
                value={auxVisionApiKey}
                onChange={(e) => setAuxVisionApiKey(e.target.value)}
                className="h-8 pr-9 text-xs"
                style={paperInputStyle}
              />
            </div>

            {/* 获取模型按钮 */}
            {auxVisionApiKey.trim() && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={testAuxVisionConnection}
                  disabled={auxVisionTesting}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
                    color: 'oklch(0.50 0.12 220)',
                  }}
                >
                  {auxVisionTesting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                  {auxVisionTesting ? 'Fetching...' : 'Fetch Models'}
                </button>

                {auxVisionApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuxVisionApiKey('');
                      setAuxVisionFetchedModels([]);
                      setSelectedAuxVisionModel('');
                      setAuxVisionTestError('');
                    }}
                    className="flex items-center gap-1 text-[10px] transition-colors hover:underline"
                    style={{ color: 'oklch(0.55 0.02 50)' }}
                  >
                    <X className="h-2.5 w-2.5" />
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* 错误提示 */}
            {auxVisionTestError && (
              <p className="mt-2 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>
                {auxVisionTestError}
              </p>
            )}

            {/* 获取到的模型列表（单选） */}
            {auxVisionFetchedModels.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                  Select Backup Vision Model (single)
                </p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {auxVisionFetchedModels.map((m) => {
                    const checked = selectedAuxVisionModel === m.modelId;
                    const key = `aux-vision-${m.modelId}`;

                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedAuxVisionModel(m.modelId)}
                          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors"
                          style={{
                            borderColor: checked ? 'oklch(0.55 0.15 220)' : 'oklch(0.75 0.02 60)',
                          }}
                        >
                          {checked && (
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: 'oklch(0.55 0.15 220)' }}
                            />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                              {m.modelId}
                            </span>
                            {m.category !== 'chat' && (
                              <span
                                className="shrink-0 rounded px-1 py-px text-[9px] leading-tight"
                                style={{
                                  backgroundColor: 'oklch(0.70 0.01 60 / 0.15)',
                                  color: 'oklch(0.50 0.01 50)',
                                }}
                              >
                                {m.category === 'embedding' ? 'Embedding' : m.category === 'vision' ? 'Vision' : m.category === 'audio' ? 'Voice' : 'Other'}
                              </span>
                            )}
                          </div>
                          {m.ownedBy && (
                            <span className="text-[10px]" style={{ color: 'oklch(0.60 0.015 50)' }}>
                              {m.ownedBy}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {/* 任务归纳模型设置 */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 220)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  Wanted
                </span>
              </div>
              {taskModelApiKey.trim() && taskModelFetchedModels.length > 0 && (
                <span className="flex items-center gap-1 text-xs" style={{ color: 'oklch(0.55 0.15 220)' }}>
                  <Check className="h-3 w-3" />
                  {taskModelFetchedModels.length} models
                </span>
              )}
            </div>

            {/* 提供商选择 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                Select Provider
              </label>
              <select
                value={taskModelProvider}
                onChange={(e) => {
                  setTaskModelProvider(e.target.value as ProviderType);
                  setTaskModelFetchedModels([]);
                  setTaskModelTestError('');
                  setSelectedTaskModel('');
                }}
                className="w-full h-8 rounded-md border px-3 text-xs"
                style={{
                  fontFamily: "'Noto Serif SC', serif",
                  backgroundColor: 'oklch(0.97 0.008 80)',
                  borderColor: 'oklch(0.85 0.01 70)',
                  color: 'oklch(0.25 0.02 50)',
                }}
              >
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.type} value={preset.type}>
                    {preset.label} ({preset.description})
                  </option>
                ))}
              </select>
            </div>

            {/* API Key 输入 */}
            <div className="relative">
              <Input
                type="text"
                placeholder={`Enter ${PROVIDER_PRESETS.find((p) => p.type === taskModelProvider)?.label || ''} API Key`}
                value={taskModelApiKey}
                onChange={(e) => setTaskModelApiKey(e.target.value)}
                className="h-8 pr-9 text-xs"
                style={paperInputStyle}
              />
            </div>

            {/* 获取模型按钮 */}
            {taskModelApiKey.trim() && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={testTaskModelConnection}
                  disabled={taskModelTesting}
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
                    color: 'oklch(0.50 0.12 220)',
                  }}
                >
                  {taskModelTesting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                  {taskModelTesting ? 'Fetching...' : 'Fetch Models'}
                </button>

                {taskModelApiKey.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setTaskModelApiKey('');
                      setTaskModelFetchedModels([]);
                      setSelectedTaskModel('');
                      setTaskModelTestError('');
                    }}
                    className="flex items-center gap-1 text-[10px] transition-colors hover:underline"
                    style={{ color: 'oklch(0.55 0.02 50)' }}
                  >
                    <X className="h-2.5 w-2.5" />
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* 错误提示 */}
            {taskModelTestError && (
              <p className="mt-2 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>
                {taskModelTestError}
              </p>
            )}

            {/* 获取到的模型列表（单选） */}
            {taskModelFetchedModels.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                  Select Wanted Model (single)
                </p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {taskModelFetchedModels.map((m) => {
                    const checked = selectedTaskModel === m.modelId;
                    const key = `task-${m.modelId}`;

                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedTaskModel(m.modelId)}
                          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors"
                          style={{
                            borderColor: checked ? 'oklch(0.55 0.15 220)' : 'oklch(0.75 0.02 60)',
                          }}
                        >
                          {checked && (
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: 'oklch(0.55 0.15 220)' }}
                            />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                              {m.modelId}
                            </span>
                            {m.thinking && (
                              <span
                                className="shrink-0 rounded px-1 py-px text-[9px] leading-tight"
                                style={{
                                  backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
                                  color: 'oklch(0.50 0.12 220)',
                                }}
                              >
                                Thinking
                              </span>
                            )}
                          </div>
                          {m.ownedBy && (
                            <span className="text-[10px]" style={{ color: 'oklch(0.60 0.015 50)' }}>
                              {m.ownedBy}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {/* 文本编辑模型设置 */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Pencil className="h-4 w-4" style={{ color: 'oklch(0.50 0.12 180)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  Text Edit
                </span>
              </div>
            </div>
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>Select Provider</label>
              <select value={editModelProvider} onChange={(e) => { setEditModelProvider(e.target.value as ProviderType); setEditModelFetchedModels([]); setEditModelTestError(''); setSelectedEditModel(''); }} className="w-full h-8 rounded-md border px-3 text-xs" style={{ fontFamily: "'Noto Serif SC', serif", backgroundColor: 'oklch(0.97 0.008 80)', borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.25 0.02 50)' }}>
                {PROVIDER_PRESETS.map((p) => <option key={p.type} value={p.type}>{p.label} ({p.description})</option>)}
              </select>
            </div>
            <div className="relative">
              <Input type="text" placeholder={`Enter ${PROVIDER_PRESETS.find(p => p.type === editModelProvider)?.label || ''} API Key`} value={editModelApiKey} onChange={(e) => setEditModelApiKey(e.target.value)} className="h-8 pr-9 text-xs" style={paperInputStyle} />
            </div>
            {editModelApiKey.trim() && (
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={testEditModelConnection} disabled={editModelTesting} className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50" style={{ backgroundColor: 'oklch(0.50 0.12 180 / 0.12)', color: 'oklch(0.50 0.12 180)' }}>
                  {editModelTesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  {editModelTesting ? 'Fetching...' : 'Fetch Models'}
                </button>
                <button type="button" onClick={() => { setEditModelApiKey(''); setEditModelFetchedModels([]); setSelectedEditModel(''); setEditModelTestError(''); }} className="flex items-center gap-1 text-[10px] transition-colors hover:underline" style={{ color: 'oklch(0.55 0.02 50)' }}><X className="h-2.5 w-2.5" />Clear</button>
              </div>
            )}
            {editModelTestError && <p className="mt-2 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>{editModelTestError}</p>}
            {editModelFetchedModels.length > 0 && (
              <div className="mt-3"><p className="mb-1 text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>Select Text Edit Model (single)</p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {editModelFetchedModels.map((m) => { const checked = selectedEditModel === m.modelId;
                    return (<label key={`edit-${m.modelId}`} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.01_80)]">
                      <button type="button" onClick={() => setSelectedEditModel(m.modelId)} className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors" style={{ borderColor: checked ? 'oklch(0.50 0.12 180)' : 'oklch(0.75 0.02 60)' }}>{checked && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'oklch(0.50 0.12 180)' }} />}</button>
                      <div className="flex-1 min-w-0"><div className="flex items-center gap-1.5"><span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>{m.modelId}</span>{m.thinking && <span className="shrink-0 rounded px-1 py-px text-[9px] leading-tight" style={{ backgroundColor: 'oklch(0.50 0.12 180 / 0.12)', color: 'oklch(0.50 0.12 180)' }}>Thinking</span>}</div>{m.ownedBy && <span className="text-[10px]" style={{ color: 'oklch(0.60 0.015 50)' }}>{m.ownedBy}</span>}</div>
                    </label>);
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 自定义工具设置 */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wrench className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  Custom Tools
                </span>
                <span className="text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  AI 可自动调用的 HTTP 工具
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const ok = window.confirm(
                    '注册自定义 HTTP 工具\n\nAI 会把对话中的参数发送到你配置的 endpoint，可能包含敏感信息。仅添加你完全信任的服务器。确认要新增工具吗？',
                  );
                  if (!ok) return;
                  setCustomTools([
                    ...customTools,
                    {
                      name: '',
                      description: '',
                      endpoint: '',
                      method: 'POST',
                      parameters: { type: 'object', properties: {}, required: [] },
                      enabled: true,
                    },
                  ]);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.1)', color: 'oklch(0.50 0.12 45)' }}
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>

            {/* 自定义工具安全警告横幅 */}
            {customTools.length > 0 && (
              <div
                className="mb-3 flex items-start gap-2 rounded-md border px-3 py-2"
                style={{
                  backgroundColor: 'oklch(0.85 0.10 70 / 0.12)',
                  borderColor: 'oklch(0.70 0.14 55 / 0.4)',
                }}
              >
                <span style={{ color: 'oklch(0.55 0.18 35)' }}>⚠</span>
                <span className="text-[10px] leading-relaxed" style={{ color: 'oklch(0.40 0.08 40)' }}>
                  AI 调用自定义工具时，会根据描述把对话上下文和参数 POST/GET 到你配置的 URL。
                  请勿将内部 Token、业务数据发送到不信任的第三方服务器。保存时会额外确认一次。
                </span>
              </div>
            )}

            {customTools.length === 0 && (
              <div
                className="rounded-lg border px-3 py-4 text-center"
                style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed' }}
              >
                <span className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  暂无自定义工具。点击 Add 注册一个 HTTP 工具，AI 会在需要时自动调用。
                </span>
              </div>
            )}

            {customTools.map((tool, idx) => (
              <div
                key={idx}
                className="mb-3 rounded-lg border p-3"
                style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.98 0.005 80 / 0.5)' }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                    Tool #{idx + 1}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const updated = [...customTools];
                        updated[idx] = { ...tool, enabled: !tool.enabled };
                        setCustomTools(updated);
                      }}
                      className="flex h-5 w-9 items-center rounded-full transition-colors"
                      style={{
                        backgroundColor: tool.enabled ? 'oklch(0.62 0.17 45)' : 'oklch(0.85 0.01 70)',
                      }}
                    >
                      <span
                        className="h-3.5 w-3.5 rounded-full bg-white transition-transform"
                        style={{ transform: tool.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomTools(customTools.filter((_, i) => i !== idx));
                      }}
                      className="rounded p-1 transition-colors hover:bg-[oklch(0.55_0.18_35/0.1)]"
                      style={{ color: 'oklch(0.55 0.18 35)' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      名称 (函数名)
                    </label>
                    <Input
                      type="text"
                      placeholder="get_weather"
                      value={tool.name}
                      onChange={(e) => {
                        const updated = [...customTools];
                        updated[idx] = { ...tool, name: e.target.value };
                        setCustomTools(updated);
                      }}
                      className="h-7 text-xs"
                      style={paperInputStyle}
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      HTTP 方法
                    </label>
                    <select
                      value={tool.method || 'POST'}
                      onChange={(e) => {
                        const updated = [...customTools];
                        updated[idx] = { ...tool, method: e.target.value as 'GET' | 'POST' };
                        setCustomTools(updated);
                      }}
                      className="h-7 w-full rounded-md border px-2 text-xs"
                      style={{
                        fontFamily: "'Noto Serif SC', serif",
                        backgroundColor: 'oklch(0.97 0.008 80)',
                        borderColor: 'oklch(0.85 0.01 70)',
                        color: 'oklch(0.25 0.02 50)',
                      }}
                    >
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                    </select>
                  </div>
                </div>

                <div className="mt-2">
                  <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                    描述 (AI 根据此描述决定是否调用)
                  </label>
                  <Input
                    type="text"
                    placeholder="获取指定城市的天气信息"
                    value={tool.description}
                    onChange={(e) => {
                      const updated = [...customTools];
                      updated[idx] = { ...tool, description: e.target.value };
                      setCustomTools(updated);
                    }}
                    className="h-7 text-xs"
                    style={paperInputStyle}
                  />
                </div>

                <div className="mt-2">
                  <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                    Endpoint URL
                  </label>
                  <Input
                    type="text"
                    placeholder="https://api.example.com/weather"
                    value={tool.endpoint}
                    onChange={(e) => {
                      const updated = [...customTools];
                      updated[idx] = { ...tool, endpoint: e.target.value };
                      setCustomTools(updated);
                    }}
                    className="h-7 text-xs"
                    style={paperInputStyle}
                  />
                </div>

                <div className="mt-2">
                  <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                    参数 (JSON Schema)
                  </label>
                  <textarea
                    value={JSON.stringify(tool.parameters || { type: 'object', properties: {}, required: [] }, null, 2)}
                    onChange={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        const updated = [...customTools];
                        updated[idx] = { ...tool, parameters: parsed };
                        setCustomTools(updated);
                      } catch {
                        // 解析失败时不更新，允许用户继续编辑
                      }
                    }}
                    className="w-full rounded-md border px-2 py-1.5 text-[10px] font-mono"
                    style={{
                      backgroundColor: 'oklch(0.97 0.008 80)',
                      borderColor: 'oklch(0.85 0.01 70)',
                      color: 'oklch(0.25 0.02 50)',
                      minHeight: '60px',
                      resize: 'vertical',
                    }}
                    placeholder={`{\n  "type": "object",\n  "properties": {\n    "city": {\n      "type": "string",\n      "description": "城市名"\n    }\n  },\n  "required": ["city"]\n}`}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* MCP 服务器设置 */}
          <div className="border-t border-[oklch(0.88_0.01_70)] mt-4 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plug className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
                <span className="text-sm font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                  MCP Servers
                </span>
                <span className="text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  标准 AI 工具协议，自动发现并调用
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMcpServers([
                    ...mcpServers,
                    {
                      id: `custom-${Date.now()}`,
                      name: '',
                      transport: 'stdio',
                      command: 'npx',
                      args: [],
                      enabled: true,
                    },
                  ]);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
                style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.1)', color: 'oklch(0.50 0.12 45)' }}
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>

            {mcpServers.map((server, idx) => (
              <div
                key={server.id || idx}
                className="mb-3 rounded-lg border p-3"
                style={{ borderColor: 'oklch(0.88 0.01 70)', backgroundColor: 'oklch(0.98 0.005 80 / 0.5)' }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                    {server.name || `Server #${idx + 1}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        // 关闭时不需要确认；打开高风险项弹确认
                        const turningOn = !server.enabled;
                        if (turningOn) {
                          const risk = isHighRisk(server);
                          if (risk) {
                            const ok = window.confirm(`${risk.title}\n\n${risk.message}`);
                            if (!ok) return;
                          }
                        }
                        const updated = [...mcpServers];
                        updated[idx] = { ...server, enabled: turningOn ? true : false };
                        setMcpServers(updated);
                      }}
                      className="flex h-5 w-9 items-center rounded-full transition-colors"
                      style={{
                        backgroundColor: server.enabled ? 'oklch(0.62 0.17 45)' : 'oklch(0.85 0.01 70)',
                      }}
                      title={isHighRisk(server)?.message || ''}
                    >
                      <span
                        className="h-3.5 w-3.5 rounded-full bg-white transition-transform"
                        style={{ transform: server.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMcpServers(mcpServers.filter((_, i) => i !== idx));
                      }}
                      className="rounded p-1 transition-colors hover:bg-[oklch(0.55_0.18_35/0.1)]"
                      style={{ color: 'oklch(0.55 0.18 35)' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      名称
                    </label>
                    <Input
                      type="text"
                      placeholder="Context7"
                      value={server.name}
                      onChange={(e) => {
                        const updated = [...mcpServers];
                        updated[idx] = { ...server, name: e.target.value, id: server.id || `mcp-${e.target.value.toLowerCase().replace(/\s/g, '-')}` };
                        setMcpServers(updated);
                      }}
                      className="h-7 text-xs"
                      style={paperInputStyle}
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      传输类型
                    </label>
                    <select
                      value={server.transport}
                      onChange={(e) => {
                        const updated = [...mcpServers];
                        updated[idx] = { ...server, transport: e.target.value as 'stdio' | 'streamable-http' };
                        setMcpServers(updated);
                      }}
                      className="h-7 w-full rounded-md border px-2 text-xs"
                      style={{
                        fontFamily: "'Noto Serif SC', serif",
                        backgroundColor: 'oklch(0.97 0.008 80)',
                        borderColor: 'oklch(0.85 0.01 70)',
                        color: 'oklch(0.25 0.02 50)',
                      }}
                    >
                      <option value="stdio">stdio (本地)</option>
                      <option value="streamable-http">streamable-http (远程)</option>
                    </select>
                  </div>
                </div>

                {server.transport === 'stdio' ? (
                  <>
                    <div className="mt-2">
                      <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                        命令
                      </label>
                      <Input
                        type="text"
                        placeholder="npx"
                        value={server.command || ''}
                        onChange={(e) => {
                          const updated = [...mcpServers];
                          updated[idx] = { ...server, command: e.target.value };
                          setMcpServers(updated);
                        }}
                        className="h-7 text-xs"
                        style={paperInputStyle}
                      />
                    </div>
                    <div className="mt-2">
                      <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                        参数 (每行一个)
                      </label>
                      <textarea
                        value={(server.args || []).join('\n')}
                        onChange={(e) => {
                          const updated = [...mcpServers];
                          updated[idx] = { ...server, args: e.target.value.split('\n').filter((a) => a.trim()) };
                          setMcpServers(updated);
                        }}
                        className="w-full rounded-md border px-2 py-1.5 text-[10px] font-mono"
                        style={{
                          backgroundColor: 'oklch(0.97 0.008 80)',
                          borderColor: 'oklch(0.85 0.01 70)',
                          color: 'oklch(0.25 0.02 50)',
                          minHeight: '40px',
                          resize: 'vertical',
                        }}
                        placeholder={'-y\n@modelcontextprotocol/server-sequential-thinking'}
                      />
                    </div>
                    <div className="mt-2">
                      <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                        环境变量 (JSON)
                      </label>
                      <textarea
                        value={JSON.stringify(server.env || {}, null, 2)}
                        onChange={(e) => {
                          try {
                            const parsed = JSON.parse(e.target.value);
                            const updated = [...mcpServers];
                            updated[idx] = { ...server, env: parsed };
                            setMcpServers(updated);
                          } catch {}
                        }}
                        className="w-full rounded-md border px-2 py-1.5 text-[10px] font-mono"
                        style={{
                          backgroundColor: 'oklch(0.97 0.008 80)',
                          borderColor: 'oklch(0.85 0.01 70)',
                          color: 'oklch(0.25 0.02 50)',
                          minHeight: '40px',
                          resize: 'vertical',
                        }}
                        placeholder='{}'
                      />
                    </div>
                  </>
                ) : (
                  <div className="mt-2">
                    <label className="mb-0.5 block text-[10px] font-medium" style={{ color: 'oklch(0.50 0.015 50)' }}>
                      URL
                    </label>
                    <Input
                      type="text"
                      placeholder="https://mcp.example.com/mcp"
                      value={server.url || ''}
                      onChange={(e) => {
                        const updated = [...mcpServers];
                        updated[idx] = { ...server, url: e.target.value };
                        setMcpServers(updated);
                      }}
                      className="h-7 text-xs"
                      style={paperInputStyle}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          </div>
        </div>
        )}

        <div className="flex items-center justify-end gap-2 px-6 py-4">
          {saved && (
            <span className="mr-auto flex items-center gap-1 text-xs" style={{ color: 'oklch(0.50 0.12 45)' }}>
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-xs"
            style={{ color: 'oklch(0.55 0.02 50)' }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            className="text-xs"
            style={{
              backgroundColor: 'oklch(0.62 0.17 45)',
              color: 'white',
            }}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
