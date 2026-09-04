'use client';

import { useEffect, useRef, useState } from 'react';
import type { ViewerRenderProps } from './types';

/** Excel 渲染器：xlsx 在线解析为表格 HTML（loading/错误自管，错误上报调度层） */
export function XlsxViewer({ proxyUrl, onError }: ViewerRenderProps) {
  const [sheetHtml, setSheetHtml] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  // onError 由调度层以内联函数传入（每次渲染新引用），用 ref 持有，
  // 避免其变化触发下方 effect 反复重新 fetch/解析导致预览闪烁
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!proxyUrl) return;
    let cancelled = false;
    setDocLoading(true);
    fetch(proxyUrl)
      .then(r => r.arrayBuffer())
      .then(async buf => {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'array' });
        const sheetsHtml = wb.SheetNames.map(name => {
          const ws = wb.Sheets[name];
          const html = XLSX.utils.sheet_to_html(ws, { id: `sheet-${name}` });
          return `<div class="sheet-tab" data-sheet="${name}"><h3 style="font-size:13px;font-weight:600;margin:8px 0 4px;color:var(--ink);">${name}</h3>${html}</div>`;
        }).join('<hr style="margin:12px 0;border:none;border-top:1px solid var(--line)"/>');
        if (!cancelled) { setSheetHtml(sheetsHtml); setDocLoading(false); }
      })
      .catch(e => {
        if (!cancelled) { onErrorRef.current(e instanceof Error ? e.message : 'Excel 文件加载失败'); setDocLoading(false); }
      });
    return () => { cancelled = true; };
  }, [proxyUrl]);

  if (docLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Parsing Excel file...</span>
      </div>
    );
  }
  if (sheetHtml) {
    return (
      <div className="px-6 py-4 overflow-y-auto ai-canvas-scroll" style={{ maxHeight: 'calc(100vh - 60px)' }}>
        <style>{`
          .sheet-tab table { border-collapse: collapse; width: 100%; font-size: 12px; }
          .sheet-tab td, .sheet-tab th { border: 1px solid var(--line); padding: 4px 8px; }
          .sheet-tab tr:first-child td { font-weight: 600; background: var(--paper-hover); }
        `}</style>
        <div dangerouslySetInnerHTML={{ __html: sheetHtml }} />
      </div>
    );
  }
  return null;
}
