/**
 * Python 包生命周期管理（TS 侧）
 *
 * 目标：AI 通过 run_command 按需安装的第三方包，若超过 30 天未被任何 python 脚本
 * import，自动卸载，防止 site-packages 无限膨胀。
 *
 * 机制（三件套）：
 *   1. recordPipInstall —— pip 安装成功后，把包名 + 安装日期写入台账
 *      （~/.bob-pkg-usage.json，位于 user site-packages 内）；
 *   2. usercustomize.py —— 写入 user site-packages 的导入追踪钩子，每次 python 运行
 *      记录顶层模块最近使用日期到同一台账；
 *   3. runAutoCleanup —— 服务启动时（24h 门控）调用 py-pkg-lifecycle.py purge，
 *      判定并卸载「安装 >30 天 且 未使用 >30 天 且 不在保护名单」的包。
 *
 * 安全边界：
 *   - 只清理台账中有 installed 日期（确认由 AI 安装）的包，用户手动装的永不删；
 *   - PROTECTED 名单（BobWork 自身依赖）永不删；
 *   - usercustomize.py 以"追加 + 标记"方式合并，不覆盖用户已有的自定义文件；
 *   - 所有失败静默降级，绝不影响 run_command 正常执行。
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PY_VERSION = '3.9';
const PY_SITE = path.join(os.homedir(), 'Library', 'Python', PY_VERSION, 'lib', 'python', 'site-packages');
const LEDGER_PATH = path.join(PY_SITE, '.bob-pkg-usage.json');
const HOOK_PATH = path.join(PY_SITE, 'usercustomize.py');
const HOOK_MARK = 'BOBWORK-PKG-USAGE';

/** 清理阈值：未使用天数 */
export const CLEANUP_DAYS = 30;
/** 清理频率门控：距上次清理不足该毫秒数则跳过 */
const CLEANUP_INTERVAL_MS = 24 * 3600 * 1000;

/** BobWork 代码 / 技能实际依赖的包：永不自动删除（安装名统一小写） */
export const PROTECTED_PACKAGES = [
  'pip', 'setuptools', 'wheel',
  'pypdf', 'pypdf2', 'pdfplumber', 'pdfminer.six', 'pymupdf', 'pdf2image', 'pypdfium2',
  'pillow', 'numpy', 'scipy', 'opencv-contrib-python',
  'python-docx', 'python-pptx', 'defusedxml', 'lxml', 'openpyxl', 'reportlab',
  'openai', 'anthropic',
];

/**
 * 导入追踪钩子（usercustomize.py）源码。
 * 放在 user site-packages，python 解释器每次启动自动加载。
 * 必须绝对安全：任何异常都会被吞掉，绝不能影响正常 python 运行。
 */
const HOOK_SRC = `# -*- coding: utf-8 -*-
# ${HOOK_MARK} - BobWork 包使用追踪（自动生成，勿手改；追加合并，不影响其他工具）
# 记录每个顶层模块最近一次被 import 的日期，供「超过30天未使用的包自动清理」判定。
import sys, os, json, time, threading

_LEDGER = os.path.join(os.path.expanduser("~"), "Library", "Python", "3.9", "lib", "python", "site-packages", ".bob-pkg-usage.json")
_TODAY = time.strftime("%Y-%m-%d")
_LOCK = threading.Lock()
_WRITTEN = set()

def _record(top):
    try:
        if not top or top in _WRITTEN:
            return
        with _LOCK:
            if top in _WRITTEN:
                return
            data = {}
            try:
                with open(_LEDGER, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    data = {}
            except Exception:
                data = {}
            entry = data.get(top)
            if isinstance(entry, dict) and entry.get("lastUsed") == _TODAY:
                _WRITTEN.add(top)
                return
            if isinstance(entry, dict):
                entry["lastUsed"] = _TODAY
            else:
                entry = {"lastUsed": _TODAY}
            data[top] = entry
            _tmp = _LEDGER + ".tmp"
            with open(_tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(_tmp, _LEDGER)
            _WRITTEN.add(top)
    except Exception:
        pass

class _SpyFinder(object):
    def find_spec(self, name, path=None, target=None):
        try:
            _record(name.split(".")[0])
        except Exception:
            pass
        return None
    def find_module(self, name, path=None):
        try:
            _record(name.split(".")[0])
        except Exception:
            pass
        return None

if not any(isinstance(m, _SpyFinder) for m in sys.meta_path):
    try:
        sys.meta_path.insert(0, _SpyFinder())
    except Exception:
        pass
`;

interface Ledger {
  _meta?: {
    lastCleanup?: string;
    lastRemoved?: string[];
  };
  [key: string]: unknown;
}

