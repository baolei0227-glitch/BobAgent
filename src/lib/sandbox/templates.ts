/**
 * Bob Sandbox 内置小程序模板。
 * 每个模板：entry（入口文件名）+ files（文件名 → 内容）。
 */

export type SandboxTemplateId =
  | 'blank'
  | 'ai-chat'
  | 'calculator'
  | 'todo'
  | 'habit'
  | 'pomodoro'
  | 'contact-form'
  | 'data-table'
  | 'portfolio'
  | 'landing'
  | 'reader'
  | 'converter';

export interface SandboxTemplate {
  id: SandboxTemplateId;
  label: string;
  description: string;
  entry: string;
  files: Record<string, string>;
  /** 需求描述示例：对应 spec_0（功能）+ spec_2（交互）+ spec_3（持久化）建议值 */
  promptSeed?: {
    category: string;
    interaction: string;
    persistence: string;
  };
}

const PAPER_STYLE = `
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "PingFang SC", "Noto Serif SC", serif;
      background: #faf8f3; color: #3a342c; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #fff; border: 1px solid #e8e0d0; border-radius: 12px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.06); padding: 24px; width: 100%; max-width: 380px;
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #4a4036; }
    /* 黄金脚手架：共享 tokens + .bw-* 组件。新模板/AI 生成优先复用，避免每次重造外壳。 */
    :root { --bw-radius: 12px; --bw-gap: 12px; --bw-pad: 20px; }
    .bw-card {
      background: var(--paper, #fff); border: 1px solid var(--line, #e8e0d0);
      border-radius: var(--bw-radius); box-shadow: 0 4px 18px rgba(0,0,0,0.06);
      padding: var(--bw-pad); width: 100%;
    }
    .bw-title { font-size: 20px; font-weight: 600; color: var(--ink, #3a342c); margin: 0; }
    .bw-muted { font-size: 12px; color: var(--ink-muted, #8a7f6f); }
    .bw-tnum { font-variant-numeric: tabular-nums; }
    .bw-input {
      width: 100%; padding: 10px 12px; border: 1px solid var(--line, #e8e0d0);
      border-radius: 8px; background: var(--input-bg, #fbf9f4); color: var(--ink, #3a342c);
      font: inherit; outline: none;
    }
    .bw-input:focus { border-color: var(--primary, #6b8e4e); box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary, #6b8e4e) 25%, transparent); }
    .bw-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 9px 14px; border: 1px solid var(--line, #e8e0d0); border-radius: 8px;
      background: var(--paper, #fff); color: var(--ink, #3a342c); font: inherit; cursor: pointer;
      transition: filter .15s, transform .05s;
    }
    .bw-btn:hover { filter: brightness(1.04); }
    .bw-btn:active { transform: scale(.98); }
    .bw-btn:disabled { opacity: .55; cursor: default; }
    .bw-btn-primary { background: var(--primary, #6b8e4e); border-color: var(--primary, #6b8e4e); color: var(--brand-on, #fff); }
    .bw-empty { padding: 20px 12px; text-align: center; color: var(--ink-muted, #8a7f6f); font-size: 12px; }
  </style>`;

// ============================================================
// Blank / Calculator（原始模板保持不变）
// ============================================================

