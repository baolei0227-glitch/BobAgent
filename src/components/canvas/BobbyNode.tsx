/**
 * BobbyNode — Bobby 插件观察 + 授权控制台（不承担执行）
 *
 * 定位（2026-08-25 用户确认）：
 *   Bobby 是插件，执行统一由主 Agent 编排调用；插件启用（MCP 设置面板）即对主 Agent 开放。
 *   画布 BobbyNode 仅用于：观察实时进度、授权管理（弹窗 + 复选框）、查看调用历史。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNodeHost } from './node-host';
import { X, ShieldCheck, History, ChevronDown, ChevronRight } from 'lucide-react';
import { NodeCardHeader } from './NodeCardHeader';
import { useConfirm } from './ConfirmDialog';
import type { BobbyNodeData } from '@/lib/types';

/** 快捷授权常用软件 */
const QUICK_GRANTS = ['Calculator', 'WPS Office', 'Safari', 'run_command'];

/** DOS 终端行类型（kind → ANSI 风格色） */
type ProgressKind = 'run' | 'ok' | 'warn' | 'err' | 'info';
const KIND_COLOR: Record<ProgressKind, string> = {
  run: '#4af626',
  ok: '#3ecf6e',
  warn: '#ffd23f',
  err: '#ff5c5c',
  info: '#6f9e6f',
};
const KIND_ICON: Record<ProgressKind, string> = { run: '▶', ok: '✓', warn: '!', err: '✗', info: '·' };
const BOOT_LINES = [
  '> Bobby SYS v0.5 — local execution hub',
  '> 8 tools loaded · grant table initialized',
  '> awaiting main-agent dispatch...',
];

interface ProgressStep {
  t: string;
  kind: ProgressKind;
  text: string;
}

interface HistoryEntry {
  time: string;
  tool: string;
  summary: string;
  ok: boolean;
  grantRequired?: boolean;
}

