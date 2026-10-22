/**
 * scripts/assemble-win-python.mjs —— 组装 Windows 随包嵌入式 Python
 *
 * 为什么需要（评估文档 §10.2-E「阶段 E」）：
 *   Windows 上没有系统 python3，而 BobWork 的 Office 模板填充 / Word 修订 / PDF 文本提取 /
 *   图片裁剪 / 表格重算都调 Python 脚本，并依赖 `python-docx` / `Pillow` / `lxml` 等第三方包。
 *   不能要求用户自己装 Python（版本、架构、包全都不受控），所以运行时必须随包分发。
 *
 * 交付形态：
 *   <target>/python.exe                          嵌入式解释器（官方 embeddable zip）
 *   <target>/python311._pth                      已改写：`Lib\site-packages` + `import site`
 *   <target>/Lib/site-packages/...               win_amd64 轮子解压后的纯文件（无需 pip）
 *   <target>/BOBWORK_PYTHON.json                 清单（版本 + 包 + 体积），供诊断与幂等复用
 *
 * 关键取舍：
 *   1. **不调用 pip**：CI 与开发机不一定有可用的 pip（Windows runner 上没有 `python`）。
 *      改为按固定清单从 PyPI 取轮子（`--only-binary` 的等价语义），解压即可用，
 *      版本与 sha256 还能写进清单做可复现构建。
 *   2. **轮子是 win_amd64（cp311）而不是宿主平台**：这是一次交叉组装，
 *      下载的是目标机要跑的二进制；绝不能用 `pip install` 把 mac 轮子装进来。
 *   3. **缺任何一个必需模块就失败**：装完能启动、但某个功能静默缺失，正是 Windows
 *      适配里最难排查的一类问题（用户只看到「模板填充没反应」）。
 *
 * 用法：
 *   node scripts/assemble-win-python.mjs                     # 默认输出 .build/python（随包资源）
 *   node scripts/assemble-win-python.mjs --target release/win-unpacked/resources/python
 *   node scripts/assemble-win-python.mjs --force             # 忽略清单，强制重装
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'win-python');

const PY_VERSION = '3.11.9';
const PY_TAG = '311';
const PY_ARCHIVE = `python-${PY_VERSION}-embed-amd64.zip`;
// python.org 优先，npmmirror 兜底（国内直连 python.org 常见 30s+ 或断流）
const PY_URLS = [
  `https://www.python.org/ftp/python/${PY_VERSION}/${PY_ARCHIVE}`,
  `https://registry.npmmirror.com/-/binary/python/${PY_VERSION}/${PY_ARCHIVE}`,
];

/**
 * 固定轮子清单（文件名即目标平台证据：cp311 / win_amd64 / py3-none-any）。
 *
 * 这些包覆盖应用当前所有会调 pythonBin 的路径：
 *   - python-docx + lxml      Word 修订 / Office 模板填充 / OOXML 校验
 *   - Pillow                  图片裁剪、截图处理
 *   - pdfplumber + pypdf       PDF 文本提取与表单
 *   - openpyxl / python-pptx   表格重算、幻灯片技能
 *   - defusedxml / PyYAML / six  上述包的运行时依赖
 *
 * 刻意未纳入的：PyMuPDF / opencv / pytesseract / pdf2image —— 它们要么体积过大，
 * 要么依赖外部可执行文件（tesseract / poppler），随包也无法真正跑通；
 * 相关技能在 Windows 上会以「模块缺失」显式失败，而不是静默返回空结果。
 */
