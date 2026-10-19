/**
 * lib/python/diagnostics — 把「Python 侧失败」翻译成用户能照做的处置
 *
 * 为什么单独一个模块：Python 的报错是**给人看的**，但它看的是「装 Python 的人」，
 * 不是 BobWork 的用户。三种最常见的情况，用户看到的原文与真因完全是两件事：
 *
 *   原文：`ModuleNotFoundError: No module named 'docx'`
 *   真因：BobWork 的 Python 依赖没装（或装到了另一个解释器里）。用户会去搜「docx 安装失败」。
 *
 *   原文：`'python' is not recognized as an internal or external command`
 *   真因：这台机器没有 Python。用户看到的是「命令不存在」，不知道自己缺什么。
 *
 *   原文：`UnicodeEncodeError: 'gbk' codec can't encode character`
 *   真因：Windows 控制台代码页 936。看起来像「文件坏了」。
 *
 * 本模块只做**纯字符串判断**（不 spawn、不读盘），所以能在两个平台上跑同一批单测 ——
 * 判断逻辑必须在 Windows 上验一次，否则又是一堆「按 mac 的经验写的 if」。
 */

import { IS_WIN } from '@/lib/platform';

export type PythonFailureKind =
  | 'missing-module'
  | 'missing-interpreter'
  | 'encoding'
  | 'permission'
  | 'syntax'
  | 'unknown';

export interface PythonFailure {
  kind: PythonFailureKind;
  /** 缺失的模块名（`missing-module` 才有；**导入名**，不是 pip 名） */
  moduleName?: string;
  /** 对应的 pip 包名（两者常常不同：docx→python-docx、PIL→Pillow） */
  pipName?: string;
  /** 可直接展示给用户的一句话处置 */
  hint: string;
}

/**
 * import 名 → pip 名。只收 BobWork 实际用到的（见 `pkg-usage.ts` 的 PROTECTED_PACKAGES），
 * 以及几个最容易搞错的。这张表写错的代价是「让用户装一个不存在的包」，
 * 所以拿不准的一律不映射，回落到同名。
 */
const PIP_NAME_BY_MODULE: Record<string, string> = {
  docx: 'python-docx',
  pptx: 'python-pptx',
  PIL: 'Pillow',
  fitz: 'PyMuPDF',
  cv2: 'opencv-contrib-python',
  yaml: 'PyYAML',
};

/** 从任意错误对象里抽出可判断的文本（stderr 优先：Node 的 e.message 只是 "Command failed: …"） */
function textOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';
  const o = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['stderr', 'stdout', 'message']) {
    const v = o[key];
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') {
      // execFile 的 stderr 在某些包装下是 Buffer
      const buf = v as { toString?: () => string };
      if (typeof buf.toString === 'function') parts.push(bindSafe(buf));
    }
  }
  if (typeof o.code === 'string') parts.push(o.code);
  return parts.join('\n');
}

function bindSafe(buf: { toString?: () => string }): string {
  try {
    return String(buf.toString?.() ?? '');
  } catch {
    return '';
  }
}

/** 当前平台给用户看的解释器名字（只用于提示，不做解析） */
function interpreterLabel(): string {
  return IS_WIN ? '%LOCALAPPDATA%\\BobWork\\python\\python.exe' : 'python3';
}

/**
 * 判断一次 Python 执行失败的性质，并给出可照做的处置。
 *
 * 返回 `null` 表示「与 Python 环境无关」（例如脚本自己返回了业务错误码），
 * 调用方应当原样透出原始错误 —— **不要**给所有失败都套一层 hint，
 * 那会让真正的脚本 bug 被「请安装依赖」盖住。
 */
export function describePythonFailure(err: unknown, opts: { usedBy?: string } = {}): PythonFailure | null {
  const text = textOf(err);
  if (!text.trim()) return null;
  const usedBy = opts.usedBy ? `（${opts.usedBy}）` : '';

  // ① 缺模块。两种写法：Python 3 的 `ModuleNotFoundError: No module named 'x'`，
  //    以及 pip 报的 `ImportError: No module named x`（老式写法，无引号）
  const mod = text.match(/No module named\s+['"]?([A-Za-z_][\w.]*)['"]?/);
  if (mod) {
    const moduleName = mod[1].split('.')[0];
    const pipName = PIP_NAME_BY_MODULE[moduleName] ?? moduleName;
    return {
      kind: 'missing-module',
      moduleName,
      pipName,
      hint:
        `缺少 Python 依赖 ${pipName}${usedBy}。安装：` +
        `"${interpreterLabel()}" -m pip install ${pipName}` +
        (IS_WIN
          ? '（若用的是系统 Python，把引号里换成 python.exe 的实际路径）'
          : '（若报 externally-managed-environment，加 --user 或改用 venv）'),
    };
  }

  // ② 连解释器都没有。三种措辞分别来自 POSIX shell、Windows cmd、Node 的 ENOENT
  if (
    /command not found|is not recognized as an internal or external command|^ENOENT$|\bENOENT\b|spawn .* ENOENT/i.test(
      text,
    )
  ) {
    return {
      kind: 'missing-interpreter',
      hint: IS_WIN
        ? `这台机器上没有可用的 Python 解释器${usedBy}。Windows 版应从随包目录 ` +
          `%LOCALAPPDATA%\\BobWork\\python\\python.exe 取解释器；若该目录不存在，说明安装不完整（重装或修复安装）。`
        : `这台机器上没有可用的 Python 解释器${usedBy}。先跑 \`xcode-select --install\`（自带 python3），` +
          `或用 Homebrew 装 python@3.12。`,
    };
  }

  // ③ 编码。Windows 控制台默认 936（GBK），中文路径/输出会在这里炸。
  //    出现它说明子进程没拿到 PYTHONUTF8 / PYTHONIOENCODING —— 是环境注入的问题，不是用户的文件坏了。
  if (/UnicodeEncodeError|UnicodeDecodeError|'gbk' codec|codec can't (encode|decode)/i.test(text)) {
    return {
      kind: 'encoding',
      hint:
        `Python 子进程的编码与系统代码页不一致${usedBy}。` +
        (IS_WIN
          ? '正常情况下主进程会注入 PYTHONUTF8=1 / PYTHONIOENCODING=utf-8；出现此错说明注入没生效，' +
            '请把这条报错原样反馈（含触发它的文件路径）。'
          : '请确认环境的 LANG / LC_ALL 已设置（例如 zh_CN.UTF-8）。'),
    };
  }

  // ④ 权限
  if (/PermissionError|EACCES|EPERM|Access is denied/i.test(text)) {
    return {
      kind: 'permission',
      hint:
        `Python 进程没有权限读写目标文件${usedBy}。` +
        (IS_WIN
          ? '常见于「文件被 Word/WPS 占用」或位于受保护目录；关闭占用程序或换到用户目录再试。'
          : '检查文件权限与「文件是否被其他程序占用」。'),
    };
  }

  // ⑤ 解释器版本与脚本不匹配（嵌入了旧解释器时会以这种面目出现）
  if (/SyntaxError: .*(f-string|invalid syntax|unexpected)/i.test(text)) {
    return {
      kind: 'syntax',
      hint: `脚本语法与解释器版本不匹配${usedBy}。这通常意味着取到的不是随包解释器，而是系统里一个更旧的 python。`,
    };
  }

  return null;
}
