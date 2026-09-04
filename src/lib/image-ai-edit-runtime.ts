/**
 * ImageAiEditor 运行时状态（模块级单例）
 *
 * 解决「折叠预览面板会卸载组件导致生成中断/结果丢失」的问题：
 *  - keepAlive：生成期间（含生成完成但尚未被用户展开查看）保持预览面板挂载，
 *    即使面板折叠为 display:none 也不卸载，保证 fetch 与结果不中断。
 *  - hidden：预览面板当前是否处于折叠隐藏态，用于生成完成后提示文案差异。
 *  - toast：生成完成 / 失败时的轻量全局提示（面板折叠时组件被隐藏，提示需挂在全局）。
 */

export type ImageAiToastKind = 'success' | 'error';
export interface ImageAiEditToast {
  id: number;
  message: string;
  kind: ImageAiToastKind;
}

let keepAlive = false;
let hidden = false;
let toasts: ImageAiEditToast[] = [];
let seq = 0;
const stateListeners = new Set<() => void>();
const toastListeners = new Set<() => void>();

function emitState(): void {
  stateListeners.forEach((l) => l());
}
function emitToasts(): void {
  toastListeners.forEach((l) => l());
}

/** 设置 keep-alive：true = 面板折叠时仍需保持挂载（生成中 / 结果待查看） */
export function setImageAiEditKeepAlive(v: boolean): void {
  if (keepAlive === v) return;
  keepAlive = v;
  emitState();
}
export function isImageAiEditKeepAlive(): boolean {
  return keepAlive;
}

/** 设置面板是否折叠隐藏（由预览面板在折叠/展开时同步） */
export function setImageAiEditHidden(v: boolean): void {
  if (hidden === v) return;
  hidden = v;
  emitState();
}
export function isImageAiEditHidden(): boolean {
  return hidden;
}

/** 订阅 keep-alive / hidden 变化，返回取消订阅函数 */
export function onImageAiEditStateChange(l: () => void): () => void {
  stateListeners.add(l);
  return () => {
    stateListeners.delete(l);
  };
}

/** 弹出全局提示（自动数秒后消失） */
export function showImageAiEditToast(message: string, kind: ImageAiToastKind = 'success'): void {
  const id = ++seq;
  toasts = [...toasts, { id, message, kind }];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 5000);
}

/** 订阅 toast 列表变化，返回取消订阅函数 */
export function onImageAiEditToastChange(l: () => void): () => void {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
}
export function getImageAiEditToasts(): ImageAiEditToast[] {
  return toasts;
}