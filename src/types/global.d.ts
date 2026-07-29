import type { ParseApi, UpdateApi, SettingsApi } from '../../electron/preload';

declare global {
  interface Window {
    api: {
      parse: ParseApi;
      update: UpdateApi;
      settings: SettingsApi;
      getPathForFile: (file: File) => string;
      openDevTools: () => Promise<void>;
      openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    };
  }
}