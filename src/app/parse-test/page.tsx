'use client';

import { useRef, useState } from 'react';
import type { ParseMode, ParseResult } from '../../lib/parse/types';

const MODES: { value: ParseMode; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'document', label: 'Document' },
  { value: 'screenshot', label: 'Screenshot' },
  { value: 'chart', label: 'Chart' },
  { value: 'casual', label: 'Preview' },
];

export default function ParseTestPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [mode, setMode] = useState<ParseMode>('general');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string>('');
  const [cacheHit, setCacheHit] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    setResult(null);
    setError('');
    setCacheHit(false);

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const handleParse = async () => {
    if (!selectedFile) return;

    setLoading(true);
    setError('');
    setResult(null);
    setCacheHit(false);

    try {
      const filePath = window.api.getPathForFile(selectedFile);
      const startTime = Date.now();

      const response = await window.api.parse.image(filePath, mode);
      const duration = Date.now() - startTime;

      if (!response.success) {
        setError(`[${response.error.code}] ${response.error.message}`);
        return;
      }

      const parsedTime = new Date(response.data.parsed_at).getTime();
      const isCacheHit = Date.now() - parsedTime > 1000 && duration < 500;
      setCacheHit(isCacheHit);
      setResult(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleClearCache = async () => {
    const response = await window.api.parse.clearCache();
    if (response.success) {
      alert('Cache cleared');
      setCacheHit(false);
    } else {
      alert(`Clear failed: ${response.error.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 p-8 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          File Parse Test
        </h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Verify vision-adapter → image-parser → IPC pipeline
        </p>

        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-4 flex flex-wrap items-center gap-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="text-sm text-zinc-600 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:text-blue-700 hover:file:bg-blue-100 dark:text-zinc-400"
            />

            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ParseMode)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            <button
              onClick={handleParse}
              disabled={!selectedFile || loading}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Parsing...' : 'Parse'}
            </button>

            <button
              onClick={handleClearCache}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Clear Cache
            </button>
          </div>

          {selectedFile && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
            </p>
          )}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Image Preview
            </h2>
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Preview"
                className="max-h-96 w-full rounded-md object-contain"
              />
            ) : (
              <div className="flex h-48 items-center justify-center rounded-md bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-800">
                Select an image
              </div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                Parse Results
              </h2>
              {cacheHit && (
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Cache hit
                </span>
              )}
            </div>

            {error && (
              <div className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
                {error}
              </div>
            )}

            {result ? (
              <div className="space-y-3">
                <div className="max-h-64 overflow-y-auto rounded-md bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  {result.extracted_text || '(No content)'}
                </div>

                <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <p>Filename: {result.file_name}</p>
                  <p>MIME: {result.mime_type}</p>
                  <p>Method: {result.parse_method}</p>
                  <p>Hash: {result.file_hash.slice(0, 16)}...</p>
                  {result.stats && (
                    <p>
                      Duration: {result.stats.duration_ms}ms | Token: {result.stats.input_tokens} →{' '}
                      {result.stats.output_tokens}
                    </p>
                  )}
                  <p>Parsed at: {new Date(result.parsed_at).toLocaleString()}</p>
                </div>
              </div>
            ) : (
              !error && (
                <div className="flex h-48 items-center justify-center rounded-md bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-800">
                  No results
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}