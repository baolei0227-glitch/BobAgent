/**
 * 服务端 ai-card 卡片列表生成器（方案 B）—— 输出结构对应前端 HtmlRenderer 注入的 .ai-card CSS。
 * 从 tools/index.ts 抽出：供 web_search 等结构化工具直接渲染卡片，LLM 只需引用精简文本。
 * index.ts 反向 re-export（CardItem / buildCardListHtml）以保持既有公共 API 不变。
 */

export interface CardItem {
  title: string;
  badge?: string;
  badgeColor?: 'default' | 'green' | 'red';
  status?: 'ok' | 'err' | 'run';
  meta?: string;
  body?: string;
  url?: string;
  btnText?: string;
}

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCardListHtml(items: CardItem[]): string {
  if (!items || items.length === 0) return '';
  const cards = items
    .map((it) => {
      const badge = it.badge
        ? `<span class="ai-badge${it.badgeColor && it.badgeColor !== 'default' ? ' ' + it.badgeColor : ''}">${escHtml(it.badge)}</span>`
        : '';
      const status = it.status ? `<span class="ai-status ${escHtml(it.status)}"></span> ` : '';
      const meta = it.meta || it.status ? `<div class="ai-card-meta">${status}${escHtml(it.meta || '')}</div>` : '';
      const body = it.body ? `<div class="ai-card-body">${escHtml(it.body)}</div>` : '';
      const btn = it.url ? `<div class="ai-card-body"><a class="ai-btn" href="${escHtml(it.url)}">${escHtml(it.btnText || '查看详情')}</a></div>` : '';
      return `<div class="ai-card"><div class="ai-card-title">${escHtml(it.title)}${badge}</div>${meta}${body}${btn}</div>`;
    })
    .join('\n');
  return `<div class="ai-card-list">\n${cards}\n</div>`;
}
