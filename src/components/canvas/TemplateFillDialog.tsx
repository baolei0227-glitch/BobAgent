'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Check, AlertCircle, Download, FileText, X, PackageOpen, Table, Plus, Copy, Trash2, ClipboardList, RefreshCw, Save, ChevronDown, ChevronRight, Upload, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import * as XLSX from 'xlsx';

export interface FillTemplateItem {
  file: string;
  fields: string[];
}

/** Field display labels (UI hint only; field keys unchanged) */
const FIELD_LABELS: Record<string, string> = {
  contractNo: 'Contract No.', partyA: 'Party A', partyB: 'Party B', signDate: 'Sign date',
  product: 'Product/Subject', quantity: 'Quantity', unitPrice: 'Unit price', totalPrice: 'Total price',
  seller: 'Seller', buyer: 'Buyer', employeeName: 'Employee name', idNumber: 'ID number',
  position: 'Position', department: 'Department', contractTerm: 'Contract term',
  clientName: 'Client', agentName: 'Agent/Lawyer', lawyer: 'Lead lawyer', matter: 'Matter', authority: 'Authority',
  lessor: 'Lessor', lessee: 'Lessee', property: 'Property/Subject', leaseTerm: 'Lease term', monthlyRent: 'Monthly rent',
  letterNo: 'Letter no.', addressee: 'Addressee', lawFirm: 'Law firm', client: 'Client/Party',
  facts: 'Facts', legalBasis: 'Legal basis', demand: 'Demand', consequence: 'Consequence', deadline: 'Deadline',
};

interface FillResult {
  ok: boolean;
  error?: string;
  message?: string;
  generated?: { file: string; size: number; path: string }[];
  zip?: { name: string; path: string } | null;
}

