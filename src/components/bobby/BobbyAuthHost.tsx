'use client';

/**
 * BobbyAuthHost — Bobby 全局授权宿主（挂在 app/layout.tsx，与画布/节点彻底解耦）
 *
 * 背景（2026-09-18 重构）：
 *   Bobby 的授权弹窗与权限引导原先写在画布节点 `BobbyNode` 内，靠「主 Agent 调 Bobby 工具 →
 *   画布自动创建/聚焦 BobbyNode → 节点内弹窗」这条链路触达用户。CanvasFlow 改为「自绘 pane +
 *   world 单焦点」后画布已不存在，且 `openBobbyNodeFor` 复用已有节点时只 setSelected、不会居中
 *   定位，节点可能落在视口外 —— 表现为「授权弹窗弹不出来，主 Agent 卡在等待授权」。
 *
 * 本组件把这三件事提到全局：
 *   1. 授权拦截弹窗（三选：拒绝 / 同意 / 同意且本次不再询问）→ ConfirmDialog 已 portal 到 body
 *   2. 系统权限引导（辅助功能 / 屏幕录制）→ 右下角常驻浮标，去设置一键跳转
 *   3. 执行状态与急停（当前工具 / 摘要 / abort）
 *
 * 授权完成后广播 `bobby:granted`，ChatNodeKernel 监听该事件自动补发「已授权，继续」消息，
 * 主 Agent 重试被拦截的工具调用 —— 与旧 BobbyNode 行为一致，无需用户手动回复。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, ChevronDown, ChevronUp, Square, CircleAlert } from 'lucide-react';
import { useConfirm } from '@/components/canvas/ConfirmDialog';

type Permissions = { accessibility: boolean; screenRecording: boolean };
type CurrentTask = { tool: string; summary: string; startedAt: string } | null;

/** 本次任务临时放行时长（与 bobby-mcp set_temp_allow 默认一致） */
const TEMP_ALLOW_MS = 30 * 60 * 1000;
/** 拒绝后的冷却：期间同一 target 不再打扰，冷却结束若仍待授权则重新弹 */
const REJECT_COOLDOWN_MS = 60 * 1000;

