/**
 * Pure bridge constants (no server-only imports).
 *
 * Safe to import from client components (e.g. CanvasFlow) without
 * pulling fs/path/project-manager into the client bundle.
 */

/** 由宿主客户端拦截执行的 chat 动作（需要用户确认弹窗 / 需要返回布尔授权态，不进服务端 handleBridgeRequest） */
export const HOST_CHAT_PERMISSION_ACTIONS: readonly string[] = ['chatRequestPermission', 'chatGetPermission'];
