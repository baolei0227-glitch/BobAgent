/**
 * 浏览器工具规格层 — 内置 `browser_*` 工具定义
 *
 * 命名统一 `browser_*`（不带 mcp__ 前缀），与 MCP 通道的
 * `mcp__bob-browser-mcp__browser_*` 互斥注入（由 settings.aiBrowser 开关决定），
 * 从根本上避免两套同名工具同时进上下文。
 *
 * 覆盖 A 档（CDP / 原生 API 等价）全量：导航 / 等待 / 元素交互 / 内容提取 /
 * 截图导出 / 标签页 / 数据面 / 监控面 / 脚本面 / 阅读。
 * B 档（status/connect/search/research/note/login/录播）与需 ffmpeg 的
 * `extract_video_text` 不在本数组内，按驱动能力显式返回 unsupported。
 */

import type { BrowserToolSpec } from './types';

export const BROWSER_TOOL_SPECS: BrowserToolSpec[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL (http/https/file) in Hippo Browser. Navigates the current tab by default; set newTab=true to open a new tab.',
    returns: '{ url: final URL, title: page title }',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open (http/https/file)' },
        newTab: { type: 'boolean', description: 'Open in a new tab instead of the current one (default false)' },
      },
      required: ['url'],
    },
    maxOutput: 800,
  },
  {
    name: 'browser_snapshot',
    description:
      'Build an interactive-element snapshot of the current page: returns a list of elements with refs (links/buttons/' +
      'inputs/selects/editable areas). Open shadow roots and same-origin/cross-origin iframes are scanned too, so web-' +
      'component internals and iframe widgets (login / payment / chat embeds) are listed as real elements instead of one ' +
      'opaque <iframe>. Refs carry their scope prefix: `e3` = main document, `s1-e2` = inside the 1st shadow root, ' +
      '`f1-e4` = inside iframe f1. Pass refs back verbatim — they are consumed by browser_click / browser_type / ' +
      'browser_fill_form, and (main-document refs only) inside browser_page_script via bb.$(\'e3\'). ' +
      'Refs are renumbered on every snapshot — take a fresh snapshot after any navigation or large DOM change. ' +
      'It waits at most ~1.5s for the page to settle: if the result has ready:false, use browser_wait_for_text / ' +
      'browser_wait_network_idle before re-snapshotting instead of retrying the same snapshot blindly.',
    returns:
      '{ url, title, ready, elements: [{ ref, tag, role, name, value?, href?, disabled?, frame?, shadow? }], ' +
      'frames?: [{ frame, url, elements }] }  // `frames` lists the iframes that were scanned (present only when there are any)',
    parameters: {
      type: 'object',
      properties: {
        max: {
          type: 'number',
          description: 'Max elements to return from the main document (default 80, cap 300). Each iframe gets its own smaller budget (≤30)',
        },
      },
    },
    maxOutput: 6000,
  },
  {
    name: 'browser_click',
    description:
      'Click an element. Prefer the ref from browser_snapshot (scope prefixes like `s1-e2` / `f1-e4` work as-is); ' +
      'a CSS selector also works. ' +
      'Main-document targets get real mouse events (including scroll-into-view), so the page\'s real interaction logic fires. ' +
      'Targets inside an iframe are clicked in-frame on the element itself (the reply marks this with via="in-frame"). ' +
      'If the click starts a download, the reply includes download { id, fileName, savePath, state } — poll it with browser_downloads.',
    returns: '{ clicked: target description, url, title, redirected?, frame?, via?, download? }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. e3)' },
        selector: { type: 'string', description: 'CSS selector (used when no ref is given)' },
      },
    },
    maxOutput: 800,
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input / textarea / editable area. Locate by ref or selector. ' +
      'clear=true (default) wipes the existing value first; clear=false appends. ' +
      'Uses the native value setter plus input/change events, so controlled components (React/Vue) update correctly.',
    returns: '{ filled: target description, value: value after writing }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref is given)' },
        text: { type: 'string', description: 'Text to type' },
        clear: { type: 'boolean', description: 'Wipe the existing value first (default true)' },
      },
      required: ['text'],
    },
    maxOutput: 800,
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill several fields in one call: each entry has a ref or selector plus a value, written in array order. ' +
      'Faster than repeated browser_type — good for login boxes and multi-field forms.',
    returns: '{ filled: [{ target, value, ok }], failed: [{ target, error }] }',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Field list, written in array order',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref' },
              selector: { type: 'string', description: 'CSS selector' },
              value: { type: 'string', description: 'Value to write' },
            },
            required: ['value'],
          },
        },
      },
      required: ['fields'],
    },
    maxOutput: 1500,
  },
  {
    name: 'browser_press_key',
    description:
      'Send a key to the focused element. Supports Enter / Tab / Escape / Backspace / Delete / ArrowUp|Down|Left|Right / ' +
      'Home / End / PageUp / PageDown / Space, plus modifier combos (e.g. Meta+A / Control+A / Shift+Enter). ' +
      'Commonly used to submit a form or confirm a search.',
    returns: '{ key: key actually sent }',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name; modifier combos allowed (e.g. Enter, Meta+A)' },
      },
      required: ['key'],
    },
    maxOutput: 400,
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the current page. direction defaults to down; amount is the pixel delta (defaults to one viewport). ' +
      'Returns the new scroll position and total page height so you can tell whether the bottom was reached.',
    returns: '{ scrollY, pageHeight, viewportHeight, atBottom }',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'top', 'bottom'],
          description: 'Scroll direction (default down)',
        },
        amount: { type: 'number', description: 'Pixel delta (ignored for top/bottom)' },
      },
    },
    maxOutput: 600,
  },
  {
    name: 'browser_extract_text',
    description:
      'Extract the main article text of the current page (auto-detects the content container, drops nav/ads) and returns ' +
      'plain text plus a Markdown skeleton. Prefer this over browser_snapshot when reading page content — ' +
      'snapshots only list interactive elements. ' +
      'When you need only a few fields (a list, prices, links, counts), use browser_page_script and return just those ' +
      'instead: whole-page text is the most expensive way to answer a narrow question. ' +
      'If the result carries a note with kind=pdf the page is a PDF document — switch to browser_read_pdf instead of ' +
      'treating the empty text as an empty page (kind=login = login wall, kind=empty = page not rendered yet).',
    returns: '{ url, title, ready, text, markdown, note?, kind? }',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'markdown', 'both'],
          description: 'Output format (default both)',
        },
      },
    },
    maxOutput: 12000,
  },
  {
    name: 'browser_screenshot',
    description:
      'Screenshot the current page. Viewport shot by default; fullPage=true captures the whole page ' +
      '(useful for court documents and long contracts). The image is saved to <project>/homework/.evidence/ as evidence.',
    returns: '{ path: absolute path on disk, bytes, fullPage }',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the full page instead of the viewport (default false)' },
      },
    },
    maxOutput: 800,
  },
  {
    name: 'browser_run_js',
    description:
      'Run a JavaScript expression in the current page context and return its value (JSON-serializable). ' +
      'Use it to read page data precisely or compute in-page; do not use it to bypass the page\'s own permission or login checks.',
    returns: '{ result: script return value (JSON-serializable) }',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JS expression to run (an IIFE returning JSON is recommended; a statement body with `return` also works)' },
      },
      required: ['script'],
    },
    maxOutput: 6000,
  },

  // ============ P1：A 档剩余工具 ============

  // ---- 导航 ----
  {
    name: 'browser_back',
    description: 'Go back in the current tab navigation history.',
    returns: '{ url, title }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 400,
  },
  {
    name: 'browser_forward',
    description: 'Go forward in the current tab navigation history.',
    returns: '{ url, title }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 400,
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page.',
    returns: '{ url, title }',
    parameters: {
      type: 'object',
      properties: {
        ignoreCache: { type: 'boolean', description: 'Reload bypassing the HTTP cache (default false)' },
      },
    },
    maxOutput: 400,
  },

  // ---- 等待 ----
  {
    name: 'browser_wait',
    description: 'Wait a fixed amount of time, then report the page ready state. Prefer browser_wait_for / browser_wait_for_text when waiting for a specific condition.',
    returns: '{ waitedMs, ready, url }',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait (default 1000, max 30000)' },
      },
    },
    maxOutput: 400,
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until an element (ref or CSS selector) exists / is visible on the page.',
    returns: '{ found, elapsedMs, selector }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
        timeoutMs: { type: 'number', description: 'Max wait (default 10000, max 60000)' },
        visible: { type: 'boolean', description: 'Require the element to be visible, not just present (default true)' },
      },
    },
    maxOutput: 500,
  },
  {
    name: 'browser_wait_for_text',
    description: 'Wait until the page body text contains a given substring.',
    returns: '{ found, elapsedMs }',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to wait for' },
        timeoutMs: { type: 'number', description: 'Max wait (default 10000, max 60000)' },
      },
      required: ['text'],
    },
    maxOutput: 500,
  },
  {
    name: 'browser_wait_network_idle',
    description: 'Wait until in-flight network requests drop to zero for a short idle window. Use after actions that trigger background loading.',
    returns: '{ idle, inflight, elapsedMs }',
    parameters: {
      type: 'object',
      properties: {
        idleMs: { type: 'number', description: 'Required quiet window (default 500ms)' },
        timeoutMs: { type: 'number', description: 'Max wait (default 15000, max 60000)' },
        tabId: { type: 'number', description: 'Watch this tab instead of the active one' },
      },
    },
    maxOutput: 500,
  },

  // ---- 元素交互 ----
  {
    name: 'browser_pick_element_ref',
    description: 'Interactive pick: the user clicks an element on the page and you get back a stable ref plus a CSS selector. Use when browser_snapshot cannot locate the right element (dynamic UI, non-interactive container).',
    returns: '{ picked, ref, tag, role, name, selector }',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: 'How long to wait for the user click (default 60000, max 180000)' },
      },
    },
    maxOutput: 600,
  },
  {
    name: 'browser_select_option',
    description: 'Select an option in a <select> element by value, label, or index. Pass exactly one of value / label / index.',
    returns: '{ selected, value, text }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
        value: { type: 'string', description: 'Option value attribute' },
        label: { type: 'string', description: 'Visible option text' },
        index: { type: 'number', description: 'Zero-based option index' },
      },
    },
    maxOutput: 500,
  },
  {
    name: 'browser_submit',
    description: 'Submit the form that owns the target element (requestSubmit, falling back to submit()).',
    returns: '{ submitted, url, title }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
      },
    },
    maxOutput: 500,
  },
  {
    name: 'browser_hover',
    description: 'Move the real mouse cursor over an element (triggers CSS :hover and mouseover handlers).',
    returns: '{ hovered }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
      },
    },
    maxOutput: 400,
  },
  {
    name: 'browser_drag',
    description: 'Drag from one element (or point) to another using real mouse events. Useful for sliders, sortable lists, and canvas drag & drop.',
    returns: '{ dragged, from, to }',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: 'Drag source: ref / selector / x+y',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        to: {
          type: 'object',
          description: 'Drop target: ref / selector / x+y',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      },
      required: ['from', 'to'],
    },
    maxOutput: 600,
  },
  {
    name: 'browser_check',
    description: 'Check a checkbox / radio button (no-op if already checked).',
    returns: '{ checked, changed }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
      },
    },
    maxOutput: 400,
  },
  {
    name: 'browser_uncheck',
    description: 'Uncheck a checkbox (no-op if already unchecked).',
    returns: '{ checked, changed }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
      },
    },
    maxOutput: 400,
  },
  {
    name: 'browser_mouse_wheel',
    description: 'Dispatch a real mouse-wheel scroll at a point (defaults to the viewport centre).',
    returns: '{ scrollY, pageHeight, viewportHeight }',
    parameters: {
      type: 'object',
      properties: {
        deltaX: { type: 'number', description: 'Horizontal delta in pixels (default 0)' },
        deltaY: { type: 'number', description: 'Vertical delta in pixels (default 400)' },
        x: { type: 'number', description: 'Viewport X (default centre)' },
        y: { type: 'number', description: 'Viewport Y (default centre)' },
      },
    },
    maxOutput: 500,
  },
  {
    name: 'browser_click_coordinates',
    description: 'Click at raw viewport coordinates (for canvas / map / custom widgets with no DOM element).',
    returns: '{ clicked, x, y, url, title }',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Viewport X' },
        y: { type: 'number', description: 'Viewport Y' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left' },
      },
      required: ['x', 'y'],
    },
    maxOutput: 500,
  },
  {
    name: 'browser_upload_file',
    description: 'Attach local files to a file input (<input type=file>) via the DevTools protocol. Pass absolute paths.',
    returns: '{ uploaded, count, files }',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach' },
      },
      required: ['files'],
    },
    maxOutput: 600,
  },

  // ---- 下载 ----
  {
    name: 'browser_save_download',
    description:
      'Copy a completed download into the current project materials/ folder (default `materials/downloads/`). Use after ' +
      'browser_download when the user wants the file inside the project (materials is visible to later file/ledger steps). ' +
      'Pass the download id; optional `folder` picks a subfolder. Fails if the download is still progressing or no project is active.',
    returns: '{ saved, path, bytes }',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Download id returned by browser_download / browser_downloads' },
        folder: { type: 'string', description: 'Optional subfolder under materials/ (default "downloads")' },
      },
      required: ['id'],
    },
    maxOutput: 800,
  },
  {
    name: 'browser_find_downloads',
    description:
      'Scan the current page for download entry points: file-extension links (pdf/doc/docx/xls/xlsx/ppt/pptx/zip/rar/7z/csv/txt/md/rtf/epub/images/audio/video), ' +
      'elements with a `download` attribute, and buttons/links whose text, class or id contains 下载/附件/导出/保存/download/export/save. ' +
      'Returns candidates with `selector` (usable by browser_download), `href`, text and kind. Cheaper than a full snapshot when the page is large or the ' +
      'download control is icon-only. Main document only — if it returns nothing, fall back to browser_snapshot.',
    returns: '{ url, title, ready, candidates: [{ selector, tag, text, href, kind }] }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 2500,
  },
  {
    name: 'browser_download',
    description:
      'Download a file from the current page. Provide `url` for a direct file link, or `ref` / `selector` for a ' +
      'download link/button on the page (the host performs a real click, so cookies and JS handlers still apply). ' +
      'The host writes the file to the system Downloads folder and returns { download: { id, fileName, savePath, state, totalBytes } }. ' +
      'After starting it waits up to `waitMs` (default 2000, max 30000) for completion, so small files come back completed in one round; ' +
      'if it is still progressing, poll browser_downloads with the id instead of sleeping. ' +
      'Set reveal=true only when the user asks to show the file in Finder; it takes effect when the download is completed. ' +
      'Do NOT use browser_export_pdf to obtain a file (that prints the page to PDF), do NOT use browser_read_pdf ' +
      '(it only returns text and keeps the file in a temp dir), and do NOT fetch binary content via browser_run_js.',
    returns: '{ download: { id, fileName, savePath, state, totalBytes, receivedBytes, url }, revealed? }',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct file URL (http/https/file or a relative href resolved against the current page). Use this when the href is known.' },
        ref: { type: 'string', description: 'Element ref from browser_snapshot (download link/button)' },
        selector: { type: 'string', description: 'CSS selector (used when no ref)' },
        waitMs: { type: 'number', description: 'After starting, wait this long for completion (default 2000, max 30000; 0 = return immediately)' },
        reveal: { type: 'boolean', description: 'Reveal the completed file in Finder (default false; only when the user asks)' },
      },
    },
    maxOutput: 1200,
  },
  {
    name: 'browser_downloads',
    description:
      'List downloads started in Hippo Browser, newest first (state, progress, save path). Pass `id` to inspect one ' +
      'download; with `waitMs` it waits up to that long for the download to finish instead of returning immediately. ' +
      'Use after browser_download / browser_click to confirm a download completed, instead of sleeping with browser_wait.',
    returns: '{ downloads: [{ id, fileName, savePath, state, totalBytes, receivedBytes, url }] } or { download }',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Download id (omit to list all)' },
        waitMs: { type: 'number', description: 'With id: wait this long for completion (default 0, max 30000)' },
      },
    },
    maxOutput: 3000,
  },

  // ---- 内容提取 ----
  {
    name: 'browser_get_html',
    description:
      'Read raw HTML of the page (full document by default, or body inner HTML). Truncated to maxChars. ' +
      'clean=true returns an archive-ready snapshot instead of the raw markup: scripts/noscript/iframe/template ' +
      'and comments stripped, on* handlers and javascript: links removed, src/href/srcset/poster/form action and ' +
      'style url(...) turned into absolute URLs, and lazy-load data-src* promoted to the real attributes. ' +
      'Pass tabId to read that tab instead of the active one (e.g. a background tab opened for archiving).',
    returns: '{ html, truncated, bytes }',
    parameters: {
      type: 'object',
      properties: {
        outer: { type: 'boolean', description: 'true = documentElement.outerHTML, false = body.innerHTML (default false)' },
        maxChars: { type: 'number', description: 'Character cap (default 20000, max 4000000)' },
        clean: { type: 'boolean', description: 'Return an archive-ready snapshot (strip noise, absolutize URLs) (default false)' },
        tabId: { type: 'number', description: 'Read this tab instead of the active one' },
      },
    },
    maxOutput: 20000,
  },
  {
    name: 'browser_get_viewport',
    description: 'Read the current viewport geometry (size, scroll position, page height, device pixel ratio).',
    returns: '{ width, height, scrollX, scrollY, pageHeight, devicePixelRatio }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 400,
  },

  // ---- 截图导出 ----
  {
    name: 'browser_export_pdf',
    description: 'Print the current page to a PDF file and save it under <project>/homework/.evidence/. Good for archiving judgments, contracts and official notices.',
    returns: '{ path, bytes, pageSize }',
    parameters: {
      type: 'object',
      properties: {
        landscape: { type: 'boolean', description: 'Landscape orientation (default false)' },
        printBackground: { type: 'boolean', description: 'Include background graphics (default true)' },
        pageSize: { type: 'string', enum: ['A4', 'A3', 'Letter', 'Legal', 'Tabloid'], description: 'Paper size, default A4' },
      },
    },
    maxOutput: 600,
  },

  // ---- 标签页 ----
  {
    name: 'browser_list_tabs',
    description: 'List all open tabs in the Hippo Browser window.',
    returns: '{ active, tabs: [{ id, title, url, active }] }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 2000,
  },
  {
    name: 'browser_active_tab',
    description: 'Describe the currently active tab.',
    returns: '{ id, title, url }',
    parameters: { type: 'object', properties: {} },
    maxOutput: 500,
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch the active tab by id (from browser_list_tabs).',
    returns: '{ id, title, url }',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Tab id from browser_list_tabs' } },
      required: ['id'],
    },
    maxOutput: 500,
  },
  {
    name: 'browser_open_tab',
    description:
      'Open a URL in a new tab and activate it. Returns once the tab is readable (up to ~3s); title may be empty ' +
      'while the page is still loading — continue with browser_wait_for_text / browser_snapshot, do not retry opening it.',
    returns: '{ id, url, title }',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (http/https/file)' },
        activate: { type: 'boolean', description: 'Focus the new tab (default true)' },
      },
      required: ['url'],
    },
    maxOutput: 500,
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab by id (defaults to the active tab). The window always keeps at least one tab.',
    returns: '{ closed, id, activeId }',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Tab id; omit to close the active tab' } },
    },
    maxOutput: 500,
  },

  // ---- 数据面 ----
  {
    name: 'browser_get_cookies',
    description: 'Read cookies visible to the current page origin.',
    returns: '{ cookies: [{ name, value, domain, path, secure, httpOnly, expires }], count }',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Scope URL (default: current page URL)' },
      },
    },
    maxOutput: 3000,
  },
  {
    name: 'browser_set_cookie',
    description: 'Set a cookie for a URL. Use for session setup / consent flags.',
    returns: '{ set, name, url }',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL the cookie belongs to (required)' },
        name: { type: 'string', description: 'Cookie name' },
        value: { type: 'string', description: 'Cookie value' },
        domain: { type: 'string', description: 'Optional domain' },
        path: { type: 'string', description: 'Optional path, default "/"' },
        secure: { type: 'boolean', description: 'Secure flag' },
        httpOnly: { type: 'boolean', description: 'HttpOnly flag' },
        expirationDate: { type: 'number', description: 'Unix seconds; omit for a session cookie' },
      },
      required: ['url', 'name', 'value'],
    },
    maxOutput: 500,
  },
  {
    name: 'browser_clear_cookies',
    description: 'Clear cookies for the browser session (all sites, or one URL scope).',
    returns: '{ cleared, url }',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL scope; omit to clear all cookies' } },
    },
    maxOutput: 400,
  },
  {
    name: 'browser_get_storage',
    description: 'Read localStorage or sessionStorage of the current page origin.',
    returns: '{ type, items: [{ key, value }], count }',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['local', 'session'], description: 'Storage area, default local' },
        maxItems: { type: 'number', description: 'Cap on returned items (default 200)' },
      },
    },
    maxOutput: 6000,
  },
  {
    name: 'browser_set_storage',
    description: 'Write a localStorage / sessionStorage entry for the current origin.',
    returns: '{ type, key, value }',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['local', 'session'], description: 'Storage area, default local' },
        key: { type: 'string', description: 'Item key' },
        value: { type: 'string', description: 'Item value' },
      },
      required: ['key', 'value'],
    },
    maxOutput: 400,
  },
  {
    name: 'browser_clear_storage',
    description: 'Clear localStorage / sessionStorage for the current origin.',
    returns: '{ type, cleared }',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['local', 'session', 'both'], description: 'Storage area, default both' },
      },
    },
    maxOutput: 400,
  },

  // ---- 监控面 ----
  {
    name: 'browser_network_requests',
    description: 'Read recently observed network requests (method, URL, status, type, duration). Populated while the DevTools protocol Network domain is active.',
    returns: '{ requests: [{ method, url, status, type, ms, failed }], count }',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, newest last (default 100, max 300)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading (default true)' },
      },
    },
    maxOutput: 8000,
  },
  {
    name: 'browser_console_logs',
    description: 'Read recently captured console messages and uncaught page errors.',
    returns: '{ logs: [{ level, text, ts }], count }',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, newest last (default 100, max 300)' },
        level: { type: 'string', enum: ['all', 'error', 'warn', 'info', 'log'], description: 'Filter by level (default all)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading (default true)' },
      },
    },
    maxOutput: 8000,
  },
  {
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss the JavaScript dialog currently blocking the page (alert / confirm / prompt). The main process auto-dismisses an unhandled dialog after a short grace period.',
    returns: '{ handled, type, message, accepted }',
    parameters: {
      type: 'object',
      properties: {
        accept: { type: 'boolean', description: 'true = OK (default), false = Cancel' },
        promptText: { type: 'string', description: 'Text to return for prompt() dialogs' },
      },
    },
    maxOutput: 500,
  },

  // ---- 脚本面 ----
  {
    name: 'browser_page_script',
    description:
      'Run a script in the page with the bb helper runtime. Helpers: ' +
      'bb.$(refOrSelector) / bb.ref(ref) locate an element (refs are the ones browser_snapshot produced; they resolve through the snapshot ' +
      'registry, so refs inside the main document\'s open shadow roots like s1-e2 work too — refs that start with f (inside an iframe) do not, ' +
      'use browser_click / browser_type for those); ' +
      'bb.fill(target, text, {clear}) writes into input / textarea / contenteditable via the native value setter plus input/change events; ' +
      'bb.click(target) / bb.press(key, target?) / bb.scroll(targetOrOptions) interact; ' +
      'bb.text(target?, {maxChars, html}) reads a region as text; bb.snapshot({max}) returns the main-document element list (same refs as browser_snapshot, but without the iframe pass); ' +
      'bb.waitFor(cond, opts) / bb.waitText(needle, opts) wait, bb.sleep(ms) pauses. ' +
      'Prefer this over a chain of browser_click / browser_type / browser_extract_text whenever a task needs 3+ steps in the same page, ' +
      'or whenever you only need specific fields (lists, prices, links, counts): one script, one round trip, no whole-page dump. ' +
      'bb.click dispatches a synthetic in-page click — if the page ignores it (coordinate handlers, isTrusted checks), use browser_click instead. ' +
      'Any navigation invalidates every ref and every element reference held by the script. ' +
      'bb.goto(url) requires allowNav=true, terminates the script (statements after it never run) and lets the host perform the navigation. ' +
      'For cross-page work the usual pattern is browser_navigate / browser_open_tab / browser_switch_tab followed by a fresh browser_page_script on the new page. ' +
      'On failure the result carries a trace of what already ran (warnings: "what was done before failing") — resume from there instead of re-running the whole script.',
    returns:
      '{ result, warnings } — result becomes { __truncated, chars, cap, head } when it exceeds the return budget; ' +
      'if the page navigated (bb.goto, or a link clicked by the script) you get { navigated, url, title, warnings } instead; ' +
      'on failure you get ok:false with warnings listing the operations that had already taken effect',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Script body (async; may use await and the bb.* helpers)' },
        allowNav: {
          type: 'boolean',
          description: 'Allow in-script navigation via bb.goto (default false); the script stops at bb.goto',
        },
        timeoutMs: { type: 'number', description: 'Overall time budget (default 15000, max 60000)' },
      },
      required: ['script'],
    },
    maxOutput: 8000,
  },
  {
    name: 'browser_resize_viewport',
    description: 'Override the viewport size (and optional device scale / mobile emulation). Use to test responsive layouts or capture a wider page.',
    returns: '{ width, height, deviceScaleFactor, mobile }',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Viewport width in CSS pixels' },
        height: { type: 'number', description: 'Viewport height in CSS pixels' },
        deviceScaleFactor: { type: 'number', description: 'Device scale factor (default 1)' },
        mobile: { type: 'boolean', description: 'Enable mobile emulation (default false)' },
      },
      required: ['width', 'height'],
    },
    maxOutput: 500,
  },

  // ---- 阅读 ----
  {
    name: 'browser_read_article',
    description: 'Read the main article body of the current page as Markdown (same extraction as browser_extract_text, trimmed to the article).',
    returns: '{ title, url, markdown }',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Character cap (default 20000)' },
      },
    },
    maxOutput: 20000,
  },
  {
    name: 'browser_read_pdf',
    description: 'Extract text from the PDF currently open in Hippo Browser (local pdf-viewer page, file:// URL, or a remote PDF link).',
    returns: '{ title, path, pages, text }',
    parameters: {
      type: 'object',
      properties: {
        maxPages: { type: 'number', description: 'Only extract the first N pages (default all)' },
        maxChars: { type: 'number', description: 'Character cap (default 40000)' },
      },
    },
    maxOutput: 40000,
  },
];

/** 全部内置浏览器工具名（供门控 / 来源判定 / 分层标注共用） */
export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(
  BROWSER_TOOL_SPECS.map((s) => s.name),
);