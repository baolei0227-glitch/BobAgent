import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcResult, ParseCacheRecord, ParseMode, ParseResult } from '../src/lib/parse/types';

export interface ParseApi {
  image: (filePath: string, mode?: ParseMode) => Promise<IpcResult<ParseResult>>;
  getCache: (hash: string) => Promise<IpcResult<ParseCacheRecord | null>>;
  clearCache: () => Promise<IpcResult<void>>;
}

export interface UpdateApi {
  check: () => Promise<{ success: boolean; error?: string }>;
  download: () => Promise<{ success: boolean; error?: string }>;
  install: () => Promise<{ success: boolean }>;
  getVersion: () => Promise<string>;
  onChecking: (callback: () => void) => void;
  onAvailable: (callback: (info: { version: string; releaseNotes: string; releaseDate: string }) => void) => void;
  onNotAvailable: (callback: () => void) => void;
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; downloaded: number; total: number }) => void) => void;
  onDownloaded: (callback: () => void) => void;
  onError: (callback: (error: string) => void) => void;
}

export interface SettingsApi {
  load: () => Promise<unknown>;
  save: (settings: unknown) => Promise<void>;
}

export interface Api {
  parse: ParseApi;
  update: UpdateApi;
  settings: SettingsApi;
  getPathForFile: (file: File) => string;
  openDevTools: () => Promise<void>;
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
}

const api: Api = {
  parse: {
    image: (filePath: string, mode?: ParseMode) =>
      ipcRenderer.invoke('parse:image', filePath, mode),
    getCache: (hash: string) => ipcRenderer.invoke('parse:get-cache', hash),
    clearCache: () => ipcRenderer.invoke('parse:clear-cache'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    getVersion: () => ipcRenderer.invoke('update:get-version'),
    onChecking: (callback) => ipcRenderer.on('update:checking', callback),
    onAvailable: (callback) => ipcRenderer.on('update:available', (_, info) => callback(info)),
    onNotAvailable: (callback) => ipcRenderer.on('update:not-available', callback),
    onDownloadProgress: (callback) => ipcRenderer.on('update:download-progress', (_, progress) => callback(progress)),
    onDownloaded: (callback) => ipcRenderer.on('update:downloaded', callback),
    onError: (callback) => ipcRenderer.on('update:error', (_, error) => callback(error)),
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  openFile: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
};

contextBridge.exposeInMainWorld('api', api);

contextBridge.exposeInMainWorld('desktopAPI', {
  platform: process.platform,
  isElectron: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});