export function TemplateFillPanel({
  scene,
  templates,
  onClose,
  onGenerated,
  embedded,
  onDeleteTemplate,
}: {
  scene: string;
  templates: FillTemplateItem[];
  onClose: () => void;
  /** 生成完成后回调：父组件发送续写消息让 AI 继续对话；files 为生成的产物（file/size/path） */
  onGenerated?: (summary: string, files?: { file: string; size: number; path: string }[]) => void;
  /** 嵌入模式（预览面板内）：隐藏弹窗式 X/Close 按钮，高度自适应容器 */
  embedded?: boolean;
  /** 可选：删除某个模板（预览面板模板管理用；独立弹窗不传则隐藏删除按钮） */
  onDeleteTemplate?: (file: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** Bob Items 下拉菜单展开态（默认收起） */
  const [itemsOpen, setItemsOpen] = useState(false);
  /** 「Update Fields」时的勾选快照：字段列重建为快照模板的字段并集；null = 未手动更新，字段列 = 全量模板并集 */
  const [fieldGenChecked, setFieldGenChecked] = useState<Set<string> | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([{}]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<FillResult | null>(null);
  /** Drop zone 拖入态：拖入文件时高亮 */
  const [dropActive, setDropActive] = useState(false);
  /** 填写视图：cards（纵向卡片，默认）/ table（横向表格，可手动切换） */
  const [view, setView] = useState<'table' | 'cards'>('cards');
  /** Cards 视图下当前展开的行索引（手风琴：一次只展开一行）；null = 全折叠 */
  const [expandedRow, setExpandedRow] = useState<number | null>(0);
  /** 已保存的填写数据（跟项目走：homework/template/.fill-data/<scene>.json；打开时不自动回填） */
  const [savedData, setSavedData] = useState<{
    savedAt: string;
    rows: Record<string, string>[];
    templateFiles?: string[];
    fields?: string[];
  } | null>(null);
  /** 保存/加载/清除忙碌态 */
  const [dataBusy, setDataBusy] = useState(false);
  /** Load saved 内联确认态：点击一次变确认按钮，再点执行（3s 未操作自动恢复） */
  const [loadArmed, setLoadArmed] = useState(false);
  const loadArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 数据操作反馈（保存/加载/清除），与生成结果 result 分开显示 */
  const [dataMsg, setDataMsg] = useState<{ text: string; error: boolean } | null>(null);
  /** 智能粘贴识别：粘贴信息文本 + 识别填充到当前展开行 */
  const [pasteText, setPasteText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState<{ text: string; error: boolean } | null>(null);

  // 字段来源模板：默认全选（进入时模板默认全勾）；点击「Update Fields」后固定为当时的勾选快照
  const fieldSource = useMemo(() => {
    const set = fieldGenChecked ?? new Set(templates.map((t) => t.file));
    return set;
  }, [fieldGenChecked, templates]);

  const allFields = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of templates) {
      if (!fieldSource.has(t.file)) continue;
      for (const f of t.fields) {
        if (!seen.has(f)) {
          seen.add(f);
          out.push(f);
        }
      }
    }
    return out;
  }, [templates, fieldSource]);

  const labelToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of allFields) {
      m.set(FIELD_LABELS[f] || f, f);
      m.set(f, f);
    }
    return m;
  }, [allFields]);

  useEffect(() => {
    setChecked(new Set(templates.map((t) => t.file)));
    setItemsOpen(false);
    // 模板集合变化时快照失效：字段列回到全量模板并集
    setFieldGenChecked(null);
    // 初始一行空行，等待填写
    setRows([{}]);
    setResult(null);
    setDropActive(false);
    setDataMsg(null);
    setLoadArmed(false);
    // 默认卡片视图（一排三个字段）；展开第一行
    setView('cards');
    setExpandedRow(0);
    // 打开时不自动回填：仅探测该场景是否已有保存数据（供 Load saved 按钮显示）
    void checkSavedData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  const toggleTemplate = (file: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        if (next.size > 1) next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });

  /** 全选：勾选所有模板 */
  const selectAllTemplates = () => setChecked(new Set(templates.map((t) => t.file)));

  /** 反选：勾选当前未选中的模板 */
  const invertTemplates = () =>
    setChecked((prev) => new Set(templates.filter((t) => !prev.has(t.file)).map((t) => t.file)));

  /** 两个集合是否相等（元素相同即可） */
  const setsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

  /** 字段来源集合与当前勾选不一致 → 字段列已过期，需点击 Update Fields 重建 */
  const fieldsStale = !setsEqual(fieldGenChecked ?? new Set(templates.map((t) => t.file)), checked);

  /** 手动重建字段列：固定为当前勾选模板的字段并集（纯内存计算，不重新扫描文件） */
  const handleUpdateFields = () => {
    const snap = new Set(checked);
    setFieldGenChecked(snap);
    // 字段集合变化时重置视图（与模板加载逻辑一致），避免更新后表格/卡片布局错位
    let count = 0;
    const seen = new Set<string>();
    for (const t of templates) {
      if (!snap.has(t.file)) continue;
      for (const f of t.fields) {
        if (!seen.has(f)) {
          seen.add(f);
          count++;
        }
      }
    }
    setView('cards');
  };

  /** 更新某个单元格的值 */
  const updateCell = (rowIdx: number, key: string, value: string) =>
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r)));

  /** 追加一行空行（并展开新行） */
  const addRow = () =>
    setRows((prev) => {
      setExpandedRow(prev.length);
      return [...prev, {}];
    });

  /** 复制当前行（在其后插入一行同值副本，并展开新行） */
  const duplicateRow = (rowIdx: number) =>
    setRows((prev) => {
      setExpandedRow(rowIdx + 1);
      return [...prev.slice(0, rowIdx + 1), { ...prev[rowIdx] }, ...prev.slice(rowIdx + 1)];
    });

  /** 删除当前行（至少保留一行）；同步调整展开行索引 */
  const removeRow = (rowIdx: number) =>
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      setExpandedRow((e) => {
        if (e === null) return null;
        if (rowIdx < e) return e - 1; // 删除行在展开行之前 → 展开行前移
        if (rowIdx === e) return Math.max(0, e - 1); // 删除的就是展开行 → 移到前一行
        return e; // 删除行在展开行之后 → 展开行不变
      });
      return prev.filter((_, i) => i !== rowIdx);
    });

  /** 有效行 = 至少填了一个字段的行 */
  const nonEmptyRows = useMemo(
    () => rows.filter((r) => Object.values(r).some((v) => (v || '').trim() !== '')),
    [rows],
  );

  /** 下载 xlsx：表头 = 字段显示名（label）+ 当前所有行（含空行，带数据下载）；
   *  列宽自适应 */
  const handleDownloadTemplate = useCallback(() => {
    if (allFields.length === 0) return;
    const labels = allFields.map((f) => FIELD_LABELS[f] || f);
    const aoa: string[][] = [labels];
    // 所有行（含空行）按 allFields 顺序对齐取值
    for (const row of rows) {
      aoa.push(allFields.map((f) => row[f] || ''));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 列宽自适应（取表头长度估算）
    ws['!cols'] = labels.map((l) => ({ wch: Math.max(12, l.length * 2 + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, `template-${(scene || 'template').replace(/[\\/:*?"<>|]/g, '_')}.xlsx`);
  }, [allFields, scene, rows]);

  /** 拖入 xlsx 文件 → 解析数据行填入 rows（表头匹配 label/key，对不上忽略） */
  const handleDropFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith('.xlsx')) {
        setResult({ ok: false, error: 'Only .xlsx files are supported' });
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const wb = XLSX.read(data, { type: 'array' });
          const sheetName = wb.SheetNames[0];
          if (!sheetName) {
            setResult({ ok: false, error: 'Empty workbook: no sheet found' });
            return;
          }
          const ws = wb.Sheets[sheetName];
          const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
            header: 1,
            blankrows: false,
            defval: '',
          });
          if (aoa.length < 2) {
            setResult({ ok: false, error: 'No data rows: need header row + at least one data row' });
            return;
          }
          // 第一行 = 表头，匹配 labelToKey（label 或 key 都能对上，对不上 = null 忽略该列）
          const headerCells = (aoa[0] as (string | number | null)[]).map((c) =>
            c == null ? '' : String(c).trim(),
          );
          const keys: (string | null)[] = headerCells.map((c) => labelToKey.get(c) ?? null);
          const parsed: Record<string, string>[] = [];
          for (let i = 1; i < aoa.length; i++) {
            const rowCells = aoa[i] as (string | number | null)[];
            const row: Record<string, string> = {};
            for (let j = 0; j < keys.length; j++) {
              const k = keys[j];
              if (!k) continue;
              const val = rowCells[j];
              const s = val == null ? '' : String(val).trim();
              if (s) row[k] = s;
            }
            if (Object.keys(row).length > 0) parsed.push(row);
          }
          if (parsed.length === 0) {
            setResult({ ok: false, error: 'No non-empty data rows found' });
            return;
          }
          setRows(parsed);
          setExpandedRow(0);
          setResult(null);
        } catch (err) {
          setResult({ ok: false, error: err instanceof Error ? err.message : 'Failed to parse xlsx' });
        }
      };
      reader.onerror = () => setResult({ ok: false, error: 'Failed to read file' });
      reader.readAsArrayBuffer(file);
    },
    [labelToKey],
  );

  /** 智能粘贴识别：调 LLM 把粘贴文本抽取到字段值，回填到当前展开行 */
  const handleAiExtract = useCallback(async () => {
    const text = pasteText.trim();
    if (!text || allFields.length === 0) return;
    setExtracting(true);
    setExtractMsg(null);
    try {
      const resp = await fetch('/api/skills/templates/ai-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: allFields.map((f) => ({ key: f, label: FIELD_LABELS[f] || f })),
          text,
        }),
      });
      const d = await resp.json();
      if (!d?.success) {
        setExtractMsg({ text: d?.error || 'AI extraction failed', error: true });
        return;
      }
      const values = d.values as Record<string, string>;
      const filledKeys = allFields.filter((f) => (values[f] || '').trim());
      if (filledKeys.length === 0) {
        setExtractMsg({ text: '未识别到可填写的字段值，请确认粘贴内容包含相关字段信息', error: true });
        return;
      }
      const targetRow = expandedRow ?? 0;
      setRows((prev) => prev.map((r, i) => (i === targetRow ? { ...r, ...values } : r)));
      setExpandedRow(targetRow);
      setExtractMsg({ text: `已识别并填充 ${filledKeys.length} 个字段到第 ${targetRow + 1} 行`, error: false });
      setPasteText('');
    } catch (e) {
      setExtractMsg({ text: e instanceof Error ? e.message : 'AI extraction failed', error: true });
    } finally {
      setExtracting(false);
    }
  }, [pasteText, allFields, expandedRow]);

  /** 检查该场景是否已有保存的填写数据（打开时不自动回填，仅在按钮上提示可恢复） */
  const checkSavedData = useCallback(async () => {
    if (!scene) return;
    try {
      const resp = await fetch(`/api/skills/templates/fill-data?scene=${encodeURIComponent(scene)}`);
      const d = await resp.json();
      if (d?.success) setSavedData(d.data || null);
    } catch { /* ignore */ }
  }, [scene]);

  /** 保存当前已填行到项目（仅底部 Save data 按钮手动调用，生成时不再自动保存）；
   *  同时记录模板指纹（勾选模板文件 + 当前字段列表），供加载时校验是否匹配 */
  const handleSaveData = useCallback(async () => {
    if (!scene || nonEmptyRows.length === 0) return;
    setDataBusy(true);
    try {
      const resp = await fetch('/api/skills/templates/fill-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene,
          rows: nonEmptyRows,
          templateFiles: [...checked],
          fields: allFields,
        }),
      });
      const d = await resp.json();
      if (d?.success) {
        setSavedData({ savedAt: d.savedAt, rows: nonEmptyRows, templateFiles: [...checked], fields: allFields });
        setDataMsg({ text: `Saved ${nonEmptyRows.length} row(s) for "${scene}" → project homework/template/.fill-data/`, error: false });
      } else {
        setDataMsg({ text: d?.error || 'Save failed', error: true });
      }
    } catch (e) {
      setDataMsg({ text: e instanceof Error ? e.message : 'Save failed', error: true });
    } finally {
      setDataBusy(false);
    }
  }, [scene, nonEmptyRows, checked, allFields]);

  /** 一键注入：把已保存数据回填到当前所有行；
   *  保留当前行数，目标行数 = max(当前行数, 保存行数)；
   *  填充规则：row i 用 savedRows[i % savedLen]（保存1行 → 广播到所有row；多行 → 逐行对应/循环）
   *  注入前校验保存时的模板字段是否与当前模板匹配，不一致则明确警告 */
  const handleLoadData = useCallback(() => {
    if (!savedData || savedData.rows.length === 0) return;
    const savedRows = savedData.rows;
    const savedLen = savedRows.length;
    setRows((prev) => {
      // 目标行数：保留当前已加的行，不足保存行数则补齐（恢复多行场景）
      const target = Math.max(prev.length, savedLen);
      const next: Record<string, string>[] = [];
      for (let i = 0; i < target; i++) {
        // 深拷贝：避免与 savedData 共享对象引用
        next.push({ ...savedRows[i % savedLen] });
      }
      return next;
    });
    setExpandedRow(0);
    const when = savedData.savedAt ? new Date(savedData.savedAt).toLocaleString() : '';
    // 模板字段匹配校验：保存的 fields 与当前 allFields 对比
    let warn = '';
    if (Array.isArray(savedData.fields) && savedData.fields.length > 0) {
      const saved = new Set(savedData.fields);
      const current = new Set(allFields);
      const missing = allFields.filter((f) => !saved.has(f)); // 当前模板新增
      const extra = savedData.fields.filter((f) => !current.has(f)); // 保存时存在、当前模板已无
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`new fields: ${missing.join(', ')}`);
        if (extra.length > 0) parts.push(`removed fields: ${extra.join(', ')}`);
        warn = ` — template fields changed since save (${parts.join('; ')}), please review the loaded rows.`;
      }
    }
    const broadcast = savedLen === 1 ? ' (broadcast to all rows)' : '';
    setDataMsg({ text: `Filled from ${savedLen} saved row(s)${broadcast}${when ? ` (${when})` : ''}${warn}`, error: !!warn });
    setLoadArmed(false);
    if (loadArmTimerRef.current) { clearTimeout(loadArmTimerRef.current); loadArmTimerRef.current = null; }
  }, [savedData, allFields]);

  /** Load saved 按钮点击：第一次进入确认态（防误覆盖当前填写），再点执行 */
  const handleLoadClick = useCallback(() => {
    if (loadArmed) {
      handleLoadData();
      return;
    }
    setLoadArmed(true);
    if (loadArmTimerRef.current) clearTimeout(loadArmTimerRef.current);
    loadArmTimerRef.current = setTimeout(() => setLoadArmed(false), 3000);
  }, [loadArmed, handleLoadData]);

  /** 清除已保存数据 */
  const handleClearData = useCallback(async () => {
    if (!scene) return;
    setDataBusy(true);
    try {
      const resp = await fetch(`/api/skills/templates/fill-data?scene=${encodeURIComponent(scene)}`, { method: 'DELETE' });
      const d = await resp.json();
      if (d?.success) {
        setSavedData(null);
        setDataMsg({ text: 'Cleared saved data', error: false });
      } else {
        setDataMsg({ text: d?.error || 'Clear failed', error: true });
      }
    } catch (e) {
      setDataMsg({ text: e instanceof Error ? e.message : 'Clear failed', error: true });
    } finally {
      setDataBusy(false);
    }
  }, [scene]);

  // 卸载时清理 Load saved 确认态计时器
  useEffect(() => () => {
    if (loadArmTimerRef.current) clearTimeout(loadArmTimerRef.current);
  }, []);

  const handleSubmit = async () => {
    const targets = templates.filter((t) => checked.has(t.file));
    if (targets.length === 0) return;
    if (nonEmptyRows.length === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      // 表格行 → rows 数组，统一走批量接口（单行=单套）
      const resp = await fetch('/api/skills/templates/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene,
          templates: targets.map((t) => t.file),
          rows: nonEmptyRows,
        }),
      });
      const finalResult = (await resp.json()) as FillResult;
      setResult(finalResult);
      if (finalResult.ok && finalResult.generated && finalResult.generated.length > 0 && onGenerated) {
        const fileList = finalResult.generated.map((g) => g.file).join(', ');
        const batchSuffix = nonEmptyRows.length > 1 ? ` (${nonEmptyRows.length} row batches)` : '';
        // 续写摘要必须指明读取工具：read_file 的 homework/ 相对路径会解析到项目根；
        // 禁止用 execute_script 相对路径（其 CWD 是 homework/.ai-workspace/，读不到 homework/ 下的文件）
        onGenerated(`Template fields filled${batchSuffix}, ${finalResult.generated.length} document(s) generated in homework/template/: ${fileList}. Read them with the read_file tool using the path "homework/template/<文件名>" (e.g. read_file(path="homework/template/${finalResult.generated[0]?.file || '<文件名>' }")). Do NOT read them via execute_script with a relative path — its CWD is homework/.ai-workspace/ and it cannot resolve "homework/template/...". Please continue.`, finalResult.generated);
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'Request failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 有效行数（顶部徽标 + 底部按钮文案用）
  const previewRows = nonEmptyRows.length;

  return (
    <div
      className={embedded ? '' : 'mb-2 rounded-xl border shadow-sm overflow-hidden'}
      style={embedded ? undefined : {
        borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)',
        backgroundColor: 'var(--popover)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
        <div className="flex items-center gap-2">
          <PackageOpen className="h-4 w-4" style={{ color: 'var(--primary)' }} />
          <div className="text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>
            Fill &amp; Generate · {scene || 'Template'}
          </div>
          {previewRows > 1 && (
            <Badge variant="muted" className="text-10 px-1.5 py-0 h-4" style={{ borderColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }}>
              {previewRows} rows · batch
            </Badge>
          )}
        </div>
        {!embedded && (
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Body */}
      <div className={`nowheel px-4 py-3 space-y-3 ${embedded ? '' : 'max-h-[50vh] overflow-y-auto'}`}>
        {templates.length > 1 && (
          <div>
            <button
              type="button"
              onClick={() => setItemsOpen((o) => !o)}
              aria-expanded={itemsOpen}
              className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors"
              style={{
                borderColor: itemsOpen ? 'var(--primary)' : 'var(--line)',
                backgroundColor: itemsOpen ? 'color-mix(in oklab, var(--primary) 6%, transparent)' : 'transparent',
                color: 'var(--ink-muted)',
              }}
            >
              <span className="flex items-center gap-1.5">
                {itemsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Bob Items ({checked.size}/{templates.length})
              </span>
              <span className="text-11 opacity-70">
                {checked.size === templates.length ? 'All selected' : `${templates.length - checked.size} unselected`}
              </span>
            </button>
            {itemsOpen && (
              <div className="mt-1 rounded-md border" style={{ borderColor: 'var(--line)' }}>
                {/* 批量操作：全选 / 反选 */}
                <div className="flex items-center gap-1 border-b px-2 py-1" style={{ borderColor: 'var(--line)' }}>
                  <button
                    type="button"
                    onClick={selectAllTemplates}
                    className="rounded px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--primary)' }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={invertTemplates}
                    className="rounded px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--primary)' }}
                  >
                    Invert
                  </button>
                </div>
                {/* 文件列表：每项前面一个复选框 */}
                <div className="max-h-[200px] overflow-y-auto p-1">
                  {templates.map((t) => {
                    const on = checked.has(t.file);
                    return (
                      <label
                        key={t.file}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--paper-hover)]"
                        style={{ color: on ? 'var(--ink-strong)' : 'var(--ink-muted)' }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleTemplate(t.file)}
                          className="h-3.5 w-3.5 shrink-0 cursor-pointer"
                          style={{ accentColor: 'var(--primary)' }}
                        />
                        <FileText className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate" title={t.file}>{t.file}</span>
                        {onDeleteTemplate && (
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); onDeleteTemplate(t.file); }}
                            className="rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                            title={`Delete ${t.file}`}
                            aria-label={`Delete ${t.file}`}
                            style={{ color: 'var(--danger)' }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 智能粘贴识别区（顺丰式）：粘贴信息文本，AI 自动抽取字段值填入当前展开行 */}
        {allFields.length > 0 && (
          <div
            className="rounded-md border p-2.5"
            style={{
              borderColor: 'color-mix(in oklab, var(--primary) 30%, var(--line))',
              backgroundColor: 'color-mix(in oklab, var(--primary) 4%, transparent)',
            }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>AI 智能填充</span>
            </div>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="粘贴一段信息文本（当事人 / 合同 / 案件信息），AI 自动识别并填充到当前展开行"
              rows={3}
              spellCheck={false}
              className="w-full resize-none rounded-md border px-2.5 py-2 text-xs outline-none transition-colors"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink-strong)' }}
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-11" style={{ color: 'var(--ink-faint)' }}>
                填到第 {(expandedRow ?? 0) + 1} 行
              </span>
              <Button
                type="button"
                onClick={handleAiExtract}
                disabled={extracting || !pasteText.trim()}
                loading={extracting}
                variant="solid"
                tone="brand"
                size="sm"
              >
                {extracting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {extracting ? '识别中…' : '识别并填充'}
              </Button>
            </div>
            {extractMsg && (
              <div
                className="mt-1.5 rounded-md px-2.5 py-1.5 text-11 leading-relaxed"
                style={{
                  backgroundColor: extractMsg.error ? 'color-mix(in oklab, var(--danger) 8%, transparent)' : 'color-mix(in oklab, var(--success) 8%, transparent)',
                  color: extractMsg.error ? 'var(--danger)' : 'var(--success)',
                }}
              >
                {extractMsg.text}
              </div>
            )}
          </div>
        )}

        <div>
          {allFields.length === 0 ? (
            <p className="rounded-md border px-3 py-4 text-center text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
              No fields detected in selected templates
            </p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  每行 = 一套数据，共 {allFields.length} 字段（当前选中模板）
                </p>
                {/* 字段区操作：Update Fields（多模板时） + 视图切换（表格/卡片） */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {templates.length > 1 && (
                    <button
                      type="button"
                      onClick={handleUpdateFields}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-11 font-medium transition-colors"
                      style={
                        fieldsStale
                          ? { backgroundColor: 'var(--primary)', color: '#fff' }
                          : { border: '1px solid var(--line)', color: 'var(--ink-muted)' }
                      }
                      title={
                        fieldsStale
                          ? 'Fields stale — click to rebuild from selected templates'
                          : 'Rebuild field columns from selected templates'
                      }
                    >
                      <RefreshCw className="h-3 w-3" />
                      Update Fields
                    </button>
                  )}
                  <div className="flex shrink-0 items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--line)' }}>
                  <button
                    type="button"
                    onClick={() => setView('table')}
                    className="flex items-center gap-1 rounded px-2 py-1 text-11 font-medium transition-colors"
                    style={
                      view === 'table'
                        ? { backgroundColor: 'var(--primary)', color: '#fff' }
                        : { color: 'var(--ink-muted)' }
                    }
                  >
                    <Table className="h-3 w-3" />
                    Table
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('cards')}
                    className="flex items-center gap-1 rounded px-2 py-1 text-11 font-medium transition-colors"
                    style={
                      view === 'cards'
                        ? { backgroundColor: 'var(--primary)', color: '#fff' }
                        : { color: 'var(--ink-muted)' }
                    }
                  >
                    <ClipboardList className="h-3 w-3" />
                    Cards
                  </button>
                  </div>
                </div>
              </div>

              {/* 可编辑表格（Table 视图）：横向滚动 + 冻结首列（行号）/尾列（操作） */}
              {view === 'table' ? (
              <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--line)' }}>
                <table className="w-full border-collapse text-sm" style={{ minWidth: 720, fontFamily: "var(--font-mono)" }}>
                  <thead>
                    <tr>
                      <th
                        className="sticky left-0 z-10 whitespace-nowrap px-2 py-1.5 text-left font-medium"
                        style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)', borderBottom: '1px solid var(--line)' }}
                      >
                        #
                      </th>
                      {allFields.map((f) => (
                        <th
                          key={f}
                          className="whitespace-nowrap px-2 py-1.5 text-left font-medium"
                          style={{ borderBottom: '1px solid var(--line)', color: 'var(--ink-muted)' }}
                        >
                          {FIELD_LABELS[f] || f}
                        </th>
                      ))}
                      <th
                        className="sticky right-0 z-10 whitespace-nowrap px-2 py-1.5 text-left font-medium"
                        style={{ backgroundColor: 'var(--paper-soft)', borderBottom: '1px solid var(--line)' }}
                      >
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIdx) => (
                      <tr key={rowIdx}>
                        <td
                          className="sticky left-0 z-10 px-2 py-1 text-center whitespace-nowrap"
                          style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)', borderBottom: '1px solid var(--line-soft)' }}
                        >
                          {rowIdx + 1}
                        </td>
                        {allFields.map((f) => (
                          <td key={f} className="px-1.5 py-1.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                            <input
                              type="text"
                              value={row[f] || ''}
                              onChange={(e) => updateCell(rowIdx, f, e.target.value)}
                              placeholder={FIELD_LABELS[f] || f}
                              spellCheck={false}
                              className="w-full min-w-[160px] rounded border border-transparent bg-transparent px-2 py-1.5 outline-none transition-colors"
                              style={{ color: 'var(--ink-strong)', fontSize: '0.866667rem' }}
                            />
                          </td>
                        ))}
                        <td
                          className="sticky right-0 z-10 whitespace-nowrap px-1 py-1"
                          style={{ backgroundColor: 'var(--paper-soft)', borderBottom: '1px solid var(--line-soft)' }}
                        >
                          <div className="flex items-center gap-0.5">
                            <Button
                              type="button"
                              onClick={() => duplicateRow(rowIdx)}
                              variant="ghost"
                              tone="neutral"
                              size="icon-xs"
                              title="Duplicate row"
                              aria-label="Duplicate row"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button
                              type="button"
                              onClick={() => removeRow(rowIdx)}
                              disabled={rows.length <= 1}
                              variant="ghost"
                              tone="danger"
                              size="icon-xs"
                              title="Delete row"
                              aria-label="Delete row"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              ) : (
                /* Cards 视图：每行 = 一张卡片，手风琴折叠（一次只展开一行），字段一排三个 */
                <div className="flex flex-col gap-2">
                  {rows.map((row, rowIdx) => {
                    const isOpen = expandedRow === rowIdx;
                    // 折叠态摘要：前几个已填字段值，用 · 连接
                    const summary = Object.values(row)
                      .filter((v) => (v || '').trim() !== '')
                      .slice(0, 3)
                      .join(' · ');
                    return (
                    <div key={rowIdx} className="rounded-md border" style={{ borderColor: 'var(--line)' }}>
                      {/* 标题栏：点击切换展开/折叠 */}
                      <div
                        className="flex cursor-pointer select-none items-center justify-between p-3"
                        onClick={() => setExpandedRow(isOpen ? null : rowIdx)}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {isOpen
                            ? <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                            : <ChevronRight className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-muted)' }} />}
                          <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                            Row {rowIdx + 1}
                          </span>
                          {!isOpen && summary && (
                            <span className="truncate text-11" style={{ color: 'var(--ink-faint, var(--ink-muted))' }}>
                              {summary}
                            </span>
                          )}
                        </div>
                        {/* 操作按钮：阻止冒泡，避免误触折叠 */}
                        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <Button
                            type="button"
                            onClick={() => duplicateRow(rowIdx)}
                            variant="ghost"
                            tone="neutral"
                            size="icon-xs"
                            title="Duplicate row"
                            aria-label="Duplicate row"
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                          <Button
                            type="button"
                            onClick={() => removeRow(rowIdx)}
                            disabled={rows.length <= 1}
                            variant="ghost"
                            tone="danger"
                            size="icon-xs"
                            title="Delete row"
                            aria-label="Delete row"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {/* 展开时显示字段网格 */}
                      {isOpen && (
                        <div className="px-3 pb-3">
                          <div className="grid grid-cols-3 gap-2">
                            {allFields.map((f) => (
                              <label key={f} className="flex min-w-0 flex-col gap-1">
                                <span className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
                                  {FIELD_LABELS[f] || f}
                                </span>
                                <input
                                  type="text"
                                  value={row[f] || ''}
                                  onChange={(e) => updateCell(rowIdx, f, e.target.value)}
                                  placeholder={FIELD_LABELS[f] || f}
                                  spellCheck={false}
                                  className="w-full rounded border px-2 py-1.5 outline-none transition-colors"
                                  style={{
                                    borderColor: 'var(--line)',
                                    backgroundColor: 'var(--input-bg)',
                                    color: 'var(--ink-strong)',
                                    fontSize: '0.866667rem',
                                  }}
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* 行操作 + 粘贴导入 */}
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <Button
                  type="button"
                  onClick={addRow}
                  variant="soft"
                  tone="brand"
                  size="xs"
                >
                  <Plus className="h-3 w-3" />
                  Add row
                </Button>
                <span className="text-11 opacity-70" style={{ color: 'var(--ink-muted)' }}>
                  {rows.length} 行 · 每行生成一份文档（共 {nonEmptyRows.length} 行已填）
                </span>
              </div>

              {/* 拖入 xlsx 文件自动填写（有字段时显示） */}
              {allFields.length > 0 && (
                <div
                  className="mt-1.5 rounded-md border-2 border-dashed p-2.5 text-center transition-colors"
                  style={{
                    borderColor: dropActive ? 'var(--primary)' : 'color-mix(in oklab, var(--line) 60%, transparent)',
                    backgroundColor: dropActive ? 'var(--primary-soft)' : 'transparent',
                  }}
                  onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropActive(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) handleDropFile(f);
                  }}
                >
                  <div className="flex items-center justify-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                    <Upload className="h-3 w-3" />
                    <span>Drop .xlsx here to auto-fill (keep header row unchanged)</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {result && (
          result.ok ? (
            <div className="space-y-1.5 rounded-md px-3 py-2.5 text-xs"
              style={{ backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)', color: 'var(--success)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-medium">
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  Generated {result.generated?.length || 0} document(s)
                </div>
                {/* 唯一下载入口：zip 一次性打包下载全部（zip 在有产物时必然生成） */}
                {result.zip ? (
                  <a
                    href={`/api/attachments?path=${encodeURIComponent(result.zip.path)}`}
                    download={result.zip.name}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-all hover:opacity-90"
                    style={{ backgroundColor: 'var(--success)', color: '#fff' }}
                    title="Download all generated documents as .zip"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download all
                  </a>
                ) : (
                  /* 兜底：zip 未生成（极端场景）时退化为逐个文件链接 */
                  (result.generated || []).map((g) => (
                    <a
                      key={g.file}
                      href={`/api/attachments?path=${encodeURIComponent(g.path)}`}
                      download={g.file}
                      className="flex items-center gap-1.5 break-all transition-colors hover:underline"
                    >
                      <FileText className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 truncate">{g.file}</span>
                    </a>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 rounded-md px-3 py-2.5 text-xs"
              style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}>
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span className="leading-relaxed">{result.error || 'Generation failed'}</span>
            </div>
          )
        )}
      </div>

      {/* 数据操作反馈条（保存/加载/清除） */}
      {dataMsg && (
        <div
          className="flex items-center gap-1.5 px-4 py-1.5 text-11 leading-relaxed"
          style={{
            borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: dataMsg.error ? 'color-mix(in oklab, var(--danger) 6%, transparent)' : 'color-mix(in oklab, var(--success) 6%, transparent)',
            color: dataMsg.error ? 'var(--danger)' : 'var(--success)',
          }}
        >
          {dataMsg.error ? <AlertCircle className="h-3 w-3 shrink-0" /> : <Check className="h-3 w-3 shrink-0" />}
          <span className="min-w-0">{dataMsg.text}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5" style={{ borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            onClick={handleDownloadTemplate}
            disabled={allFields.length === 0}
            variant="ghost"
            tone="neutral"
            size="sm"
            title="Download .xlsx template with field headers (fill in Excel, then drop back)"
          >
            <span className="inline-flex items-center gap-1">
              <Download className="h-3 w-3" />
              Template
            </span>
          </Button>

          {/* 填写数据保存 / 恢复（跟项目走：homework/template/.fill-data/<scene>.json；打开不自动回填） */}
          <span className="mx-1 inline-block h-4 w-px" style={{ backgroundColor: 'var(--line)' }} />
          <Button
            type="button"
            onClick={handleSaveData}
            disabled={dataBusy || nonEmptyRows.length === 0}
            variant="ghost"
            tone="neutral"
            size="sm"
            title="Save current fills to the project (homework/template/.fill-data/)"
          >
            <span className="inline-flex items-center gap-1">
              {dataBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save data
            </span>
          </Button>
          {savedData && (
            <>
              <button
                type="button"
                onClick={handleLoadClick}
                disabled={dataBusy}
                className="rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-40"
                style={
                  loadArmed
                    ? { backgroundColor: 'var(--primary)', color: '#fff' }
                    : { backgroundColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }
                }
                title={`Load saved fills (${savedData.rows.length} row(s)${savedData.savedAt ? `, saved ${new Date(savedData.savedAt).toLocaleString()}` : ''}) — click once to arm, again to inject`}
              >
                <span className="inline-flex items-center gap-1">
                  {loadArmed ? <Check className="h-3 w-3" /> : <ClipboardList className="h-3 w-3" />}
                  {loadArmed ? 'Load now?' : `Load saved (${savedData.rows.length})`}
                </span>
              </button>
              <Button
                type="button"
                onClick={handleClearData}
                disabled={dataBusy}
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                title="Clear saved fills"
                aria-label="Clear saved fills"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!embedded && (
            <Button
              type="button"
              onClick={onClose}
              variant="ghost"
              tone="neutral"
              size="md"
            >
              Close
            </Button>
          )}
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || allFields.length === 0 || checked.size === 0}
            loading={submitting}
            variant="solid"
            tone="brand"
            size="md"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />
                {previewRows > 1 ? `Generate × ${previewRows}` : 'Generate'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
