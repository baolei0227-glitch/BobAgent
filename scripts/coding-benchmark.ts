/**
 * Coding 小程序质量基准 CLI。
 *
 * 用法：
 *   pnpm coding:benchmark --list
 *   pnpm coding:benchmark --app <appId> --case <caseId>
 *
 * 说明：先在 BobWork 里用 case 的 wish 生成一个 app，再用 appId 跑本脚本。
 * 检查项见 src/lib/sandbox/benchmark.ts；失败退出码 1，可直接接 CI。
 */
import process from 'node:process';

import { readAppEntry, readAppFile } from '../src/lib/sandbox/apps';
import {
  CODING_BENCHMARKS,
  evaluateCodingBenchmark,
  findCodingBenchmark,
} from '../src/lib/sandbox/benchmark';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<number> {
  if (process.argv.includes('--list') || process.argv.length <= 2) {
    console.log('Coding 小程序质量基准（caseId — 愿望 — 建议模板）\n');
    for (const b of CODING_BENCHMARKS) {
      console.log(`- ${b.id.padEnd(10)} ${b.label}`);
      console.log(`  愿望: ${b.wish}`);
      console.log(`  模板: ${b.template}\n`);
    }
    console.log('用法: pnpm coding:benchmark --app <appId> --case <caseId>');
    return 0;
  }

  const appId = argValue('--app');
  const caseId = argValue('--case');
  if (!appId || !caseId) {
    console.error('缺少参数。用法: pnpm coding:benchmark --app <appId> --case <caseId>（或 --list 查看用例）');
    return 2;
  }

  const bench = findCodingBenchmark(caseId);
  if (!bench) {
    console.error(`未知 case「${caseId}」。可用: ${CODING_BENCHMARKS.map((b) => b.id).join(', ')}`);
    return 2;
  }

  const entry = await readAppEntry(appId);
  if (!entry) {
    console.error(`读不到小程序「${appId}」的入口文件（appId 是否正确？可在 Mini Programs 商城查看）。`);
    return 2;
  }
  const smokeBuf = await readAppFile(appId, 'smoke-test.js').catch(() => null);
  const result = evaluateCodingBenchmark(
    {
      entry: entry.app.entry || 'index.html',
      content: entry.content,
      smoke: smokeBuf ? smokeBuf.toString('utf8') : undefined,
    },
    bench,
  );

  console.log(`\nCase: ${bench.id} — ${bench.label}`);
  console.log(`App : ${entry.app.name} (${appId})`);
  console.log(`Score: ${Math.round(result.score * 100)}%  ${result.passed ? 'PASS' : 'FAIL'}\n`);
  for (const c of result.checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log('');
  return result.passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