/** 脚本目录：standalone 模式在 scripts/，dev 模式在 src/lib/python/（与 PDF 脚本同一套约定） */
function getScriptsDir(): string {
  const standaloneDir = path.join(process.cwd(), 'scripts');
  const devDir = path.join(process.cwd(), 'src', 'lib', 'python');
  try {
    fs.accessSync(path.join(standaloneDir, 'py-pkg-lifecycle.py'));
    return standaloneDir;
  } catch {
    /* fallthrough */
  }
  try {
    fs.accessSync(path.join(devDir, 'py-pkg-lifecycle.py'));
    return devDir;
  } catch {
    /* fallthrough */
  }
  return devDir;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLedger(): Ledger {
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeLedger(data: Ledger): void {
  try {
    const tmp = `${LEDGER_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, LEDGER_PATH);
  } catch {
    /* 忽略 */
  }
}

/**
 * 安装/合并导入追踪钩子。
 * 若已有 usercustomize.py（用户或其他工具自备），在其末尾追加我们的代码块，
 * 绝不整体覆盖。返回是否就绪。
 */
export function ensureUsageHook(): boolean {
  try {
    fs.mkdirSync(PY_SITE, { recursive: true });
    if (fs.existsSync(HOOK_PATH)) {
      const existing = fs.readFileSync(HOOK_PATH, 'utf8');
      if (existing.includes(HOOK_MARK)) return true;
      // 追加合并（以用户已有内容为前缀）
      fs.writeFileSync(HOOK_PATH, `${existing}\n\n${HOOK_SRC}`, 'utf8');
      return true;
    }
    fs.writeFileSync(HOOK_PATH, HOOK_SRC, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 pip install 命令中解析出包名列表。
 * 支持：pip install a b --flag、-r requirements.txt、版本约束（a>=2.0 取 a）。
 */
export function parseInstallPackages(cmd: string): string[] {
  const m = cmd.match(/(pip3?|pipx|python3? -m pip)\s+([^\n]*)/i);
  if (!m) return [];
  const rest = m[2];
  const im = rest.match(/\binstall\b/i);
  if (!im || im.index === undefined) return [];
  const args = rest.slice(im.index + im[0].length).trim();
  const tokens = args.split(/\s+/).filter(Boolean);
  const pkgs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // 需求文件：pip install -r requirements.txt（读文件取包名，版本约束去掉）
    if (/^(-r|--requirement|-c|--constraint)$/i.test(tok) && tokens[i + 1]) {
      const reqFile = tokens[++i];
      try {
        const content = fs.readFileSync(reqFile, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const name = trimmed.split(/[<>=!~;[\s]/)[0].trim();
          if (name && !name.startsWith('-')) pkgs.push(name);
        }
      } catch {
        /* 读不到需求文件则跳过（保守：未记账的包不会被自动删） */
      }
      continue;
    }
    if (tok.startsWith('-')) {
      // 跳过带值参数：-i/--index-url/--extra-index-url/-t/--target 等
      const takesValue = /^(-i|--index-url|--extra-index-url|-t|--target|--python-version|--platform|--find-links|-f|--proxy)$/i;
      if (takesValue.test(tok) && tokens[i + 1]) i++;
      continue;
    }
    // 去掉版本约束 a>=2.0 / a==1.0
    const name = tok.split(/[<>=!~;[]/)[0].trim();
    if (name && !name.startsWith('#')) pkgs.push(name);
  }
  return [...new Set(pkgs)];
}

/**
 * pip 安装成功后记账：包名 -> installed(当天)。
 * 调用方在 run_command 执行成功路径调用；失败静默，不影响命令结果。
 */
export function recordPipInstall(cmd: string): void {
  try {
    if (!/(pip3?|pipx|python3? -m pip)\s+.*\binstall\b/i.test(cmd)) return;
    const pkgs = parseInstallPackages(cmd);
    if (pkgs.length === 0) return;
    if (!ensureUsageHook()) return;
    const data = readLedger();
    const t = today();
    let changed = false;
    for (const p of pkgs) {
      const key = p.toLowerCase();
      const cur = data[key];
      const entry = cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : {};
      if (entry.installed === t) continue;
      entry.installed = t;
      data[key] = entry;
      changed = true;
    }
    if (changed) writeLedger(data);
  } catch {
    /* 忽略 */
  }
}

/**
 * 自动清理入口：24h 门控 + 调用 python 清理脚本。
 * 供 instrumentation 服务启动时调用；内部全部 try/catch，失败不影响启动。
 */
export async function runAutoCleanup(): Promise<void> {
  try {
    ensureUsageHook();
    const data = readLedger();
    const last = data._meta?.lastCleanup;
    if (last) {
      const dt = new Date(last);
      if (!Number.isNaN(dt.getTime()) && Date.now() - dt.getTime() < CLEANUP_INTERVAL_MS) {
        return; // 24h 内已清理过
      }
    }
    const script = path.join(getScriptsDir(), 'py-pkg-lifecycle.py');
    if (!fs.existsSync(script)) return;
    const { stdout } = await execFileAsync(
      'python3',
      [script, 'purge', '--days', String(CLEANUP_DAYS), '--protected', PROTECTED_PACKAGES.join(',')],
      { timeout: 180_000 },
    );
    console.log('[py-cleanup]', stdout.trim());
  } catch (e) {
    console.error('[py-cleanup] 失败:', e instanceof Error ? e.message : String(e));
  }
}
