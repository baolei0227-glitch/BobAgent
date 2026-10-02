/**
 * lib/butler/rule-nearmiss.ts —— 弱触发与「提议固化」（server-only，v6 §3.4）
 *
 * near-miss 有三件互相独立的策略，独立成层避免 rule-exec.ts 继续膨胀：
 *   ① 弱触发信号（比规则触发词更宽的同域动词 → 产生候选）；
 *   ② 限流（同一模式累计询问上限 NEAR_MISS_ASK_LIMIT，「问过即计数」）；
 *   ③ 拉黑（两类负样本，各按 (objectType, class) 独立读判据，互不误伤）。
 *
 * 模式键只由**对象类型**构成（§3.4 Q13）：对象类型是有限枚举，措辞是无限集——
 * 弱触发词只作产生候选的信号，**不进键**。对象类型映射写在代码里、**不落盘**（不变量 2）。
 *
 * 落点：计数落既有 `.state/`（rule-behavior.json / rule-nearmiss.json），不新建存储根。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { STATE_DIR, ensureDir } from './storage';
import { atomicWriteFile, createLock } from './fs-atomic';
import {
  NEAR_MISS_ASK_LIMIT,
  NEAR_MISS_BEHAVIOR_N,
  ruleObjectType,
  type ObjectType,
} from './rules-shared';
import { listRules } from './rules';
import { isPatternBlocked, type NegativeSampleClass } from './rule-signals';

export type { ObjectType } from './rules-shared';

/** 弱触发词表（同域动词；只作产生候选的信号，**不进模式键**） */
const WEAK_SIGNALS: ReadonlyArray<{ type: ObjectType; re: RegExp }> = [
  { type: 'todo', re: /待办|提醒我|别忘|要做|记(?:个|一下)?(?:待办|任务)/ },
  { type: 'schedule', re: /安排|日程|排(?:个|一下)|约(?:个|一下)/ },
  { type: 'note', re: /记一下|记下|备忘|笔记|记录一下/ },
  { type: 'meeting', re: /会议|开(?:个)?会|约谈|碰头/ },
  { type: 'project', re: /新建项目|建个项目|开个项目/ },
];

/** 把用户话映射到对象类型（命中多个则都返回，去重、按词表顺序） */
export function weakSignalObjectTypes(text: string): ObjectType[] {
  const t = String(text ?? '');
  const out: ObjectType[] = [];
  for (const s of WEAK_SIGNALS) {
    if (s.re.test(t) && !out.includes(s.type)) out.push(s.type);
  }
  return out;
}

/** 读一个 JSON 计数文件（坏文件 / 缺文件 → 空对象） */
async function readCounts(file: string): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
  } catch { /* 无文件 → 空 */ }
  return {};
}

/** 计数写回：原子写 + **串行锁**。
 *  （2026-10-02 评审 P2-⑭：此前 `noteBehavior` / `consumeAsk` 是**无锁**读-改-写，
 *   且 tmp 名只有 `pid+Date.now()`，同毫秒并发会互相覆盖 → 询问额度与行为计数都会失真。） */
const withCountsLock = createLock();

/** 原子写回计数文件（tmp + rename，避免半截文件） */
async function writeCounts(file: string, map: Record<string, number>): Promise<void> {
  await ensureDir(STATE_DIR);
  await atomicWriteFile(file, JSON.stringify(map));
}

function behaviorFile(): string {
  return join(STATE_DIR, 'rule-behavior.json');
}

function askFile(): string {
  return join(STATE_DIR, 'rule-nearmiss.json');
}

/**
 * 记一次「某对象类型的行为」（落 .state/rule-behavior.json）。
 * 返回该对象类型的**累计次数**与是否已达提议阈值 N（§3.4 提议固化需要「做了 N 次」这一计数）。
 */
export async function noteBehavior(objectType: ObjectType): Promise<{ count: number; exceeded: boolean }> {
  const file = behaviorFile();
  return withCountsLock(async () => {
    const map = await readCounts(file);
    const prev = typeof map[objectType] === 'number' && Number.isFinite(map[objectType]) ? map[objectType] : 0;
    const count = prev + 1;
    map[objectType] = count;
    await writeCounts(file, map);
    return { count, exceeded: count >= NEAR_MISS_BEHAVIOR_N };
  });
}

/**
 * 只读：导出「询问额度」消耗表（落 `.state/rule-nearmiss.json`）。
 * 供记忆台的证据视图（`/api/butler/memory-audit`）展示「这个模式还能问几次」——
 * **不改行为**，与 `consumeAsk` 读同一份文件、同一把锁外的只读路径。
 */
export async function readAskCounts(): Promise<Record<string, number>> {
  return readCounts(askFile());
}

/**
 * 限流：消耗一次「询问额度」（落 .state/rule-nearmiss.json），上限 NEAR_MISS_ASK_LIMIT。
 * 「问过即计数」——与「被否几次」（负样本，见 rule-signals）是**两个计数**（D8）。
 * 返回 false = 额度用尽，本次不再询问。
 */
export async function consumeAsk(objectType: ObjectType): Promise<boolean> {
  const file = askFile();
  return withCountsLock(async () => {
    const map = await readCounts(file);
    const used = typeof map[objectType] === 'number' && Number.isFinite(map[objectType]) ? map[objectType] : 0;
    if (used >= NEAR_MISS_ASK_LIMIT) return false;
    map[objectType] = used + 1;
    await writeCounts(file, map);
    return true;
  });
}

/** 拉黑判定（两类各自独立，互不误伤）：某对象类型下该类负样本是否处于拉黑态 */
export async function isBlocked(objectType: ObjectType, cls: NegativeSampleClass): Promise<boolean> {
  return await isPatternBlocked(objectType, objectType, cls);
}

/** 是否已有覆盖该对象类型的 active 规则（有 → 不必再提议固化） */
async function hasActiveRuleFor(objectType: ObjectType): Promise<boolean> {
  const all = await listRules();
  return all.some((r) => r.status === 'active' && ruleObjectType(r) === objectType);
}

/**
 * 提议固化的判定（§3.4 / §8.4 第 4 情形）：用户话命中某弱触发对象类型、**且**当前没有
 * 覆盖该类型的 active 规则、**且**该类型的 **not_a_habit** 未被拉黑、**且**行为累计达 N 次，
 * 且询问额度未用尽 → 产一条「提议固化」候选（只问一句，占主动冒头预算）。
 * 满足则返回对象类型与累计次数；否则 null（静默）。
 */
export async function proposeForText(
  text: string,
): Promise<{ objectType: ObjectType; count: number } | null> {
  for (const objectType of weakSignalObjectTypes(text)) {
    if (await isBlocked(objectType, 'not_a_habit')) continue;
    if (await hasActiveRuleFor(objectType)) continue;
    const { count, exceeded } = await noteBehavior(objectType);
    if (!exceeded) continue;
    if (!(await consumeAsk(objectType))) continue;
    return { objectType, count };
  }
  return null;
}