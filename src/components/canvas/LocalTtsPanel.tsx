'use client';

/**
 * components/canvas/LocalTtsPanel.tsx — 本地 TTS 区块（本地神经 sherpa-onnx）
 *
 * 位置：设置 → 角色派发 → Audio TTS Model 折叠区内，与云端模型**同一份扁平列表**平铺。
 *
 * 设计（与 LocalSttPanel 对称）：
 *  - 与云端**互斥单选**：选中本地引擎即清空云端池；没有 Auto、也不自动兜底；
 *  - 一档本地引擎：Offline neural —— sherpa-onnx 神经合成；引擎与模型按需下载（与 STT 共享同一份引擎包）；
 *  - 引擎（shared 包）与模型都后台下载，前端按 1.2s 轮询 GET /api/tts/local 读进度（进度来自磁盘 .part）；
 *  - 已下载的模型可就地删除（二次确认）释放磁盘；就绪后可**试听**（合成一句样例即时播放）。
 *
 * 受控组件：engine / localModel 由父级 SettingsModal 持有并随 Save 一并落盘。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Download, Loader2, Play, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** 本地引擎档位：'' = 未选本地（此时用云端池） */
export type LocalTtsEngine = 'sherpa-local' | '';

/** 零样本克隆模型的内置参考音（来自模型 test_wavs/，文本由官方 prompt.txt 自动补全） */
interface BuiltinRef {
  id: string;
  label: string;
  wavPath: string;
  text: string;
  textKnown: boolean;
}

/** 多音色预置模型的一条音色（sid 由服务端映射为 sherpa --sid） */
interface LocalVoice {
  id: string;
  label: string;
  sid: number;
}

interface NeuralModelStatus {
  id: string;
  label: string;
  description: string;
  /** preset = 固定音色库；zero-shot = 需参考音的克隆模型 */
  kind: 'preset' | 'zero-shot';
  /** 多音色预置模型的音色表；空 = 单音色模型（不渲染音色下拉） */
  voices: LocalVoice[];
  ready: boolean;
  downloadedBytes: number;
  totalBytes: number;
  builtinRefs: BuiltinRef[];
}

interface EngineStatus {
  installed: boolean;
  path: string;
  downloadedBytes: number;
  totalBytes: number;
}

interface LocalTtsStatus {
  supported: boolean;
  provider: string;
  suggestedChunkChars: number;
  engine: EngineStatus;
  models: NeuralModelStatus[];
  job: {
    key: string;
    kind: 'binary' | 'model';
    modelId?: string;
    status: 'running' | 'done' | 'error';
    error?: string;
  } | null;
}

interface LocalTtsPanelProps {
  engine: LocalTtsEngine;
  onEngineChange: (next: LocalTtsEngine) => void;
  /** 本地神经模型 id */
  localModel: string;
  onLocalModelChange: (id: string) => void;
  /** 零样本克隆（ZipVoice）的参考音频绝对路径；'' = 未选 */
  refAudio: string;
  onRefAudioChange: (path: string) => void;
  /** 与参考音频逐字一致的文本（零样本克隆必填） */
  refText: string;
  onRefTextChange: (text: string) => void;
  /** 多音色预置模型的音色 id；'' = 用模型首条 */
  voice: string;
  onVoiceChange: (id: string) => void;
}

/** 「上传自己的参考音」在下拉里用的哨兵值（与真实路径不会冲突） */
const UPLOAD_VALUE = '__upload__';

/** 取路径末段，用于下拉里展示已上传文件名 */
function fileNameOf(p: string): string {
  return p.split('/').pop() || p;
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

/** 单选圆点 */
function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: selected ? 'var(--brand)' : 'var(--line)' }}>
      {selected && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--brand)' }} />}
    </span>
  );
}

