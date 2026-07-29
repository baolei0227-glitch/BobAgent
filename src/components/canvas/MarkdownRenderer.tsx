'use client';

import React from 'react';

interface MarkdownRendererProps {
  content: string;
}

/** 行内元素类型 */
type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

/** 解析行内 markdown */
function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const regex = /(`[^`]+`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIdx = 0;

  for (const match of text.matchAll(regex)) {
    const before = text.slice(lastIdx, match.index);
    if (before) tokens.push({ type: 'text', text: before });

    const raw = match[0];
    if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ type: 'bold', text: match[2] || raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*') && !raw.startsWith('**')) {
      tokens.push({ type: 'italic', text: match[3] || raw.slice(1, -1) });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('[')) {
      tokens.push({ type: 'link', text: match[4] || '', url: match[5] || '' });
    }

    lastIdx = (match.index ?? 0) + raw.length;
  }

  const tail = text.slice(lastIdx);
  if (tail) tokens.push({ type: 'text', text: tail });

  return tokens;
}

/** 渲染行内元素 */
function renderInline(tokens: InlineToken[]): React.ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'bold':
        return <strong key={i} className="font-semibold">{t.text}</strong>;
      case 'italic':
        return <em key={i}>{t.text}</em>;
      case 'code':
        return (
          <code key={i} className="rounded bg-black/5 px-1 py-0.5 text-[11px]" style={{ fontFamily: '"SF Mono", Menlo, monospace' }}>
            {t.text}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={t.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: '#537D96' }}>
            {t.text || t.url}
          </a>
        );
      default:
        return <span key={i}>{t.text}</span>;
    }
  });
}

/** 解析单行为 React 元素 */
function renderLine(line: string, key: number): React.ReactNode {
  // 空行
  if (!line.trim()) return <div key={key} className="h-2" />;

  // h1-h3
  if (/^### (.+)/.test(line)) {
    const text = line.replace(/^### /, '');
    return (
      <h3 key={key} className="mt-3 mb-1 text-[13px] font-semibold" style={{ color: '#2c2416' }}>
        {renderInline(parseInline(text))}
      </h3>
    );
  }
  if (/^## (.+)/.test(line)) {
    const text = line.replace(/^## /, '');
    return (
      <h2 key={key} className="mt-4 mb-1.5 text-[14px] font-bold" style={{ color: '#2c2416' }}>
        {renderInline(parseInline(text))}
      </h2>
    );
  }
  if (/^# (.+)/.test(line)) {
    const text = line.replace(/^# /, '');
    return (
      <h1 key={key} className="mt-4 mb-2 text-[16px] font-bold" style={{ color: '#2c2416' }}>
        {renderInline(parseInline(text))}
      </h1>
    );
  }

  // 分割线
  if (/^[-*_]{3,}$/.test(line.trim())) {
    return <hr key={key} className="my-3" style={{ borderColor: 'rgba(0,0,0,0.06)' }} />;
  }

  // 无序列表
  if (/^[-*] (.+)/.test(line)) {
    const text = line.replace(/^[-*] /, '');
    return (
      <li key={key} className="ml-4 list-disc text-[12px] leading-relaxed" style={{ color: '#4a4232' }}>
        {renderInline(parseInline(text))}
      </li>
    );
  }

  // 有序列表
  const orderedMatch = line.match(/^(\d+)\. (.+)/);
  if (orderedMatch) {
    const text = orderedMatch[2];
    return (
      <li key={key} className="ml-4 list-decimal text-[12px] leading-relaxed" style={{ color: '#4a4232' }}>
        {renderInline(parseInline(text))}
      </li>
    );
  }

  // 引用
  if (line.startsWith('> ')) {
    const text = line.replace(/^> /, '');
    return (
      <blockquote key={key} className="my-1 border-l-[3px] pl-3 italic text-[12px] leading-relaxed" style={{ borderLeftColor: '#d4a017', color: '#5c5342' }}>
        {renderInline(parseInline(text))}
      </blockquote>
    );
  }

  // 普通段落
  return (
    <p key={key} className="my-0.5 text-[12px] leading-relaxed break-words" style={{ color: '#4a4232' }}>
      {renderInline(parseInline(line))}
    </p>
  );
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  if (!content) return null;

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let codeBlockKey = 0;

  // 表格缓冲
  let tableBuffer: string[] = [];

  function flushTableBuffer() {
    if (tableBuffer.length < 2) {
      // 不足 2 行，不是有效表格，当作普通文本
      for (const l of tableBuffer) {
        elements.push(renderLine(l, Math.random()));
      }
      tableBuffer = [];
      return;
    }

    // 检查第二行是否为分隔行（| --- | --- |）
    if (!/^\|[\s\-:|]+\|$/.test(tableBuffer[1].trim())) {
      for (const l of tableBuffer) {
        elements.push(renderLine(l, Math.random()));
      }
      tableBuffer = [];
      return;
    }

    const parseRow = (line: string): string[] =>
      line
        .replace(/^\||\|$/g, '') // 去掉首尾 |
        .split('|')
        .map(c => c.trim());

    const headerCells = parseRow(tableBuffer[0]);

    // 解析对齐方式（---, :---, ---:, :---:）
    const getAlign = (sep: string): 'left' | 'center' | 'right' => {
      const trimmed = sep.trim();
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
      if (trimmed.endsWith(':')) return 'right';
      return 'left';
    };
    const alignments = parseRow(tableBuffer[1]).map(getAlign);

    // 数据行（跳过表头第 0 行和分隔行第 1 行）
    const dataRows = tableBuffer.slice(2).map(parseRow);
    const maxCols = headerCells.length;

    elements.push(
      <div key={`table-${tableKey++}`} className="my-3 overflow-x-auto rounded-lg border" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
        <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr style={{ backgroundColor: '#f5f2ea' }}>
              {headerCells.map((cell, ci) => (
                <th
                  key={ci}
                  className="px-3 py-2 font-semibold"
                  style={{
                    borderBottom: '2px solid rgba(0,0,0,0.08)',
                    color: '#2c2416',
                    textAlign: alignments[ci] || 'left',
                    minWidth: '80px',
                    wordBreak: 'break-word',
                  }}
                >
                  {renderInline(parseInline(cell))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.map((row, ri) => (
              <tr
                key={ri}
                className="transition-colors duration-100"
                style={{ backgroundColor: ri % 2 === 0 ? '#ffffff' : '#fdfcf7' }}
              >
                {Array.from({ length: maxCols }).map((_, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-2"
                    style={{
                      borderBottom: '1px solid rgba(0,0,0,0.04)',
                      color: '#4a4232',
                      textAlign: alignments[ci] || 'left',
                      wordBreak: 'break-word',
                      verticalAlign: 'top',
                    }}
                  >
                    {renderInline(parseInline(row[ci] || ''))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );

    tableBuffer = [];
  }

  let tableKey = 0;

  // 逐行处理，识别表格行（以 | 开头）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块
    if (line.startsWith('```')) {
      flushTableBuffer();
      if (inCodeBlock) {
        // 结束代码块
        elements.push(
          <div key={`code-${codeBlockKey}`} className="my-2 overflow-x-auto rounded-md border p-3" style={{ backgroundColor: '#f5f2ea', borderColor: 'rgba(0,0,0,0.06)' }}>
            {codeBlockLang && (
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: '#8a8270' }}>
                {codeBlockLang}
              </div>
            )}
            <pre className="text-[11px] leading-relaxed" style={{ fontFamily: '"SF Mono", Menlo, monospace', color: '#4a4232' }}>
              {codeBlockLines.join('\n')}
            </pre>
          </div>,
        );
        codeBlockLines = [];
        codeBlockLang = '';
        inCodeBlock = false;
        codeBlockKey++;
      } else {
        // 开始代码块
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // 表格行检测：以 | 开头且以 | 结尾（或前后有 |）
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableBuffer.push(line);
      // 最后一行也需要 flush
      if (i === lines.length - 1) {
        flushTableBuffer();
      }
      continue;
    }

    // 当前行不是表格行，先 flush 表格缓冲再处理
    flushTableBuffer();

    // 对话记录中的 Q&A 标记特殊处理
    if (/^### Q\d*$/.test(line.trim())) {
      elements.push(
        <div key={`qa-${i}`} className="mt-3 rounded-md px-3 py-2" style={{ backgroundColor: 'rgba(83,125,150,0.04)' }}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#537D96' }}>
            Question
          </div>
          {renderLine(line, i)}
        </div>,
      );
      continue;
    }
    if (/^### A\d*$/.test(line.trim())) {
      elements.push(
        <div key={`qa-${i}`} className="mt-2 rounded-md px-3 py-2" style={{ backgroundColor: 'rgba(212,160,23,0.04)' }}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#d4a017' }}>
            Answer
          </div>
          {renderLine(line, i)}
        </div>,
      );
      continue;
    }

    elements.push(renderLine(line, i));
  }

  // 未闭合的代码块
  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <pre key={`code-${codeBlockKey}`} className="my-2 overflow-x-auto rounded-md p-3 text-[11px] leading-relaxed" style={{ backgroundColor: '#f5f2ea', fontFamily: '"SF Mono", Menlo, monospace', color: '#4a4232' }}>
        {codeBlockLines.join('\n')}
      </pre>,
    );
  }

  return <div className="markdown-body">{elements}</div>;
}
