/**
 * Butler 桌面独立窗（悬浮球 + 面板）—— BobWork 最小化 / 隐藏后留在桌面上的 Butler
 *
 * 为什么必须是真窗口：DOM 元素活在窗口里，主窗口一最小化，球就跟着不见了。
 * 「球留在桌面上」「球能就地展开成面板」只能由独立 BrowserWindow 实现
 * （与截图覆盖窗 ocr-editor 同一套配方，见 main.ts 的 createOcrEditorWindow）。
 *
 * 分工（三个宿主互不重叠，任何时刻只有一处画 Butler）：
 *   - 主窗口可见时：球由渲染层画在主窗口里（src/components/butler/ButlerOrb.tsx），锚点 = 中栏左下角；
 *     点球打开的是主窗口里的 Butler 抽屉（既有实现）。本模块只负责在主窗最大化 / 还原 / 进出全屏时
 *     给渲染层发归位信号。
 *   - 主窗口最小化 / 隐藏（含 macOS 上关窗不退出）时：显示置顶**球窗**，落在「主窗所在屏幕的 workArea
 *     左下角」。拖拽由主进程轮询 `screen.getCursorScreenPoint()` 完成（渲染层拿不到屏幕坐标，
 *     而窗口本身要跟光标走）。
 *   - 点这颗桌面球 → **就地展开成 Butler 面板窗**（/butler-panel，里面是**桌面版同一个 Butler 抽屉**
 *     `ButlerDrawer`，与 BobWork 里点球打开的一致），BobWork 保持最小化。面板标题条上两个按钮：
 *       · 缩小 → 面板收回成球，球停在**面板当前所在位置**（面板左下角）；
 *       · 关闭 → 球与面板一起**从桌面消失**（不再自动出球，直到主窗回到前台过一轮）。
 *     面板被 ⌘W 直接关掉时按「缩小」处理：球回到面板原位，避免 Butler 毫无征兆地整个消失。
 *
 * 四个已规避的坑：
 *   ① 球窗 `focusable:false` + `acceptFirstMouse:true`：球绝不能抢走主窗口的输入焦点（否则拖一下球
 *      就把正在打字的焦点偷走），但首击仍要能收到。面板窗相反 —— 里面有输入框，必须可聚焦。
 *   ② `setVisibleOnAllWorkspaces` 必须带 `skipTransformProcessType:true`：不带的话 macOS 会把进程
 *      转成 UIElement、**Dock 图标直接消失**——临时的截图覆盖窗看不出来，常驻窗会一直中招。
 *   ③ 不要用 `parent: mainWindow`：macOS 子窗口会跟随父窗口最小化，正好与需求相反。
 *   ④ 面板只 hide 不 destroy：抽屉里挂着会话流（SSE）与可能进行中的会议控制台，
 *      销毁窗口会中断它们。代价是隐藏期间仍保留抽屉自己的轮询。
 *
 * 平台：当前仅 macOS 启用。Windows / Linux 的「关闭窗口即退出」语义不同，顺手改会动到退出行为。
 */
import { BrowserWindow, app, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  ORB_WINDOW_SIZE,
  PANEL_DEFAULT_SIZE,
  PANEL_MIN_SIZE,
  clampOrbPointInRect,
  orbPointAtRectBottomLeft,
  orbPointFromPanel,
  orbWindowBounds,
  panelBoundsForOrb,
  type OrbPoint,
  type OrbRect,
} from '../src/lib/butler/orb-geometry';
import type { ButlerOrbWindowState } from './preload';

/** 主进程侧需要外部提供的依赖（不 import main.ts，避免循环依赖） */
export interface ButlerOrbHost {
  /** 当前主窗口（可能为 null / 已销毁）：贴泊锚点与「主窗在哪块屏」都取自它 */
  getMainWindow: () => BrowserWindow | null;
  /** 独立窗要加载的本机服务地址（http://localhost:PORT） */
  getServerUrl: () => string;
  log: (msg: string) => void;
  /** 是否启用（仅 macOS） */
  enabled: boolean;
}

/** 拖拽轮询间隔：16ms ≈ 60fps，与光标跟手即可（窗口移动不需要更高） */
const DRAG_INTERVAL_MS = 16;

