/**
 * lib/butler/rule-nearmiss.ts —— 弱触发「一次即记忆」（server-only）
 *
 * 2026-10-05 学习机制改造：由「攒够 N 次才*提议固化*」改为「**一次即记忆** + 主动遗忘兜底」。
 *   ① 弱触发命中 1 次 → 静默落一条 **draft** 规则（不执行、不弹窗，进面板「待确认」收件箱）；
 *   ② 再次命中同一对象的 draft → 记一次「印证」（写 hits），提升收件箱排序，**不自动转正**；
 *   ③ 转正 / 整改 / 废除由用户发起（面板 PATCH），废除走负样本（`not_a_habit`）兜底，防止再被静默学回。
 * 兜底在 rule-forget.ts：draft 超期自动清除；active 绝不静默删，只产「建议废除」软提示。
 *
 * 为什么**只对 todo 建 draft**：draft 转正后要能**确定性执行**，而宿主执行器只认
 * `create_todo` / `create_scheduled_todo`（见 rule-exec.ts）。schedule 动作需要**确定时刻**
 * （`actionParams.when`），弱触发词提供不了时刻 → 建出来也是永不生效的废 draft；
 * note / meeting / project **没有确定性动作**，`ruleObjectType` 派生为 null。故本期只对
 * 弱触发对象类型 `todo` 落 draft；其余类型的词表保留（是候选词汇，等执行器扩展后再启用）。
 *
 * 模式键只由**对象类型**构成（§3.4 Q13）：对象类型是有限枚举，措辞是无限集——
 * 弱触发词只作产生候选的信号，**不进键**。
 */
import { listRules, createRule } from './rules';
import { recordHit, isPatternBlocked, type NegativeSampleClass } from './rule-signals';
import { readRuleLog, type HitEntry } from './rule-logs';
import { ruleObjectType, type ObjectType, type RuleStep } from './rules-shared';

export type { ObjectType } from './rules-shared';

/** 落 hits 的场景标签（near-miss 的「命中」是「又见一次该模式」，不是规则执行） */
const NEAR_MISS_SCENE = 'nearmiss';

/** 弱触发词表（同域动词；只作产生候选的信号，**不进模式键**） */
const WEAK_SIGNALS: ReadonlyArray<{ type: ObjectType; re: RegExp }> = [
  { type: 'todo', re: /待办|提醒我|别忘|要做|记(?:个|一下)?(?:待办|任务)/ },
  { type: 'schedule', re: /安排|日程|排(?:个|一下)|约(?:个|一下)/ },
  { type: 'note', re: /记一下|记下|备忘|笔记|记录一下/ },
  { type: 'meeting', re: /会议|开(?:个)?会|约谈|碰头/ },
  { type: 'project', re: /新建项目|建个项目|开个项目/ },
];

/** 把用户话映射到「对象类型 + 命中的触发词」（命中多个则都返回，去重、按词表顺序） */
export function weakSignalMatches(text: string): { type: ObjectType; keyword: string }[] {
  const t = String(text ?? '');
  const out: { type: ObjectType; keyword: string }[] = [];
  for (const s of WEAK_SIGNALS) {
    const m = s.re.exec(t); // 无 g 标志 → exec 无状态，多行安全
    if (m && !out.some((x) => x.type === s.type)) out.push({ type: s.type, keyword: m[0] });
  }
  return out;
}

/** 把用户话映射到对象类型（weakSignalMatches 的薄封装，保留既有调用面） */
export function weakSignalObjectTypes(text: string): ObjectType[] {
  return weakSignalMatches(text).map((m) => m.type);
}

/** 拉黑判定（两类各自独立，互不误伤）：某对象类型下该类负样本是否处于拉黑态 */
export async function isBlocked(objectType: ObjectType, cls: NegativeSampleClass): Promise<boolean> {
  return await isPatternBlocked(objectType, objectType, cls);
}

/** 一次「记忆」的结果：新建 draft / 印证已有 draft（都没有 → null，静默） */
export type LearnOutcome =
  | { action: 'created'; objectType: ObjectType; ruleId: string }
  | { action: 'reinforced'; objectType: ObjectType; ruleId: string; seen: number };

/**
 * 弱触发「一次即记忆」：用户话命中 todo 弱触发词时——
 *   - 已被 `not_a_habit` 拉黑（用户说过「这不是习惯」）→ 不再学；
 *   - 已有覆盖 todo 的 **active** 规则（已学会）→ 不再学；
 *   - 已有覆盖 todo 的 **draft** → 记一次印证（写 hits），返回 reinforced（**不自动转正**）；
 *   - 否则 → 落一条 draft 规则（静默、不执行），并记首次命中。
 * 返回 null 表示本轮无需动作（无弱信号 / 被拉黑 / 已学会）。
 */
export async function rememberFromText(text: string): Promise<LearnOutcome | null> {
  const raw = String(text ?? '');
  const hit = weakSignalMatches(raw).find((m) => m.type === 'todo');
  if (!hit || !hit.keyword.trim()) return null;
  if (await isBlocked('todo', 'not_a_habit')) return null;

  const all = await listRules();
  if (all.some((r) => r.status === 'active' && ruleObjectType(r) === 'todo')) return null;

  const existing = all.find((r) => r.status === 'draft' && ruleObjectType(r) === 'todo');
  if (existing) {
    await recordHit(existing.id, existing.version, NEAR_MISS_SCENE);
    const seen = (await readRuleLog<HitEntry>('hits', existing.id)).length;
    return { action: 'reinforced', objectType: 'todo', ruleId: existing.id, seen };
  }

  const keyword = hit.keyword.trim();
  const steps: RuleStep[] = [
    { kind: 'deterministic', text: `把「${keyword}」后面的事建成一张待办`, action: 'create_todo' },
  ];
  const rule = await createRule({
    name: `“${keyword}” 自动建待办`,
    intentRaw: raw.trim(),
    steps,
    trigger: { keywords: [keyword] },
    status: 'draft',
  });
  await recordHit(rule.id, rule.version, NEAR_MISS_SCENE);
  return { action: 'created', objectType: 'todo', ruleId: rule.id };
}
