/**
 * Widget 代码块解析（纯函数 / 无 React / 无 DOM 依赖）
 *
 * 从 WidgetRenderer 抽出，供两侧共用：
 *   - 客户端：WidgetRenderer（聊天气泡 / 分享卡片内渲染图表）
 *   - 服务端：分享页 SSR（share-widget.ts 预处理 ```mermaid / ```widget:* 围栏）
 *
 * 本模块禁止引入 React、浏览器 API 或 client-only 依赖。
 */

export interface WidgetBlock {
  type: 'svg' | 'html' | 'mermaid' | 'chart' | 'antv';
  code: string;
}

export type WidgetBlockPart =
  | { kind: 'text'; content: string }
  | { kind: 'widget'; widget: WidgetBlock };

/** 无语言围栏里，内容以这些 SVG 子元素开头即视为「裸 SVG 片段」（不含 <svg> 根节点） */
const SVG_FRAGMENT_HEAD =
  /^(?:<!--[\s\S]*?-->\s*)*<(?:svg|g|rect|circle|ellipse|line|polyline|polygon|path|text|tspan|defs|marker|use|symbol|linearGradient|radialGradient|clipPath|mask|pattern|filter)[\s/>]/i;

/** 取属性值字符串（缺失返回空串） */
function attrValue(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return m ? m[1] : '';
}

/** 取属性数值（缺失或非法返回 NaN） */
function attrNum(attrs: string, name: string): number {
  return parseFloat(attrValue(attrs, name));
}