const CALCULATOR_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .display {
      width: 100%; text-align: right; font-size: 32px; font-weight: 600;
      padding: 14px 16px; border: 1px solid #e8e0d0; border-radius: 8px;
      background: #fbf9f4; color: #2e2820; margin-bottom: 12px; min-height: 64px;
      overflow-x: auto; font-family: "SF Mono", Menlo, monospace;
    }
    .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .keys button {
      font-size: 18px; padding: 14px 0; border: 1px solid #e8e0d0; border-radius: 8px;
      background: #fff; color: #3a342c; cursor: pointer; transition: background 0.15s;
    }
    .keys button:hover { background: #f3eee4; }
    .keys .op { background: #f6f0e2; color: #7a5c2e; }
    .keys .eq { background: #d9c9a3; color: #3a342c; font-weight: 600; }
    .keys .clear { background: #f3e2dd; color: #8a4a3a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>计算器</h1>
    <div class="display" id="display">0</div>
    <div class="keys" id="keys">
      <button class="clear" data-k="C">C</button>
      <button data-k="(">(</button>
      <button data-k=")">)</button>
      <button class="op" data-k="/">÷</button>
      <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
      <button class="op" data-k="*">×</button>
      <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
      <button class="op" data-k="-">−</button>
      <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
      <button class="op" data-k="+">+</button>
      <button data-k="0">0</button><button data-k=".">.</button>
      <button class="eq" data-k="=">=</button>
    </div>
  </div>
  <script>
    const display = document.getElementById('display');
    let expr = '';
    const safeEval = (s) => {
      if (!/^[0-9.+\-*/().%\\s]+$/.test(s)) return NaN;
      try { return Function('"use strict";return (' + s + ')')(); } catch { return NaN; }
    };
    document.getElementById('keys').addEventListener('click', (e) => {
      const k = e.target.dataset.k;
      if (k === undefined) return;
      if (k === 'C') { expr = ''; display.textContent = '0'; return; }
      if (k === '=') {
        const v = safeEval(expr);
        display.textContent = (Number.isFinite(v) ? (Math.round(v * 1e10) / 1e10) : '错误');
        expr = String(v);
        return;
      }
      expr += k === '÷' ? '/' : k === '×' ? '*' : k === '−' ? '-' : k;
      display.textContent = expr;
    });
  </script>
</body>
</html>`;

const BLANK_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
</head>
<body>
  <div class="card">
    <h1>空白小程序</h1>
    <p style="font-size:13px;color:#8a7f6f;line-height:1.8">
      在节点对话中让 AI 修改
      <code style="background:#f3eee4;padding:1px 5px;border-radius:4px">bob-sandbox/apps/&lt;id&gt;/index.html</code>
      即可迭代此页面。
    </p>
  </div>
</body>
</html>`;

// ============================================================
// 待办管理（持久化磁盘）
// ============================================================

const TODO_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .row { display: flex; gap: 8px; margin-bottom: 16px; }
    input[type="text"] {
      flex: 1; padding: 10px 12px; border: 1px solid #e8e0d0; border-radius: 8px;
      font-size: 14px; background: #fbf9f4; color: #3a342c; font-family: inherit;
    }
    button.primary {
      padding: 10px 16px; border: none; border-radius: 8px; background: #6b8e4e;
      color: #fff; font-size: 14px; cursor: pointer; font-family: inherit;
    }
    button.primary:hover { filter: brightness(1.05); }
    .list { list-style: none; }
    .list li {
      display: flex; align-items: center; gap: 10px; padding: 10px 0;
      border-bottom: 1px dashed #e8e0d0;
    }
    .list li:last-child { border-bottom: none; }
    .list input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
    .list .t { flex: 1; font-size: 14px; }
    .list li.done .t { text-decoration: line-through; color: #9c907b; }
    .del {
      background: transparent; border: none; color: #a86060; cursor: pointer;
      font-size: 18px; padding: 4px 8px;
    }
    .hint { font-size: 12px; color: #8a7f6f; margin-top: 10px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>待办清单</h1>
    <div class="row">
      <input type="text" id="inp" placeholder="输入内容后按回车或点添加" />
      <button class="primary" id="addBtn">添加</button>
    </div>
    <ul class="list" id="list"></ul>
    <p class="hint">数据自动保存到磁盘 · 重启 BobWork 后保留</p>
  </div>
  <script>
    const KEY = 'todo_items_v1';
    const listEl = document.getElementById('list');
    const inp = document.getElementById('inp');
    const STORAGE = (window.BobStorage && window.BobStorage.save) ? window.BobStorage : null;

    async function load() {
      try {
        if (STORAGE) return (await STORAGE.load(KEY)) || [];
      } catch {}
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    }
    async function save(items) {
      try {
        if (STORAGE) await STORAGE.save(KEY, items);
      } catch {}
      localStorage.setItem(KEY, JSON.stringify(items));
    }
    function render(items) {
      listEl.innerHTML = '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        if (it.done) li.classList.add('done');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!it.done;
        cb.onchange = async () => { items[i].done = cb.checked; render(items); await save(items); };
        const t = document.createElement('span'); t.className = 't'; t.textContent = it.text;
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
        del.onclick = async () => { items.splice(i, 1); render(items); await save(items); };
        li.append(cb, t, del); listEl.appendChild(li);
      });
    }
    (async function init() {
      const items = await load(); render(items);
      async function add() {
        const v = inp.value.trim(); if (!v) return;
        items.push({ text: v, done: false });
        inp.value = ''; render(items); await save(items);
      }
      document.getElementById('addBtn').onclick = add;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    })();
  </script>
</body>
</html>`;

// ============================================================
// 习惯打卡（持久化磁盘）
// ============================================================

const HABIT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .habits { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
    .habit {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px; border: 1px solid #e8e0d0; border-radius: 10px; background: #fbf9f4;
    }
    .habit input[type="text"] {
      flex: 1; border: none; background: transparent; font-size: 14px; color: #3a342c;
      font-family: inherit;
    }
    .habit input[type="text"]:focus { outline: none; }
    .streak { font-size: 12px; color: #8a6b2a; font-weight: 600; min-width: 44px; text-align: right; }
    .dot {
      width: 34px; height: 34px; border-radius: 50%; border: 2px solid #d9c9a3;
      background: transparent; cursor: pointer; flex-shrink: 0; transition: all 0.2s;
    }
    .dot.done { background: #6b8e4e; border-color: #6b8e4e; }
    .row { display: flex; gap: 8px; }
    button.add {
      width: 100%; padding: 10px; border: 1px dashed #c9bda6; background: transparent;
      border-radius: 8px; color: #8a7f6f; cursor: pointer; font-family: inherit;
    }
    button.add:hover { background: #f3eee4; }
    .del { background: transparent; border: none; color: #a86060; cursor: pointer; font-size: 18px; }
    .hint { font-size: 12px; color: #8a7f6f; text-align: center; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>习惯追踪</h1>
    <div class="habits" id="hb"></div>
    <div class="row"><button class="add" id="addBtn">+ 新增习惯</button></div>
    <p class="hint">每天打卡 · 数据自动保留</p>
  </div>
  <script>
    const KEY = 'habits_v1';
    const STORAGE = (window.BobStorage && window.BobStorage.save) ? window.BobStorage : null;
    const today = new Date().toISOString().slice(0, 10);
    async function load() {
      try { if (STORAGE) return (await STORAGE.load(KEY)) || []; } catch {}
      const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : [];
    }
    async function save(d) {
      try { if (STORAGE) await STORAGE.save(KEY, d); } catch {}
      localStorage.setItem(KEY, JSON.stringify(d));
    }
    function render(data) {
      const wrap = document.getElementById('hb');
      wrap.innerHTML = '';
      data.forEach((h, i) => {
        const lastCheck = h.lastDate;
        const streak = (lastCheck === today) ? h.streak :
                       (lastCheck === dayOffset(-1)) ? h.streak : 0;
        const done = lastCheck === today;
        const el = document.createElement('div'); el.className = 'habit';
        const dot = document.createElement('button'); dot.className = 'dot' + (done ? ' done' : '');
        dot.onclick = async () => {
          if (!done) { h.streak = (lastCheck === dayOffset(-1) ? h.streak : 0) + 1; h.lastDate = today; }
          else { h.streak = Math.max(0, h.streak - 1); h.lastDate = null; }
          render(data); await save(data);
        };
        const name = document.createElement('input'); name.type = 'text'; name.value = h.name;
        name.placeholder = '习惯名称，如：早起';
        name.onchange = async () => { h.name = name.value.trim(); await save(data); };
        const sk = document.createElement('span'); sk.className = 'streak'; sk.textContent = streak + '天';
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
        del.onclick = async () => { data.splice(i, 1); render(data); await save(data); };
        el.append(dot, name, sk, del); wrap.appendChild(el);
      });
    }
    function dayOffset(n) {
      const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
    }
    (async function init() {
      const data = await load(); render(data);
      document.getElementById('addBtn').onclick = async () => {
        data.push({ name: '', streak: 0, lastDate: null }); render(data); await save(data);
      };
    })();
  </script>
</body>
</html>`;

// ============================================================
// 番茄钟计时器（session 级持久化）
// ============================================================

const POMODORO_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .timer {
      font-size: 72px; font-weight: 300; text-align: center; letter-spacing: -2px;
      color: #4a4036; font-variant-numeric: tabular-nums; margin: 20px 0 10px;
      font-family: "SF Mono", Menlo, monospace;
    }
    .modes { display: flex; gap: 6px; justify-content: center; margin-bottom: 16px; }
    .modes button {
      flex: 1; padding: 8px 10px; border: 1px solid #e8e0d0; background: #fff;
      border-radius: 8px; font-size: 12px; cursor: pointer; color: #6b6152;
      font-family: inherit;
    }
    .modes button.active { background: #d9c9a3; color: #3a342c; border-color: #c9bda6; }
    .actions { display: flex; gap: 8px; margin-bottom: 16px; }
    .actions button {
      flex: 1; padding: 12px; border: none; border-radius: 8px;
      font-size: 14px; cursor: pointer; font-family: inherit;
    }
    .start { background: #6b8e4e; color: #fff; }
    .reset { background: #f3e2dd; color: #8a4a3a; }
    .stats {
      background: #fbf9f4; border-radius: 8px; padding: 12px;
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    }
    .stats div { font-size: 12px; color: #8a7f6f; }
    .stats b { display: block; font-size: 20px; color: #4a4036; margin-top: 2px; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="card">
    <h1>番茄钟</h1>
    <div class="modes" id="modes">
      <button data-m="25" class="active">专注 25:00</button>
      <button data-m="5">短休 05:00</button>
      <button data-m="15">长休 15:00</button>
    </div>
    <div class="timer" id="timer">25:00</div>
    <div class="actions">
      <button class="start" id="toggle">开始</button>
      <button class="reset" id="reset">重置</button>
    </div>
    <div class="stats">
      <div>今日完成<b id="todayCount">0</b></div>
      <div>累计分钟<b id="totalMin">0</b></div>
    </div>
  </div>
  <script>
    const KEY = 'pomodoro_stats_v1';
    let mode = 25, left = 25 * 60, running = false, tid = null;
    const timerEl = document.getElementById('timer');
    const toggleBtn = document.getElementById('toggle');
    const modes = document.getElementById('modes');
    function fmt(s) { const m = Math.floor(s / 60); return String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0'); }
    function load() {
      try {
        const raw = localStorage.getItem(KEY); if (!raw) return { today: 0, total: 0, date: new Date().toISOString().slice(0,10) };
        const d = JSON.parse(raw); const today = new Date().toISOString().slice(0,10);
        if (d.date !== today) d.today = 0; return { ...d, date: today };
      } catch { return { today: 0, total: 0, date: new Date().toISOString().slice(0,10) }; }
    }
    function save(d) { localStorage.setItem(KEY, JSON.stringify(d)); renderStats(d); }
    function renderStats(d) { document.getElementById('todayCount').textContent = d.today; document.getElementById('totalMin').textContent = d.total; }
    let stats = load(); renderStats(stats);
    function tick() {
      timerEl.textContent = fmt(left);
      if (left <= 0) { clearInterval(tid); running = false; toggleBtn.textContent = '完成';
        if (mode === 25) { stats.today += 1; stats.total += 25; save(stats); }
        try { if (window.BobStorage && BobStorage.set) BobStorage.set('pomo_done_' + Date.now(), { mode }); } catch {}
        return;
      }
      left--;
    }
    modes.addEventListener('click', (e) => {
      const m = e.target.dataset.m; if (!m) return;
      mode = parseInt(m, 10); left = mode * 60; running = false; clearInterval(tid);
      timerEl.textContent = fmt(left); toggleBtn.textContent = '开始';
      modes.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.m === m));
    });
    toggleBtn.onclick = () => {
      if (running) { clearInterval(tid); running = false; toggleBtn.textContent = '继续'; return; }
      if (left <= 0) return;
      running = true; toggleBtn.textContent = '暂停'; tid = setInterval(tick, 1000);
    };
    document.getElementById('reset').onclick = () => {
      clearInterval(tid); running = false; left = mode * 60; timerEl.textContent = fmt(left); toggleBtn.textContent = '开始';
    };
  </script>
</body>
</html>`;

// ============================================================
// 联系表单收集（持久化磁盘）
// ============================================================

const FORM_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .field { margin-bottom: 14px; }
    label { display: block; font-size: 12px; color: #6b6152; margin-bottom: 6px; font-weight: 600; }
    input[type="text"], input[type="email"], textarea {
      width: 100%; padding: 10px 12px; border: 1px solid #e8e0d0; border-radius: 8px;
      font-size: 14px; background: #fbf9f4; color: #3a342c; font-family: inherit; resize: vertical;
    }
    textarea { min-height: 80px; }
    button.submit {
      width: 100%; padding: 12px; border: none; border-radius: 8px;
      background: #6b8e4e; color: #fff; font-size: 14px; cursor: pointer; font-family: inherit;
    }
    .ok { color: #6b8e4e; text-align: center; padding: 16px; font-size: 14px; display: none; }
    .ok.show { display: block; }
    .sep { margin: 16px 0; border-bottom: 1px dashed #e8e0d0; }
    .rec {
      background: #fbf9f4; border-left: 3px solid #d9c9a3; padding: 10px 12px;
      margin-bottom: 8px; border-radius: 0 6px 6px 0; font-size: 13px;
    }
    .rec b { color: #4a4036; }
    .hint { font-size: 12px; color: #8a7f6f; }
  </style>
</head>
<body>
  <div class="card" style="max-width:440px">
    <h1>客户信息登记</h1>
    <form id="f">
      <div class="field">
        <label>姓名</label>
        <input type="text" name="name" required placeholder="请输入姓名" />
      </div>
      <div class="field">
        <label>手机 / 联系方式</label>
        <input type="text" name="phone" required placeholder="手机号或邮箱" />
      </div>
      <div class="field">
        <label>需求简述</label>
        <textarea name="msg" placeholder="请描述您的需求"></textarea>
      </div>
      <button type="submit" class="submit">提交登记</button>
      <div class="ok" id="ok">✓ 已成功提交！感谢您的登记，稍后会与您联系。</div>
    </form>
    <div class="sep"></div>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h1 style="font-size:14px;margin:0">历史记录</h1>
        <span class="hint" id="cnt">0 条</span>
      </div>
      <div id="list"></div>
    </div>
  </div>
  <script>
    const KEY = 'form_records_v1';
    const STORAGE = (window.BobStorage && window.BobStorage.save) ? window.BobStorage : null;
    async function load() {
      try { if (STORAGE) return (await STORAGE.load(KEY)) || []; } catch {}
      const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : [];
    }
    async function save(d) {
      try { if (STORAGE) await STORAGE.save(KEY, d); } catch {}
      localStorage.setItem(KEY, JSON.stringify(d));
    }
    function render(d) {
      document.getElementById('cnt').textContent = d.length + ' 条';
      const list = document.getElementById('list'); list.innerHTML = '';
      d.slice().reverse().slice(0, 5).forEach((r) => {
        const el = document.createElement('div'); el.className = 'rec';
        const d_ = new Date(r._at).toLocaleString();
        el.innerHTML = '<b>' + r.name + '</b> · <span style="color:#8a7f6f;font-size:12px">' + d_ + '</span><br>' +
          (r.phone || '') + (r.msg ? '<br><span style="color:#6b6152">' + r.msg + '</span>' : '');
        list.appendChild(el);
      });
    }
    (async function init() {
      const d = await load(); render(d);
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const rec = { name: fd.get('name'), phone: fd.get('phone'), msg: fd.get('msg'), _at: new Date().toISOString() };
        d.push(rec); await save(d); render(d);
        e.target.reset(); document.getElementById('ok').classList.add('show');
        setTimeout(() => document.getElementById('ok').classList.remove('show'), 2500);
      });
    })();
  </script>
</body>
</html>`;

// ============================================================
// 数据表格展示（无需持久化）
// ============================================================

const TABLE_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .card { max-width: 560px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .header .sub { font-size: 12px; color: #8a7f6f; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #f0e9d8; text-align: left; }
    th { background: #fbf9f4; font-weight: 600; color: #6b6152; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: "SF Mono", Menlo, monospace; }
    tr.total td { background: #fbf9f4; font-weight: 600; }
    .bar {
      display: inline-block; height: 6px; background: #d9c9a3; border-radius: 3px;
      vertical-align: middle; margin-left: 6px;
    }
    .legend { font-size: 12px; color: #8a7f6f; margin-top: 12px; }
    .kpi {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px;
    }
    .kpi .box {
      background: #fbf9f4; border-radius: 8px; padding: 12px; text-align: center;
      border: 1px solid #e8e0d0;
    }
    .kpi .v { font-size: 22px; font-weight: 600; color: #4a4036; font-variant-numeric: tabular-nums; }
    .kpi .l { font-size: 11px; color: #8a7f6f; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin:0">Q3 销售概览</h1>
      <span class="sub">单位：万元 · 数据可按需替换</span>
    </div>
    <div class="kpi">
      <div class="box"><div class="v">1,286</div><div class="l">总销售额</div></div>
      <div class="box"><div class="v">18.4%</div><div class="l">同比增长</div></div>
      <div class="box"><div class="v">342</div><div class="l">成交单量</div></div>
    </div>
    <table id="tbl">
      <thead>
        <tr>
          <th>月份</th><th>销售额</th><th>订单数</th><th>客单价</th><th style="width:120px">达成率</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>7 月</td><td class="num">392</td><td class="num">108</td><td class="num">3.63</td><td><span style="color:#6b8e4e">98%</span><span class="bar" style="width:98px;background:#6b8e4e"></span></td></tr>
        <tr><td>8 月</td><td class="num">428</td><td class="num">117</td><td class="num">3.66</td><td><span style="color:#6b8e4e">107%</span><span class="bar" style="width:107px;background:#6b8e4e"></span></td></tr>
        <tr><td>9 月</td><td class="num">466</td><td class="num">117</td><td class="num">3.98</td><td><span style="color:#6b8e4e">116%</span><span class="bar" style="width:116px;background:#6b8e4e"></span></td></tr>
        <tr class="total"><td>合计</td><td class="num">1,286</td><td class="num">342</td><td class="num">3.76</td><td>—</td></tr>
      </tbody>
    </table>
    <p class="legend">💡 提示：以上为示例静态数据，节点对话中可让 AI 替换为真实数据、或接入图表库做可视化。</p>
  </div>
</body>
</html>`;

// ============================================================
// 个人主页作品集（无需持久化）
// ============================================================

const PORTFOLIO_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .card { max-width: 420px; }
    .avatar {
      width: 64px; height: 64px; border-radius: 50%;
      background: linear-gradient(135deg, #d9c9a3, #b7a079);
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; font-weight: 600; color: #fff; margin: 0 auto 14px;
      border: 2px solid #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }
    .name { text-align: center; font-size: 20px; font-weight: 600; color: #4a4036; }
    .title { text-align: center; font-size: 12px; color: #8a7f6f; margin-top: 4px; margin-bottom: 16px; }
    .links { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
    .lnk {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; border: 1px solid #e8e0d0; border-radius: 10px;
      background: #fff; text-decoration: none; color: #3a342c;
      transition: all 0.15s; font-size: 14px;
    }
    .lnk:hover { background: #fbf9f4; transform: translateY(-1px); box-shadow: 0 4px 10px rgba(0,0,0,0.04); }
    .lnk .ic {
      width: 30px; height: 30px; border-radius: 8px;
      background: #f6f0e2; color: #7a5c2e;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
    }
    .lnk .txt { flex: 1; }
    .lnk .arr { color: #c9bda6; }
    .skills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; justify-content: center; }
    .tag {
      background: #fbf9f4; border: 1px solid #e8e0d0; color: #6b6152;
      padding: 4px 10px; border-radius: 999px; font-size: 12px;
    }
    .intro {
      font-size: 13px; color: #6b6152; line-height: 1.7; margin-bottom: 14px;
      padding: 10px 12px; background: #fbf9f4; border-radius: 8px;
      border-left: 3px solid #d9c9a3;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="avatar">AB</div>
    <div class="name">Alex Brown</div>
    <div class="title">产品设计师 · Freelancer</div>
    <div class="intro">
      5 年产品设计经验，专注 B 端 SaaS 体验设计、信息架构与交互原型。擅长用设计思维解决复杂业务问题。
    </div>
    <div class="skills">
      <span class="tag">Figma</span><span class="tag">User Research</span>
      <span class="tag">Prototyping</span><span class="tag">Design System</span>
      <span class="tag">DesignOps</span>
    </div>
    <div style="height:8px"></div>
    <div class="links">
      <a class="lnk" href="#" onclick="return false">
        <div class="ic">📄</div><div class="txt">在线简历 / Resume</div><div class="arr">→</div>
      </a>
      <a class="lnk" href="#" onclick="return false">
        <div class="ic">🎨</div><div class="txt">作品集精选 / Portfolio</div><div class="arr">→</div>
      </a>
      <a class="lnk" href="#" onclick="return false">
        <div class="ic">📧</div><div class="txt">联系我 / Contact Me</div><div class="arr">→</div>
      </a>
      <a class="lnk" href="#" onclick="return false">
        <div class="ic">💼</div><div class="txt">LinkedIn 主页</div><div class="arr">→</div>
      </a>
    </div>
  </div>
</body>
</html>`;

// ============================================================
// 营销落地页（无需持久化）
// ============================================================

const LANDING_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .card { max-width: 480px; padding: 28px; }
    .eyebrow {
      display: inline-block; background: #f6f0e2; color: #7a5c2e;
      padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
      margin-bottom: 12px;
    }
    .headline {
      font-size: 26px; font-weight: 700; line-height: 1.3; color: #3a342c; margin-bottom: 10px;
    }
    .headline em { background: linear-gradient(transparent 65%, #f6e5b0 65%); font-style: normal; padding: 0 2px; }
    .sub { font-size: 14px; color: #6b6152; line-height: 1.7; margin-bottom: 20px; }
    .bullets { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
    .b {
      display: flex; gap: 12px; align-items: flex-start;
    }
    .b .dot {
      width: 22px; height: 22px; border-radius: 50%; background: #6b8e4e; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600;
      flex-shrink: 0;
    }
    .b .txt { font-size: 13px; color: #4a4036; line-height: 1.6; flex: 1; }
    .cta {
      display: flex; flex-direction: column; gap: 10px;
      padding: 18px; background: #fbf9f4; border-radius: 10px;
      border: 1px solid #e8e0d0;
    }
    .cta input[type="email"] {
      padding: 12px 14px; border: 1px solid #e8e0d0; border-radius: 8px;
      font-size: 14px; background: #fff; color: #3a342c; font-family: inherit;
    }
    .cta button {
      padding: 12px; border: none; border-radius: 8px; background: #4a4036; color: #fff;
      font-size: 14px; cursor: pointer; font-family: inherit; font-weight: 600;
    }
    .cta .fine { font-size: 11px; color: #8a7f6f; text-align: center; }
    .foot { margin-top: 18px; font-size: 11px; color: #9c907b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <span class="eyebrow">🔥 限时公测 · 前 100 位用户享终身免费</span>
    <h1 class="headline">让 AI 在 <em>10 分钟</em> 内为你构建一个可用小程序</h1>
    <p class="sub">不用写代码，不用部署。只需描述你想要的功能，AI 自动生成可直接使用的网页应用——从待办清单到客户表单，从数据看板到个人主页，一切皆可一句话。</p>
    <div class="bullets">
      <div class="b"><div class="dot">1</div><div class="txt"><b>输入需求</b>——用自然语言描述你要的功能，比如"法律费用计算工具"。</div></div>
      <div class="b"><div class="dot">2</div><div class="txt"><b>AI 生成</b>——几十秒内生成完整的前端代码，实时预览效果。</div></div>
      <div class="b"><div class="dot">3</div><div class="txt"><b>直接使用</b>——生成结果就在你的工作台内，可分享、可修改。</div></div>
    </div>
    <div class="cta">
      <input type="email" placeholder="输入邮箱，获取优先体验资格" />
      <button id="join">立即加入公测</button>
      <div class="fine">✓ 无信用卡 · 随时取消 · 数据保存在本地</div>
    </div>
    <div class="foot">© 2026 BobWork Inc. · 所有产品与服务均符合本地数据隐私法规</div>
  </div>
  <script>
    document.getElementById('join').addEventListener('click', () => {
      const inp = document.querySelector('.cta input[type="email"]');
      if (!inp.value || !/@/.test(inp.value)) { inp.style.borderColor = '#a86060'; inp.focus(); return; }
      try { if (window.BobStorage && BobStorage.set) BobStorage.set('landing_email_' + Date.now(), inp.value); } catch {}
      const btn = document.getElementById('join'); btn.textContent = '✓ 已加入！稍后邮箱查收';
      btn.style.background = '#6b8e4e'; inp.value = '';
    });
  </script>
</body>
</html>`;

// ============================================================
// 文档阅读器（无需持久化）
// ============================================================

const READER_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .card { max-width: 520px; }
    .toolbar {
      display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
      padding: 10px 12px; background: #fbf9f4; border-radius: 8px;
      border: 1px solid #e8e0d0;
    }
    .toolbar .sp { flex: 1; }
    .toolbar label { font-size: 12px; color: #8a7f6f; }
    .toolbar select, .toolbar input[type="range"] {
      padding: 4px 8px; border: 1px solid #e8e0d0; border-radius: 6px;
      background: #fff; color: #4a4036; font-family: inherit; font-size: 12px;
    }
    .content {
      font-family: "Noto Serif SC", "PingFang SC", serif;
      line-height: 1.85; font-size: 16px; color: #3a342c;
    }
    .content h2 { font-size: 20px; margin: 24px 0 12px; color: #4a4036; }
    .content h3 { font-size: 17px; margin: 20px 0 10px; }
    .content p { margin-bottom: 14px; }
    .content blockquote {
      border-left: 3px solid #d9c9a3; padding: 4px 16px; color: #6b6152;
      background: #fbf9f4; margin: 14px 0; border-radius: 0 6px 6px 0;
    }
    .content ul, .content ol { margin: 10px 0 14px 24px; }
    .content li { margin-bottom: 6px; }
    .toc {
      background: #fbf9f4; padding: 14px 18px; border-radius: 8px;
      margin-bottom: 16px; border: 1px solid #e8e0d0;
    }
    .toc b { font-size: 12px; color: #8a7f6f; }
    .toc ol { margin: 8px 0 0 20px; font-size: 13px; color: #4a4036; }
    .toc a { color: #4a4036; text-decoration: none; }
    .toc a:hover { text-decoration: underline; }
    .progress {
      position: fixed; top: 0; left: 0; height: 3px; background: #d9c9a3;
      transition: width 0.1s;
    }
  </style>
</head>
<body>
  <div class="progress" id="progress"></div>
  <div class="card">
    <div class="toolbar">
      <label>字号</label>
      <input type="range" id="fs" min="13" max="22" value="16" />
      <span id="fsVal" style="font-size:12px;color:#8a7f6f">16px</span>
      <div class="sp"></div>
      <label>主题</label>
      <select id="theme">
        <option value="paper">宣纸</option>
        <option value="dark">护眼深色</option>
        <option value="sepia">褐色</option>
      </select>
    </div>
    <div class="toc">
      <b>📑 目录</b>
      <ol>
        <li><a href="#s1">什么是增量压缩？</a></li>
        <li><a href="#s2">为什么需要压缩？</a></li>
        <li><a href="#s3">硬事实抽取规则</a></li>
        <li><a href="#s4">小结</a></li>
      </ol>
    </div>
    <article class="content" id="content">
      <h2 id="s1">什么是增量压缩？</h2>
      <p>增量压缩（Incremental Compaction）是一种智能体长期记忆管理技术。与传统"每次全量重压"不同，增量压缩只处理 <b>memory_compacted_until 游标</b>之后的新增对话轮次，已压缩部分一旦冻结就不再进入压缩通道。</p>
      <blockquote>压十次和压一次的信息衰减相同，因此频率可以放到很短。——规格 v3 §四</blockquote>
      <h2 id="s2">为什么需要压缩？</h2>
      <p>大型语言模型的上下文窗口（Context Window）决定了单次推理能容纳的文本长度。无论是 128k 还是 1M，它终究是有限的。压缩解决两个问题：</p>
      <ol>
        <li>成本：将长上下文压缩为结构化摘要，避免每次推理都重新支付大量输入 token。</li>
        <li>聚焦：摘要中的 goal / settled / disputes / preferences 四类信息，帮助模型在后续对话中锚定关键决策点。</li>
      </ol>
      <h2 id="s3">硬事实抽取规则</h2>
      <p>为避免数字、日期等关键信息在压缩中漂移，硬事实（Hard Facts）由正则规则从原文直接抽取，写入 settled 时必须原文照抄，模型无权改写。抽取模式包括：</p>
      <ul>
        <li>日期：2026-07-31、2026/7/31、2026年7月31日</li>
        <li>金额：8000元、￥8,000、1.5万元、3亿元</li>
        <li>条款号：第三条、第 4.1 条、第2款</li>
        <li>文号编号：法释〔2020〕17号、（2021）最高法民终123号</li>
        <li>百分比：30%、18.4%</li>
      </ul>
      <h2 id="s4">小结</h2>
      <p>增量压缩是工程上权衡成本与质量的折中方案。通过冻结已压缩段、规则抽取硬事实，系统在保持信息密度的同时，最大程度降低了"转述的转述"带来的漂移风险。</p>
    </article>
  </div>
  <script>
    const fs = document.getElementById('fs'); const fsVal = document.getElementById('fsVal');
    const content = document.getElementById('content'); const theme = document.getElementById('theme');
    const progress = document.getElementById('progress');
    fs.addEventListener('input', () => { content.style.fontSize = fs.value + 'px'; fsVal.textContent = fs.value + 'px'; });
    theme.addEventListener('change', () => {
      const v = theme.value;
      if (v === 'paper') { document.body.style.background = '#faf8f3'; content.style.color = '#3a342c'; }
      if (v === 'dark')  { document.body.style.background = '#1c1a17'; content.style.color = '#d6cdb8'; }
      if (v === 'sepia') { document.body.style.background = '#f0e7d3'; content.style.color = '#3a342c'; }
    });
    window.addEventListener('scroll', () => {
      const h = document.documentElement;
      const pct = Math.min(100, (h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100);
      progress.style.width = pct + '%';
    });
  </script>
</body>
</html>`;

// ============================================================
// 单位换算器（无需持久化）
// ============================================================

const CONVERTER_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    .cats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
    .cat {
      padding: 6px 10px; border: 1px solid #e8e0d0; border-radius: 999px;
      background: #fff; font-size: 12px; cursor: pointer; color: #6b6152;
      font-family: inherit;
    }
    .cat.active { background: #d9c9a3; color: #3a342c; border-color: #c9bda6; }
    .conv { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; margin-bottom: 12px; }
    .conv .arr { color: #c9bda6; font-size: 18px; }
    .group { display: flex; flex-direction: column; gap: 6px; }
    .group select {
      padding: 8px 10px; border: 1px solid #e8e0d0; border-radius: 6px;
      font-size: 12px; background: #fbf9f4; color: #4a4036; font-family: inherit;
    }
    .group input {
      padding: 12px; border: 1px solid #e8e0d0; border-radius: 8px;
      font-size: 18px; background: #fff; color: #3a342c; font-family: inherit;
      font-variant-numeric: tabular-nums;
    }
    .hint { font-size: 11px; color: #8a7f6f; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>单位换算</h1>
    <div class="cats" id="cats"></div>
    <div class="conv">
      <div class="group">
        <select id="from"></select>
        <input type="number" id="a" value="1" />
      </div>
      <span class="arr">⇌</span>
      <div class="group">
        <select id="to"></select>
        <input type="number" id="b" />
      </div>
    </div>
    <p class="hint" id="formula">公式将在此显示</p>
  </div>
  <script>
    const UNITS = {
      length: { label: '长度', units: { m:1, km:1000, cm:0.01, mm:0.001, mi:1609.34, ft:0.3048, in:0.0254 } },
      weight: { label: '重量', units: { kg:1, g:0.001, mg:0.000001, t:1000, lb:0.453592 } },
      area:   { label: '面积', units: { m2:1, km2:1000000, ha:10000, mu:666.6667, ft2:0.092903 } },
      temp:   { label: '温度', special:'temp', units: { c:0, f:0, k:0 } },
      volume: { label: '体积', units: { L:1, mL:0.001, m3:1000, gal:3.785, floz:0.029574 } },
    };
    let cat = 'length';
    const catsEl = document.getElementById('cats');
    Object.keys(UNITS).forEach(k => {
      const b = document.createElement('button'); b.className = 'cat' + (cat === k ? ' active' : '');
      b.textContent = UNITS[k].label; b.onclick = () => { cat = k; render(); }; catsEl.appendChild(b);
    });
    const fromSel = document.getElementById('from'), toSel = document.getElementById('to');
    const aInp = document.getElementById('a'), bInp = document.getElementById('b');
    const formula = document.getElementById('formula');
    function render() {
      catsEl.querySelectorAll('.cat').forEach(b => b.classList.toggle('active', b.textContent === UNITS[cat].label));
      const names = Object.keys(UNITS[cat].units);
      fromSel.innerHTML = names.map(n => \`<option>\${n}</option>\`).join('');
      toSel.innerHTML = names.map((n,i) => \`<option\${i===1?' selected':''}>\${n}</option>\`).join('');
      compute();
    }
    function cvt(fromVal, f, t) {
      if (UNITS[cat].special === 'temp') {
        if (f === 'c' && t === 'f') return fromVal * 9/5 + 32;
        if (f === 'f' && t === 'c') return (fromVal - 32) * 5/9;
        if (f === 'c' && t === 'k') return fromVal + 273.15;
        if (f === 'k' && t === 'c') return fromVal - 273.15;
        if (f === 'f' && t === 'k') return (fromVal - 32) * 5/9 + 273.15;
        if (f === 'k' && t === 'f') return (fromVal - 273.15) * 9/5 + 32;
        return fromVal;
      }
      return fromVal * UNITS[cat].units[f] / UNITS[cat].units[t];
    }
    function compute() {
      const f = fromSel.value, t = toSel.value;
      const av = parseFloat(aInp.value);
      if (isNaN(av)) { bInp.value = ''; formula.textContent = ''; return; }
      const bv = cvt(av, f, t);
      bInp.value = Number.isInteger(bv) ? bv : (Math.round(bv * 1e8) / 1e8);
      formula.textContent = \`1 \${f} ≈ \${cvt(1,f,t)} \${t}\`;
    }
    aInp.addEventListener('input', compute); fromSel.addEventListener('change', compute); toSel.addEventListener('change', compute);
    bInp.addEventListener('input', () => {
      const f = fromSel.value, t = toSel.value;
      const bv = parseFloat(bInp.value);
      if (isNaN(bv)) { aInp.value = ''; return; }
      const av = cvt(bv, t, f);
      aInp.value = Number.isInteger(av) ? av : (Math.round(av * 1e8) / 1e8);
    });
    render();
  </script>
</body>
</html>`;

/**
 * 默认冒烟脚本（所有新小程序都会写入；模板自带 smoke-test.js 时不覆盖）。
 * 由 coding 节点用 interact_preview 执行：结果写 window.__testResult。
 */
export const SMOKE_TEST_JS = `/* Minimal smoke test — run via interact_preview (page global scope). */
window.__testResult = { ok: true, steps: [] };
try {
  var bodyText = (document.body.innerText || '').trim();
  window.__testResult.steps.push({ step: 'body-rendered', ok: bodyText.length > 0 });
  var primary = document.querySelector('button, [role="button"], input, textarea');
  if (primary) {
    primary.dispatchEvent(new Event('click', { bubbles: true }));
    window.__testResult.steps.push({ step: 'primary-interaction', ok: true });
  }
} catch (e) {
  window.__testResult.ok = false;
  window.__testResult.error = String(e);
}
window.__testResult.ok = window.__testResult.ok && window.__testResult.steps.every(function (s) { return s.ok; });
`;

const AI_CHAT_SMOKE_TEST = `window.__testResult = { ok: true, steps: [] };
try {
  var input = document.querySelector('#input');
  var send = document.querySelector('#send');
  var messages = document.querySelector('#messages');
  var model = document.querySelector('#model');
  window.__testResult.steps.push({ step: 'core-elements', ok: !!(input && send && messages && model) });
  if (input) {
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__testResult.steps.push({ step: 'input-accepts-text', ok: input.value === 'hello' });
  }
} catch (e) {
  window.__testResult.ok = false;
  window.__testResult.error = String(e);
}
window.__testResult.ok = window.__testResult.ok && window.__testResult.steps.every(function (s) { return s.ok; });
`;

const AI_CHAT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${PAPER_STYLE}
  <style>
    body { align-items: stretch; justify-content: stretch; padding: 0; background: var(--background, #faf8f3); }
    .bw-app { width: 100%; max-width: 720px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
    .bw-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line, #e8e0d0); background: var(--paper, #fff); }
    .bw-model { width: auto; min-width: 120px; max-width: 220px; padding: 6px 8px; font-size: 12px; }
    .bw-messages { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .bw-msg { display: flex; }
    .bw-msg.user { justify-content: flex-end; }
    .bw-bubble { max-width: 80%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: var(--paper, #fff); border: 1px solid var(--line, #e8e0d0); color: var(--ink, #3a342c); }
    .bw-msg.user .bw-bubble { background: var(--primary, #6b8e4e); border-color: var(--primary, #6b8e4e); color: var(--brand-on, #fff); }
    .bw-status { min-height: 16px; padding: 0 18px; font-size: 11px; color: var(--ink-muted, #8a7f6f); }
    .bw-compose { display: flex; gap: 8px; padding: 12px 18px 18px; border-top: 1px solid var(--line, #e8e0d0); background: var(--paper, #fff); }
    .bw-compose .bw-input { resize: none; max-height: 120px; }
  </style>
</head>
<body>
  <div class="bw-app">
    <header class="bw-head">
      <div>
        <h1 class="bw-title">AI Chat</h1>
        <p class="bw-muted">Streaming replies · model picker</p>
      </div>
      <select id="model" class="bw-input bw-model" aria-label="Model"></select>
    </header>
    <main id="messages" class="bw-messages" aria-live="polite"></main>
    <div id="status" class="bw-status"></div>
    <footer class="bw-compose">
      <textarea id="input" class="bw-input" rows="2" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send" class="bw-btn bw-btn-primary" type="button">Send</button>
    </footer>
  </div>
  <script>
  (function () {
    var messagesEl = document.getElementById('messages');
    var inputEl = document.getElementById('input');
    var sendEl = document.getElementById('send');
    var modelEl = document.getElementById('model');
    var statusEl = document.getElementById('status');
    var history = [];
    var busy = false;
    var selectedModel = '';
    try { selectedModel = BobStorage.get('selectedModel') || ''; } catch (e) {}

    function setStatus(text) { statusEl.textContent = text || ''; }
    function scroll() { messagesEl.scrollTop = messagesEl.scrollHeight; }
    function bubble(role, text) {
      var el = document.createElement('div');
      el.className = 'bw-msg ' + role;
      var inner = document.createElement('div');
      inner.className = 'bw-bubble';
      inner.textContent = text;
      el.appendChild(inner);
      messagesEl.appendChild(el);
      scroll();
      return inner;
    }
    function renderEmpty() {
      messagesEl.innerHTML = '';
      var empty = document.createElement('div');
      empty.className = 'bw-empty';
      empty.textContent = 'Ask anything — replies stream in.';
      messagesEl.appendChild(empty);
    }
    function loadModels() {
      if (typeof BobWork === 'undefined') {
        setStatus('Host bridge unavailable — configure a model first.');
        return;
      }
      BobWork.request('listConfiguredModels', {}).then(function (data) {
        var models = Array.isArray(data) ? data : ((data && data.models) || []);
        modelEl.innerHTML = '';
        var first = '';
        var preferred = '';
        models.forEach(function (m) {
          if (!m || !m.provider || !m.modelId) return;
          var value = m.provider + ':' + m.modelId;
          if (!first) first = value;
          if (!preferred && m.isDefault) preferred = value;
          var opt = document.createElement('option');
          opt.value = value;
          opt.textContent = (m.label || m.modelId) + (m.supportsVision ? ' · vision' : '');
          modelEl.appendChild(opt);
        });
        if (modelEl.options.length === 0) {
          selectedModel = '';
          setStatus('No model configured — add one in Manage Models.');
          return;
        }
        var match = false;
        for (var i = 0; i < modelEl.options.length; i++) {
          if (modelEl.options[i].value === selectedModel) match = true;
        }
        if (!match) selectedModel = preferred || first;
        modelEl.value = selectedModel;
      }).catch(function () {
        selectedModel = '';
        setStatus('Model list unavailable — configure a model first.');
      });
    }
    modelEl.addEventListener('change', function () {
      selectedModel = modelEl.value || '';
      try { BobStorage.set('selectedModel', selectedModel); } catch (e) {}
    });
    function send() {
      var text = (inputEl.value || '').trim();
      if (!text || busy) return;
      if (!selectedModel) { setStatus('Select a model first.'); return; }
      busy = true;
      sendEl.disabled = true;
      setStatus('');
      if (messagesEl.querySelector('.bw-empty')) messagesEl.innerHTML = '';
      bubble('user', text);
      history.push({ role: 'user', content: text });
      inputEl.value = '';
      var out = bubble('assistant', '…');
      var acc = '';
      var payload = { model: selectedModel, messages: history.slice(), maxTokens: 2048 };
      function done() {
        history.push({ role: 'assistant', content: acc });
        busy = false;
        sendEl.disabled = false;
        inputEl.focus();
        setStatus('');
      }
      function fail(e) {
        out.textContent = 'Model call failed: ' + (e && e.message ? e.message : String(e));
        setStatus('Request failed — check the model configuration.');
        busy = false;
        sendEl.disabled = false;
      }
      try {
        if (BobWork.chatStream) {
          var handle = BobWork.chatStream({
            model: payload.model,
            messages: payload.messages,
            maxTokens: payload.maxTokens,
            onDelta: function (delta) {
              acc += typeof delta === 'string' ? delta : (delta && delta.text) || '';
              out.textContent = acc || '…';
              scroll();
            }
          });
          handle.promise.then(done).catch(fail);
        } else {
          BobWork.request('chat', payload).then(function (res) {
            acc = (res && res.content) || '';
            out.textContent = acc || '(empty reply)';
            done();
          }).catch(fail);
        }
      } catch (e) { fail(e); }
    }
    sendEl.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    renderEmpty();
    loadModels();
  })();
  </script>
</body>
</html>`;

// ============================================================
// 注册
// ============================================================

export const APP_TEMPLATES: Record<SandboxTemplateId, SandboxTemplate> = {
  blank: {
    id: 'blank', label: 'Blank', description: '空白页，自由发挥',
    entry: 'index.html', files: { 'index.html': BLANK_TEMPLATE },
    promptSeed: { category: '其他（自定义）', interaction: '单页卡片式展示', persistence: '不需要，每次打开重新开始' },
  },
  'ai-chat': {
    id: 'ai-chat', label: 'AI Chat', description: '流式 AI 对话 + 模型选择 + 错误兜底',
    entry: 'index.html', files: { 'index.html': AI_CHAT_TEMPLATE, 'smoke-test.js': AI_CHAT_SMOKE_TEST },
    promptSeed: { category: 'AI 智能问答/内容生成', interaction: '对话式交互', persistence: '仅本次会话临时保存即可（用 BobStorage.set）' },
  },
  calculator: {
    id: 'calculator', label: 'Calculator', description: '带基础运算的实用计算器',
    entry: 'index.html', files: { 'index.html': CALCULATOR_TEMPLATE },
    promptSeed: { category: '计算/换算工具', interaction: '表单输入 + 结果展示', persistence: '不需要，每次打开重新开始' },
  },
  todo: {
    id: 'todo', label: '待办清单 Todo', description: '列表 + 增删改查 + 磁盘持久化',
    entry: 'index.html', files: { 'index.html': TODO_TEMPLATE },
    promptSeed: { category: '待办/任务管理', interaction: '列表 + 增删改查', persistence: '需要，历史记录/重要数据必须保留（用 BobStorage.save）' },
  },
  habit: {
    id: 'habit', label: '习惯打卡 Habit', description: '每日打卡 + 连续天数 + 持久化',
    entry: 'index.html', files: { 'index.html': HABIT_TEMPLATE },
    promptSeed: { category: '倒计时/打卡/习惯追踪', interaction: '列表 + 增删改查', persistence: '需要，历史记录/重要数据必须保留（用 BobStorage.save）' },
  },
  pomodoro: {
    id: 'pomodoro', label: '番茄钟 Pomodoro', description: '25/5/15 三档计时器 + 统计',
    entry: 'index.html', files: { 'index.html': POMODORO_TEMPLATE },
    promptSeed: { category: '倒计时/打卡/习惯追踪', interaction: '单页卡片式展示', persistence: '仅本次会话临时保存即可（用 BobStorage.set）' },
  },
  'contact-form': {
    id: 'contact-form', label: '联系表单 Form', description: '客户信息登记 + 历史记录持久化',
    entry: 'index.html', files: { 'index.html': FORM_TEMPLATE },
    promptSeed: { category: '表单填写与数据收集', interaction: '表单输入 + 结果展示', persistence: '需要，历史记录/重要数据必须保留（用 BobStorage.save）' },
  },
  'data-table': {
    id: 'data-table', label: '数据表格 Table', description: 'KPI 卡片 + 表格 + 进度条',
    entry: 'index.html', files: { 'index.html': TABLE_TEMPLATE },
    promptSeed: { category: '数据图表/大屏展示', interaction: '图表 + 可视化', persistence: '不需要，每次打开重新开始' },
  },
  portfolio: {
    id: 'portfolio', label: '个人主页 Portfolio', description: '头像 + 技能标签 + 链接卡片',
    entry: 'index.html', files: { 'index.html': PORTFOLIO_TEMPLATE },
    promptSeed: { category: '个人主页/作品集页', interaction: '单页卡片式展示', persistence: '不需要，每次打开重新开始' },
  },
  landing: {
    id: 'landing', label: '营销落地页 Landing', description: '头图 + 卖点列表 + CTA 邮箱收集',
    entry: 'index.html', files: { 'index.html': LANDING_TEMPLATE },
    promptSeed: { category: '营销/产品落地页', interaction: '单页卡片式展示', persistence: '仅本次会话临时保存即可（用 BobStorage.set）' },
  },
  reader: {
    id: 'reader', label: '文档阅读器 Reader', description: '字号/主题切换 + 阅读进度条 + 目录',
    entry: 'index.html', files: { 'index.html': READER_TEMPLATE },
    promptSeed: { category: '信息/文档阅读器', interaction: '单页卡片式展示', persistence: '不需要，每次打开重新开始' },
  },
  converter: {
    id: 'converter', label: '单位换算 Converter', description: '长度/重量/面积/温度/体积六类换算',
    entry: 'index.html', files: { 'index.html': CONVERTER_TEMPLATE },
    promptSeed: { category: '计算/换算工具', interaction: '表单输入 + 结果展示', persistence: '不需要，每次打开重新开始' },
  },
};

export const SANDBOX_TEMPLATE_LIST: SandboxTemplate[] = Object.values(APP_TEMPLATES);

/**
 * 模板默认图标（emoji）：新建小程序时由 createApp 写入 manifest，
 * 避免商店卡片/侧栏退回通用图标或名称首字母。
 */
export const SANDBOX_TEMPLATE_ICONS: Record<SandboxTemplateId, string> = {
  blank: '✨',
  'ai-chat': '🤖',
  calculator: '🧮',
  todo: '✅',
  habit: '🌱',
  pomodoro: '🍅',
  'contact-form': '📋',
  'data-table': '📊',
  portfolio: '👤',
  landing: '🚀',
  reader: '📖',
  converter: '🔁',
};