export function LocalTtsPanel({
  engine,
  onEngineChange,
  localModel,
  onLocalModelChange,
  refAudio,
  onRefAudioChange,
  refText,
  onRefTextChange,
  voice,
  onVoiceChange,
}: LocalTtsPanelProps) {
  const [status, setStatus] = useState<LocalTtsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState<string>('');
  const [uploadingRef, setUploadingRef] = useState(false);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const refFileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tts/local');
      const data = (await res.json()) as LocalTtsStatus & { success?: boolean; error?: string };
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

  // 卸载时停掉试听
  useEffect(() => () => { previewAudio.current?.pause(); }, []);

  const start = async (action: 'binary' | 'model', modelId?: string) => {
    setError(null);
    try {
      const res = await fetch('/api/tts/local', {
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

  const remove = async (modelId: string, label: string) => {
    if (!window.confirm(`Delete ${label}? You can re-download it later.`)) return;
    setError(null);
    try {
      const res = await fetch('/api/tts/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', modelId }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      if (modelId === localModel) onLocalModelChange('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 上传自定义参考音：服务端转码为 24kHz 单声道 wav 后回填绝对路径（文本仍由用户手填） */
  const uploadRef = async (file: File) => {
    setError(null);
    setUploadingRef(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/tts/local/refs', { method: 'POST', body: form });
      const data = (await res.json()) as { success?: boolean; path?: string; error?: string };
      if (!res.ok || data.success === false || !data.path) throw new Error(data.error || `HTTP ${res.status}`);
      onRefAudioChange(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingRef(false);
    }
  };

  /** 试听：合成一句样例并播放；再次点击同一模型 = 停止 */
  const preview = async (m: NeuralModelStatus) => {
    previewAudio.current?.pause();
    previewAudio.current = null;
    if (previewing === m.id) {
      setPreviewing('');
      return;
    }
    setError(null);
    setPreviewLoading(m.id);
    try {
      const res = await fetch('/api/tts/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          modelId: m.id,
          // 零样本克隆：带上当前（可能尚未保存的）参考音与文本
          ...(m.kind === 'zero-shot' ? { referenceAudio: refAudio, referenceText: refText } : {}),
          // 多音色预置：带上当前音色（未选时服务端回落首条）
          ...(m.voices.length > 0 ? { voiceId: voice } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      previewAudio.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewing(''); };
      setPreviewing(m.id);
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreviewing('');
    } finally {
      setPreviewLoading('');
    }
  };

  const job = status?.job;
  const jobRunning = job?.status === 'running';
  const jobOn = (kind: 'binary' | 'model', id?: string) =>
    jobRunning && job?.kind === kind && (kind === 'binary' || job?.modelId === id);

  return (
    <div className="mt-2 space-y-1.5">
      {status && !status.supported && (
        <p className="text-11" style={{ color: 'var(--warn)' }}>
          Offline TTS needs macOS — not available on this platform.
        </p>
      )}

      {status?.supported && (
        <>
          {/* ① 共享引擎：未安装时出现下载入口（与 STT 复用同一份 sherpa-onnx shared 包） */}
          {!status.engine.installed && (
            <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>Offline engine</span>
                  <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                    sherpa-onnx · {formatBytes(status.engine.totalBytes)} · shared with Audio STT
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
              {jobOn('binary') && <ProgressBar ratio={status.engine.downloadedBytes / status.engine.totalBytes} />}
            </div>
          )}

          {/* ② 本地神经模型：点击行 = 选为 TTS 引擎（互斥单选）；右侧 = 试听/下载/删除 */}
          {status.models.map((m) => {
            const selected = engine === 'sherpa-local' && localModel === m.id;
            const busy = jobOn('model', m.id);
            const ratio = m.totalBytes > 0 ? m.downloadedBytes / m.totalBytes : 0;
            const partial = !m.ready && m.downloadedBytes > 0;
            // 当前参考音是否命中内置项（决定下拉选中值与文本自动填充）
            const refMatch = m.builtinRefs.find((r) => r.wavPath === refAudio);
            return (
              <div
                key={m.id}
                className="rounded-md border px-2.5 py-1.5"
                style={{ borderColor: selected ? 'var(--brand)' : 'var(--line)', backgroundColor: selected ? 'color-mix(in oklab, var(--brand) 6%, transparent)' : 'var(--paper)' }}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (selected) { onEngineChange(''); return; }
                      onLocalModelChange(m.id);
                      onEngineChange('sherpa-local');
                      // 零样本克隆：未选参考音时默认用第一个内置真人参考音（否则选完还是没声音）
                      if (m.kind === 'zero-shot' && !refAudio) {
                        const first = m.builtinRefs.find((r) => r.textKnown) ?? m.builtinRefs[0];
                        if (first) { onRefAudioChange(first.wavPath); onRefTextChange(first.text); }
                      }
                      // 多音色预置：当前音色不属于这个模型时，默认落到它的首条（否则选完还是没声音）
                      if (m.voices.length > 0 && !m.voices.some((v) => v.id === voice)) {
                        onVoiceChange(m.voices[0].id);
                      }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={selected ? 'Deselect' : 'Use offline neural TTS'}
                  >
                    <RadioDot selected={selected} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</span>
                      <span className="block truncate text-10" style={{ color: 'var(--ink-muted)' }}>{m.description} · {formatBytes(m.totalBytes)}</span>
                    </span>
                  </button>
                  {m.ready && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0"
                      title={previewing === m.id ? 'Stop preview' : 'Preview voice'}
                      loading={previewLoading === m.id}
                      onClick={() => void preview(m)}
                    >
                      {previewLoading === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : previewing === m.id ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </Button>
                  )}
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
                      onClick={() => void start('model', m.id)}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      {partial ? 'Resume' : 'Download'}
                    </Button>
                  )}
                  {!busy && (m.ready || m.downloadedBytes > 0) && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0"
                      title="Delete (frees disk space)"
                      onClick={() => void remove(m.id, m.label)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {busy && <ProgressBar ratio={ratio} />}
                {/* 参考音：零样本克隆专属——内置真人参考音（文本自动填充）或自行上传 + 逐字文本 */}
                {selected && m.kind === 'zero-shot' && m.ready && (
                  <div className="mt-1.5 space-y-1.5">
                    <select
                      value={refAudio}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === UPLOAD_VALUE) {
                          refFileInput.current?.click();
                          return;
                        }
                        if (!v) {
                          onRefAudioChange('');
                          onRefTextChange('');
                          return;
                        }
                        // 内置参考音：文本由官方 prompt.txt 自动带出（未知则留空，由用户手填）
                        onRefAudioChange(v);
                        onRefTextChange(m.builtinRefs.find((r) => r.wavPath === v)?.text ?? '');
                      }}
                      className="h-7 w-full rounded-md border px-2 text-xs outline-none"
                      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                    >
                      <option value="">Select a reference voice…</option>
                      {m.builtinRefs.map((r) => (
                        <option key={r.id} value={r.wavPath}>{r.label}</option>
                      ))}
                      {refAudio && !refMatch && <option value={refAudio}>{fileNameOf(refAudio)} · uploaded</option>}
                      <option value={UPLOAD_VALUE}>{uploadingRef ? 'Uploading…' : 'Upload your own…'}</option>
                    </select>
                    <input
                      ref={refFileInput}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void uploadRef(f);
                      }}
                    />
                    <input
                      value={refText}
                      onChange={(e) => onRefTextChange(e.target.value)}
                      placeholder="Type exactly what the audio says (3–15s recommended)"
                      className="h-7 w-full rounded-md border px-2 text-xs outline-none"
                      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                    />
                    {!refAudio && (
                      <p className="text-10" style={{ color: 'var(--ink-muted)' }}>
                        Clones the voice from your reference audio — pick one above (or upload your own).
                      </p>
                    )}
                    <p className="text-10" style={{ color: 'var(--ink-muted)' }}>
                      Speed is not supported by this model.
                    </p>
                  </div>
                )}
                {/* 音色：多音色预置模型专属——同一模型内切换音色（服务端映射为 --sid） */}
                {selected && m.ready && m.voices.length > 0 && (
                  <select
                    value={m.voices.some((v) => v.id === voice) ? voice : m.voices[0].id}
                    onChange={(e) => onVoiceChange(e.target.value)}
                    className="mt-1.5 h-7 w-full rounded-md border px-2 text-xs outline-none"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                  >
                    {m.voices.map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </select>
                )}
                {/* 已选但引擎未装齐：给出明确原因，避免"选了没声音" */}
                {selected && !m.ready && !busy && (
                  <p className="mt-1 text-10" style={{ color: 'var(--warn)' }}>
                    {status.engine.installed ? 'Model not fully downloaded yet.' : 'Download the offline engine and this model first.'}
                  </p>
                )}
                {selected && m.ready && m.kind !== 'zero-shot' && m.voices.length === 0 && (
                  <p className="mt-1 text-10" style={{ color: 'var(--ink-muted)' }}>Single built-in voice.</p>
                )}
              </div>
            );
          })}
        </>
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