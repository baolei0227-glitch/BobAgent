'use client';

import { useState, useEffect } from 'react';
import { Download, RefreshCw, Check, AlertCircle, X } from 'lucide-react';

export function UpdateNotification() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'no-update' | 'downloading' | 'downloaded' | 'error'>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version: string; releaseNotes: string; releaseDate: string } | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (typeof window.api?.update !== 'undefined') {
      window.api.update.onChecking(() => setStatus('checking'));
      window.api.update.onAvailable((info) => {
        setUpdateInfo(info);
        // 自动下载模式：直接进入下载状态
        setStatus('downloading');
        setProgress(0);
      });
      window.api.update.onNotAvailable((info: any) => {
        // 仅手动检查时提示"已是最新版"，自动检查静默处理
        if (info?.manual) {
          setStatus('no-update');
          // 3 秒后自动消失
          setTimeout(() => setStatus('idle'), 3000);
        } else {
          setStatus('idle');
        }
      });
      window.api.update.onDownloadProgress((p) => {
        setProgress(p.percent);
      });
      window.api.update.onDownloaded(() => setStatus('downloaded'));
      window.api.update.onError((err) => {
        setError(err);
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
  };

  if (status === 'idle') return null;

  return (
    <div
      className="fixed left-1/2 top-6 z-50 flex w-[400px] -translate-x-1/2 flex-col rounded-lg p-4 shadow-xl"
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
            {status === 'no-update' && 'Current version is up to date'}
            {status === 'downloading' && 'Downloading...'}
            {status === 'downloaded' && 'Update downloaded'}
            {status === 'error' && 'Update check failed'}
          </span>
        </div>
        <button
          onClick={handleClose}
          className="rounded p-1 transition-colors hover:bg-gray-100"
          style={{ color: 'oklch(0.55 0.02 50)' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {status === 'available' && updateInfo && (
        <div className="mt-3">
          {updateInfo.releaseNotes && (
            <p className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
              Release notes: {updateInfo.releaseNotes}
            </p>
          )}
          <button
            onClick={handleDownload}
            className="mt-3 w-full rounded-md px-4 py-2 text-xs transition-colors hover:opacity-90"
            style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
          >
            Download Update
          </button>
        </div>
      )}

      {status === 'downloading' && (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
            <span>Download Progress</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-2 w-full rounded-full" style={{ backgroundColor: 'oklch(0.90 0.01 70)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress}%`,
                backgroundColor: 'oklch(0.62 0.17 45)',
              }}
            />
          </div>
        </div>
      )}

      {status === 'downloaded' && (
        <div className="mt-3">
          <button
            onClick={handleInstall}
            className="w-full rounded-md px-4 py-2 text-xs transition-colors hover:opacity-90"
            style={{ backgroundColor: 'oklch(0.55 0.15 45)', color: 'white' }}
          >
            Install and Restart
          </button>
          <p className="mt-2 text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
            The app will restart to complete the update
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className="mt-3">
          <p className="text-xs" style={{ color: 'oklch(0.65 0.20 25)' }}>
            {error}
          </p>
          <button
            onClick={handleCheckUpdate}
            className="mt-3 w-full rounded-md px-4 py-2 text-xs transition-colors hover:opacity-90"
            style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
