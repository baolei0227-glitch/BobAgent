/**
 * scripts/after-pack-win-slim.cjs —— electron-builder afterPack 钩子：裁剪 Windows 包的 app/node_modules
 *
 * 为什么需要（2026-10-24 实测）：
 *   electron-builder 会把 package.json 的全部 production 依赖收进 resources/app，
 *   而主进程（electron/dist/main.js）实际只 require 两个外部包：
 *     adm-zip、electron-updater
 *   其余 next / @next/swc-darwin-arm64 / mermaid / echarts / pdfjs-dist / @napi-rs/canvas…
 *   全是**服务端**依赖，它们在 resources/next-standalone 里已经有一份。
 *
 *   后果不是功能问题，而是安装极慢：
 *     - resources/app：948 MB / 32170 个文件（整包 37421 个文件、1.06 GB 待解压）
 *     - NSIS 逐文件写盘 + Windows Defender 逐文件实时扫描 ⇒ 用户感知「装了半天」
 *   裁掉后 app 只剩 ~50 MB / 几百个文件，安装时间随文件数线性下降。
 *
 * 判据是代码证据：对 electron/dist/main.js + preload.js 里所有字面量 require 做统计，
 * 外部 specifier 只有 adm-zip / electron-updater / electron（见下方 verifySeeds）。
 * 若将来主进程引入新的外部包，这里会在 afterPack 阶段直接失败，而不是装完才崩。
 *
 * ⚠️ 只裁 resources/app，不动 next-standalone（那是服务端运行时，依赖闭包由 Next 追踪）。
 */
const fs = require('fs');
const path = require('path');
const { createRequire, builtinModules } = require('module');

const SEEDS = ['adm-zip', 'electron-updater'];
const BUILTINS = new Set(builtinModules);

/** 读取包名 → package.json（扁平布局；scoped 包按 @scope/name 处理） */
function readPkg(appNm, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appNm, name, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function exists(appNm, name) {
  return fs.existsSync(path.join(appNm, name, 'package.json'));
}

function depNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ].filter((n) => !BUILTINS.has(n) && !n.startsWith('node:'));
}

function prune(appNm) {
  const keep = new Set();
  const queue = [...SEEDS];
  while (queue.length) {
    const name = queue.shift();
    if (keep.has(name)) continue;
    if (!exists(appNm, name)) continue;
    keep.add(name);
    const pkg = readPkg(appNm, name);
    if (!pkg) continue;
    for (const dep of depNames(pkg)) {
      // 传递依赖可能被 pnpm 放在包自己的 node_modules 下（保留父包即可，
      // 这里只在顶层存在同名包时才需要单独保留）
      if (exists(appNm, dep)) queue.push(dep);
    }
  }

  let removedDirs = 0;
  let removedFiles = 0;
  const countFiles = (dir) => {
    let n = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
      else n += 1;
    }
    return n;
  };

  for (const ent of fs.readdirSync(appNm, { withFileTypes: true })) {
    const full = path.join(appNm, ent.name);
    if (ent.name.startsWith('.')) continue; // .bin / .modules.yaml 等，体积极小
    if (ent.name.startsWith('@')) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        const name = `${ent.name}/${sub.name}`;
        if (keep.has(name)) continue;
        const target = path.join(full, sub.name);
        removedFiles += sub.isDirectory() ? countFiles(target) : 1;
        fs.rmSync(target, { recursive: true, force: true });
        removedDirs += 1;
      }
      if (fs.readdirSync(full).length === 0) fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    if (keep.has(ent.name)) continue;
    removedFiles += ent.isDirectory() ? countFiles(full) : 1;
    fs.rmSync(full, { recursive: true, force: true });
    removedDirs += 1;
  }
  return { keep, removedDirs, removedFiles };
}

/**
 * 裁完立刻验证：两个种子必须仍能 resolve。
 * 只判目录存在不够 —— pnpm 的依赖可能在包内嵌套，裁掉父级同名包后仍要能解析。
 */
function verifySeeds(appNm) {
  const req = createRequire(path.resolve(appNm, '__verify__.js'));
  const bad = SEEDS.filter((name) => {
    try {
      req.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  if (bad.length) {
    throw new Error(`[win-slim] 裁剪后仍无法解析：${bad.join(', ')}（主进程启动会直接失败）`);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const appNm = path.resolve(context.appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(appNm)) {
    console.log('[win-slim] 没有 resources/app/node_modules，跳过');
    return;
  }

  const before = fs.readdirSync(appNm).length;
  const { keep, removedDirs, removedFiles } = prune(appNm);
  verifySeeds(appNm);

  console.log(
    `[win-slim] app/node_modules 裁剪完成：保留 ${keep.size} 个包（顶层 ${before} → ${fs.readdirSync(appNm).length}），` +
      `删除 ${removedDirs} 个目录 / ${removedFiles} 个文件`,
  );
};
