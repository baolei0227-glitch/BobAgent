'use client';

import { useState, useEffect } from 'react';
import { Download, RefreshCw, Check, AlertCircle, X, ArrowDownCircle } from 'lucide-react';

export function UpdateNotification() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'no-update' | 'downloading' | 'downloaded' | 'error'>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version: string; releaseNotes: string; releaseDate: string } | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string>('');
  /** 下载完成后延迟 N 秒自动弹出对话框 */
  const [autoShowDialog, setAutoShowDialog] = useState(false);
  /** 用户在浮动条点了 "稍后" → 不自动弹对话框 */
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window.api?.update !== 'undefined') {
      window.api.update.onChecking(() => {
        setStatus('checking');
        setDismissed(false);
        setAutoShowDialog(false);
      });
      window.api.update.onAvailable((info) => {
        setUpdateInfo(info);
        setStatus('downloading');
        setProgress(0);
        setDismissed(false);
        setAutoShowDialog(false);
      });
      window.api.update.onNotAvailable((info: any) => {
        if (info?.manual) {
          setStatus('no-update');
          setTimeout(() => setStatus('idle'), 3000);
        } else {
          setStatus('idle');
        }
      });
      window.api.update.onDownloadProgress((p) => {
        setProgress(p.percent);
      });
      window.api.update.onDownloaded(() => {
        setStatus('downloaded');
        // 2 秒后自动弹出安装确认对话框（除非用户已点"稍后"）
        if (!dismissed) {
          setTimeout(() => setAutoShowDialog(true), 2000);
        }
      });
      window.api.update.onError((err) => {
        setError(err.message);
        setStatus('error');
      });
    }
  }, []);

  const handleCheckUpdate = async () => {
    if (typeof window.api?.update !== 'undefined') {
      setStatus('checking');
      await window.api.update.check();
    }
  };

  const handleDownload = async () => {
    if (typeof window.api?.update !== 'undefined') {
      setStatus('downloading');
      setProgress(0);
      await window.api.update.download();
    }
  };

  const handleInstall = async () => {
    if (typeof window.api?.update !== 'undefined') {
      await window.api.update.install();
    }
  };

  const handleClose = () => {
    setStatus('idle');
    setError('');
    setAutoShowDialog(false);
  };

  const handleDismiss = () => {
    setDismissed(true);
    // floating bar 消失，但状态保留在 Sidebar 里
    setAutoShowDialog(false);
    // 不重置 status，让 Sidebar 仍然显示 "Install vX.X.XX"
  };

  if (status === 'idle') return null;

  // ====================================================================
  // 下载完成 → 醒目模态对话框（自动弹出）
  // ====================================================================
  const showInstallDialog = status === 'downloaded' && autoShowDialog && !dismissed;

  return (
    <>
      {/* ========== 安装确认对话框（模态遮罩） ========== */}
      {showInstallDialog && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)' }}
          onClick={() => setAutoShowDialog(false)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl p-6 shadow-2xl"
            style={{
              backgroundColor: 'oklch(0.98 0.01 90)',
              border: '1px solid oklch(0.80 0.03 60 / 0.4)',
              fontFamily: "'Noto Serif SC', serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 图标 */}
            <div className="mb-4 flex justify-center">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.12)' }}
              >
                <ArrowDownCircle className="h-8 w-8" style={{ color: 'oklch(0.62 0.17 45)' }} />
              </div>
            </div>

            <h3
              className="mb-1 text-center text-base font-semibold"
              style={{ color: 'oklch(0.30 0.015 50)' }}
            >
              Update Ready to Install
            </h3>
            <p
              className="mb-4 text-center text-sm"
              style={{ color: 'oklch(0.50 0.02 50)', lineHeight: '1.5' }}
            >
              BobAgent <span style={{ fontWeight: 600, color: 'oklch(0.35 0.05 50)' }}>v{updateInfo?.version}</span> has been downloaded and is ready.
              <br />
              The app will restart to complete the update.
            </p>

            {/* Release notes */}
            {updateInfo?.releaseNotes && (
              <div
                className="mb-4 max-h-28 overflow-y-auto rounded-md px-3 py-2 text-xs"
                style={{
                  backgroundColor: 'oklch(0.95 0.01 85)',
                  color: 'oklch(0.45 0.015 50)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {updateInfo.releaseNotes}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={handleInstall}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-all hover:opacity-90 active:scale-[0.98]"
                style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
              >
                Install & Restart Now
              </button>
              <button
                onClick={() => setAutoShowDialog(false)}
                className="w-full rounded-lg px-4 py-2 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                style={{ color: 'oklch(0.50 0.02 50)' }}
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== 下载进度浮动条（检查 + 下载中 + 错误） ========== */}
      {(status === 'checking' || status === 'available' || status === 'no-update' || status === 'downloading' || status === 'downloaded' || status === 'error') && !showInstallDialog && (
        <div
          className="fixed left-1/2 top-6 z-[200] flex w-[380px] -translate-x-1/2 flex-col rounded-lg p-3 shadow-lg"
          style={{
            backgroundColor: 'oklch(0.97 0.015 80)',
            border: '1px solid oklch(0.80 0.03 60 / 0.35)',
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {status === 'checking' && <RefreshCw className="h-4 w-4 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />}
              {status === 'available' && <AlertCircle className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />}
              {status === 'no-update' && <Check className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 45)' }} />}
              {status === 'downloading' && <Download className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />}
              {status === 'downloaded' && <Check className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 45)' }} />}
              {status === 'error' && <AlertCircle className="h-4 w-4" style={{ color: 'oklch(0.65 0.20 25)' }} />}
              <span className="text-sm font-medium" style={{ color: 'oklch(0.35 0.02 50)' }}>
                {status === 'checking' && 'Checking for updates...'}
                {status === 'available' && `New version v${updateInfo?.version} available`}
                {status === 'no-update' && 'Already up to date'}
                {status === 'downloading' && `Downloading v${updateInfo?.version}`}
                {status === 'downloaded' && (
                  <span>
                    v{updateInfo?.version} ready —{' '}
                    <button
                      onClick={handleInstall}
                      className="underline font-semibold hover:opacity-80"
                      style={{ color: 'oklch(0.62 0.17 45)' }}
                    >
                      Install now
                    </button>
                  </span>
                )}
                {status === 'error' && 'Update failed'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {status === 'downloaded' && (
                <button
                  onClick={handleDismiss}
                  className="rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-[oklch(0.90_0.02_80)]"
                  style={{ color: 'oklch(0.50 0.02 50)' }}
                >
                  稍后
                </button>
              )}
              {status !== 'downloaded' && (
                <button
                  onClick={handleClose}
                  className="rounded p-1 transition-colors hover:bg-[oklch(0.90_0.02_80)]"
                  style={{ color: 'oklch(0.55 0.02 50)' }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {status === 'available' && updateInfo && (
            <div className="mt-3">
              {updateInfo.releaseNotes && (
                <p className="mb-2 max-h-20 overflow-y-auto text-xs" style={{ color: 'oklch(0.55 0.02 50)', whiteSpace: 'pre-wrap' }}>
                  {updateInfo.releaseNotes}
                </p>
              )}
              <button
                onClick={handleDownload}
                className="w-full rounded-md px-4 py-2 text-xs font-medium transition-colors hover:opacity-90"
                style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
              >
                Download Update
              </button>
            </div>
          )}

          {status === 'downloading' && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
                <span>{Math.round(progress)}%</span>
                <span>{updateInfo?.version}</span>
              </div>
              <div className="h-1.5 w-full rounded-full" style={{ backgroundColor: 'oklch(0.90 0.01 70)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${progress}%`, backgroundColor: 'oklch(0.62 0.17 45)' }}
                />
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="mt-3">
              <p className="text-xs" style={{ color: 'oklch(0.65 0.20 25)' }}>
                {error}
              </p>
              <button
                onClick={handleCheckUpdate}
                className="mt-2 w-full rounded-md px-4 py-2 text-xs font-medium transition-colors hover:opacity-90"
                style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
