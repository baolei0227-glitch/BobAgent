'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Code2, Plus, FolderOpen, Loader2, Boxes, Lightbulb, FileText } from 'lucide-react';
import { DEFAULT_MODEL_ID } from '@/lib/types';

interface SandboxApp {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
}

interface SandboxTemplate {
  id: string;
  label: string;
  description: string;
  entry: string;
  /** 可选：每个模板自带的"灵感需求描述种子"，选模板时预填需求描述框（可选） */
  promptSeed?: { category: string; interaction: string; persistence: string };
}

interface CreatedNodePayload {
  nodeId: string;
  title: string;
  sandboxAppId?: string;
  appName?: string;
  /** 可选：用户在创建对话框里填写的初始需求，画布层需要先把它作为首轮 user 消息塞进节点 */
  initialPrompt?: string;
}

interface Props {
  open: boolean;
  /** 画布坐标（flow 坐标），创建节点时写入 frontmatter 便于重启恢复布局 */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** 创建成功回调，由画布层挂载节点并打开预览 */
  onCreated: (payload: CreatedNodePayload) => void;
}

/**
 * AI Coding 节点创建对话框（画布空白处右键 → AI Coding 节点触发）：
 *  - 新建项目：输入小程序名称 + 选模板，先建 sandbox app 再建绑定节点
 *  - 绑定已有：从现有小程序列表选择，创建绑定同一 app 的节点
 * AI Coding 节点创建时写入 frontmatter.sandbox_app_id，
 * 后端 /api/chat 会据此注入编程上下文（写入路径、截图自检闭环）。
 */
