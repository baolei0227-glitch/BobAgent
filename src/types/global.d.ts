import type { ParseApi, UpdateApi, SettingsApi, ScreenOcrApi } from '../../electron/preload';
import type { MessageAttachment } from '../../lib/types';

declare global {
  interface Window {
    api: {
      parse: ParseApi;
      update: UpdateApi;
      settings: SettingsApi;
      screenOcr: ScreenOcrApi;
      getPathForFile: (file: File) => string;
      openDevTools: () => Promise<void>;
      openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      openHtml: (content: string, filename?: string) => Promise<{ success: boolean; error?: string; path?: string }>;
      showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      selectDirectory: () => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
      getHomeDir: () => string;
    };
    /** "发送到节点"事件缓冲：新建节点尚未挂载时暂存附件，挂载后消费，防止事件先于监听器注册而丢失 */
    __pendingNodeAttachments?: Record<string, MessageAttachment[]>;
    /** "发送到新建节点"缓冲：暂存待发送的选中文字，新节点挂载后消费为引用标签 */
    __pendingNodeReference?: Record<string, string>;
    /** "一键安装等任务"缓冲：新建节点挂载后直接自动发送执行（无需用户确认） */
    __pendingNodeTasks?: Record<string, string>;
  }
}