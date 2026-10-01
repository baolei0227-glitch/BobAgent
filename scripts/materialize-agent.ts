/**
 * 物化官方 Agent 画像到运行时目录（dev 工具，2026-09-25 起）。
 *
 * 为什么需要它：运行时读的是 `<APP_ROOT>/agents/<id>/agent.json`
 * （store.ts getInstalledAgentProfile），**没有 upgrade 函数** —— 改了
 * official-packages.ts / profiles.ts 里的 prompt、version、fixedScenes，
 * 端上不会自动生效，只能「卸载重装」或直接同步写该文件。
 *
 * 本脚本从源码 import（不经手抄），保证写盘内容与官方包定义一字不差；
 * 写前自动同目录备份（`agent.json.bak-YYYYMMDD`），可随时回退。
 *
 * 用法：
 *   cd projects
 *   ./node_modules/.bin/tsx scripts/materialize-agent.ts --dry          # 只看差异
 *   ./node_modules/.bin/tsx scripts/materialize-agent.ts                # 物化 butler
 *   ./node_modules/.bin/tsx scripts/materialize-agent.ts --id=archivist
 *
 * 注意：这会覆盖用户在端上对画像 prompt 的本地改动 —— 有备份可回退，但仍属
 * 「写用户数据目录」，改别人的项目前先取得确认。
 */
import { writeFile, readFile, copyFile, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { OFFICIAL_PACKAGES } from '../src/lib/agents/official-packages';

function argValue(flag: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : fallback;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const id = argValue('--id', 'butler');
  const pkg = OFFICIAL_PACKAGES.find((p) => p.id === id);
  if (!pkg) {
    throw new Error(
      `官方包 "${id}" 不存在。可选：${OFFICIAL_PACKAGES.map((p) => p.id).join(', ')}`,
    );
  }

  const dir = join(homedir(), 'BobWork', 'agents', id);
  const target = join(dir, 'agent.json');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 字段顺序与既有物化文件保持一致：id, name, description, version, scenes, prompt
  const manifest: Record<string, unknown> = {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    ...(pkg.fixedScenes ? { fixedScenes: [...pkg.fixedScenes] } : {}),
    ...(pkg.coreExclusions ? { coreExclusions: [...pkg.coreExclusions] } : {}),
    ...(pkg.skillPool ? { skillPool: [...pkg.skillPool] } : {}),
    ...(pkg.icon ? { icon: pkg.icon } : {}),
    prompt: pkg.prompt,
  };

  let before = '(未安装)';
  try {
    const raw = JSON.parse(await readFile(target, 'utf-8')) as Record<string, unknown>;
    before = `version=${String(raw.version)} fixedScenes=${JSON.stringify(raw.fixedScenes)} promptLen=${String(raw.prompt ?? '').length}`;
  } catch {
    /* 首次写入 */
  }
  console.log(`[target] ${target}`);
  console.log('[before]', before);
  console.log(
    '[after ]',
    `version=${String(manifest.version)} fixedScenes=${JSON.stringify(manifest.fixedScenes)} promptLen=${String(pkg.prompt ?? '').length}`,
  );

  if (dry) {
    console.log('[dry-run] 未写盘');
    return;
  }

  await mkdir(dir, { recursive: true });
  const bak = join(dir, `agent.json.bak-${today}`);
  try {
    await stat(target);
    await copyFile(target, bak);
    console.log('[backup]', bak);
  } catch {
    console.log('[backup] 原文件不存在，跳过');
  }

  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log('[written] 完成。端上需重开该 agent 会话（或重启应用）才会读到新画像。');
}

main().catch((e) => {
  console.error('[materialize-agent] 失败:', e);
  process.exit(1);
});