async function bobbyPost(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch('/api/bobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as Record<string, unknown>;
}

export function BobbyAuthHost() {
  const { askChoices, render: confirmRender } = useConfirm();
  /** null = 尚未探测；true = Bobby 插件已启用（MCP 设置面板开启） */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [current, setCurrent] = useState<CurrentTask>(null);
  const [pendingGrant, setPendingGrant] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // 已弹过授权的 target（防止同一目标在轮询周期内重复弹窗）
  const promptedRef = useRef<Set<string>>(new Set());
  // 正在弹窗处理中的 target（并发去重）
  const handlingRef = useRef<Set<string>>(new Set());
  // 被拒绝的 target → 拒绝时刻（冷却内不再弹）
  const rejectedAtRef = useRef<Map<string, number>>(new Map());

  const loadStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/bobby');
      const res = (await resp.json()) as {
        ok?: boolean;
        enabled?: boolean;
        current?: CurrentTask;
        pendingGrant?: string | null;
      };
      if (res.ok) {
        setEnabled(res.enabled === true);
        setCurrent(res.current ?? null);
        setPendingGrant(typeof res.pendingGrant === 'string' ? res.pendingGrant : null);
      } else {
        setEnabled(false);
        setCurrent(null);
        setPendingGrant(null);
      }
    } catch {
      setEnabled(false);
    }
  }, []);

  const loadPermissions = useCallback(async () => {
    try {
      const res = await bobbyPost({ action: 'permissions' });
      if (res.ok && res.permissions) setPermissions(res.permissions as Permissions);
    } catch {
      /* 忽略：Bobby 未启用时探测失败属预期 */
    }
  }, []);

  /** 授权某软件（写入 grants.json，持久） */
  const doGrant = useCallback(async (target: string) => {
    const res = await bobbyPost({ action: 'grant', target });
    return res.ok === true;
  }, []);

  /** 本次任务临时放行（不落盘，30 分钟） */
  const doTempAllow = useCallback(async (target: string) => {
    await bobbyPost({ action: 'temp_allow', target, durationMs: TEMP_ALLOW_MS });
  }, []);

  /** 处理一次授权拦截：弹三选 → 授权/放行 → 广播 bobby:granted */
  const handleGrantRequired = useCallback(
    async (target: string) => {
      if (handlingRef.current.has(target)) return;
      const rejectedAt = rejectedAtRef.current.get(target);
      if (rejectedAt && Date.now() - rejectedAt < REJECT_COOLDOWN_MS) return;
      if (promptedRef.current.has(target)) return;
      promptedRef.current.add(target);
      handlingRef.current.add(target);
      try {
        const choice = await askChoices({
          title: 'Bobby 请求授权',
          message: `主 Agent 正在操作「${target}」，但该软件尚未授权。\n是否允许 Bobby 自动操作它？`,
          choices: [
            { label: '拒绝', value: 'reject' },
            { label: '同意', value: 'allow' },
            { label: '同意且本次不再询问', value: 'allow_silent' },
          ],
        });
        if (choice === 'allow' || choice === 'allow_silent') {
          const ok = await doGrant(target);
          if (ok && choice === 'allow_silent') await doTempAllow(target);
          rejectedAtRef.current.delete(target);
          setHint(ok ? `已授权 ${target}` : `授权失败：${target}`);
          if (ok && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('bobby:granted', { detail: { target } }));
          }
        } else {
          // 拒绝：仅本次跳过，冷却结束后若仍在等待授权会重新询问
          promptedRef.current.delete(target);
          rejectedAtRef.current.set(target, Date.now());
          setHint(`已拒绝 ${target}`);
        }
      } finally {
        handlingRef.current.delete(target);
      }
    },
    [askChoices, doGrant, doTempAllow],
  );

  /** 急停：中止当前与后续操作 */
  const doAbort = useCallback(async () => {
    const res = await bobbyPost({ action: 'abort' });
    setHint(res.ok === true ? '已发送急停' : '急停失败');
    void loadStatus();
  }, [loadStatus]);

  /** 跳转系统设置对应授权页 */
  const openPermissionPage = useCallback(async (page: 'accessibility' | 'screen') => {
    await bobbyPost({ action: 'open_permissions', target: page });
    setHint('已打开系统设置，勾选后需完全重启 BobWork 生效');
  }, []);

  // 轮询：Bobby 启用时 5s 刷状态；未启用时降到 30s（未开启插件不该持续高频请求）
  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), enabled ? 5000 : 30_000);
    return () => clearInterval(timer);
  }, [loadStatus, enabled]);

  // 系统权限探测：启用时 30s 一次
  useEffect(() => {
    if (!enabled) return;
    void loadPermissions();
    const timer = setInterval(() => void loadPermissions(), 30_000);
    return () => clearInterval(timer);
  }, [loadPermissions, enabled]);

  // 待授权目标 → 弹窗（轮询兜底：页面刷新或错过 SSE 事件时仍能恢复）
  useEffect(() => {
    if (pendingGrant) void handleGrantRequired(pendingGrant);
  }, [pendingGrant, handleGrantRequired]);

  // 即时通道：ChatNodeKernel 收到 grant_required SSE 时广播，比 5s 轮询更快
  useEffect(() => {
    const onGrantRequired = (e: Event) => {
      const target = (e as CustomEvent<{ target?: string }>).detail?.target;
      if (typeof target === 'string' && target.trim()) void handleGrantRequired(target.trim());
    };
    window.addEventListener('bobby:grant-required', onGrantRequired);
    return () => window.removeEventListener('bobby:grant-required', onGrantRequired);
  }, [handleGrantRequired]);

  // 提示 3s 后自动消失
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(timer);
  }, [hint]);

  // Bobby 未启用：不渲染任何 UI（避免常驻噪声）
  if (enabled !== true) return <>{confirmRender}</>;

  /** 缺失的系统权限（用于浮标提示与一键跳转） */
  const missing: Array<{ key: string; label: string; page: 'accessibility' | 'screen' }> = [];
  if (permissions) {
    if (!permissions.accessibility) {
      missing.push({ key: 'accessibility', label: '辅助功能（真实键鼠）', page: 'accessibility' });
    }
    if (!permissions.screenRecording) {
      missing.push({ key: 'screen', label: '屏幕录制（OCR 回收）', page: 'screen' });
    }
  }

  return (
    <>
      {confirmRender}
      <div
        className="fixed bottom-4 right-4 z-[60] w-[300px] overflow-hidden rounded-2xl border text-[12px] shadow-lg backdrop-blur"
        style={{
          borderColor: 'var(--border)',
          backgroundColor: 'var(--popover)',
          color: 'var(--popover-foreground)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.14)',
        }}
      >
        {/* 头部：状态 + 折叠 */}
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setCollapsed((v) => !v)}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: current ? 'var(--warning, #ffd23f)' : missing.length ? 'var(--danger)' : 'var(--success)' }}
          />
          <ShieldCheck size={14} className="shrink-0" />
          <span className="flex-1 truncate font-medium">Bobby</span>
          {missing.length > 0 && (
            <span className="shrink-0 flex items-center gap-1" style={{ color: 'var(--danger)' }}>
              <CircleAlert size={12} />
              {missing.length} 项未授权
            </span>
          )}
          {collapsed ? <ChevronUp size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
        </button>

        {!collapsed && (
          <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            {/* 当前执行 */}
            {current ? (
              <div className="mb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" style={{ color: 'var(--ink-muted)' }}>
                    正在执行：{current.tool}
                  </span>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5"
                    style={{ backgroundColor: 'var(--surface-muted)' }}
                    onClick={() => void doAbort()}
                    title="急停（中止当前与后续操作）"
                  >
                    <Square size={10} />
                    停止
                  </button>
                </div>
                {current.summary && (
                  <div className="mt-0.5 line-clamp-2" style={{ color: 'var(--ink-muted)' }}>
                    {current.summary}
                  </div>
                )}
              </div>
            ) : (
              <div className="mb-2" style={{ color: 'var(--ink-muted)' }}>
                空闲 · 等待主 Agent 调度
              </div>
            )}

            {/* 系统权限引导 */}
            {permissions && (
              <div className="space-y-1">
                {missing.length === 0 ? (
                  <div style={{ color: 'var(--success)' }}>系统权限已就绪</div>
                ) : (
                  missing.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left"
                      style={{ backgroundColor: 'var(--surface-muted)' }}
                      onClick={() => void openPermissionPage(m.page)}
                    >
                      <span className="truncate">{m.label}</span>
                      <span className="shrink-0" style={{ color: 'var(--danger)' }}>
                        去设置
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {hint && (
              <div className="mt-2 truncate" style={{ color: 'var(--ink-muted)' }}>
                {hint}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
