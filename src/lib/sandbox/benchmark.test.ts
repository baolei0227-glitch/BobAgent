import { describe, expect, it } from 'vitest';

import { evaluateCodingBenchmark, findCodingBenchmark, genericQualityChecks } from './benchmark';

const okHtml = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"></head><body><ul id="list"></ul><script>document.getElementById('list').addEventListener('click',()=>{}); BobStorage.save('items', []);</script></body></html>`;

describe('coding benchmark evaluator (pure)', () => {
  it('generic checks pass for a normal mini-app shell', () => {
    const checks = genericQualityChecks({ entry: 'index.html', content: okHtml });
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('flags alert() and missing viewport', () => {
    const checks = genericQualityChecks({
      entry: 'index.html',
      content: '<html><body><script>alert("x")</script></body></html>',
    });
    expect(checks.find((c) => c.id === 'no-alert')?.pass).toBe(false);
    expect(checks.find((c) => c.id === 'viewport')?.pass).toBe(false);
    expect(checks.find((c) => c.id === 'doctype')?.pass).toBe(false);
  });

  it('todo case fails without persistence + smoke test, passes with them', () => {
    const bench = findCodingBenchmark('todo');
    expect(bench).toBeTruthy();
    if (!bench) return;

    const missing = evaluateCodingBenchmark({ entry: 'index.html', content: okHtml }, bench);
    expect(missing.passed).toBe(false);
    expect(missing.checks.find((c) => c.id === 'smoke-test')?.pass).toBe(false);

    const full = evaluateCodingBenchmark(
      {
        entry: 'index.html',
        content: okHtml,
        smoke: `window.__testResult = { ok: true };`,
      },
      bench,
    );
    expect(full.passed).toBe(true);
    expect(full.score).toBe(1);
  });

  it('unknown case id is undefined (script can list valid ids)', () => {
    expect(findCodingBenchmark('nope')).toBeUndefined();
  });
});
