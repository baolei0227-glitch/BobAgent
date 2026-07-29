'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Check, X, Loader2, Zap, Image, ArrowLeft, Pencil, Brain, Sparkles } from 'lucide-react';
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
  migrateOldSettingsIfNeeded,
  type AppSettings,
} from '@/lib/settings';
import { inferModelSpec } from '@/lib/model-matcher';

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

  // 任务归纳模型（与视觉模型同结构）
  const [taskModelProvider, setTaskModelProvider] = useState<ProviderType>('glm');
  const [taskModelApiKey, setTaskModelApiKey] = useState<string>('');
  const [taskModelFetchedModels, setTaskModelFetchedModels] = useState<FetchedModel[]>([]);
  const [taskModelTesting, setTaskModelTesting] = useState(false);
  const [taskModelTestError, setTaskModelTestError] = useState('');
  const [selectedTaskModel, setSelectedTaskModel] = useState<string>('');

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

        // 任务归纳模型配置
        if (settings.taskModel) {
          setTaskModelApiKey(settings.taskModel.apiKey || '');
          setSelectedTaskModel(settings.taskModel.defaultModel || '');
          if (settings.taskModel.defaultProvider) {
            setTaskModelProvider(settings.taskModel.defaultProvider as ProviderType);
          }
        }
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

  const handleSave = async () => {
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
    });

    await updateTaskModel({
      defaultProvider: taskModelProvider,
      defaultModel: selectedTaskModel,
      apiKey: taskModelApiKey.trim(),
      baseUrl: PROVIDER_PRESETS.find((p) => p.type === taskModelProvider)?.baseUrl || '',
    });

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
                    No vision model configured
                  </span>
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
