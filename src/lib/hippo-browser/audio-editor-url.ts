/**
 * 全页音频编辑器（Hippo）的 URL 构造。
 *
 * 为什么集中在这里：预览面板的启动卡、左栏 Audio Editor 入口都拼同一个地址；
 * 两处各写一遍 `?path=&name=&size=` 迟早会在编码/空值上漂移。
 */
export interface AudioEditorTarget {
  /** 音频绝对路径（local 口径；空 = 空编辑器，进 Library / Import） */
  path: string;
  /** 展示名 */
  name: string;
  /** 字节数（仅标题栏显示） */
  size?: number;
}

export function audioEditorUrl(target: AudioEditorTarget, origin?: string): string {
  const raw = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  /**
   * 127.0.0.1 → localhost：服务端会把「预览/小程序 origin」302 回 localhost，
   * 而 302 会**丢掉 query**（实测 `/audio-editor?path=...` 变成 `/audio-editor`）。
   * Hippo 与主窗口同机，直接统一成 localhost，路径参数才不会在重定向里消失。
   */
  const base = raw.replace(/\/\/127\.0\.0\.1(?=:|$)/, '//localhost');
  const qs = new URLSearchParams();
  if (target.path) qs.set('path', target.path);
  if (target.name) qs.set('name', target.name);
  if (target.size && target.size > 0) qs.set('size', String(target.size));
  const query = qs.toString();
  return `${base}/audio-editor${query ? `?${query}` : ''}`;
}