const WHEELS = [
  ['python-docx', '1.2.0', 'python_docx-1.2.0-py3-none-any.whl'],
  ['lxml', '6.1.3', 'lxml-6.1.3-cp311-cp311-win_amd64.whl'],
  ['pillow', '13.0.0', 'pillow-13.0.0-cp311-cp311-win_amd64.whl'],
  ['typing-extensions', '4.16.0', 'typing_extensions-4.16.0-py3-none-any.whl'],
  ['openpyxl', '3.1.5', 'openpyxl-3.1.5-py2.py3-none-any.whl'],
  ['et-xmlfile', '2.0.0', 'et_xmlfile-2.0.0-py3-none-any.whl'],
  ['python-pptx', '1.0.2', 'python_pptx-1.0.2-py3-none-any.whl'],
  ['xlsxwriter', '3.2.9', 'xlsxwriter-3.2.9-py3-none-any.whl'],
  ['pypdf', '6.21.2', 'pypdf-6.21.2-py3-none-any.whl'],
  ['pdfplumber', '0.11.10', 'pdfplumber-0.11.10-py3-none-any.whl'],
  ['pdfminer-six', '20260107', 'pdfminer_six-20260107-py3-none-any.whl'],
  ['pypdfium2', '5.14.0', 'pypdfium2-5.14.0-py3-none-win_amd64.whl'],
  ['charset-normalizer', '3.5.2', 'charset_normalizer-3.5.2-cp311-cp311-win_amd64.whl'],
  ['cryptography', '50.0.2', 'cryptography-50.0.2-cp311-abi3-win_amd64.whl'],
  ['cffi', '2.1.1', 'cffi-2.1.1-cp311-cp311-win_amd64.whl'],
  ['pycparser', '3.11', 'pycparser-3.11-py3-none-any.whl'],
  ['defusedxml', '0.7.1', 'defusedxml-0.7.1-py2.py3-none-any.whl'],
  ['pyyaml', '6.0.3', 'pyyaml-6.0.3-cp311-cp311-win_amd64.whl'],
  ['six', '1.17.0', 'six-1.17.0-py2.py3-none-any.whl'],
];

/** 组装后必须存在的文件（相对 target）。少一个都说明「装得起来、功能缺一块」。 */
const MUST_EXIST = [
  'python.exe',
  `python${PY_TAG}.zip`,
  `python${PY_TAG}._pth`,
  'Lib/site-packages/docx/__init__.py',
  'Lib/site-packages/PIL/Image.py',
  'Lib/site-packages/lxml/etree.cp311-win_amd64.pyd',
  'Lib/site-packages/pdfplumber/__init__.py',
  'Lib/site-packages/openpyxl/__init__.py',
  'Lib/site-packages/pptx/__init__.py',
  'Lib/site-packages/pypdf/__init__.py',
];

const log = (m) => console.log(`[win-py] ${m}`);
const fail = (m) => {
  console.error(`[win-py] ❌ ${m}`);
  process.exit(1);
};

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const TARGET = path.resolve(argOf('target', path.join(ROOT, '.build', 'python')));
const FORCE = process.argv.includes('--force');
const MANIFEST = path.join(TARGET, 'BOBWORK_PYTHON.json');

