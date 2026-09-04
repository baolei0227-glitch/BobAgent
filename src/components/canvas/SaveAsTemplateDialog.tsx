'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Save, Loader2, AlertCircle } from 'lucide-react';
import type { Node, Edge } from '@xyflow/react';
import type { AiChatNodeData } from '@/lib/types';

// ── Types ──

interface WorkflowStep {
  order: number;
  title: string;
  modelId?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  skills: string[];
  tools: string[];
  prompt: string;
  attachmentHint?: string;
  nextSteps?: number[];
}

interface SaveAsTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes?: Node<AiChatNodeData>[];
  edges?: Edge[];
  onSaved?: () => void;
}

// ── Step extraction ──

function extractStepsFromNodes(nodes: Node<AiChatNodeData>[], edges: Edge[]): WorkflowStep[] {
  const sorted = [...nodes].sort((a, b) => {
    if (Math.abs(a.position.y - b.position.y) > 30) return a.position.y - b.position.y;
    return a.position.x - b.position.x;
  });

  const idToIndex = new Map<string, number>();
  sorted.forEach((n, i) => idToIndex.set(n.id, i));

  return sorted.map((node, i) => {
    const data = node.data;
    const firstUserMsg = data.messages?.find((m) => m.role === 'user');
    const prompt = firstUserMsg?.content || '';

    const nextSteps: number[] = [];
    for (const edge of edges) {
      if (edge.source === node.id) {
        const targetIdx = idToIndex.get(edge.target);
        if (targetIdx !== undefined && !nextSteps.includes(targetIdx)) {
          nextSteps.push(targetIdx);
        }
      }
    }

    return {
      order: i,
      title: data.title || `Step ${i + 1}`,
      modelId: data.modelId,
      thinkingLevel: data.thinkingLevel as WorkflowStep['thinkingLevel'],
      skills: (data.skills as string[]) || [],
      tools: (data.tools as string[]) || [],
      prompt,
      attachmentHint: (data.attachmentHint as string) || undefined,
      nextSteps: nextSteps.length > 0 ? nextSteps : (i < sorted.length - 1 ? [i + 1] : undefined),
    };
  });
}

export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  nodes,
  edges,
  onSaved,
}: SaveAsTemplateDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('General');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);

  // 打开时从画布节点提取
  useEffect(() => {
    if (open && nodes && nodes.length > 0) {
      setName('');
      setDescription('');
      setCategory('General');
      setError('');
      setSteps(extractStepsFromNodes(nodes, edges || []));
    }
  }, [open, nodes, edges]);

  const handleSave = async () => {
    setError('');
    if (!name.trim()) {
      setError('Please enter a template name');
      return;
    }
    if (steps.length === 0) {
      setError('No steps to save');
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          category: category.trim(),
          steps: steps.map((s, i) => ({ ...s, order: i })),
        }),
      });
      const data = await resp.json();
      if (data.template_id) {
        onSaved?.();
        window.dispatchEvent(new Event('templates-changed'));
        onOpenChange(false);
      } else {
        setError(data.error || 'Save failed');
      }
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[460px] !max-w-[460px] !max-h-[80vh] rounded-lg gap-0 p-0 flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'var(--ink-strong)' }}
          >
            Save as Template
          </DialogTitle>
          <DialogDescription className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Save current canvas ({steps.length} steps) as a reusable workflow template.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-3 space-y-2.5 shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template Name"
              className="flex-1 rounded border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
              autoFocus
            />
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Category"
              className="w-28 rounded border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
            />
          </div>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="w-full rounded border px-2 py-1.5 text-xs outline-none"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
          />
        </div>

        {/* Steps preview (read-only) */}
        <div className="px-5 pb-2 flex-1 min-h-0 overflow-y-auto">
          <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
            Steps ({steps.length})
          </span>
          <div className="mt-1.5 space-y-1.5">
            {steps.map((step, idx) => (
              <div
                key={idx}
                className="rounded border px-2.5 py-1.5 text-xs"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: 'var(--primary)' }}
                  >
                    {idx + 1}
                  </span>
                  <span className="font-medium truncate" style={{ color: 'var(--ink-strong)' }}>
                    {step.title || `Step ${idx + 1}`}
                  </span>
                  {step.modelId && (
                    <span className="text-xs shrink-0" style={{ color: 'var(--ink-muted)' }}>
                      {step.modelId}
                    </span>
                  )}
                </div>
                {step.prompt && (
                  <p className="mt-0.5 text-xs line-clamp-2" style={{ color: 'var(--ink-muted)' }}>
                    {step.prompt}
                  </p>
                )}
                <div className="flex gap-1 mt-0.5 flex-wrap">
                  {step.skills.map((s) => (
                    <span
                      key={s}
                      className="text-xs rounded px-1 py-px"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)', color: 'var(--primary)' }}
                    >
                      {s}
                    </span>
                  ))}
                  {step.tools.map((t) => (
                    <span
                      key={t}
                      className="text-xs rounded px-1 py-px"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--info) 10%, transparent)', color: 'var(--info)' }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                {step.nextSteps && step.nextSteps.length > 0 && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--ink-muted)' }}>
                    → {step.nextSteps.map((n) => `Step ${n + 1}`).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="px-5 py-1 text-xs shrink-0 flex items-center gap-1" style={{ color: 'var(--danger)' }}>
            <AlertCircle className="h-3 w-3" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 px-5 py-3 shrink-0 border-t" style={{ borderColor: 'var(--line-soft)' }}>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-4 py-1.5 text-xs transition-colors hover:bg-gray-100"
            style={{ color: 'var(--ink-muted)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || steps.length === 0}
            className="flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'var(--primary)' }}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save Template
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
