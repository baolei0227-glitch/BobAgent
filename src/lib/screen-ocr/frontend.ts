/**
 * 全局截图 OCR（Cmd+Shift+O）前端总线
 *
 * 主进程经 IPC 下发 OCR 结果后，结果应插入「最近聚焦」的聊天节点输入框。
 * 本模块维护节点级插入目标注册表：
 *   - 每个 ChatNodeKernel 挂载时注册插入回调，卸载时注销
 *   - 输入框获得焦点时标记为最近聚焦节点
 *   - CanvasFlow 单点订阅 IPC，把文本派发给最近聚焦节点
 */

type ScreenOcrInsert = (text: string) => void;

/** 节点 id → 插入回调 */
const targets = new Map<string, ScreenOcrInsert>();

/** 最近获得过输入焦点的节点 id（结果默认插入该节点） */
let lastFocusedNodeId: string | null = null;

/** ChatNodeKernel 挂载时注册为候选插入目标 */
export function registerScreenOcrTarget(nodeId: string, insert: ScreenOcrInsert): void {
  targets.set(nodeId, insert);
}

/** ChatNodeKernel 卸载时注销 */
export function unregisterScreenOcrTarget(nodeId: string): void {
  targets.delete(nodeId);
  if (lastFocusedNodeId === nodeId) lastFocusedNodeId = null;
}

/** 输入框获得焦点：把该节点标记为最近聚焦 */
export function setScreenOcrFocus(nodeId: string): void {
  lastFocusedNodeId = nodeId;
}

/**
 * 把 OCR 文本派发给最近聚焦的节点输入框。
 * @returns 是否成功插入（false = 无目标节点，调用方可提示用户先聚焦输入框）
 */
export function dispatchScreenOcrText(text: string): boolean {
  const insert = lastFocusedNodeId ? targets.get(lastFocusedNodeId) : undefined;
  if (insert) {
    insert(text);
    return true;
  }
  return false;
}