export function AICodingCreateDialog({ open, position, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'create' | 'bind'>('create');
  const [apps, setApps] = useState<SandboxApp[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  /** 灵感卡片（推荐分类 + 对应模板 id，点击即选中并预填） */
  const INSPIRATIONS: { label: string; emoji: string; tplId: string; desc: string }[] = [
    { label: '待办清单', emoji: '✅', tplId: 'todo', desc: '任务管理、勾勾选选、历史记录保留' },
    { label: '习惯打卡', emoji: '🌱', tplId: 'habit', desc: '每日签到、连续天数统计' },
    { label: '番茄钟', emoji: '🍅', tplId: 'pomodoro', desc: '专注计时、短休长休、今日完成统计' },
    { label: '联系表单', emoji: '📋', tplId: 'contact-form', desc: '客户登记、问卷收集、历史记录回看' },
    { label: '数据报表', emoji: '📊', tplId: 'data-table', desc: 'KPI 卡 + 表格 + 达成率进度条' },
    { label: '个人主页', emoji: '👤', tplId: 'portfolio', desc: '头像介绍 + 技能标签 + 链接入口' },
    { label: '营销落地', emoji: '🚀', tplId: 'landing', desc: '标题卖点 + CTA 邮箱收集' },
    { label: '文档阅读', emoji: '📖', tplId: 'reader', desc: '字号主题切换、进度条、目录导航' },
    { label: '单位换算', emoji: '🔁', tplId: 'converter', desc: '长度/重量/温度/面积/体积六类' },
    { label: '计算器', emoji: '🧮', tplId: 'calculator', desc: '基础四则运算、括号优先' },
    { label: 'AI 问答', emoji: '🤖', tplId: 'blank', desc: '需要接入 AI 聊天能力的小程序' },
    { label: '自由发挥', emoji: '✨', tplId: 'blank', desc: '空白模板，自定义功能' },
  ];

  const loadSandbox = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/sandbox');
      const data = await resp.json();
      if (data.success) {
        setApps(data.apps || []);
        setTemplates(data.templates || []);
      }
    } catch {
      setApps([]);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时重置状态并预加载小程序清单与模板
  useEffect(() => {
    if (open) {
      setMode('create');
      setName('');
      setTemplate('blank');
      setPrompt('');
      loadSandbox();
    }
  }, [open, loadSandbox]);

  if (!open) return null;

  /** 创建绑定节点，成功后统一回调 */
  const createNode = async (title: string, sandboxAppId: string, appName: string, initialPromptText = '') => {
    setCreating(true);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title,
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: 'coding',
          ...(position ? { position_x: position.x, position_y: position.y } : {}),
          sandbox_app_id: sandboxAppId,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onCreated({
          nodeId: data.node_id,
          title: data.title || title,
          sandboxAppId,
          appName,
          initialPrompt: initialPromptText.trim() || undefined,
        });
        onClose();
      }
    } catch {
      // 创建失败：忽略，保持对话框打开
    } finally {
      setCreating(false);
    }
  };

  /** 新建小程序项目 → 创建 AI Coding 节点 */
  const handleCreateApp = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: name.trim() || 'Untitled App', template }),
      });
      const data = await resp.json();
      if (data.success && data.app) {
        await createNode(data.app.name, data.app.id, data.app.name, prompt);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.18)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          fontFamily: "var(--font-sans)",
        }}
      >
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <Code2 className="h-4 w-4" style={{ color: 'var(--info)' }} />
            AI Coding 节点
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--line-soft)]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          新建或绑定 Bob Sandbox 小程序，AI 将在此编程并自动预览自检。
        </p>

        {/* 模式切换：新建项目 / 绑定已有 */}
        <div className="mb-3 flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <button
            type="button"
            onClick={() => setMode('create')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'create'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Plus className="h-3.5 w-3.5" />
            新建项目
          </button>
          <button
            type="button"
            onClick={() => setMode('bind')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'bind'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <FolderOpen className="h-3.5 w-3.5" />
            绑定已有
          </button>
        </div>

        {mode === 'create' ? (
          /* ---- 新建项目 ---- */
          <div>
            {/* 灵感卡片网格 */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <Lightbulb className="h-3.5 w-3.5" style={{ color: 'var(--warn)' }} />
                我想做…（先选一个方向，模板和需求描述会自动预填）
              </div>
              <div
                className="grid max-h-[240px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5"
              >
                {INSPIRATIONS.map((ins) => {
                  const active = template === ins.tplId;
                  return (
                    <button
                      key={ins.label}
                      type="button"
                      onClick={() => {
                        setTemplate(ins.tplId);
                        if (!name) setName(ins.label);
                        // 预填需求描述（仅当 prompt 为空时，避免覆盖用户手写内容）
                        if (!prompt.trim()) {
                          setPrompt(
                            `做一个「${ins.label}」小程序：${ins.desc}。${
                              templates.find((t) => t.id === ins.tplId)?.promptSeed
                                ? `\n\n我的设计偏好（AI 首轮会再弹出设计表单确认）：\n- 功能分类：${templates.find((t) => t.id === ins.tplId)!.promptSeed!.category}\n- 交互方式：${templates.find((t) => t.id === ins.tplId)!.promptSeed!.interaction}\n- 数据持久化：${templates.find((t) => t.id === ins.tplId)!.promptSeed!.persistence}`
                                : ''
                            }`,
                          );
                        }
                      }}
                      className="flex items-start gap-2 rounded-lg border p-2 text-left transition-all hover:shadow-sm"
                      style={{
                        borderColor: active ? 'color-mix(in oklab, var(--info) 55%, transparent)' : 'var(--line)',
                        backgroundColor: active
                          ? 'color-mix(in oklab, var(--info) 7%, transparent)'
                          : 'var(--popover)',
                        boxShadow: active ? '0 1px 4px rgba(0,0,0,0.06)' : undefined,
                      }}
                    >
                      <span className="text-base leading-none">{ins.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-13 font-semibold"
                          style={{ color: 'var(--ink-strong)' }}
                        >
                          {ins.label}
                        </span>
                        <span
                          className="block truncate text-11"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          {ins.desc}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 基础字段：名称 + 模板下拉（兜底，灵感未覆盖时使用） */}
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>项目名</span>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateApp()}
              placeholder="小程序名称（如：合同审查助手）"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--info)]"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            />
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="mt-2 w-full rounded-lg border px-2 py-2 text-xs outline-none"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            >
              {templates.length === 0 ? (
                <option value="blank">Blank（空白模板）</option>
              ) : (
                templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} — {t.description}
                  </option>
                ))
              )}
            </select>

            {/* 需求描述大文本框 */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <FileText className="h-3.5 w-3.5" />
                需求描述（可选，不填直接进入设计表单）
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateApp();
                }}
                placeholder="简单告诉我你想要什么功能？比如：「做一个帮我算加班费的工具，输入月薪和加班小时数，自动算出应得金额」。创建后 AI 还会弹出设计表单供你确认。"
                rows={4}
                className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--info)]"
                style={{
                  borderColor: 'var(--line)',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.6,
                }}
              />
              <div
                className="mt-1 flex items-center justify-between"
                style={{ color: 'var(--ink-muted)' }}
              >
                <span className="text-11">⌘/Ctrl + Enter 快速创建 · 填写越多首版越精准</span>
                <span className="text-11">{prompt.length}/800</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreateApp}
              disabled={creating}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-60"
              style={{ backgroundColor: 'var(--info)' }}
            >
              {creating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Code2 className="h-3.5 w-3.5" />
                  新建并创建 Coding 节点
                </>
              )}
            </button>
          </div>
        ) : (
          /* ---- 绑定已有项目 ---- */
          <div className="max-h-[260px] overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--info)' }} />
              </div>
            ) : apps.length === 0 ? (
              <p className="py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                暂无小程序，请先切换到「新建项目」创建
              </p>
            ) : (
              apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => createNode(app.name, app.id, app.name)}
                  disabled={creating}
                  className="mb-1.5 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--info)_8%,transparent)] disabled:opacity-60"
                  style={{ borderColor: 'color-mix(in oklab, var(--info) 50%, transparent)', backgroundColor: 'var(--popover)' }}
                >
                  <Boxes className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>
                      {app.name}
                    </span>
                    {app.description && (
                      <span className="block truncate text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                        {app.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
