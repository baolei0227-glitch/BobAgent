#!/usr/bin/env node
/**
 * scripts/check-pm.mjs — 包管理器守卫（替代 `npx only-allow pnpm`）
 *
 * 为什么不能继续用 `npx only-allow pnpm`：
 *   1. `preinstall` 在**依赖安装之前**运行，此时 node_modules 还不存在
 *      ⇒ `node node_modules/only-allow/bin.js` 在干净 clone 上必然 ENOENT，
 *      这正是当初不得不写 npx 的原因；
 *   2. 但 npx 在本地缺失时会**联网取任意版本**执行。一个只看一个环境变量、
 *      三十行就能写完的判断，却把「用哪个包管理器」交给网络上的最新版本决定 ——
 *      构建结果因此可以静默漂移，而日志上完全看不出来。
 *
 * 判据与 only-allow 等价：读 `npm_config_user_agent` 的首段
 * （形如 `pnpm/9.15.9 npm/? node/v22.22.2 darwin arm64`），
 * npm / yarn / pnpm / bun 在执行生命周期脚本时都会注入它。
 *
 * 行为对齐 only-allow，**不额外加严**：环境变量为空时放行（只在能确定时才拦）。
 * 加严会改变既有语义，可能把某些非包管理器触发的调用误杀。
 */

const ua = String(process.env.npm_config_user_agent || '').trim();
const used = ua.split('/')[0].toLowerCase();
// 作为依赖被安装进来时不拦（与 only-allow 的 isInstalledAsDependency 判据一致）
const cwd = process.env.INIT_CWD || process.cwd();
const installedAsDependency = cwd.includes('node_modules');

if (!used || used === 'pnpm' || installedAsDependency) process.exit(0);

console.error(`[check-pm] 本仓库用 pnpm 管理依赖，检测到的是 ${used}。`);
console.error('[check-pm] 请改用：pnpm install');
console.error('[check-pm] 没有 pnpm 时：npm i -g pnpm（或 corepack enable pnpm）');
console.error('[check-pm] 为什么必须统一：换包管理器会生成另一套锁文件与另一套 node_modules 布局，');
console.error('[check-pm] 之后 tsup / electron-builder / 原生模块的解析路径都会变，');
console.error('[check-pm] 症状与真缺陷无法区分。');
process.exit(1);
