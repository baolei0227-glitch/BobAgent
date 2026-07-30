'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, FileStack, Pencil, Trash2, Play, Loader2, ChevronDown } from 'lucide-react';

interface WorkflowStep {
  order: number;
  title: string;
  modelId?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  skills: string[];
  prompt: string;
  attachmentHint?: string;
}

interface WorkflowTemplate {
  template_id: string;
  project_id: string;
  name: string;
  description: string;
  category: string;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

interface TemplatePanelProps {
  onCreateNew: () => void;
  onEditTemplate: (templateId: string) => void;
  onApplyTemplate: (templateId: string) => void;
  refreshTrigger?: number;
}

export function TemplatePanel({ onCreateNew, onEditTemplate, onApplyTemplate, refreshTrigger }: TemplatePanelProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/workflows');
      const data = await resp.json();
      setTemplates(data.templates || []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates, refreshTrigger]);

  const handleDelete = async (templateId: string) => {
    try {
      await fetch(`/api/workflows/${templateId}`, { method: 'DELETE' });
      setTemplates(prev => prev.filter(t => t.template_id !== templateId));
      setConfirmDelete(null);
    } catch {
      // ignore
    }
  };

  return (
    <div className="px-2 py-1">
      {/* 标题栏 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-left"
      >
        <ChevronDown
          className="h-3 w-3 transition-transform"
          style={{
            color: 'oklch(0.55 0.02 50)',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        />
        <FileStack className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
        <span className="text-[11px] font-semibold" style={{ color: 'oklch(0.35 0.015 50)' }}>
          Templates
        </span>
        <span className="text-[10px] ml-auto" style={{ color: 'oklch(0.50 0.02 50 / 0.6)' }}>
          {templates.length}
        </span>
      </button>

      {/* 模板列表 */}
      {expanded && (
        <div className="mt-1 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />
            </div>
          ) : templates.length === 0 ? (
            <p className="px-2 py-2 text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
              暂无模板
            </p>
          ) : (
            templates.map(tpl => (
              <div
                key={tpl.template_id}
                className="group rounded-md border px-2 py-1.5 transition-colors hover:bg-[oklch(0.95_0.008_80)]"
                style={{ borderColor: 'oklch(0.88 0.008 70)', backgroundColor: 'oklch(0.99 0.003 80)' }}
              >
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onApplyTemplate(tpl.template_id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                        {tpl.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[9px]" style={{ color: 'oklch(0.50 0.02 50 / 0.7)' }}>
                        {tpl.steps.length} 步
                      </span>
                      {tpl.category && (
                        <span className="text-[9px]" style={{ color: 'oklch(0.50 0.02 50 / 0.5)' }}>
                          · {tpl.category}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => onApplyTemplate(tpl.template_id)}
                      className="rounded p-1 transition-colors hover:bg-[oklch(0.62_0.17_45_/_0.1)]"
                      title="应用模板"
                    >
                      <Play className="h-3 w-3" style={{ color: 'oklch(0.62 0.17 45)' }} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditTemplate(tpl.template_id)}
                      className="rounded p-1 transition-colors hover:bg-[oklch(0.92_0.015_75)]"
                      title="编辑"
                    >
                      <Pencil className="h-3 w-3" style={{ color: 'oklch(0.55 0.02 50)' }} />
                    </button>
                    {confirmDelete === tpl.template_id ? (
                      <button
                        type="button"
                        onClick={() => handleDelete(tpl.template_id)}
                        className="text-[9px] rounded px-1 py-0.5"
                        style={{ color: '#fff', backgroundColor: 'oklch(0.55 0.18 35)' }}
                      >
                        确认
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(tpl.template_id)}
                        className="rounded p-1 transition-colors hover:bg-[oklch(0.55_0.18_35_/_0.1)]"
                        title="删除"
                      >
                        <Trash2 className="h-3 w-3" style={{ color: 'oklch(0.55 0.18 35)' }} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}

          {/* 新建按钮 */}
          <button
            type="button"
            onClick={onCreateNew}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-[10px] transition-colors hover:bg-[oklch(0.95_0.008_80)]"
            style={{ borderColor: 'oklch(0.85 0.01 70)', color: 'oklch(0.55 0.02 50)' }}
          >
            <Plus className="h-3 w-3" />
            新建模板
          </button>
        </div>
      )}
    </div>
  );
}
