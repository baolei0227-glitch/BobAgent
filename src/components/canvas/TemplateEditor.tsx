'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Trash2, GripVertical, Save, Play, Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import { loadSettings } from '@/lib/settings';
import { getAvailableModels, type ProviderConfig } from '@/lib/types';

// ── 类型 ──

interface WorkflowStep {
  order: number;
  title: string;
  modelId?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  skills: string[];
  prompt: string;
  attachmentHint?: string;
  attachments?: string[];
}

interface TemplateEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId?: string;       // 编辑已有模板时传入
  initialSteps?: WorkflowStep[]; // 从画布节点创建时预填
  initialName?: string;
  onSaved?: () => void;
}

const THINKING_OPTIONS: Array<{ value: 'off' | 'low' | 'medium' | 'high'; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

// ── 迷你画布预览节点 ──

function TemplatePreviewNode({ data }: NodeProps) {
  const step = data.step as WorkflowStep;
  const idx = data.idx as number;

  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-sm"
      style={{
        width: 200,
        borderColor: 'oklch(0.62 0.17 45 / 0.25)',
        backgroundColor: 'oklch(0.99 0.003 80)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ backgroundColor: 'oklch(0.62 0.17 45)' }}
        >
          {idx + 1}
        </span>
        <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
          {step.title || `步骤 ${idx + 1}`}
        </span>
      </div>
      {step.modelId && (
        <div className="mt-0.5 text-[10px]" style={{ color: 'oklch(0.50 0.02 50)' }}>
          {step.modelId}
        </div>
      )}
      {step.thinkingLevel && step.thinkingLevel !== 'off' && (
        <div className="text-[10px]" style={{ color: 'oklch(0.55 0.15 60)' }}>
          思考: {step.thinkingLevel}
        </div>
      )}
      {step.attachmentHint && (
        <div className="mt-0.5 text-[10px] truncate" style={{ color: 'oklch(0.50 0.15 220)' }}>
          {step.attachmentHint}
        </div>
      )}
      <div className="mt-1 text-[10px] line-clamp-2" style={{ color: 'oklch(0.55 0.02 50)' }}>
        {step.prompt || '（无提示词）'}
      </div>
      {step.skills.length > 0 && (
        <div className="mt-1 flex gap-1 flex-wrap">
          {step.skills.map(s => (
            <span
              key={s}
              className="text-[9px] rounded px-1 py-px"
              style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.08)', color: 'oklch(0.50 0.12 45)' }}
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { templateNode: TemplatePreviewNode };

// ── 单步编辑器 ──

function StepEditor({
  step,
  idx,
  total,
  availableModels,
  availableSkills,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: WorkflowStep;
  idx: number;
  total: number;
  availableModels: Array<{ modelId: string; label: string }>;
  availableSkills: string[];
  onChange: (updated: WorkflowStep) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.99 0.003 80)' }}
    >
      {/* 步骤头部 */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: 'oklch(0.62 0.17 45)' }}
        >
          {idx + 1}
        </span>
        <input
          type="text"
          value={step.title}
          onChange={(e) => onChange({ ...step, title: e.target.value })}
          placeholder="步骤标题"
          className="flex-1 rounded border px-2 py-1 text-xs outline-none"
          style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
        />
        <button
          type="button"
          onClick={onMoveUp}
          disabled={idx === 0}
          className="rounded p-1 transition-colors hover:bg-[oklch(0.92_0.015_75)] disabled:opacity-30"
        >
          <ChevronUp className="h-3 w-3" style={{ color: 'oklch(0.55 0.02 50)' }} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={idx === total - 1}
          className="rounded p-1 transition-colors hover:bg-[oklch(0.92_0.015_75)] disabled:opacity-30"
        >
          <ChevronDown className="h-3 w-3" style={{ color: 'oklch(0.55 0.02 50)' }} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 transition-colors hover:bg-[oklch(0.55_0.18_35_/_0.1)]"
        >
          <Trash2 className="h-3 w-3" style={{ color: 'oklch(0.55 0.18 35)' }} />
        </button>
      </div>

      {/* 模型 + 思考强度 */}
      <div className="flex items-center gap-2 mb-2">
        <select
          value={step.modelId || ''}
          onChange={(e) => onChange({ ...step, modelId: e.target.value || undefined })}
          className="rounded border px-2 py-1 text-[11px] outline-none"
          style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
        >
          <option value="">默认模型</option>
          {availableModels.map(m => (
            <option key={m.modelId} value={m.modelId}>{m.label}</option>
          ))}
        </select>
        <select
          value={step.thinkingLevel || 'off'}
          onChange={(e) => onChange({ ...step, thinkingLevel: e.target.value as WorkflowStep['thinkingLevel'] })}
          className="rounded border px-2 py-1 text-[11px] outline-none"
          style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
        >
          {THINKING_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>思考: {o.label}</option>
          ))}
        </select>
      </div>

      {/* 附件说明 */}
      <input
        type="text"
        value={step.attachmentHint || ''}
        onChange={(e) => onChange({ ...step, attachmentHint: e.target.value })}
        placeholder="附件说明（可选）：该步骤需要上传什么文件"
        className="w-full rounded border px-2 py-1 text-[11px] outline-none mb-2"
        style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
      />

      {/* 技能多选 */}
      {availableSkills.length > 0 && (
        <div className="mb-2">
          <div className="flex flex-wrap gap-1">
            {availableSkills.slice(0, 12).map(skillName => {
              const checked = step.skills.includes(skillName);
              return (
                <button
                  key={skillName}
                  type="button"
                  onClick={() => {
                    const newSkills = checked
                      ? step.skills.filter(s => s !== skillName)
                      : [...step.skills, skillName];
                    onChange({ ...step, skills: newSkills });
                  }}
                  className="text-[9px] rounded px-1.5 py-0.5 transition-colors"
                  style={{
                    backgroundColor: checked ? 'oklch(0.62 0.17 45 / 0.12)' : 'oklch(0.95 0.008 80)',
                    color: checked ? 'oklch(0.50 0.12 45)' : 'oklch(0.55 0.02 50)',
                  }}
                >
                  {checked ? '✓ ' : ''}{skillName}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 提示词 */}
      <textarea
        value={step.prompt}
        onChange={(e) => onChange({ ...step, prompt: e.target.value })}
        placeholder="提示词（支持 {{变量名}} 占位符，{{upstream}} 运行时替换为上游输出）"
        rows={3}
        className="w-full rounded border px-2 py-1 text-[11px] outline-none resize-y"
        style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
      />
    </div>
  );
}

// ── 主组件 ──

export function TemplateEditor({
  open,
  onOpenChange,
  templateId,
  initialSteps,
  initialName,
  onSaved,
}: TemplateEditorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('通用');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);

  // 初始化
  useEffect(() => {
    if (open) {
      setName(initialName || '');
      setDescription('');
      setCategory('通用');
      setSteps(initialSteps || [createEmptyStep(0)]);
      setError('');

      // 加载模型列表
      loadSettings().then(s => setProviderConfigs(s.providers));

      // 加载技能列表
      fetch('/api/skills')
        .then(r => r.json())
        .then(data => {
          setAvailableSkills((data.skills || []).map((s: any) => s.name));
        })
        .catch(() => {});

      // 加载已有模板
      if (templateId) {
        fetch(`/api/workflows/${templateId}`)
          .then(r => r.json())
          .then(data => {
            if (data.template) {
              setName(data.template.name);
              setDescription(data.template.description);
              setCategory(data.template.category);
              setSteps(data.template.steps);
            }
          })
          .catch(() => {});
      }
    }
  }, [open, templateId, initialSteps, initialName]);

  const availableModels = useMemo(() => {
    return getAvailableModels(providerConfigs);
  }, [providerConfigs]);

  // ── 步骤操作 ──

  const updateStep = (idx: number, updated: WorkflowStep) => {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...updated, order: i } : s));
  };

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i })));
  };

  const addStep = () => {
    setSteps(prev => [...prev, createEmptyStep(prev.length)]);
  };

  const moveStep = (idx: number, dir: 'up' | 'down') => {
    setSteps(prev => {
      const next = [...prev];
      const target = dir === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((s, i) => ({ ...s, order: i }));
    });
  };

  // ── 保存 ──

  const handleSave = async (applyAfter = false) => {
    setError('');
    if (!name.trim()) {
      setError('请输入模板名称');
      return;
    }
    if (steps.length === 0) {
      setError('至少需要一个步骤');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        steps: steps.map((s, i) => ({ ...s, order: i })),
      };

      let savedTemplateId = templateId;
      if (templateId) {
        await fetch(`/api/workflows/${templateId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        const resp = await fetch('/api/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        savedTemplateId = data.template_id;
      }

      onSaved?.();
      onOpenChange(false);

      if (applyAfter && savedTemplateId) {
        window.dispatchEvent(new CustomEvent('apply-workflow-template', {
          detail: { template_id: savedTemplateId },
        }));
      }
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // ── 画布预览 nodes/edges ──

  const previewNodes: Node[] = steps.map((step, i) => ({
    id: `step-${i}`,
    type: 'templateNode',
    position: { x: 80, y: i * 140 },
    data: { step, idx: i },
    draggable: false,
    connectable: false,
    selectable: false,
  }));

  const previewEdges: Edge[] = steps.slice(0, -1).map((_, i) => ({
    id: `edge-${i}`,
    source: `step-${i}`,
    target: `step-${i + 1}`,
    type: 'smoothstep',
    style: { stroke: 'oklch(0.62 0.17 45 / 0.4)', strokeWidth: 2 },
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl gap-0 p-0"
        style={{ fontFamily: "'Noto Serif SC', serif" }}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'oklch(0.30 0.015 50)' }}
          >
            {templateId ? '编辑模板' : '新建模板'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 px-6 pb-2" style={{ height: '65vh' }}>
          {/* 左侧：编辑区 */}
          <div className="w-1/2 overflow-y-auto pr-2">
            {/* 基本信息 */}
            <div className="space-y-2 mb-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="模板名称"
                className="w-full rounded border px-3 py-1.5 text-xs outline-none"
                style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述（可选）"
                className="w-full rounded border px-3 py-1.5 text-xs outline-none"
                style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
              />
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="分类"
                className="w-full rounded border px-3 py-1.5 text-xs outline-none"
                style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
              />
            </div>

            {/* 步骤列表 */}
            <div className="space-y-2 mb-3">
              {steps.map((step, idx) => (
                <StepEditor
                  key={idx}
                  step={step}
                  idx={idx}
                  total={steps.length}
                  availableModels={availableModels}
                  availableSkills={availableSkills}
                  onChange={(updated) => updateStep(idx, updated)}
                  onRemove={() => removeStep(idx)}
                  onMoveUp={() => moveStep(idx, 'up')}
                  onMoveDown={() => moveStep(idx, 'down')}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={addStep}
              className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-2 text-xs transition-colors hover:bg-[oklch(0.95_0.008_80)]"
              style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.55 0.02 50)' }}
            >
              <Plus className="h-3 w-3" />
              添加步骤
            </button>
          </div>

          {/* 右侧：画布映射预览 */}
          <div
            className="w-1/2 rounded-md border overflow-hidden"
            style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.98 0.005 80)' }}
          >
            <div
              className="px-3 py-1.5 text-[10px] font-medium border-b"
              style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.45 0.015 50)', backgroundColor: 'oklch(0.96 0.008 80)' }}
            >
              画布预览映射
            </div>
            <div style={{ height: 'calc(100% - 28px)' }}>
              <ReactFlow
                nodes={previewNodes}
                edges={previewEdges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                panOnScroll={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="oklch(0.90 0.008 80)" />
              </ReactFlow>
            </div>
          </div>
        </div>

        {/* 底部 */}
        {error && (
          <p className="px-6 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>{error}</p>
        )}
        <div className="flex items-center justify-between px-6 py-4">
          <span className="text-[11px]" style={{ color: 'oklch(0.50 0.02 50)' }}>
            {steps.length} 个步骤
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md px-4 py-1.5 text-xs transition-colors hover:bg-gray-100"
              style={{ color: 'oklch(0.55 0.02 50)' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => handleSave(false)}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs transition-colors disabled:opacity-50"
              style={{ backgroundColor: 'oklch(0.92 0.01 60)', color: 'oklch(0.30 0.015 50)' }}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              保存
            </button>
            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: '#fff' }}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              保存并应用
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 工具函数 ──

function createEmptyStep(order: number): WorkflowStep {
  return {
    order,
    title: '',
    skills: [],
    prompt: '',
  };
}