/** 清单一致且关键文件都在 ⇒ 直接复用（出包是幂等的，重复跑不该再下载 40MB） */
function reusable() {
  if (FORCE) return false;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (m.python !== PY_VERSION) return false;
    if (m.wheels?.length !== WHEELS.length) return false;
    return MUST_EXIST.every((rel) => fs.existsSync(path.join(TARGET, rel)));
  } catch {
    return false;
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 用系统 curl 下载：Node 的 fetch 在本项目的网络环境里会稳定
 * `UND_ERR_CONNECT_TIMEOUT`（与 lib/net/download.ts 的选择同因，那里也统一走 curl）。
 */
function curlDownload(url, dest) {
  execFileSync(
    'curl',
    [
      '-L', '--fail', '--silent', '--show-error',
      '--retry', '3', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '30',
      '-A', 'BobWork',
      '-o', dest,
      url,
    ],
    { timeout: 300_000, stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

async function download(urls, dest, expectedBytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && (!expectedBytes || fs.statSync(dest).size === expectedBytes)) {
    log(`复用缓存 ${path.basename(dest)}`);
    return dest;
  }
  const list = Array.isArray(urls) ? urls : [urls];
  let last = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = list[attempt % list.length];
    const part = `${dest}.part`;
    try {
      curlDownload(url, part);
      const size = fs.statSync(part).size;
      if (expectedBytes && size !== expectedBytes) {
        throw new Error(`体积不符：${size} != ${expectedBytes}`);
      }
      fs.renameSync(part, dest);
      log(`已下载 ${path.basename(dest)}（${(size / 1048576).toFixed(1)} MB）`);
      return dest;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      fs.rmSync(`${dest}.part`, { force: true });
      log(`下载失败（${attempt + 1}/3）${url}: ${last.slice(0, 200)}`);
    }
  }
  throw new Error(`下载失败：${path.basename(dest)} —— ${last}`);
}

/** 从 PyPI JSON 取轮子的直链与 sha256（钉版本，不解析依赖） */
function wheelMeta(project, version, filename) {
  const url = `https://pypi.org/pypi/${project}/${version}/json`;
  const out = execFileSync(
    'curl',
    ['-sL', '--fail', '--retry', '3', '--retry-all-errors', '--connect-timeout', '30', url],
    { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 },
  ).toString();
  const data = JSON.parse(out);
  const hit = (data.urls || []).find((u) => u.filename === filename);
  if (!hit) throw new Error(`${project} ${version} 找不到轮子 ${filename}`);
  return { url: hit.url, sha256: hit.digests?.sha256, size: hit.size };
}

function extractZip(zipPath, destDir) {
  const require = createRequire(import.meta.url);
  const AdmZip = require('adm-zip');
  fs.mkdirSync(destDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(destDir, true);
}

async function main() {
  if (process.platform !== 'win32' && !process.env.BOBWORK_ALLOW_CROSS_PYTHON) {
    log(`交叉组装：宿主 ${process.platform} → 目标 win32-x64（轮子按 win_amd64 取）`);
  }

  if (reusable()) {
    log(`已是最新：${TARGET}（Version ${PY_VERSION}，${WHEELS.length} 个包）`);
    return;
  }

  log(`目标目录 ${TARGET}`);
  log(`Python ${PY_VERSION} embeddable amd64`);

  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });

  // ---- 1. 解释器本体 ----
  const pyZip = await download(PY_URLS, path.join(CACHE, PY_ARCHIVE), 11_249_023);
  extractZip(pyZip, TARGET);

  // ---- 2. 打开 site-packages（embeddable 默认关闭 site，第三方包会被完全忽略）----
  const pth = path.join(TARGET, `python${PY_TAG}._pth`);
  if (!fs.existsSync(pth)) fail(`解压后没有 python${PY_TAG}._pth（归档结构变了？）`);
  fs.writeFileSync(
    pth,
    [`python${PY_TAG}.zip`, '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'),
  );
  log('已改写 ._pth：Lib\\site-packages + import site');

  // ---- 3. 轮子 → Lib/site-packages（纯解压，无需 pip / 无需运行 python.exe）----
  const sitePackages = path.join(TARGET, 'Lib', 'site-packages');
  fs.mkdirSync(sitePackages, { recursive: true });
  const installed = [];
  for (const [project, version, filename] of WHEELS) {
    const meta = await wheelMeta(project, version, filename);
    const dest = path.join(CACHE, filename);
    await download(meta.url, dest, meta.size);
    if (meta.sha256) {
      const actual = sha256(dest);
      if (actual !== meta.sha256) fail(`${filename} sha256 不符：${actual} != ${meta.sha256}`);
    }
    extractZip(dest, sitePackages);
    installed.push({ name: project, version, file: filename, sha256: meta.sha256 });
    log(`  ✓ ${project} ${version}`);
  }

  // ---- 4. 清单 ----
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        python: PY_VERSION,
        arch: 'win-x64',
        builtAt: new Date().toISOString(),
        wheels: installed,
        note: '由 scripts/assemble-win-python.mjs 生成；不要手工改，重新生成会覆盖',
      },
      null,
      2,
    ) + '\n',
  );

  // ---- 5. 自检 ----
  const missing = MUST_EXIST.filter((rel) => !fs.existsSync(path.join(TARGET, rel)));
  if (missing.length) fail(`组装后缺文件：${missing.join(', ')}`);

  const bytes = (function size(dir) {
    let total = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      total += ent.isDirectory() ? size(p) : fs.statSync(p).size;
    }
    return total;
  })(TARGET);

  log(`✅ 完成：${MUST_EXIST.length} 项自检通过，${(bytes / 1048576).toFixed(1)} MB → ${TARGET}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
