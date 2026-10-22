'use client';

/**
 * components/canvas/LocalSttPanel.tsx — 本地离线 STT（sherpa-onnx）配置区块
 *
 * 位置：设置 → 角色派发 → Audio STT Model 折叠区内，云端模型下面是本地清单。
 *
 * 设计：
 *  - 引擎（CLI）与模型都**按需下载**到 BOBWORK_HOME/.stt，不随安装包分发；
 *  - 大文件（最大 ~375MB）后台下载，前端按 1.2s 轮询 GET /api/stt/local 读进度（进度来自磁盘 .part 字节）；
 *  - 本地模型与云端模型**互斥单选**：选中某个本地模型即切换引擎（父级同时清空云端池）；
 *    没有 Auto、也没有"云端失败自动回退本地"；再点一次已选中的模型即取消选择；
 *  - 清单按能力分三类：**单选只列 batch（可批量转写）**（realtime 模型当批量引擎会直接报错）；
 *    realtime 模型（实时出字）与 punctuates 模型（给实时文本补标点/断句）各自单列一行、不带分类标题，
 *    只有下载/删除、不参与单选——下载完成即自动启用；
 *  - 已下载的引擎/模型可就地删除（二次确认）以释放磁盘，之后可重新下载。
 *
 * 受控组件：model 由父级 SettingsModal 持有并随 Save 一并落盘。
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Download, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LocalModelStatus {
  id: string;
  /** 模型能力：batch = 可选作转写引擎；realtime = 实时出字；punctuates = 给实时文本补标点/断句。
   *  后两者只服务麦克风实时输入，都不参与引擎单选；diarizes = 给导入录音标「谁在什么时候说」，同样不参与单选 */
  capabilities: { batch: boolean; realtime: boolean; punctuates: boolean; diarizes: boolean };
  label: string;
  languages: string;
  description: string;
  ready: boolean;
  downloadedBytes: number;
  totalBytes: number;
}

interface LocalSttStatus {
  supported: boolean;
  binary: { installed: boolean; path: string; downloadedBytes: number; totalBytes: number };
  models: LocalModelStatus[];
  job: {
    key: string;
    kind: 'binary' | 'model';
    modelId?: string;
    status: 'running' | 'done' | 'error';
    error?: string;
  } | null;
}

interface LocalSttPanelProps {
  /** 选定的本地模型 id；'' = 未选择（此时不启用本地引擎）。再点一次已选中的模型即取消选择 */
  model: string;
  onModelChange: (id: string) => void;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 细进度条（下载中显示） */
function ProgressBar({ ratio }: { ratio: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--line-soft)' }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, backgroundColor: 'var(--brand)' }} />
      </div>
      <span className="shrink-0 text-10 tabular-nums" style={{ color: 'var(--ink-muted)' }}>{pct}%</span>
    </div>
  );
}

/** 行右侧：就绪标记 / 下载（含续传）/ 删除。offline 与 streaming 两组共用 */
function ModelActions({
  m,
  busy,
  jobRunning,
  onStart,
  onRemove,
}: {
  m: LocalModelStatus;
  busy: boolean;
  jobRunning: boolean;
  onStart: () => void;
  onRemove: () => void;
}) {
  const partial = !m.ready && m.downloadedBytes > 0;
  return (
    <>
      {m.ready ? (
        <span className="flex shrink-0 items-center gap-1 text-11" style={{ color: 'var(--success)' }}>
          <Check className="h-3 w-3" /> Ready
        </span>
      ) : (
        <Button
          size="xs"
          variant="soft"
          tone="brand"
          className="shrink-0"
          loading={busy}
          disabled={jobRunning && !busy}
          onClick={onStart}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {partial ? 'Resume' : 'Download'}
        </Button>
      )}
      {!busy && (m.ready || m.downloadedBytes > 0) && (
        <Button
          size="icon-xs"
          variant="ghost"
          tone="danger"
          className="shrink-0"
          disabled={jobRunning}
          onClick={onRemove}
          title={m.ready ? 'Delete model' : 'Discard partial download'}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      )}
    </>
  );
}

