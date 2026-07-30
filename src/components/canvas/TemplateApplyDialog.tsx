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
  onApplied?: (nodes: Array<{ node_id: string; title: string; position: { x: number; y: number } }>) => void;
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
            // 初始化变量为空
            const vars = extractVariables(data.template.steps);
            const initVars: Record<string, string> = {};
            for (const v of vars) initVars[v] = '';
            setVariables(initVars);
          }
        })
        .catch(() => setError('加载模板失败'))
        .finally(() => setLoading(false));
    } else {
      setTemplate(null);
      setVariables({});
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
          basePosition: { x: 400, y: 200 },
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || '应用失败');
        return;
      }
      onApplied?.(data.nodes);
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message || '网络错误');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg gap-0 p-0"
        style={{ fontFamily: "'Noto Serif SC', serif" }}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'oklch(0.30 0.015 50)' }}
          >
            应用模板
          </DialogTitle>
          {template && (
            <DialogDescription className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
              {template.name} — 将创建 {template.steps.length} 个节点，自动连线
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />
            </div>
          ) : !template ? (
            <p className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>模板未找到</p>
          ) : (
            <div className="space-y-4">
              {/* 附件提示 */}
              {stepsWithHints.length > 0 && (
                <div
                  className="rounded-md border px-3 py-2.5"
                  style={{ borderColor: 'oklch(0.72 0.15 60 / 0.3)', backgroundColor: 'oklch(0.55 0.15 60 / 0.05)' }}
                >
                  <p className="text-[10px] font-medium mb-1.5" style={{ color: 'oklch(0.45 0.15 60)' }}>
                    请提前准备好以下附件：
                  </p>
                  {stepsWithHints.map((step, i) => (
                    <div key={i} className="flex items-start gap-1.5 mb-1">
                      <Paperclip className="h-3 w-3 shrink-0 mt-px" style={{ color: 'oklch(0.50 0.15 60)' }} />
                      <div>
                        <span className="text-[10px] font-medium" style={{ color: 'oklch(0.40 0.015 50)' }}>
                          Step {step.order + 1} · {step.title}
                        </span>
                        <span className="text-[10px] ml-1" style={{ color: 'oklch(0.55 0.02 50)' }}>
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
                  <p className="text-[10px] font-medium mb-2" style={{ color: 'oklch(0.45 0.015 50)' }}>
                    变量替换
                  </p>
                  <div className="space-y-2">
                    {customVariables.map(varName => (
                      <div key={varName} className="flex items-center gap-2">
                        <span
                          className="rounded px-1.5 py-1 text-[10px] font-mono shrink-0"
                          style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.08)', color: 'oklch(0.50 0.12 45)' }}
                        >
                          {`{{${varName}}}`}
                        </span>
                        <input
                          type="text"
                          value={variables[varName] || ''}
                          onChange={(e) => setVariables(prev => ({ ...prev, [varName]: e.target.value }))}
                          placeholder={`输入 ${varName} 的值`}
                          className="flex-1 rounded border px-2 py-1 text-xs outline-none"
                          style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.30 0.015 50)' }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 预览 */}
              <div>
                <p className="text-[10px] font-medium mb-2" style={{ color: 'oklch(0.45 0.015 50)' }}>
                  预览
                </p>
                <div
                  className="rounded-md border divide-y"
                  style={{ borderColor: 'oklch(0.85 0.01 70)' }}
                >
                  {template.steps.map((step, i) => (
                    <div key={i} className="px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                          style={{ backgroundColor: 'oklch(0.62 0.17 45)' }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-[11px] font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                          {step.title}
                        </span>
                        {step.modelId && (
                          <span className="text-[9px]" style={{ color: 'oklch(0.50 0.02 50)' }}>
                            {step.modelId}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] leading-relaxed pl-5" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {previewPrompt(step.prompt, variables)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* 错误提示 */}
              {error && (
                <div
                  className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-[11px]"
                  style={{ backgroundColor: 'oklch(0.55 0.18 35 / 0.06)', color: 'oklch(0.50 0.18 35)' }}
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
            style={{ color: 'oklch(0.55 0.02 50)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={applying || !template}
            className="flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: '#fff' }}
          >
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            应用到画布
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
