'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Paperclip, AlertCircle, Loader2, Check } from 'lucide-react';

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

interface WorkflowTemplate {
  template_id: string;
  name: string;
  description: string;
  category: string;
  steps: WorkflowStep[];
}

interface TemplateApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string | null;
  onApplied?: (projectId: string, projectName: string) => void;
}

/** 从 steps 的 prompt 中提取所有自定义变量 */
function extractVariables(steps: WorkflowStep[]): string[] {
  const vars = new Set<string>();
  for (const step of steps) {
    const matches = step.prompt.match(/\{\{(\w+)\}\}/g) || [];
    for (const m of matches) {
      const name = m.slice(2, -2);
      // 排除内置变量
      if (name !== 'upstream' && name !== 'date' && name !== 'project') {
        vars.add(name);
      }
    }
  }
  return [...vars];
}

/** 变量替换预览 */
function previewPrompt(prompt: string, variables: Record<string, string>): string {
  let result = prompt.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
  for (const [key, value] of Object.entries(variables)) {
    if (key === 'upstream') continue;
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || `{{${key}}}`);
  }
  return result;
}

export function TemplateApplyDialog({
  open,
  onOpenChange,
  templateId,
  onApplied,
}: TemplateApplyDialogProps) {
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState('');

  // 加载模板详情
  useEffect(() => {
    if (open && templateId) {
      setLoading(true);
      setError('');
      fetch(`/api/workflows/${templateId}`)
        .then(r => r.json())
        .then(data => {
          if (data.template) {
            setTemplate(data.template);
            setProjectName(data.template.name || '');
            // 初始化变量为空
            const vars = extractVariables(data.template.steps);
            const initVars: Record<string, string> = {};
            for (const v of vars) initVars[v] = '';
            setVariables(initVars);
          }
        })
        .catch(() => setError('Failed to load template'))
        .finally(() => setLoading(false));
    } else {
      setTemplate(null);
      setVariables({});
      setProjectName('');
    }
  }, [open, templateId]);

  const customVariables = useMemo(() => {
    if (!template) return [];
    return extractVariables(template.steps);
  }, [template]);

  const stepsWithHints = useMemo(() => {
    if (!template) return [];
    return template.steps.filter(s => s.attachmentHint && s.attachmentHint.trim());
  }, [template]);

  const handleApply = async () => {
    if (!templateId) return;
    setApplying(true);
    setError('');
    try {
      const resp = await fetch(`/api/workflows/${templateId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variables,
          project_name: projectName.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Apply failed');
        return;
      }
      // 切换到新项目
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', project_id: data.project.id }),
      });
      onOpenChange(false);
      window.location.reload();
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg gap-0 p-0"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'var(--ink-strong)' }}
          >
            Apply Template
          </DialogTitle>
          {template && (
            <DialogDescription className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {template.name} — Create a new project with {template.steps.length} steps
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
          ) : !template ? (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>Template not found</p>
          ) : (
            <div className="space-y-4">
              {/* Project Name */}
              <div>
                <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--ink-muted)' }}>
                  Project Name
                </p>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="New project name"
                  className="w-full rounded border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                />
              </div>

              {/* 附件提示 */}
              {stepsWithHints.length > 0 && (
                <div
                  className="rounded-md border px-3 py-2.5"
                  style={{ borderColor: 'color-mix(in oklab, var(--warn) 30%, transparent)', backgroundColor: 'color-mix(in oklab, var(--warn) 5%, transparent)' }}
                >
                  <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--warn)' }}>
                    Prepare the following attachments:
                  </p>
                  {stepsWithHints.map((step, i) => (
                    <div key={i} className="flex items-start gap-1.5 mb-1">
                      <Paperclip className="h-3 w-3 shrink-0 mt-px" style={{ color: 'var(--warn)' }} />
                      <div>
                        <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
                          Step {step.order + 1} · {step.title}
                        </span>
                        <span className="text-xs ml-1" style={{ color: 'var(--ink-muted)' }}>
                          {step.attachmentHint}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 变量输入 */}
              {customVariables.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: 'var(--ink-muted)' }}>
                    Variables
                  </p>
                  <div className="space-y-2">
                    {customVariables.map(varName => (
                      <div key={varName} className="flex items-center gap-2">
                        <span
                          className="rounded px-1.5 py-1 text-xs font-mono shrink-0"
                          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)', color: 'var(--primary)' }}
                        >
                          {`{{${varName}}}`}
                        </span>
                        <input
                          type="text"
                          value={variables[varName] || ''}
                          onChange={(e) => setVariables(prev => ({ ...prev, [varName]: e.target.value }))}
                          placeholder={`Enter ${varName}`}
                          className="flex-1 rounded border px-2 py-1 text-xs outline-none"
                          style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 预览 */}
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--ink-muted)' }}>
                  Preview
                </p>
                <div
                  className="rounded-md border divide-y"
                  style={{ borderColor: 'var(--line)' }}
                >
                  {template.steps.map((step, i) => (
                    <div key={i} className="px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                          style={{ backgroundColor: 'var(--primary)' }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
                          {step.title}
                        </span>
                        {step.modelId && (
                          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                            {step.modelId}
                          </span>
                        )}
                      </div>
                      <p className="text-xs leading-relaxed pl-5" style={{ color: 'var(--ink-muted)' }}>
                        {previewPrompt(step.prompt, variables)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* 错误提示 */}
              {error && (
                <div
                  className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4">
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
            onClick={handleApply}
            disabled={applying || !template}
            className="flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
          >
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Create Project
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