export function LocalSttPanel({ model, onModelChange }: LocalSttPanelProps) {
  const [status, setStatus] = useState<LocalSttStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/stt/local');
      const data = (await res.json()) as LocalSttStatus & { success?: boolean; error?: string };
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 仅在任务进行中高频轮询，空闲时不打扰后端
  const running = status?.job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  const start = async (action: 'binary' | 'model', modelId?: string) => {
    setError(null);
    try {
      const res = await fetch('/api/stt/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, modelId }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 删除已下载的引擎或模型（磁盘释放，之后可重新下载）；删除当前首选模型时清除选择 */
  const remove = async (opts: { target: 'binary' | 'model'; modelId?: string; label: string }) => {
    if (!window.confirm(`Delete ${opts.label}? You can re-download it later.`)) return;
    setError(null);
    try {
      const res = await fetch('/api/stt/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', target: opts.target, modelId: opts.modelId }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      if (opts.target === 'model' && opts.modelId && opts.modelId === model) onModelChange('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const job = status?.job;
  const jobRunning = job?.status === 'running';
  // 当前任务是否作用在该条目上（用于把进度条/忙碌态挂到正确的行）
  const jobOn = (kind: 'binary' | 'model', id?: string) =>
    jobRunning && job?.kind === kind && (kind === 'binary' || job?.modelId === id);

  return (
    <div className="mt-2 space-y-1.5">
      {status && !status.supported && (
        <p className="text-11" style={{ color: 'var(--warn)' }}>
          Offline STT needs macOS — not available on this platform.
        </p>
      )}

      {status?.supported && (
        <>
          {/* 引擎（CLI）：未安装时才出现（下载入口），装好后整行隐藏——它不随安装包分发，按需下载 */}
          {!status.binary.installed && (
          <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>Offline engine</span>
                <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                  sherpa-onnx · {formatBytes(status.binary.totalBytes)}
                </span>
              </span>
              <Button
                size="xs"
                variant="soft"
                tone="brand"
                className="shrink-0"
                loading={jobOn('binary')}
                disabled={jobRunning && !jobOn('binary')}
                onClick={() => void start('binary')}
              >
                {jobOn('binary') ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Download
              </Button>
            </div>
            {jobOn('binary') && <ProgressBar ratio={status.binary.downloadedBytes / status.binary.totalBytes} />}
          </div>
          )}

          {/* 转写引擎（单选）：**只列 batch 能力的模型**——realtime 只服务麦克风实时出字，
              被选成批量转写引擎会在转写时直接报错，故不在此可选 */}
          {status.models.filter((m) => m.capabilities.batch).map((m) => {
            const selected = model === m.id;
            const busy = jobOn('model', m.id);
            const ratio = m.totalBytes > 0 ? m.downloadedBytes / m.totalBytes : 0;
            return (
              <div
                key={m.id}
                className="rounded-md border px-2.5 py-1.5"
                style={{ borderColor: selected ? 'var(--brand)' : 'var(--line)', backgroundColor: selected ? 'color-mix(in oklab, var(--brand) 6%, transparent)' : 'var(--paper)' }}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onModelChange(selected ? '' : m.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={selected ? 'Deselect' : 'Use as STT engine'}
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: selected ? 'var(--brand)' : 'var(--line)' }}>
                      {selected && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--brand)' }} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</span>
                      <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>{m.languages} · {formatBytes(m.totalBytes)}</span>
                    </span>
                  </button>
                  <ModelActions
                    m={m}
                    busy={busy}
                    jobRunning={jobRunning}
                    onStart={() => void start('model', m.id)}
                    onRemove={() => void remove({ target: 'model', modelId: m.id, label: `"${m.label}"` })}
                  />
                </div>
                {busy && <ProgressBar ratio={ratio} />}
              </div>
            );
          })}

          {/* 实时语音输入：streaming 模型只在这里下载/删除，不参与上面的引擎单选。
              就绪后麦克风自动边走字边说（无需再选一次）——落定文本仍是本地离线推理，不出网 */}
          {status.models.filter((m) => m.capabilities.realtime).map((m) => {
            const busy = jobOn('model', m.id);
            const ratio = m.totalBytes > 0 ? m.downloadedBytes / m.totalBytes : 0;
            return (
              <div
                key={m.id}
                className="rounded-md border px-2.5 py-1.5"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</span>
                    <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                      {m.languages} · {formatBytes(m.totalBytes)}
                    </span>
                  </span>
                  <ModelActions
                    m={m}
                    busy={busy}
                    jobRunning={jobRunning}
                    onStart={() => void start('model', m.id)}
                    onRemove={() => void remove({ target: 'model', modelId: m.id, label: `"${m.label}"` })}
                  />
                </div>
                {busy && <ProgressBar ratio={ratio} />}
              </div>
            );
          })}

          {/* 标点/断句（可选）：同样只服务实时语音输入、不参与引擎单选。
              下载完成即在每个停顿处自动给实时文本补标点——这正是「一边说一边出带句读的文字」的来源 */}
          {status.models.filter((m) => m.capabilities.punctuates).map((m) => {
            const busy = jobOn('model', m.id);
            const ratio = m.totalBytes > 0 ? m.downloadedBytes / m.totalBytes : 0;
            return (
              <div
                key={m.id}
                className="rounded-md border px-2.5 py-1.5"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</span>
                    <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                      {m.languages} · {formatBytes(m.totalBytes)}
                    </span>
                  </span>
                  <ModelActions
                    m={m}
                    busy={busy}
                    jobRunning={jobRunning}
                    onStart={() => void start('model', m.id)}
                    onRemove={() => void remove({ target: 'model', modelId: m.id, label: `"${m.label}"` })}
                  />
                </div>
                {busy && <ProgressBar ratio={ratio} />}
              </div>
            );
          })}
          {/* 说话人分离（可选）：只服务「导入录音」，给整段音频标出「谁在什么时候说」，
              结果作为导入转写的分块依据（同样不参与引擎单选）——全程本地推理，音频不出网 */}
          {status.models.filter((m) => m.capabilities.diarizes).map((m) => {
            const busy = jobOn('model', m.id);
            const ratio = m.totalBytes > 0 ? m.downloadedBytes / m.totalBytes : 0;
            return (
              <div
                key={m.id}
                className="rounded-md border px-2.5 py-1.5"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</span>
                    <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                      {m.languages} · {formatBytes(m.totalBytes)}
                    </span>
                  </span>
                  <ModelActions
                    m={m}
                    busy={busy}
                    jobRunning={jobRunning}
                    onStart={() => void start('model', m.id)}
                    onRemove={() => void remove({ target: 'model', modelId: m.id, label: `"${m.label}"` })}
                  />
                </div>
                {busy && <ProgressBar ratio={ratio} />}
              </div>
            );
          })}
          {/* 选中了未下载完的模型：转写会直接报错，这里提前给出提示 */}
          {model && status.models.some((m) => m.id === model && !m.ready) && (
            <p className="flex items-start gap-1 text-11" style={{ color: 'var(--warn)' }}>
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>The selected model is not downloaded yet — transcription fails until it finishes downloading.</span>
            </p>
          )}
        </>
      )}

      {job?.status === 'error' && (
        <p className="flex items-start gap-1 text-11" style={{ color: 'var(--danger)' }}>
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{job.error || 'Download failed'}</span>
        </p>
      )}
      {error && (
        <p className="flex items-start gap-1 text-11" style={{ color: 'var(--danger)' }}>
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}