function BobbyNodeInner({ id, data, selected }: {
  id: string;
  data: BobbyNodeData;
  selected?: boolean;
}) {
  const nodeHost = useNodeHost();
  const { ask: confirmAsk, askChoices, render: confirmRender } = useConfirm();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lastUpdated, setLastUpdated] = useState('');
  // 本次任务临时放行状态（target=null 表示放行全部）
  const [tempAllow, setTempAllowState] = useState<{ active: boolean; target: string | null }>({ active: false, target: null });
  // 系统授权状态（辅助功能 + 屏幕录制，引导面板）
  const [permissions, setPermissions] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);

  // 实时进度（DOS 终端滚动流）
  const [current, setCurrent] = useState<{ tool: string; summary: string; startedAt: string } | null>(null);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [pendingGrant, setPendingGrantState] = useState<string | null>(null);

  // 授权管理
  const [grants, setGrants] = useState<string[]>([]);
  const [grantInput, setGrantInput] = useState('');
  const [grantMsg, setGrantMsg] = useState<{ ok: boolean; detail?: string } | null>(null);

  // 调用历史（默认折叠）
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 授权管理（默认折叠）
  const [grantsOpen, setGrantsOpen] = useState(false);

  // 已弹过授权确认的 target（避免重复弹窗）
  const promptedRef = useRef<Set<string>>(new Set());
  // 上一轮 running 状态（变化时广播给画布控制连线电流）
  const runningRef = useRef<boolean | null>(null);

  // 加载实时状态（连接 + 进度 + 待授权 + 授权列表）
  const loadStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby');
      const res = await resp.json();
      if (res.ok) {
        setEnabled(res.enabled === true);
        setLastUpdated(new Date().toLocaleTimeString());
        setCurrent(res.current ?? null);
        // 运行状态变化 → 广播给画布：执行中连线显示电流，闲置关闭
        const nextRunning = res.current != null;
        if (runningRef.current !== nextRunning) {
          runningRef.current = nextRunning;
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bobby:run-state', { detail: { running: nextRunning } }));
          }
        }
        setProgress(Array.isArray(res.progress) ? res.progress : []);
        setPendingGrantState(typeof res.pendingGrant === 'string' ? res.pendingGrant : null);
        if (res.tempAllow && typeof res.tempAllow.active === 'boolean') {
          setTempAllowState({ active: res.tempAllow.active, target: res.tempAllow.target ?? null });
        }
        if (Array.isArray(res.grants)) setGrants(res.grants);
      } else {
        setEnabled(false);
      }
    } catch {
      setEnabled(false);
    }
  }, []);

  // 加载授权列表（独立接口，授权/撤销后刷新）
  const loadGrants = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_grants' }),
      });
      const res = await resp.json();
      if (res.ok && Array.isArray(res.grants)) {
        setGrants(res.grants.map((g: { target: string }) => g.target));
      }
    } catch { /* 忽略 */ }
  }, []);

  // 加载调用历史
  const loadHistory = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'history', limit: 10 }),
      });
      const res = await resp.json();
      if (res.ok && Array.isArray(res.history)) setHistory(res.history);
    } catch { /* 忽略 */ }
  }, []);

  // 系统授权状态检测（辅助功能 + 屏幕录制）
  const loadPermissions = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'permissions' }),
      });
      const res = await resp.json();
      if (res.ok && res.permissions) setPermissions(res.permissions);
    } catch { /* 忽略 */ }
  }, []);

  // 轮询：状态 5s，授权/历史/系统权限 30s
  useEffect(() => {
    loadStatus();
    loadGrants();
    loadHistory();
    loadPermissions();
    const fast = setInterval(loadStatus, 5000);
    const slow = setInterval(() => { loadGrants(); loadHistory(); loadPermissions(); }, 30000);
    return () => { clearInterval(fast); clearInterval(slow); };
  }, [loadStatus, loadGrants, loadHistory, loadPermissions]);

  // 首次授权弹窗：检测到待授权目标且未提示过 → 弹窗询问（三选项：拒绝 / 同意 / 同意且本次不再询问）
  useEffect(() => {
    if (!pendingGrant || promptedRef.current.has(pendingGrant)) return;
    promptedRef.current.add(pendingGrant);
    askChoices({
      title: 'Bobby 请求授权',
      message: `主 Agent 正在操作「${pendingGrant}」，但该软件尚未授权。\n是否允许 Bobby 自动操作它？`,
      choices: [
        { label: '拒绝', value: 'reject' },
        { label: '同意', value: 'allow' },
        { label: '同意且本次不再询问', value: 'allow_silent' },
      ],
    }).then((choice) => {
      if (choice === 'allow' || choice === 'allow_silent') {
        doGrant(pendingGrant);
        if (choice === 'allow_silent') doTempAllow();
      }
      // reject：仅本次跳过（pendingGrant 在下次调用时会重新触发）
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGrant]);

  // 删除节点（宿主统一负责后端档案删除 + 本地移除节点/关联边）
  const handleDelete = useCallback(async () => {
    const ok = await confirmAsk({
      title: 'Delete Node?',
      message: 'Deleting "Bobby node" will permanently remove this node.\nThis action cannot be undone.',
    });
    if (!ok) return;
    nodeHost.deleteNodeWithEdges(id);
  }, [id, nodeHost, confirmAsk]);

  // 授权软件
  const doGrant = useCallback(async (target?: string) => {
    const t = (target ?? grantInput).trim();
    if (!t) return;
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grant', target: t }),
      });
      const res = await resp.json();
      if (res.ok) {
        setGrantMsg({ ok: true, detail: `已授权 ${res.granted}` });
        setGrantInput('');
        // 广播授权完成：ChatNodeKernel 监听后自动补发"已授权，继续"消息触发主 Agent 重试（无需用户手动回复）
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('bobby:granted', { detail: { target: String(res.granted ?? t) } }));
        }
        loadGrants();
        loadStatus();
      } else {
        setGrantMsg({ ok: false, detail: res.error || '授权失败' });
      }
    } catch (e) {
      setGrantMsg({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }, [grantInput, loadGrants, loadStatus]);

  // 本次任务不再询问：临时放行（target 省略 = 放行全部软件，30 分钟过期）
  const doTempAllow = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'temp_allow' }),
      });
      const res = await resp.json();
      if (res.ok) {
        setGrantMsg({ ok: true, detail: res.detail || '本次任务不再询问授权（30 分钟有效）' });
        loadStatus();
      } else {
        setGrantMsg({ ok: false, detail: res.error || '临时放行失败' });
      }
    } catch (e) {
      setGrantMsg({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }, [loadStatus]);

  // 取消临时放行
  const doTempAllowOff = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'temp_allow', durationMs: 0 }),
      });
      const res = await resp.json();
      if (res.ok) {
        setGrantMsg({ ok: true, detail: '已取消本次任务临时放行' });
        loadStatus();
      }
    } catch { /* 忽略 */ }
  }, [loadStatus]);

  // 急停：用户按 ESC / 点停止按钮 → 中止 Bobby 当前与后续鼠标键盘操作
  const doAbort = useCallback(async () => {
    try {
      await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      });
      setGrantMsg({ ok: false, detail: '已请求停止 Bobby 操作' });
    } catch { /* 忽略 */ }
  }, []);


  // 跳转系统设置对应授权页（一键引导）
  const openPermissions = useCallback(async (page: 'accessibility' | 'screen') => {
    try {
      await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open_permissions', target: page }),
      });
    } catch { /* 忽略 */ }
  }, []);

  // 撤销授权
  const doRevoke = useCallback(async (target: string) => {    try {
      const resp = await fetch('/api/bobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', target }),
      });
      const res = await resp.json();
      if (res.ok) {
        setGrantMsg({ ok: true, detail: `已撤销 ${res.revoked}` });
        loadGrants();
        loadStatus();
      }
    } catch { /* 忽略 */ }
  }, [loadGrants, loadStatus]);

  // 授权分组
  const appGrants = grants.filter((g) => g !== 'run_command');
  const hasRunCommand = grants.includes('run_command');

  const statusColor = enabled === null ? 'var(--ink-muted)' : enabled ? 'var(--success)' : 'var(--danger)';
  const running = current !== null;

  // ESC 键急停：仅 Bobby 执行中时拦截（capture 优先于 React Flow 的 ESC 取消选中）
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        doAbort();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [running, doAbort]);

  // ---- DOS 终端渲染数据 ----
  // 顶栏状态字
  const terminalState = enabled === false
    ? { text: 'OFFLINE', color: '#ff5c5c' }
    : running
      ? { text: 'RUNNING', color: '#4af626' }
      : pendingGrant
        ? { text: 'AWAIT GRANT', color: '#ffd23f' }
        : { text: 'STANDBY', color: '#2e7d32' };

  // 终端行：新进度在顶部（服务端已倒序），旧进度从底部消失（固定行数裁剪 + overflow hidden）
  interface TermRow { key: string; time: string; text: string; color: string; animate: boolean; blink?: boolean }
  const termRows: TermRow[] = [];
  if (enabled === false) {
    termRows.push({ key: 'off', time: '', text: '> ERROR: Bobby MCP not enabled (settings panel)', color: '#ff5c5c', animate: false });
  } else if (progress.length === 0) {
    BOOT_LINES.forEach((l, i) => termRows.push({ key: `boot-${i}`, time: '', text: l, color: i === BOOT_LINES.length - 1 ? '#4af626' : '#5a8a5a', animate: false }));
    termRows.push({ key: 'cursor-idle', time: '', text: '▊', color: '#4af626', animate: false, blink: true });
  } else {
    progress.slice(0, 10).forEach((p, i) => {
      const icon = KIND_ICON[p.kind] ?? '·';
      // 文本已含 ✓/✗/! 前缀时不再重复图标
      const prefix = p.text.startsWith(icon) ? '' : `${icon} `;
      termRows.push({
        key: `${p.t}-${i}`,
        time: new Date(p.t).toLocaleTimeString('zh-CN', { hour12: false }),
        text: `${prefix}${p.text}`,
        color: KIND_COLOR[p.kind] ?? '#c8f0c8',
        animate: i === 0,
      });
    });
    termRows.push({ key: 'cursor-run', time: '', text: '▊', color: '#4af626', animate: false, blink: true });
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        className="ai-node-wrapper group relative flex flex-col overflow-hidden rounded-lg border text-sm"
        style={{
          width: 460,
          // 高度自适应：授权/历史折叠时容器收缩，展开时撑开（React Flow 按内容测量）
          minHeight: 300,
          backgroundColor: 'var(--paper)',
          borderColor: selected ? 'color-mix(in oklab, var(--info) 60%, transparent)' : 'var(--line)',
          boxShadow: selected
            ? '0 0 0 2px color-mix(in oklab, var(--info) 25%, transparent), 0 8px 24px rgba(0,0,0,.12)'
            : '0 4px 14px rgba(0,0,0,.08)',
        }}
      >
        <NodeCardHeader
          title="Bobby node"
          subtitle={running ? `执行中 · ${current?.tool}` : lastUpdated ? `空闲 · ${lastUpdated}` : '插件观察 · 授权控制台'}
          rightActions={
            <div className="flex items-center gap-1.5">
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full"
                style={{ backgroundColor: statusColor, opacity: 0.9 }}
              />
              {running && (
                <button
                  type="button"
                  onClick={doAbort}
                  title="停止（急停，也可按 ESC 键）"
                  className="flex h-5 items-center gap-1 rounded-full px-2 text-10 font-medium text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: 'var(--danger)' }}
                >
                  <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: '#fff' }} />
                  停止
                </button>
              )}
              <button
                type="button"
                onClick={handleDelete}
                title="删除此节点"
                className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          }
          divider
        />
        {confirmRender}

        {/* 内容流式布局：高度随折叠/展开自适应（父容器 minHeight + auto） */}
        <div className="flex flex-col gap-2 p-3">
          {/* 实时进度 —— 老式 DOS 终端（固定大小，新进度顶部滚入，旧进度底部消失） */}
          <div
            className="relative shrink-0 overflow-hidden rounded-md border"
            style={{
              height: 176,
              backgroundColor: '#050805',
              borderColor: running ? '#1d5a1d' : '#1d3a1d',
              boxShadow: 'inset 0 0 28px rgba(74,246,38,.06)',
            }}
          >
            {/* 终端顶栏 */}
            <div
              className="flex items-center justify-between border-b px-2 py-[5px]"
              style={{ backgroundColor: '#0b120b', borderColor: '#1d3a1d' }}
            >
              <span className="text-9 tracking-wider" style={{ fontFamily: 'var(--font-mono)', color: '#3fbf4f' }}>
                BOBBY.EXE v0.5 — LOCAL EXECUTION HUB
              </span>
              <span
                className="text-9"
                style={{ fontFamily: 'var(--font-mono)', color: terminalState.color, animation: running || enabled === false ? 'bobbyBlink 1.2s step-end infinite' : undefined }}
              >
                {terminalState.text}
              </span>
            </div>
            {/* 滚动区：固定高度 + overflow hidden → 新行顶部进入，旧行被挤出底部消失 */}
            <div className="flex flex-col overflow-hidden px-2 py-1" style={{ height: 146 }}>
              {termRows.map((r, i) => (
                <div
                  key={r.key}
                  className="truncate whitespace-pre text-10"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    lineHeight: '15px',
                    color: r.color,
                    animation: r.blink
                      ? 'bobbyBlink 1s step-end infinite'
                      : r.animate
                        ? 'bobbyLineIn .18s ease-out'
                        : undefined,
                  }}
                >
                  {r.time && <span style={{ color: '#2e7d32' }}>[{r.time}] </span>}
                  {r.text}
                </div>
              ))}
            </div>
            <style>{`
              @keyframes bobbyLineIn { from { transform: translateY(-12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
              @keyframes bobbyBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
            `}</style>
          </div>

          {/* 系统授权引导（辅助功能 + 屏幕录制，macOS TCC） */}
          <div
            className="flex flex-col rounded-md border p-2"
            style={{ borderColor: 'color-mix(in oklab, var(--info) 40%, transparent)', backgroundColor: 'var(--paper)' }}
          >
            <div className="flex items-center justify-between">
              <span className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
                系统授权（macOS）
              </span>
              <button
                type="button"
                onClick={loadPermissions}
                className="text-10 transition-colors hover:opacity-80"
                style={{ color: 'var(--info)' }}
              >
                刷新
              </button>
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {[
                { key: 'accessibility' as const, label: '辅助功能（真实键鼠）', ok: permissions?.accessibility ?? false, page: 'accessibility' as const },
                { key: 'screen' as const, label: '屏幕录制（OCR 回收）', ok: permissions?.screenRecording ?? false, page: 'screen' as const },
              ].map((p) => (
                <div key={p.key} className="flex items-center justify-between rounded px-1 py-0.5" style={{ backgroundColor: 'var(--soft)' }}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: permissions === null ? 'var(--ink-muted)' : p.ok ? 'var(--success)' : 'var(--danger)' }}
                    />
                    <span className="truncate text-11" style={{ color: 'var(--ink)' }}>{p.label}</span>
                    <span className="shrink-0 text-10" style={{ color: permissions === null ? 'var(--ink-muted)' : p.ok ? 'var(--success)' : 'var(--danger)' }}>
                      {permissions === null ? '检测中' : p.ok ? '已授权' : '未授权'}
                    </span>
                  </div>
                  {permissions !== null && !p.ok && (
                    <button
                      type="button"
                      onClick={() => openPermissions(p.page)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-10 text-white transition-colors hover:opacity-90"
                      style={{ backgroundColor: 'var(--info)' }}
                    >
                      前往授权
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1 text-10 leading-snug" style={{ color: 'var(--ink-muted)' }}>
              授权后需完全重启 BobWork 生效；「自动化」权限在首次控制应用时由系统弹窗询问。
            </div>
          </div>

          {/* 软件授权（默认折叠；勾选交互已改为：列表条目行尾撤销按钮） */}
          <div
            className="flex flex-col rounded-md border p-2"
            style={{ borderColor: 'color-mix(in oklab, var(--warn) 45%, transparent)', backgroundColor: 'var(--paper)' }}
          >
            <button
              type="button"
              onClick={() => setGrantsOpen((v) => !v)}
              className="flex items-center gap-1 text-11 font-medium"
              style={{ color: 'var(--ink-muted)' }}
            >
              {grantsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <ShieldCheck className="h-3 w-3" />
              软件授权（{grants.length}）
            </button>
            {grantsOpen && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {/* 本次任务不再询问（临时放行） */}
                <div
                  className="flex items-center justify-between rounded-md border px-2 py-1"
                  style={{ borderColor: tempAllow.active ? 'color-mix(in oklab, var(--success) 45%, transparent)' : 'var(--line)', backgroundColor: tempAllow.active ? 'color-mix(in oklab, var(--success) 8%, transparent)' : 'var(--soft)' }}
                >
                  <span className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
                    本次任务不再询问
                  </span>
                  {tempAllow.active ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-10" style={{ color: 'var(--success)' }}>
                        放行中{tempAllow.target ? `：${tempAllow.target}` : '（全部）'}
                      </span>
                      <button
                        type="button"
                        onClick={doTempAllowOff}
                        className="rounded px-1.5 py-0.5 text-10 transition-colors"
                        style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink-muted)' }}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={doTempAllow}
                      className="rounded px-1.5 py-0.5 text-10 transition-colors"
                      style={{ backgroundColor: 'var(--success)', color: '#fff' }}
                    >
                      开启
                    </button>
                  )}
                </div>
                {/* 快捷授权 */}
                <div className="flex flex-wrap gap-1">
                  {QUICK_GRANTS.map((q) => {
                    const granted = q === 'run_command' ? hasRunCommand : appGrants.includes(q);
                    return (
                      <button
                        key={q}
                        type="button"
                        onClick={() => (granted ? doRevoke(q) : doGrant(q))}
                        className="rounded-full px-2 py-0.5 text-10 transition-colors"
                        style={{
                          backgroundColor: granted ? 'color-mix(in oklab, var(--success) 15%, transparent)' : 'var(--soft)',
                          border: '1px solid var(--line)',
                          color: granted ? 'var(--success)' : 'var(--ink-muted)',
                        }}
                      >
                        {q} {granted ? '✓' : '+'}
                      </button>
                    );
                  })}
                </div>
                {/* 软件授权列表：条目 + 行尾撤销按钮 */}
                {appGrants.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <div className="text-10" style={{ color: 'var(--ink-muted)' }}>软件</div>
                    {appGrants.map((g) => (
                      <div key={g} className="group flex items-center justify-between rounded px-1 py-0.5 text-xs hover:bg-[var(--paper-hover)]" style={{ color: 'var(--ink)' }}>
                        <span className="min-w-0 truncate">{g}</span>
                        <button
                          type="button"
                          onClick={() => doRevoke(g)}
                          title={`撤销 ${g} 的授权`}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--danger-soft)]"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* 命令执行授权：条目 + 行尾撤销按钮 */}
                {hasRunCommand && (
                  <div className="group flex items-center justify-between rounded px-1 py-0.5 text-xs hover:bg-[var(--paper-hover)]" style={{ color: 'var(--ink)' }}>
                    <span className="min-w-0 truncate">run_command（命令执行）</span>
                    <button
                      type="button"
                      onClick={() => doRevoke('run_command')}
                      title="撤销命令执行授权"
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--danger-soft)]"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                {/* 添加授权 */}
                <div className="flex gap-1.5 pt-0.5">
                  <input
                    value={grantInput}
                    onChange={(e) => setGrantInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doGrant(); } }}
                    placeholder="软件名，如 WPS Office / Finder"
                    className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none"
                    style={{ backgroundColor: 'var(--paper-secondary)', borderColor: 'var(--line)', color: 'var(--ink)' }}
                  />
                  <button
                    type="button"
                    onClick={() => doGrant()}
                    disabled={!grantInput.trim()}
                    className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                    style={{ backgroundColor: 'var(--warn)', color: '#fff' }}
                  >
                    授权
                  </button>
                </div>
                {grantMsg && (
                  <div
                    className="rounded-md border-l-2 px-2 py-1 text-11"
                    style={{ borderLeftColor: grantMsg.ok ? 'var(--success)' : 'var(--danger)', backgroundColor: 'var(--soft)', color: grantMsg.ok ? 'var(--ink)' : 'var(--danger)' }}
                  >
                    {grantMsg.detail}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 调用历史（默认折叠） */}
          <div
            className="flex flex-col rounded-md border p-2"
            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--soft)' }}
          >
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1 text-11 font-medium"
              style={{ color: 'var(--ink-muted)' }}
            >
              {historyOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <History className="h-3 w-3" />
              调用历史（{history.length}）
            </button>
            {historyOpen && (
              <div className="mt-1.5 flex flex-col gap-1">
                {history.length === 0 ? (
                  <div className="text-11" style={{ color: 'var(--ink-muted)' }}>暂无调用记录</div>
                ) : (
                  history.map((h, i) => (
                    <div key={i} className="flex items-start gap-1.5 rounded px-1.5 py-1 text-10" style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)' }}>
                      <span
                        className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: h.ok ? 'var(--success)' : h.grantRequired ? 'var(--warn)' : 'var(--danger)' }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate" style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>
                          {h.tool}
                          {h.grantRequired && <span style={{ color: 'var(--warn)' }}> · 需授权</span>}
                        </div>
                        <div className="truncate" style={{ color: 'var(--ink-muted)' }}>{h.summary}</div>
                      </div>
                      <span className="shrink-0" style={{ color: 'var(--ink-muted)' }}>
                        {new Date(h.time).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const BobbyNode = React.memo(function BobbyNode(props: {
  id: string;
  data: BobbyNodeData;
  selected?: boolean;
}) {
  return <BobbyNodeInner {...props} />;
});
