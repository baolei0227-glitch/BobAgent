'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseFileWatcherOptions {
  nodeId: string | null;
  interval?: number;
  enabled?: boolean;
}

export interface FileWatcherState {
  content: string | null;
  lastModified: number | null;
  fileChanged: boolean;
  isWatching: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UseFileWatcherResult extends FileWatcherState {
  refresh: () => Promise<void>;
  acknowledgeChange: () => Promise<void>;
}

async function fetchNodeContent(nodeId: string): Promise<{ content: string; lastModified: number }> {
  const resp = await fetch(`/api/nodes?action=raw&id=${encodeURIComponent(nodeId)}`);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `获取节点内容失败 (${resp.status})`);
  }
  const data = await resp.json();
  return {
    content: data.content,
    lastModified: Date.now(),
  };
}

export function useFileWatcher({
  nodeId,
  interval = 2000,
  enabled = true,
}: UseFileWatcherOptions): UseFileWatcherResult {
  const [state, setState] = useState<FileWatcherState>({
    content: null,
    lastModified: null,
    fileChanged: false,
    isWatching: false,
    isLoading: false,
    error: null,
  });

  const lastKnownMtime = useRef<number | null>(null);
  const lastKnownSize = useRef<number | null>(null);
  const isInitialLoad = useRef(true);
  const isRefreshing = useRef(false);

  const loadContent = useCallback(async () => {
    if (!nodeId || !enabled || isRefreshing.current) return;

    isRefreshing.current = true;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const { content, lastModified } = await fetchNodeContent(nodeId);

      const sizeChanged =
        lastKnownSize.current !== null && content.length !== lastKnownSize.current;

      if (!isInitialLoad.current && sizeChanged) {
        setState((prev) => ({
          ...prev,
          content,
          lastModified,
          fileChanged: true,
          isLoading: false,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          content,
          lastModified,
          isLoading: false,
        }));
      }

      lastKnownMtime.current = lastModified;
      lastKnownSize.current = content.length;
      isInitialLoad.current = false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState((prev) => ({ ...prev, error: message, isLoading: false }));
    } finally {
      isRefreshing.current = false;
    }
  }, [nodeId, enabled]);

  const refresh = useCallback(async () => {
    isInitialLoad.current = true;
    setState((prev) => ({ ...prev, fileChanged: false }));
    await loadContent();
  }, [loadContent]);

  const acknowledgeChange = useCallback(async () => {
    if (!nodeId) return;
    setState((prev) => ({ ...prev, fileChanged: false }));
    await loadContent();
  }, [nodeId, loadContent]);

  useEffect(() => {
    if (!nodeId || !enabled) {
      setState((prev) => ({ ...prev, isWatching: false }));
      return;
    }

    setState((prev) => ({ ...prev, isWatching: true }));
    isInitialLoad.current = true;
    lastKnownMtime.current = null;
    lastKnownSize.current = null;

    loadContent();

    const timer = setInterval(loadContent, interval);

    return () => {
      clearInterval(timer);
      setState((prev) => ({ ...prev, isWatching: false }));
    };
  }, [nodeId, enabled, interval, loadContent]);

  return {
    ...state,
    refresh,
    acknowledgeChange,
  };
}
