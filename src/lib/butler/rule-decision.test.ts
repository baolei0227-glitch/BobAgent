/**
 * 规则裁决（rule-decision）回归：候选生成三通道 + decide 五条路径 + 修订阈值边界。
 * 纯函数，无 I/O，无需隔离。
 */
import { describe, expect, it } from 'vitest';
import { REVISION_WINDOW, evaluateRevision, type RuleRecord } from './rules-shared';
import { conflictKeyOf, decide, generateCandidates, type ConflictResolution } from './rule-decision';

function mkRule(partial: Partial<RuleRecord> & { id: string }): RuleRecord {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'rule',
    intentRaw: partial.intentRaw ?? '',
    trigger: partial.trigger ?? { keywords: [] },
    steps: partial.steps ?? [{ kind: 'deterministic', text: 'x' }],
    commitment: partial.commitment ?? '必做到',
    scope: partial.scope ?? 'global',
    ...(partial.scopeTarget ? { scopeTarget: partial.scopeTarget } : {}),
    priority: partial.priority ?? 50,
    status: partial.status ?? 'active',
    version: partial.version ?? 1,
    createdAt: partial.createdAt ?? '2026-09-28 10:00',
  };
}

const NOW = new Date('2026-09-28T10:00:00.000Z');

describe('generateCandidates 三通道', () => {
  it('硬通道：关键词原样包含 → confidence 1', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', trigger: { keywords: ['记一下'] } });
    const c = generateCandidates({ text: '记一下 买牛奶', rules: [rule], now: NOW });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ ruleId: rule.id, channel: 'hard', confidence: 1 });
  });

  it('软通道：关键词未整词命中但相似度 ≥ 0.5 → confidence < 1', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', name: 'zzz', trigger: { keywords: ['记一下'] } });
    const c = generateCandidates({ text: '记录一下买牛奶', rules: [rule], now: NOW });
    expect(c).toHaveLength(1);
    expect(c[0].channel).toBe('soft');
    expect(c[0].confidence).toBeLessThan(1);
    expect(c[0].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('软通道：规则 name 出现在 text → confidence 0.9', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', name: '买牛奶', trigger: { keywords: ['记一下'] } });
    const c = generateCandidates({ text: '帮我买牛奶', rules: [rule], now: NOW });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ channel: 'soft', confidence: 0.9 });
  });

  it('定时候选优先：timerHits 命中 → channel timer 且 confidence 1', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', trigger: { keywords: ['记一下'] } });
    const c = generateCandidates({ text: '无关内容', rules: [rule], now: NOW, timerHits: [rule.id] });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ channel: 'timer', confidence: 1 });
  });

  it('无任何通道命中 → 不产候选', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', name: 'No coriander', trigger: { keywords: ['香菜'] } });
    expect(generateCandidates({ text: '今天天气不错', rules: [rule], now: NOW })).toEqual([]);
  });
});