let host: ButlerOrbHost | null = null;
let orbWindow: BrowserWindow | null = null;
let panelWindow: BrowserWindow | null = null;
let disposed = false;
let ipcRegistered = false;
/** 拖拽轮询定时器 */
let dragTimer: NodeJS.Timeout | null = null;
/** 指针在球窗内的抓取偏移（按下瞬间的指针 − 窗口左上角） */
let dragOffset: OrbPoint = { x: 0, y: 0 };
/** 球当前所在的桌面位置；null = 本次没拖过 → 落在 workArea 左下角（主窗回到前台即作废） */
let freePoint: OrbPoint | null = null;
/** 面板最后一次已知矩形（'move'/'resize' 跟踪）：⌘W 直接关窗时靠它把球放回原位 */
let lastPanelBounds: OrbRect | null = null;
/** 本次「BobWork 不在前台」会话里点过面板的关闭按钮：不再自动出球，直到主窗回到前台 */
let dismissed = false;

function active(): boolean {
  return !!host && host.enabled && !disposed;
}

function stopDragLoop(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

/** 独立态的落点基准：主窗所在屏幕的可用区（主窗没了就用光标所在屏） */
function freeAnchorRect(): OrbRect {
  const main = host?.getMainWindow();
  const display =
    main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

/** 面板当前矩形：窗口还在就取实时值，否则退回最后一次已知值 */
function livePanelBounds(): OrbRect | null {
  if (panelWindow && !panelWindow.isDestroyed()) {
    const b = panelWindow.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  return lastPanelBounds;
}

/** 球窗 console 转发：独立窗没有 DevTools 可看，排障只能靠日志（与截图覆盖窗同一做法） */
function forwardConsole(win: BrowserWindow, tag: string): void {
  win.webContents.on('console-message', (_e, level, message) => {
    try {
      fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[${tag}:${level}] ${message}\n`);
    } catch { /* 忽略 */ }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    host?.log(`[butler-orb] ${tag} 渲染进程退出: ${details.reason} (exitCode=${details.exitCode})`);
  });
}

function createOrbWindow(): BrowserWindow | null {
  if (!active()) return null;
  const h = host;
  if (!h) return null;
  if (orbWindow && !orbWindow.isDestroyed()) {
    // 渲染进程崩了（且没有自动恢复）：销毁重建，否则球窗会永远是一块空白
    if (orbWindow.webContents.isCrashed()) {
      try {
        orbWindow.destroy();
      } catch { /* 忽略 */ }
      orbWindow = null;
    } else {
      return orbWindow;
    }
  }

  const win = new BrowserWindow({
    width: ORB_WINDOW_SIZE,
    height: ORB_WINDOW_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 坑 ①：不抢焦点（拖动球时不能偷走主窗口正在打字的焦点）；acceptFirstMouse 保证首击仍能收到
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  // 显示在所有虚拟桌面 / 其他应用的全屏窗口之上；第三个参数见坑 ②
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch { /* 平台差异忽略 */ }

  win.on('closed', () => {
    orbWindow = null;
  });
  forwardConsole(win, 'ORB-WIN');
  win.loadURL(`${h.getServerUrl()}/butler-orb`);
  orbWindow = win;
  h.log(`[butler-orb] 独立球窗已创建（${ORB_WINDOW_SIZE}×${ORB_WINDOW_SIZE}，置顶 / 全桌面可见）`);
  return win;
}

function createPanelWindow(): BrowserWindow | null {
  if (!active()) return null;
  const h = host;
  if (!h) return null;
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.webContents.isCrashed()) {
      try {
        panelWindow.destroy();
      } catch { /* 忽略 */ }
      panelWindow = null;
    } else {
      return panelWindow;
    }
  }

  const win = new BrowserWindow({
    width: PANEL_DEFAULT_SIZE.width,
    height: PANEL_DEFAULT_SIZE.height,
    show: false,
    frame: false,
    /**
     * 透明 + 不要系统投影：面板里只有 Butler 抽屉那一张卡（自带圆角/描边/CSS 投影），
     * 窗口自身不许再画任何底色或边框，否则卡片四周会露出一圈「背景面板」（用户点名的那个东西）。
     * 窗口比卡片大一圈只是给 CSS 投影留出空间，那圈是完全透明的。
     */
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 面板是可聚焦窗口（坑 ① 的反面）：里面有对话输入框，点了要能直接打字
    resizable: true,
    minWidth: PANEL_MIN_SIZE.width,
    minHeight: PANEL_MIN_SIZE.height,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Butler',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch { /* 平台差异忽略 */ }

  const remember = () => {
    if (!win.isDestroyed()) {
      const b = win.getBounds();
      lastPanelBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  };
  win.on('move', remember);
  win.on('resize', remember);
  win.on('closed', () => {
    panelWindow = null;
    if (disposed) return;
    // ⌘W / 系统关窗：按「缩小」处理 —— 球回到面板原位，而不是让 Butler 毫无征兆地整个消失
    const panel = lastPanelBounds;
    if (panel) {
      freePoint = orbPointFromPanel(panel);
      showOrbFree(freePoint);
    }
  });
  forwardConsole(win, 'PANEL-WIN');
  win.loadURL(`${h.getServerUrl()}/butler-panel`);
  panelWindow = win;
  h.log(`[butler-orb] Butler 面板窗已创建（${PANEL_DEFAULT_SIZE.width}×${PANEL_DEFAULT_SIZE.height}，置顶 / 可缩放 / 可聚焦，内含桌面版 Butler 抽屉）`);
  return win;
}

/** 只隐藏球窗，不动会话级状态（freePoint / dismissed） */
function hideOrbWindow(): void {
  stopDragLoop();
  const win = orbWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.hide();
  } catch { /* 忽略 */ }
}

/** 只隐藏面板窗（坑 ④：不销毁） */
function hidePanelWindow(): void {
  const win = panelWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.hide();
  } catch { /* 忽略 */ }
}

/**
 * 主窗回到前台：球与面板一起收起，并复位会话级状态——
 * 「拖动只在当前状态下有效」「关闭后下次最小化重新出现」两条语义都靠这里落地。
 */
function collapseDesktop(): void {
  hideOrbWindow();
  hidePanelWindow();
  freePoint = null;
  dismissed = false;
}

/** 显示球。`explicitPoint` 给出时按它落点（用于「缩小」把球放回面板原位），否则用记住的位置/左下角 */
function showOrbFree(explicitPoint?: OrbPoint): void {
  if (!active()) return;
  // ⌘H（应用整体隐藏）不出球：那是「全藏」，不是「最小化」——否则用户会看到
  // 「应用藏了但球赖在桌面上」。app.isHidden() 只有 macOS 有意义，而本模块只在 macOS 启用。
  if (app.isHidden()) return;
  // 用户点过面板的「关闭」：本次最小化会话不再自动出球（主窗回到前台时才复位）
  if (dismissed) return;
  const win = createOrbWindow();
  if (!win) return;
  const target = explicitPoint ?? freePoint;
  // 有明确落点时按「落点所在屏」钳制：面板可能被拖到副屏去了
  const area = target ? screen.getDisplayNearestPoint(target).workArea : freeAnchorRect();
  const point = clampOrbPointInRect(target ?? orbPointAtRectBottomLeft(area), area);
  freePoint = point;
  try {
    win.setBounds(orbWindowBounds(point));
    // showInactive：显示但不激活（focusable:false 下不抢焦点，也不把 BobWork 从后台拽到前台）
    win.showInactive();
  } catch (e) {
    host?.log(`[butler-orb] 显示独立球窗失败: ${String(e)}`);
  }
}

/** 点球（未拖动）：就地展开 Butler 面板，BobWork 保持最小化 */
function expandPanel(): void {
  if (!active()) return;
  const win = createPanelWindow();
  if (!win) return;
  const area = freeAnchorRect();
  const ballPoint = clampOrbPointInRect(freePoint ?? orbPointAtRectBottomLeft(area), area);
  const bounds = panelBoundsForOrb(ballPoint, PANEL_DEFAULT_SIZE, area);
  // 球让位给面板：「缩小」时才把它放回面板左下角（见 minimizePanel）
  hideOrbWindow();
  try {
    if (win.isMinimized()) win.restore();
    win.setBounds(bounds);
    lastPanelBounds = bounds;
    win.show();
    win.focus();
  } catch (e) {
    host?.log(`[butler-orb] 展开 Butler 面板失败: ${String(e)}`);
  }
}

/** 面板的「缩小」：收回成球，球停在面板当前所在位置（面板被拖过也认） */
function minimizePanel(): void {
  const panel = livePanelBounds();
  const area = panel ? screen.getDisplayMatching(panel).workArea : freeAnchorRect();
  hidePanelWindow();
  const point = panel ? clampOrbPointInRect(orbPointFromPanel(panel), area) : freePoint;
  freePoint = point;
  showOrbFree(point ?? undefined);
}

/**
 * 面板的「关闭」：球与面板一起从桌面消失。
 * 主窗可见时这条路径走不到（那时球在主窗口里），所以它等价于「从桌面消失」；
 * 下次主窗回到前台再最小化，球会重新出现在桌面左下角（见 collapseDesktop）。
 */
function closePanel(): void {
  hidePanelWindow();
  hideOrbWindow();
  freePoint = null;
  dismissed = true;
  host?.log('[butler-orb] 面板关闭：球与面板已从桌面收起');
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('butler-orb:drag-start', (_e, offset: Partial<OrbPoint>) => {
    if (!active()) return;
    const win = orbWindow;
    if (!win || win.isDestroyed()) return;
    dragOffset = { x: Number(offset?.x) || 0, y: Number(offset?.y) || 0 };
    stopDragLoop();
    dragTimer = setInterval(() => {
      const w = orbWindow;
      if (!w || w.isDestroyed()) {
        stopDragLoop();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      // 拖动允许跨屏：按光标所在屏的可用区钳制，避免拖出屏幕后找不回来
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      const point = clampOrbPointInRect({ x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y }, area);
      freePoint = point;
      try {
        w.setBounds(orbWindowBounds(point));
      } catch { /* 忽略 */ }
    }, DRAG_INTERVAL_MS);
  });

  ipcMain.on('butler-orb:drag-end', (_e, payload: { moved?: boolean }) => {
    stopDragLoop();
    if (payload?.moved) return; // 拖到哪就留在哪（freePoint 已记录）
    expandPanel(); // 位移未过阈值 = 点击 → 就地展开面板
  });

  ipcMain.on('butler-orb:panel-minimize', () => minimizePanel());
  ipcMain.on('butler-orb:panel-close', () => closePanel());
}

/**
 * 注册模块（启动时调用一次）。`enabled: false` 时只记一条日志，
 * 其余函数全部退化为空操作——不影响主窗口里那颗球。
 */
export function setupButlerOrb(options: ButlerOrbHost): void {
  host = options;
  if (!options.enabled) {
    options.log('[butler-orb] 桌面独立窗未启用（当前仅 macOS）');
    return;
  }
  registerIpc();
}

/** 预热球窗（保持隐藏）：消除首次最小化「先空窗再出球」的迟滞，与截图覆盖窗的预热同理。
 *  面板刻意**不预热**：它一创建就会开始自己的轮询（会议 3s），没必要为从没用过的人常驻。 */
export function prewarmButlerOrb(): void {
  if (!active()) return;
  try {
    if (orbWindow && !orbWindow.isDestroyed() && !orbWindow.webContents.isCrashed()) return;
    createOrbWindow();
  } catch (e) {
    host?.log(`[butler-orb] 预热失败: ${String(e)}`);
  }
}

/** 退出前销毁（避免退出流程里主窗 closed → 又把球窗显示出来） */
export function disposeButlerOrb(): void {
  disposed = true;
  stopDragLoop();
  const panel = panelWindow;
  panelWindow = null;
  if (panel && !panel.isDestroyed()) {
    try {
      panel.destroy();
    } catch { /* 忽略 */ }
  }
  const orb = orbWindow;
  orbWindow = null;
  if (orb && !orb.isDestroyed()) {
    try {
      orb.destroy();
    } catch { /* 忽略 */ }
  }
}

/**
 * 绑定主窗口事件。**每次重建主窗口都要重新绑定**（见 main.ts createMainWindow）：
 * 主窗口在 macOS 上可以被关闭再由 Dock 图标重建，绑定只做一次会漏掉新窗口。
 */
export function bindButlerOrbMainWindow(win: BrowserWindow): void {
  const notify = (state: ButlerOrbWindowState) => {
    if (!active() || win.isDestroyed()) return;
    try {
      win.webContents.send('butler-orb:window-state', state);
    } catch { /* 忽略 */ }
  };

  // 放大 / 还原 / 进出全屏：球归位到中栏左下角（渲染层收到信号即清零偏移）
  win.on('maximize', () => {
    collapseDesktop();
    notify('maximize');
  });
  win.on('unmaximize', () => notify('unmaximize'));
  win.on('enter-full-screen', () => notify('enter-full-screen'));
  win.on('leave-full-screen', () => notify('leave-full-screen'));
  // 从最小化恢复 / 重新显示 / 获得焦点 → 桌面上的球与面板一起收起（Butler 回到主窗口中栏左下角）
  win.on('restore', () => {
    collapseDesktop();
    notify('restore');
  });
  win.on('show', () => collapseDesktop());
  win.on('focus', () => collapseDesktop());
  // 最小化 / 隐藏 → 球独立留在桌面左下角（用户自己最小化窗口时照常出球；Butler 的键不再动窗口）
  win.on('minimize', () => showOrbFree());
  win.on('hide', () => showOrbFree());
  // 主窗被关闭（macOS 上应用不退出）→ 球留着，否则用户没有任何入口
  win.on('closed', () => showOrbFree());
}