/** 从属性值里抽出所有数值（points="1,2 3,4" / path d 等） */
function numbersIn(value: string): number[] {
  return (value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}

/**
 * 估算裸 SVG 片段的内容外框（补 <svg viewBox> 用）。
 * 仅做坐标层面的粗略估算，不处理 transform 与文本实际宽度，因此留足 padding；
 * 结果偏大只会在图周围多留白，不会裁切内容。
 */
function estimateViewBox(fragment: string): string {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const put = (x: number, y: number): void => {
    if (!Number.isNaN(x)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (!Number.isNaN(y)) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  };
  const PATH_STEP: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 };

  for (const m of fragment.matchAll(/<([a-zA-Z]+)\b([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    const a = m[2];
    switch (tag) {
      case 'rect':
      case 'image':
      case 'use': {
        const w = attrNum(a, 'width');
        const h = attrNum(a, 'height');
        put(attrNum(a, 'x'), attrNum(a, 'y'));
        put(attrNum(a, 'x') + (Number.isNaN(w) ? 0 : w), attrNum(a, 'y') + (Number.isNaN(h) ? 0 : h));
        break;
      }
      case 'line':
        put(attrNum(a, 'x1'), attrNum(a, 'y1'));
        put(attrNum(a, 'x2'), attrNum(a, 'y2'));
        break;
      case 'circle':
      case 'ellipse': {
        const cx = attrNum(a, 'cx');
        const cy = attrNum(a, 'cy');
        const rx = tag === 'circle' ? attrNum(a, 'r') : attrNum(a, 'rx');
        const ry = tag === 'circle' ? attrNum(a, 'r') : attrNum(a, 'ry');
        put(cx - rx, cy - ry);
        put(cx + rx, cy + ry);
        break;
      }
      case 'polyline':
      case 'polygon': {
        const nums = numbersIn(attrValue(a, 'points'));
        for (let i = 0; i + 1 < nums.length; i += 2) put(nums[i], nums[i + 1]);
        break;
      }
      case 'path': {
        for (const seg of attrValue(a, 'd').matchAll(/([MLHVCTSQAZmlhvctsqaz])([^MLHVCTSQAZmlhvctsqaz]*)/g)) {
          const cmd = seg[1];
          // 相对指令需要累积坐标才能换算，这里直接放弃（交给 padding 兜底）
          if (cmd !== cmd.toUpperCase()) break;
          const step = PATH_STEP[cmd];
          if (!step) continue;
          const args = numbersIn(seg[2]);
          for (let i = 0; i + step <= args.length; i += step) {
            if (cmd === 'H') put(args[i], NaN);
            else if (cmd === 'V') put(NaN, args[i]);
            else put(args[i + step - 2], args[i + step - 1]);
          }
        }
        break;
      }
      case 'text':
      case 'tspan': {
        const size = attrNum(a, 'font-size');
        const fs = Number.isNaN(size) ? 14 : size;
        const x = attrNum(a, 'x');
        const y = attrNum(a, 'y');
        put(x, Number.isNaN(y) ? NaN : y - fs * 1.2);
        put(x, Number.isNaN(y) ? NaN : y + fs * 0.3);
        break;
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return '0 0 640 480';
  const pad = 24;
  const x0 = Math.floor(Math.max(0, minX - pad));
  const y0 = Math.floor(Math.max(0, minY - pad));
  const w = Math.max(1, Math.ceil(maxX + pad - x0));
  const h = Math.max(1, Math.ceil(maxY + pad - y0));
  return `${x0} ${y0} ${w} ${h}`;
}

/** 给裸 SVG 片段补 <svg> 根节点（缺根节点时浏览器不会渲染 <rect>/<text> 等子元素） */
function wrapSvgFragment(fragment: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${estimateViewBox(fragment)}">\n${fragment}\n</svg>`;
}

/**
 * 容错：把模型偶尔写错的 widget 标记（**widget:xxx** / ### widget:xxx 等 markdown 写法）
 * 规范化为渲染器唯一识别的标准 ```widget:xxx 代码块围栏。
 * 同时剥掉紧随其后的语言围栏（```python），并给无闭合的 html/svg 形态补闭合围栏。
 */
export function normalizeWidgetMarkers(content: string): string {
  let out = content;
  // ① 行首 markdown 标记 → 标准开围栏（如 `**widget:chart**` → ```widget:chart）
  out = out.replace(/^[ \t]*\*{1,3}widget:(svg|html|mermaid|chart|antv)\*{1,3}[ \t]*$/gm, '```widget:$1');
  out = out.replace(/^[ \t]*#{1,6}\s+widget:(svg|html|mermaid|chart|antv)[ \t]*$/gm, '```widget:$1');
  // ② 剥掉紧随其后的语言围栏行（```python / ```js 等），避免双重围栏导致闭合错位
  out = out.replace(/(```widget:\w+[ \t]*\r?\n)```[a-zA-Z0-9_+-]*[ \t]*\r?\n/g, '$1');
  // ③ 无闭合的 html/svg 形态（`**widget:html**` 后直接跟正文）：补闭合围栏到下一个标题/标记/末尾。
  //    注意：lookahead 中的 ``` 也会命中「已正确闭合」的块（匹配结束后紧邻真实闭合围栏），
  //    此时必须原样保留，否则重复追加闭合围栏会让后续文本块开头残留孤立 ```，
  //    导致 markdown 把整个后续正文当作未闭合代码块渲染（表格/列表/粗体全部退化为原始文本）。
  out = out.replace(
    /```widget:(?:html|svg)\s*\n([\s\S]*?)(?=\n\s*(?:#{1,6}\s|```|\*\*widget:|$))/g,
    (m: string, body: string, offset: number, str: string) => {
      if (/^\n[ \t]*```/.test(str.slice(offset + m.length))) return m;
      return '```widget:html\n' + body + '\n```';
    },
  );
  // ④ 无语言标签围栏：内容本身就是 SVG（<svg> 根节点，或缺根节点的 SVG 子元素片段）时按 widget:svg 处理。
  //    模型常直接贴不带围栏语言的 SVG，此前会被当作普通代码块原样展示。
  out = out.replace(/```[ \t]*\r?\n([\s\S]*?)```/g, (m: string, body: string) => {
    const code = body.trim();
    if (!SVG_FRAGMENT_HEAD.test(code)) return m;
    const hasRoot = /^(?:<!--[\s\S]*?-->\s*)*<svg[\s/>]/i.test(code);
    return '```widget:svg\n' + (hasRoot ? code : wrapSvgFragment(code)) + '\n```';
  });
  return out;
}

export function parseWidgetBlocks(content: string): WidgetBlockPart[] {
  const normalized = normalizeWidgetMarkers(content);
  const results: WidgetBlockPart[] = [];

  // 匹配 ```widget:svg / ```widget:html / ```widget:mermaid / ```widget:chart / ```widget:antv / 标准 ```mermaid 代码块
  const regex = /```(?:widget:(svg|html|mermaid|chart|antv)|mermaid)\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    // 前面的文本片段
    if (match.index > lastIndex) {
      const text = normalized.slice(lastIndex, match.index);
      if (text.trim()) {
        results.push({ kind: 'text', content: text });
      }
    }

    // match[1] 为捕获组：'svg' | 'html' | 'mermaid' | 'chart'（widget: 前缀）或 'mermaid'（标准 ```mermaid）
    const marker = match[1];
    const widgetType: WidgetBlock['type'] =
      marker === 'svg' || marker === 'html' || marker === 'chart' || marker === 'antv' ? marker : 'mermaid';
    const widgetCode = match[2].trim();
    results.push({ kind: 'widget', widget: { type: widgetType, code: widgetCode } });

    lastIndex = regex.lastIndex;
  }

  // 尾部文本
  if (lastIndex < normalized.length) {
    const text = normalized.slice(lastIndex);
    if (text.trim()) {
      results.push({ kind: 'text', content: text });
    }
  }

  // 如果没有 widget，返回整个内容作为文本
  if (results.length === 0) {
    return [{ kind: 'text', content }];
  }

  return results;
}

/** 检测内容是否包含 widget 代码块（含标准 ```mermaid） */
export function hasWidgetBlocks(content: string): boolean {
  return /```(?:widget:(svg|html|mermaid|chart|antv)|mermaid)\s*\n/.test(normalizeWidgetMarkers(content));
}

/**
 * 流式期间：内容末尾是否存在"未闭合"的 widget/mermaid 代码块。
 * 用于渲染骨架屏占位（对话还在生成图表，先给用户一个视觉占位而不是裸代码）。
 */
export function hasOpenWidgetFence(content: string): boolean {
  const parts = content.split('```');
  let open = false;
  for (let i = 0; i < parts.length; i++) {
    if (open) {
      // 已处于块内：遇到下一段即视为闭合
      open = false;
      continue;
    }
    if (/^(?:widget:(?:svg|html|mermaid|chart|antv)|mermaid)\s*\n/.test(parts[i])) {
      open = true;
    }
  }
  return open;
}