describe('decide 五条路径', () => {
  it('无候选 → silent', () => {
    expect(decide({ candidates: [], rules: [], resolutions: [] })).toEqual({ kind: 'silent' });
  });

  it('单个硬候选 → execute（含 version）', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', version: 3 });
    const d = decide({
      candidates: [{ ruleId: rule.id, confidence: 1, channel: 'hard' }],
      rules: [rule],
      resolutions: [],
    });
    expect(d).toEqual({ kind: 'execute', ruleId: rule.id, version: 3 });
  });

  it('定时候选 → execute', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa', version: 1 });
    const d = decide({
      candidates: [{ ruleId: rule.id, confidence: 1, channel: 'timer' }],
      rules: [rule],
      resolutions: [],
    });
    expect(d).toEqual({ kind: 'execute', ruleId: rule.id, version: 1 });
  });

  it('仅软候选 → ask（永不直接执行）', () => {
    const rule = mkRule({ id: 'r-20260928-aaaa' });
    const d = decide({
      candidates: [{ ruleId: rule.id, confidence: 0.6, channel: 'soft' }],
      rules: [rule],
      resolutions: [],
    });
    expect(d).toEqual({ kind: 'ask', ruleId: rule.id });
  });

  it('硬候选压过更高优先级的软候选', () => {
    const hard = mkRule({ id: 'r-20260928-aaaa', priority: 10 });
    const soft = mkRule({ id: 'r-20260928-bbbb', priority: 99 });
    const d = decide({
      candidates: [
        { ruleId: hard.id, confidence: 1, channel: 'hard' },
        { ruleId: soft.id, confidence: 0.7, channel: 'soft' },
      ],
      rules: [hard, soft],
      resolutions: [],
    });
    expect(d).toEqual({ kind: 'execute', ruleId: hard.id, version: 1 });
  });

  it('多硬候选：project 具体度压过 global（即便 priority 更低）', () => {
    const project = mkRule({ id: 'r-20260928-aaaa', scope: 'project', scopeTarget: 'p1', priority: 1 });
    const global = mkRule({ id: 'r-20260928-bbbb', priority: 100 });
    const d = decide({
      candidates: [
        { ruleId: project.id, confidence: 1, channel: 'hard' },
        { ruleId: global.id, confidence: 1, channel: 'hard' },
      ],
      rules: [project, global],
      resolutions: [],
      activeProjectId: 'p1',
    });
    expect(d).toEqual({ kind: 'execute', ruleId: project.id, version: 1 });
  });

  it('project 规则不匹配当前项目 → 不适用（仅此候选则 silent）', () => {
    const project = mkRule({ id: 'r-20260928-aaaa', scope: 'project', scopeTarget: 'p2' });
    const d = decide({
      candidates: [{ ruleId: project.id, confidence: 1, channel: 'hard' }],
      rules: [project],
      resolutions: [],
      activeProjectId: 'p1',
    });
    expect(d).toEqual({ kind: 'silent' });
  });

  it('同分并列无历史消解 → need_user（选项升序 + conflictKey）', () => {
    const a = mkRule({ id: 'r-20260928-aaaa', priority: 50 });
    const b = mkRule({ id: 'r-20260928-bbbb', priority: 50 });
    const d = decide({
      candidates: [
        { ruleId: a.id, confidence: 1, channel: 'hard' },
        { ruleId: b.id, confidence: 1, channel: 'hard' },
      ],
      rules: [a, b],
      resolutions: [],
    });
    expect(d).toEqual({
      kind: 'need_user',
      options: [a.id, b.id],
      conflictKey: conflictKeyOf([a.id, b.id]),
    });
  });

  it('同分并列有历史消解 → 按记录选择 execute', () => {
    const a = mkRule({ id: 'r-20260928-aaaa', priority: 50 });
    const b = mkRule({ id: 'r-20260928-bbbb', priority: 50 });
    const resolutions: ConflictResolution[] = [
      { key: conflictKeyOf([a.id, b.id]), inputFeature: 't', chosen: b.id, versions: [1, 1], at: '2026-09-27T00:00:00.000Z' },
    ];
    const d = decide({
      candidates: [
        { ruleId: a.id, confidence: 1, channel: 'hard' },
        { ruleId: b.id, confidence: 1, channel: 'hard' },
      ],
      rules: [a, b],
      resolutions,
    });
    expect(d).toEqual({ kind: 'execute', ruleId: b.id, version: 1 });
  });

  it('同分并列时取最近一条消解记录（at 更大者胜）', () => {
    const a = mkRule({ id: 'r-20260928-aaaa', priority: 50 });
    const b = mkRule({ id: 'r-20260928-bbbb', priority: 50 });
    const key = conflictKeyOf([a.id, b.id]);
    const resolutions: ConflictResolution[] = [
      { key, inputFeature: 't', chosen: a.id, versions: [1, 1], at: '2026-09-01T00:00:00.000Z' },
      { key, inputFeature: 't', chosen: b.id, versions: [1, 1], at: '2026-09-20T00:00:00.000Z' },
    ];
    const d = decide({
      candidates: [
        { ruleId: a.id, confidence: 1, channel: 'hard' },
        { ruleId: b.id, confidence: 1, channel: 'hard' },
      ],
      rules: [a, b],
      resolutions,
    });
    expect(d).toEqual({ kind: 'execute', ruleId: b.id, version: 1 });
  });
});

describe('conflictKeyOf 有序对', () => {
  it('规则 id 升序连接 __，与入参顺序无关', () => {
    expect(conflictKeyOf(['r-b', 'r-a'])).toBe('r-a__r-b');
    expect(conflictKeyOf(['r-a', 'r-b'])).toBe('r-a__r-b');
  });
});

describe('evaluateRevision 阈值与样本量边界', () => {
  it('样本不足 K（4 次命中）→ 不启用', () => {
    const r = evaluateRevision(REVISION_WINDOW - 1, 3);
    expect(r.active).toBe(false);
    expect(r.shouldPropose).toBe(false);
    expect(r.ratio).toBeCloseTo(0.75);
  });

  it('恰好 K（5 命中 3 否定）→ 提议修订', () => {
    const r = evaluateRevision(REVISION_WINDOW, 3);
    expect(r.active).toBe(true);
    expect(r.ratio).toBeCloseTo(0.6);
    expect(r.shouldPropose).toBe(true);
  });

  it('ratio 恰好等于阈值（5 命中 2 否定 = 0.4）→ 不提议（严格大于）', () => {
    const r = evaluateRevision(REVISION_WINDOW, 2);
    expect(r.active).toBe(true);
    expect(r.ratio).toBeCloseTo(0.4);
    expect(r.shouldPropose).toBe(false);
  });

  it('超过 K（6 命中 4 否定）→ 提议', () => {
    const r = evaluateRevision(REVISION_WINDOW + 1, 4);
    expect(r.shouldPropose).toBe(true);
  });

  it('零命中 → ratio 0、不启用', () => {
    expect(evaluateRevision(0, 0)).toEqual({ active: false, ratio: 0, shouldPropose: false });
  });
});