/**
 * Office 文档（docx / xlsx / pptx 的 XML 结构文本）→ 紧凑文本：
 * materials 内容索引与 read_attachment 共用的同一套转换规则。
 *
 * 抽成共享模块的原因：同一份 docx 走 materials 索引与走 chat 附件必须得到**同样质量**的文本
 * （见 lib/materials/indexer.ts 头部的「不做能力阉割」口径）——两处各写一份必然逐渐分叉。
 *
 * 纯函数、无副作用：解析（mammoth / xlsx / adm-zip）留给调用方，这里只负责把
 * 「已解析出的 HTML / XML / 表格行」收敛成紧凑文本。
 */

/** 把「已用 \n（段落/行尾）与 \u0001（单元格分隔）标记过的 XML/HTML」收敛成紧凑文本行 */
export function collapseMarkedLines(marked: string): string {
  const s = marked
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
  const lines: string[] = [];
  for (const raw of s.split('\n')) {
    const cells = raw.split('\u0001').map((c) => c.replace(/\s+/g, ' ').trim());
    // 去掉行尾空列与行首空列标记，避免悬挂分隔符
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    const line = cells.join(' | ').replace(/^\s*\|\s*/, '').trim();
    if (line.length > 0) lines.push(line);
  }
  return lines.join('\n');
}

/** docx → 结构化文本：mammoth HTML（保留段落/标题/有序列表编号/表格行列）→ 紧凑文本 */
export function docxHtmlToText(html: string): string {
  let s = html;
  // 有序列表编号（支持 start 属性），避免列表退化为无编号的 "- "
  s = s.replace(/<ol([^>]*)>([\s\S]*?)<\/ol>/gi, (_m, attrs: string, inner: string) => {
    const start = Number((/start="(\d+)"/i.exec(String(attrs)) ?? [])[1] ?? 1);
    let n = start;
    const numbered = inner.replace(/<li([^>]*)>([\s\S]*?)<\/li>/gi, (_lm, _la: string, body: string) => `${n++}. ${body}`);
    return `\n${numbered}`;
  });
  s = s.replace(/<table[^>]*>/gi, '\n');
  s = s.replace(/<\/table>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/td>|<\/th>/gi, '\u0001');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/h([1-6])>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  return collapseMarkedLines(s);
}

/** docx 兜底（无 mammoth 时）：直接解 document.xml 做轻量结构提取 */
export function docxXmlFallbackText(xml: string): string {
  return collapseMarkedLines(
    xml
      .replace(/<w:tab\/>/g, '\u0001')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:tc>/g, '\u0001')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  );
}

/** Excel 行 → 紧凑文本行（丢空行与行尾空列，单元格以 " | " 分隔） */
export function xlsxRowsToLines(rows: unknown[][]): string[] {
  return rows
    .filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined))
    .map((r) => {
      const cells = r.map((c) => String(c ?? '').replace(/[\r\n\t]+/g, ' ').trim());
      // 去掉行尾空列，避免出现悬挂的分隔符
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells.join(' | ');
    })
    .filter((l) => l.length > 0);
}
