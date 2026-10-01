/**
 * K3-1 工具轮咨询链 hook 边界显式化单测：TOOL_CONSULT_SEQUENCE 顺序 / 值合法性 / 冲突 /
 * 注册表覆盖对齐断言。顺序契约源 = 接口面盘点 §1.2「咨询点顺序（硬性，跨 kind）」：
 *   ask_user(pre) → search_capabilities(pre 全接管) → butler_confirm(pre) → tool_confirm(pre)
 *   → [tool_call_update running] → args_transform(pre) → [keepalive/bobby/team] → executeTool
 *   → grant(post) → login(post) → load_skill(post 联动) → tool_result → result_compact(post)；
 *   butler 卡覆盖后跳过 tool_confirm。
 * 本测试是顺序契约的唯一防护（route.ts 咨询点旁仅注释编号、不加运行时检查）；新增/移动咨询点
 * 必须同步 TOOL_CONSULT_SEQUENCE + route 注释编号 + 本文件（顺序断言本体见「顺序与清单一致」）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { assertConsultContract, TOOL_CONSULT_SEQUENCE } from './tool-pipeline';
import type { ToolTakeoverKind, ToolTakeoverPhase } from './tool-pipeline';

/** 允许的咨询时机（= ToolTakeoverPhase 全部取值） */
const PHASES: readonly ToolTakeoverPhase[] = ['pre', 'post'];

/** 允许的咨询点物理位置稳定名（与 tool-pipeline.ts 常量注释口径一致） */
const CONSULT_POINTS: readonly string[] = [
  'before_execute_running', // tool_call(pending) 帧后、running 心跳帧前（挂起/全接管 pre 段）
  'before_execute', // running 心跳帧后、executeTool 前（参数注入）
  'after_execute', // executeTool 成功后（post 段挂起/联动）
  'after_tool_result', // tool_result 帧后、结果写入对话历史前（结果压缩）
];

/**
 * 已注册 kind 全集（= ToolTakeoverKind 穷举：tool-pipeline 两注册表 registerTakeover /
 * registerHostTakeover 允许注册的全部 kind，route.ts 已逐一注册）。新增 kind 必须先进入
 * TOOL_CONSULT_SEQUENCE 与本清单；下方 expectTypeOf 编译期断言保证两者与类型联合一致。
 */
const ALL_REGISTRABLE_KINDS: readonly ToolTakeoverKind[] = [
  'scenario_activate', // pre：search_capabilities（#2）；post：load_skill（#8）→ 两个咨询点
  'args_transform', // pre（#5）：节点参数注入 + browser.login mode 注入 + 技能闸门三注册条目同一咨询点合并一项
  'result_compact', // post（#9）
  'ask_user', // pre（#1）
  'tool_confirm', // pre（#4）
  'butler_confirm', // pre（#3）
  'login', // post（#7）
  'grant', // post（#6）
];

/** §1.2 硬顺序逐项快照 [kind, phase, consultPoint]：改顺序 / 改名 / 增删项都必须同步这里 */
const EXPECTED_ORDER: ReadonlyArray<readonly [ToolTakeoverKind, ToolTakeoverPhase, string]> = [
  ['ask_user', 'pre', 'before_execute_running'], // #1 咨询链最顶端（pending 帧后、running 前）
  ['scenario_activate', 'pre', 'before_execute_running'], // #2 search_capabilities pre 全接管
  ['butler_confirm', 'pre', 'before_execute_running'], // #3 butler 卡（先于 tool_confirm）
  ['tool_confirm', 'pre', 'before_execute_running'], // #4 通用确认（butler 卡覆盖后跳过）
  ['args_transform', 'pre', 'before_execute'], // #5 running 后、executeTool 前参数注入
  ['grant', 'post', 'after_execute'], // #6 grantRequired SSE 旁路
  ['login', 'post', 'after_execute'], // #7 loginRequired 挂起
  ['scenario_activate', 'post', 'after_execute'], // #8 load_skill post 场景激活联动
  ['result_compact', 'post', 'after_tool_result'], // #9 tool_result 帧后、写历史前压缩
];

/** 编译期穷举护栏：TOOL_CONSULT_SEQUENCE 的 kind 集合必须与 ToolTakeoverKind 联合完全一致 */
type SequenceKind = (typeof TOOL_CONSULT_SEQUENCE)[number]['kind'];
expectTypeOf<SequenceKind>().toEqualTypeOf<ToolTakeoverKind>();

describe('TOOL_CONSULT_SEQUENCE 顺序与清单（§1.2 硬顺序）', () => {
  it('顺序与清单一致：9 项 [kind, phase, consultPoint] 快照逐项相等', () => {
    expect(TOOL_CONSULT_SEQUENCE.map((e) => [e.kind, e.phase, e.consultPoint])).toEqual(
      EXPECTED_ORDER,
    );
    expect(TOOL_CONSULT_SEQUENCE).toHaveLength(9);
  });

  it('kind/phase 值合法（phase ∈ {pre,post}，kind 均属注册 kind 全集）', () => {
    for (const stage of TOOL_CONSULT_SEQUENCE) {
      expect(PHASES).toContain(stage.phase);
      expect(ALL_REGISTRABLE_KINDS).toContain(stage.kind);
      expect(CONSULT_POINTS).toContain(stage.consultPoint);
      // consultPoint 前缀与 phase 语义一致：before_* 仅在 pre 段、after_* 仅在 post 段
      if (stage.phase === 'pre') {
        expect(stage.consultPoint.startsWith('before_')).toBe(true);
      } else {
        expect(stage.consultPoint.startsWith('after_')).toBe(true);
      }
    }
  });

  it('无重复咨询点冲突：(kind, phase) 组合唯一 —— 同族咨询只出现在一个物理咨询点', () => {
    const keyOf = (e: (typeof TOOL_CONSULT_SEQUENCE)[number]) => `${e.kind}::${e.phase}`;
    const byKindPhase = new Map<string, number>();
    for (const e of TOOL_CONSULT_SEQUENCE) {
      const k = keyOf(e);
      byKindPhase.set(k, (byKindPhase.get(k) ?? 0) + 1);
    }
    for (const [k, n] of byKindPhase) {
      expect(n, `(kind, phase)=${k} 出现 ${n} 次`).toBe(1);
    }
    // scenario_activate 的 pre/post 分属 #2/#8 两个物理咨询点，靠 phase 区分（见注册表覆盖对齐）
  });

  it('注册表覆盖对齐：所有可注册 kind 都在序列中（序列 kinds 集合 = 注册 kind 全集）', () => {
    expect(new Set(TOOL_CONSULT_SEQUENCE.map((e) => e.kind))).toEqual(
      new Set(ALL_REGISTRABLE_KINDS),
    );
    // scenario_activate 是全序列唯一出现两次的 kind（pre + post 两个物理咨询点）
    const counts = new Map<ToolTakeoverKind, number>();
    for (const e of TOOL_CONSULT_SEQUENCE) {
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    }
    for (const kind of ALL_REGISTRABLE_KINDS) {
      expect(counts.get(kind) ?? 0).toBeGreaterThanOrEqual(1);
    }
    expect(counts.get('scenario_activate')).toBe(2);
    for (const [kind, n] of counts) {
      if (kind !== 'scenario_activate') expect(n).toBe(1);
    }
  });

  it('K3-2 加载期自检通过：assertConsultContract() 对当前契约不抛', () => {
    expect(() => assertConsultContract()).not.toThrow();
  });
});
