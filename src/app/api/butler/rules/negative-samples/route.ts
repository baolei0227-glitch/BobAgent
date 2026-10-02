/**
 * /api/butler/rules/negative-samples —— 负样本（被拉黑的模式）的可见与解封
 *
 * 依据：Butler Phase 2 计划 §3.9 / §3.10 / D7（负样本分片键＝**对象类型**，分**两类**）。
 * near-miss 询问被否（signal_mismatch）或固化提议被否（not_a_habit）后，该模式不再产生候选
 * （见 rule-signals.recordNegativeSample / rule-nearmiss.isBlocked）。
 * 「我的定制」总览页 Preferences 段分两栏（不再问 / 不想固化）展示并提供解封。
 *
 *   GET    ?object_type=<ot>&class=<cls> → { samples, blocked, grouped }
 *        object_type 缺省 → 扫描全部对象类型分片（含 Phase 1 遗留的 'rule'，只读兼容）
 *        class 缺省       → 两类合并返回；blocked 另附 grouped 两栏
 *   DELETE ?object_type=<ot>&pattern=<p>&class=<cls> → 解封：追加一条 action='unblocked'
 *
 * 解封不删历史：日志是 append-only，读侧以**最后一条**（同类的）记录为准（见 isPatternBlocked），
 * 故解封后该模式立即恢复产生候选，旧记录仍可审计（不变量：无静默截断）。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listNegativeSamples,
  listBlockedPatterns,
  recordNegativeSample,
  normalizeNegativeClass,
  NEGATIVE_OBJECT_TYPES,
  type NegativeSampleClass,
} from '@/lib/butler/rule-signals';
import type { NegativeSampleEntry } from '@/lib/butler/rule-logs';

const CLASSES: NegativeSampleClass[] = ['signal_mismatch', 'not_a_habit'];

/** 带分片键与「类」的负样本条目（供前端分栏与解封定位） */
type TaggedNegative = NegativeSampleEntry & { objectType: string; class: NegativeSampleClass };

function parseClass(raw: string | null): NegativeSampleClass | undefined {
  return raw && (CLASSES as string[]).includes(raw) ? (raw as NegativeSampleClass) : undefined;
}

/** 聚合若干分片的负样本（objectType 缺省 → 全部对象类型；cls 缺省 → 两类合并） */
async function collect(
  objectType: string | undefined,
  cls: NegativeSampleClass | undefined,
): Promise<{ samples: TaggedNegative[]; blocked: TaggedNegative[] }> {
  const keys: string[] = objectType ? [objectType] : [...NEGATIVE_OBJECT_TYPES];
  const samples: TaggedNegative[] = [];
  const blocked: TaggedNegative[] = [];
  for (const k of keys) {
    const [s, b] = await Promise.all([listNegativeSamples(k, cls), listBlockedPatterns(k, cls)]);
    for (const e of s) samples.push({ ...e, objectType: k, class: normalizeNegativeClass(e) });
    for (const e of b) blocked.push({ ...e, objectType: k, class: normalizeNegativeClass(e) });
  }
  const byAt = (a: TaggedNegative, b: TaggedNegative) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  samples.sort(byAt);
  blocked.sort(byAt);
  return { samples, blocked };
}

export async function GET(request: NextRequest) {
  const objectType = request.nextUrl.searchParams.get('object_type') || undefined;
  const cls = parseClass(request.nextUrl.searchParams.get('class'));
  try {
    const { samples, blocked } = await collect(objectType, cls);
    // 两栏分组（§3.4）：不再问（signal_mismatch）/ 不想固化（not_a_habit）
    const grouped = {
      signal_mismatch: blocked.filter((e) => e.class === 'signal_mismatch'),
      not_a_habit: blocked.filter((e) => e.class === 'not_a_habit'),
    };
    return NextResponse.json({
      success: true,
      objectType: objectType ?? null,
      class: cls ?? null,
      samples,
      blocked,
      grouped,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules/negative-samples] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function DELETE(request: NextRequest) {
  const objectType = request.nextUrl.searchParams.get('object_type') || 'rule';
  const pattern = request.nextUrl.searchParams.get('pattern');
  if (!pattern) return NextResponse.json({ success: false, error: 'pattern required' });
  // 解封需**按类**精确（同类 latest-wins），缺省按 signal_mismatch（Phase 1 旧记录语义）
  const cls = parseClass(request.nextUrl.searchParams.get('class')) ?? 'signal_mismatch';
  try {
    await recordNegativeSample(objectType, pattern, 'unblocked', cls);
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules/negative-samples] 解封失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}