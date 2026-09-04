const TOKEN = process.env.GC_TOKEN;
const API = 'https://api.gitcode.com/api/v5';
const OWNER = 'baolei89';
const REPO = 'BobWork';
const MODE = process.env.MODE || 'list';
const KEEP_COUNT = parseInt(process.env.KEEP || '3');
const ONLY_TAG = process.env.ONLY_TAG || '';

if (!TOKEN) { console.error('GC_TOKEN missing'); process.exit(1); }

const https = require('https');

function req(opt, postData, followRedirect) {
  return new Promise((resolve, reject) => {
    const u = new URL(opt.url || (API + opt.path));
    const headers = Object.assign({ Accept: 'application/json' }, opt.headers || {});
    if (postData) headers['Content-Type'] = 'application/json';
    const o = {
      method: opt.method || 'GET',
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers,
    };
    const r = https.request(o, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        if (followRedirect && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308)) {
          const loc = res.headers.location;
          if (loc) {
            try {
              const redirectUrl = new URL(loc, u.origin);
              const redirectOpt = {
                method: res.statusCode === 303 ? 'GET' : opt.method,
                url: redirectUrl.toString(),
                headers: opt.headers || {},
              };
              resolve(await req(redirectOpt, null, false));
              return;
            } catch (e) { /* fall through */ }
          }
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          try {
            const cleaned = data.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            resolve({ status: res.statusCode, body: JSON.parse(cleaned) });
          } catch (e2) {
            resolve({ status: res.statusCode, body: null, raw: data, parseErr: e2.message });
          }
        }
      });
    });
    r.on('error', reject);
    if (postData) r.write(JSON.stringify(postData));
    r.end();
  });
}

async function listAll() {
  const seen = new Set();
  const releases = [];
  for (let page = 1; page <= 15; page++) {
    const r = await req({ path: `/repos/${OWNER}/${REPO}/releases?access_token=${TOKEN}&limit=100&page=${page}` });
    if (!Array.isArray(r.body) || r.body.length === 0) break;
    for (const it of r.body) {
      if (seen.has(it.tag_name)) continue;
      seen.add(it.tag_name);
      releases.push({
        tag: it.tag_name,
        created: (it.created_at || '').slice(0, 10),
        status: it.release_status || 'none',
        attachCount: (it.assets || []).filter(a => a.type === 'attach').length,
      });
    }
    if (r.body.length < 100) break;
  }
  releases.sort((a, b) => {
    const av = a.tag.replace(/^v/, '').split('.').map(Number);
    const bv = b.tag.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      if ((bv[i] || 0) !== (av[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
    }
    return 0;
  });
  return releases;
}

async function deleteByTag(tag) {
  const attempts = [];
  const variants = [
    { base: API, path: `/repos/${OWNER}/${REPO}/releases/tags/${tag}?access_token=${TOKEN}`, follow: true },
    { base: API, path: `/repos/${OWNER}/${REPO}/releases/${tag}?access_token=${TOKEN}`, follow: true },
    {
      base: 'https://api.gitcode.com',
      path: `/repos/${OWNER}/${REPO}/releases/tags/${tag}`,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
      follow: true,
    },
    {
      base: 'https://api.gitcode.com',
      path: `/repos/${OWNER}/${REPO}/releases/${tag}`,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
      follow: true,
    },
    {
      base: 'https://www.gitcode.com',
      path: `/api/v5/repos/${OWNER}/${REPO}/releases/tags/${tag}?access_token=${TOKEN}`,
      follow: true,
    },
    {
      base: 'https://www.gitcode.com',
      path: `/api/v5/repos/${OWNER}/${REPO}/releases/${tag}?access_token=${TOKEN}`,
      follow: true,
    },
  ];
  for (const v of variants) {
    const r = await req({
      method: 'DELETE',
      url: v.base ? (v.base + v.path) : undefined,
      path: v.base ? undefined : v.path,
      headers: v.headers || {},
    }, null, v.follow);
    attempts.push({
      url: (v.base ? v.base : API) + v.path,
      status: r.status,
      body: typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 300) : String(r.body || '').slice(0, 300),
    });
    if (r.status === 200 || r.status === 204 || r.status === 201) {
      return { tag, status: r.status, body: r.body, attempts };
    }
  }
  return { tag, status: attempts[attempts.length - 1].status, attempts };
}

(async () => {
  const releases = await listAll();

  if (MODE === 'list') {
    console.log(`共 ${releases.length} 个去重 Release（按版本倒序，最新在前）：`);
    for (let i = 0; i < releases.length; i++) {
      const r = releases[i];
      const keep = i < KEEP_COUNT ? ' [KEEP]' : '';
      console.log(`  ${String(i + 1).padStart(3)}. ${r.tag.padEnd(12)} | ${r.created} | status=${r.status.padEnd(7)} | ${r.attachCount} attach${keep}`);
    }
    console.log(`\n> 默认保留最新 KEEP=3 个（可通过环境变量 KEEP=N 调整）`);
    console.log('> 用法示例：');
    console.log('  GC_TOKEN=xxx MODE=list KEEP=5   node scripts/gc_release.js    # 打印列表，保留最新 5');
    console.log('  GC_TOKEN=xxx MODE=delete KEEP=3 node scripts/gc_release.js  # 删除，保留最新 3');
    console.log('  GC_TOKEN=xxx MODE=delete ONLY_TAG=v1.3.45 node scripts/gc_release.js  # 只删除指定 tag');
    process.exit(0);
  }

  if (MODE === 'delete') {
    let targets;
    if (ONLY_TAG) {
      targets = releases.filter(r => r.tag === ONLY_TAG);
      if (targets.length === 0) { console.log(`未找到 tag=${ONLY_TAG}`); process.exit(1); }
    } else {
      targets = releases.slice(KEEP_COUNT);
    }
    console.log(`将删除 ${targets.length} 个 Release：${targets.map(t => t.tag).join(', ')}`);
    for (const t of targets) {
      const r = await deleteByTag(t.tag);
      const attemptsStr = r.attempts ? r.attempts.map(a => `(${a.status})${a.url.slice(0,70)}`).join(' | ') : '';
      console.log(`  DELETE ${t.tag}  -> HTTP ${r.status}`);
      if (r.status !== 200 && r.status !== 204) {
        console.log(`    attempts: ${attemptsStr}`);
        if (r.attempts && r.attempts.length > 0) {
          const lastBody = r.attempts[r.attempts.length - 1].body;
          if (lastBody) console.log(`    last_body: ${lastBody}`);
        }
      }
    }
    const remain = await listAll();
    console.log(`\n删除后剩余 ${remain.length} 个 Release：`);
    for (const r of remain) console.log(`  ${r.tag.padEnd(12)} | ${r.created} | status=${r.status}`);
    process.exit(0);
  }

  console.error('Unknown MODE:', MODE);
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
