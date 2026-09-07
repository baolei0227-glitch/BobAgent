'use client';

import { useState } from 'react';
import { Check, ClipboardList, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 问卷交互面板：识别节点 .md 文档中 ```json 代码块形式的问卷（数组结构，
 * 元素含 question/options/allowCustom），渲染为可作答的卡片，支持把答案
 * 写回文档（在原 JSON 上附加 answer 字段）。
 */

export interface QuestionnaireItem {
  id?: string;
  question: string;
  options?: string[];
  allowCustom?: boolean;
  answer?: string;
}

export interface QuestionnaireBlock {
  /** 原始代码块文本（```json ... ```） */
  raw: string;
  /** 编辑器视图中的占位文本，写回时据此定位还原 */
  placeholder: string;
  items: QuestionnaireItem[];
}

/** ```json 代码块匹配（含 ```json 语言标识，行首闭合） */
export const JSON_CODE_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * 宽松判断 JSON 字符串是否"疑似问卷"：以 [ 开头且含 "question" 键。
 * 用于流式生成期间（JSON.parse 尚未成功）也把问卷原文替换为占位，避免裸露。
 */
export function isLikelyQuestionnaire(jsonStr: string): boolean {
  if (!/^\s*\[/.test(jsonStr)) return false;
  return /"question"\s*:/.test(jsonStr);
}

/** 查找"未闭合"的 ```json 块（AI 流式输出中，最后一段以 ```json 开头且无闭合 ```） */
function findUnclosedQuestionnaire(md: string): { raw: string } | null {
  const idx = md.lastIndexOf('```json');
  if (idx === -1) return null;
  const after = md.slice(idx + '```json'.length);
  if (after.indexOf('```') !== -1) return null; // 已闭合，交给闭合块逻辑
  const content = after.replace(/^[ \t]*\r?\n/, '');
  return isLikelyQuestionnaire(content) ? { raw: md.slice(idx) } : null;
}

/**
 * 从 markdown 中提取问卷代码块：
 * - 匹配 ```json 代码块，尝试 JSON.parse
 * - 仅接受数组且至少一个元素含 question 字段
 * - 返回问卷块列表 + 编辑器视图内容（问卷块替换为占位文本）
 * - 解析失败但疑似问卷（流式生成中）的块 → pendingPlaceholders（视图同样占位，写盘前需还原原文）
 */
export function extractQuestionnaires(md: string): {
  blocks: QuestionnaireBlock[];
  editorContent: string;
  /** 疑似问卷但尚未解析成功（流式生成中/格式异常）的代码块：视图已替换为占位，保存前需还原为原文 */
  pendingPlaceholders: { placeholder: string; raw: string }[];
} {
  const blocks: QuestionnaireBlock[] = [];
  const replaced: { raw: string; placeholder: string }[] = [];
  const pendingPlaceholders: { placeholder: string; raw: string }[] = [];
  const re = new RegExp(JSON_CODE_FENCE.source, 'g');
  let m: RegExpExecArray | null;

  while ((m = re.exec(md)) !== null) {
    const jsonStr = m[1].trim();
    if (!jsonStr.startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // 流式未写完 / 格式异常：若仍疑似问卷则先占位，避免原文裸露
      if (isLikelyQuestionnaire(jsonStr)) {
        const placeholder = '📋 问卷生成中…';
        pendingPlaceholders.push({ placeholder, raw: m[0] });
        replaced.push({ raw: m[0], placeholder });
      }
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const items = parsed.filter(
      (x): x is QuestionnaireItem =>
        !!x && typeof x === 'object' && typeof (x as QuestionnaireItem).question === 'string',
    );
    if (items.length === 0) continue;
    const ids =
      items
        .map((i) => i.id)
        .filter(Boolean)
        .join(',') || `block${blocks.length + 1}`;
    const block: QuestionnaireBlock = {
      raw: m[0],
      placeholder: `📋 问卷（${items.length} 题）请在上方面板作答 [${ids}]`,
      items,
    };
    blocks.push(block);
    replaced.push({ raw: m[0], placeholder: block.placeholder });
  }

  // 未闭合的 ```json 块（AI 流式输出中）：疑似问卷则整段占位，避免原文裸露
  const unclosed = findUnclosedQuestionnaire(md);
  if (unclosed) {
    const placeholder = '📋 问卷生成中…';
    pendingPlaceholders.push({ placeholder, raw: unclosed.raw });
    replaced.push({ raw: unclosed.raw, placeholder });
  }

  let editorContent = md;
  for (const r of replaced) {
    editorContent = editorContent.replace(r.raw, r.placeholder);
  }
  return { blocks, editorContent, pendingPlaceholders };
}

/** 生成写回文档的 JSON 块内容（保留原字段并附加 answer） */
export function buildBlockJson(items: QuestionnaireItem[], answers: (string | undefined)[]): string {
  const updated = items.map((it, i) => {
    const ans = answers[i];
    if (ans === undefined || ans.trim() === '') return it;
    return { ...it, answer: ans.trim() };
  });
  return JSON.stringify(updated, null, 2);
}

export function QuestionnairePanel({
  blocks,
  onWriteBack,
}: {
  blocks: QuestionnaireBlock[];
  onWriteBack: (updates: { placeholder: string; json: string }[]) => Promise<void>;
}) {
  // answers[块][题] = 该题答案文本（'' 表示未作答）
  const [answers, setAnswers] = useState<string[][]>(() =>
    blocks.map((b) => b.items.map((it) => it.answer ?? '')),
  );
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const setAnswer = (bi: number, qi: number, value: string) => {
    setAnswers((prev) => {
      const next = prev.map((arr) => [...arr]);
      next[bi][qi] = value;
      return next;
    });
    setSaved(false);
  };

  const hasChanges = answers.some((arr, bi) =>
    arr.some((a, qi) => a !== (blocks[bi].items[qi].answer ?? '')),
  );

  const handleWrite = async () => {
    setWriting(true);
    try {
      const updates = blocks.map((b, bi) => ({
        placeholder: b.placeholder,
        json: buildBlockJson(b.items, answers[bi]),
      }));
      await onWriteBack(updates);
      setSaved(true);
    } finally {
      setWriting(false);
    }
  };

  return (
    <div
      className="mx-3 mt-3 overflow-hidden rounded-xl border shadow-sm"
      style={{
        backgroundColor: 'var(--popover)',
        borderColor: 'var(--line)',
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* 头部 */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: expanded ? '1px solid var(--line)' : 'none' }}
      >
        <ClipboardList className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
          问卷
        </span>
        <span className="text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
          {blocks.reduce((n, b) => n + b.items.length, 0)} 题
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}
          title={expanded ? '收起问卷' : '展开问卷'}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 px-3 py-2">
          {blocks.map((block, bi) => (
            <div
              key={bi}
              className="rounded-lg p-2.5"
              style={{ backgroundColor: 'var(--paper-soft)', border: '1px solid var(--line)' }}
            >
              {block.items.map((item, qi) => (
                <div key={item.id || qi} className="mb-2 last:mb-0">
                  <div className="mb-1 flex items-start gap-1.5">
                    <span
                      className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 15%, transparent)', color: 'var(--primary)' }}
                    >
                      {qi + 1}
                    </span>
                    <span className="text-xs font-medium leading-snug" style={{ color: 'var(--ink)' }}>
                      {item.question}
                    </span>
                  </div>

                  {/* 选项 */}
                  {item.options && item.options.length > 0 && (
                    <div className="ml-6 flex flex-wrap gap-1">
                      {item.options.map((opt) => {
                        const selected = answers[bi][qi] === opt;
                        return (
                          <button
                            key={opt}
                            onClick={() => setAnswer(bi, qi, selected ? '' : opt)}
                            className="rounded-full px-2 py-0.5 text-xs transition-colors"
                            style={{
                              backgroundColor: selected
                                ? 'color-mix(in oklab, var(--primary) 16%, transparent)'
                                : 'var(--paper-soft)',
                              border: `1px solid ${
                                selected ? 'color-mix(in oklab, var(--primary) 55%, transparent)' : 'var(--line)'
                              }`,
                              color: selected ? 'var(--primary)' : 'var(--ink-muted)',
                            }}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* 自定义答案 */}
                  {item.allowCustom && (
                    <div className="ml-6 mt-1">
                      <input
                        type="text"
                        value={answers[bi][qi]}
                        onChange={(e) => setAnswer(bi, qi, e.target.value)}
                        placeholder="自定义答案（可选）"
                        className="w-full rounded-md px-2 py-1 text-xs outline-none transition-colors"
                        style={{
                          backgroundColor: 'var(--input-bg)',
                          border: '1px solid var(--line)',
                          color: 'var(--ink)',
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

          {/* 操作区 */}
          <div className="flex items-center justify-end gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }}>
                <Check className="h-3 w-3" />
                已写回文档
              </span>
            )}
            <Button
              onClick={handleWrite}
              disabled={writing || !hasChanges}
              loading={writing}
              variant="solid"
              tone="brand"
              size="sm"
              title="将当前答案写入节点文档（JSON 附加 answer 字段）"
            >
              {writing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {hasChanges ? '写回文档' : '无更改'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
