'use client';

/**
 * ButlerRulesPanel —— 「我的定制」总览页（Customize）
 *
 * 依据 Butler Phase 1 §3.9 / Phase 3 §3.9：把既有规则面板扩为**四段总览页**，
 * 解决「规则从第二条起就熵增」——规则、命中/信号、技能、记忆收进一个可管理面。
 *
 *   Rules        规则列表（commitment / kind / status）+ 一键停用 + 悬挂提示 + 修订建议标记
 *                + 被拉黑模式（负样本）的可见与解封——它属规则学习闭环，不跟记忆放一段
 *   Signals      单规则的命中时间线 + 三类信号 + 冲突消解记录（按需拉取）
 *   Skills       技能列表（适用条件 / 版本 / 来源 / 成败 / 生命周期）+ 详情（步骤 / 副作用 / 修订历史）
 *                + 治理动作（Retire 停用 / Unquarantine 解封）——Phase 3 §3.9
 *   Memories     直接嵌入 ButlerMemoryPanel（增 / 改 / 删全功能）。
 *                2026-09-29 并入：原先的只读「偏好聚合」段取消——同一份 butler/preferences.md
 *                不再在 Memories 入口与 Customize 各画一遍，左栏也少一个键。
 *
 * 首屏为**脑图落点**（BrainMap）：一张简笔画大脑接四个入口节点，点节点才进对应分区页；
 * 分区页不再保留横向标签，只留左上角 `← All` 回到脑图。
 * 例外：外部传 initialSection（如 openButlerMemories）时跳过脑图，直接落在指定分区。
 *
 * 数据源与既有实现同源，不新造存储：
 *   /api/butler/rules                          规则读写（底层 butler/.rules/<id>.md）
 *   /api/butler/rules/signals?id=             规则信号详情（新增子路径，纯增量）
 *   /api/butler/skills                         技能列表 + 成败信号 + 生命周期治理（底层 butler/.skills/<id>.md）
 *   /api/butler/preferences                    记忆读写（底层 butler/preferences.md，Memories 段由内嵌面板自行调用）
 *   /api/butler/rules/negative-samples         被拉黑模式的可见与解封（新增子路径）
 *
 * 悬挂惰性检查（v6 §3.2 / 计划 D9）：打开总览页时读规则 → 比对当前项目列表 →
 * `scope_target` 已不存在的**生效中**规则转 `paused` 并标记。不接调度器。
 * 文案全英文（存储值仍是中文三值，仅展示层映射），对齐 ButlerMemoryPanel 的先例。
 */
import { useCallback, useEffect, useState } from 'react';
import type { RuleRecord, RuleStep, StepKind } from '@/lib/butler/rules-shared';
import {
  COMMITMENT_LABELS,
  KIND_LABELS,
  STATUS_LABELS,
  REVISION_WINDOW,
  deriveCommitment,
} from '@/lib/butler/rules-shared';
import {
  LIFECYCLE_LABELS,
  ORIGIN_LABELS,
  RUNTIME_LABELS,
  SKILL_FAIL_QUARANTINE,
  describeEffects,
  type SkillRecord,
} from '@/lib/butler/skills-shared';
import { ButlerMemoryPanel } from './ButlerMemoryPanel';

/** 四个分区 */
export type Section = 'rules' | 'signals' | 'skills' | 'memories';

export interface ButlerRulesPanelProps {
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
  /** 初始分区：左栏 Customize 默认 Rules；外部 `openButlerMemories()` 直接落到 Memories */
  initialSection?: Section;
}

/** 表单里的步骤草稿（annex 仅对 judgment 有效，展示为行内小开关） */
interface StepDraft {
  kind: StepKind;
  text: string;
  annex: boolean;
}

/** 新建 / 编辑共用一份草稿 */
interface Draft {
  mode: 'create' | 'edit';
  /** edit 时的规则 id */
  id?: string;
  /** edit 时的乐观锁版本（并发写防覆盖，⑨） */
  version?: number;
  name: string;
  intent: string;
  /** 逗号分隔的触发词（展示层用字符串，提交时切分为数组） */
  keywords: string;
  steps: StepDraft[];
}

/** 修订评估（与宿主 rules-shared.evaluateRevision 同形） */
interface Revision {
  active: boolean;
  ratio: number;
  shouldPropose: boolean;
}

/** 单技能的成败信号（/api/butler/skills 响应体的 signals 字段） */
interface SkillSignal {
  revision: Revision;
  runs: { ok: number; failed: number; dismissed: number; consecutiveFailures: number };
}

/** 技能适用条件 → 一行可读描述（英文；空则提示未显式声明） */
function describeWhen(skill: SkillRecord): string {
  const parts: string[] = [];
  if (skill.when.keywords.length > 0) parts.push(`keywords: ${skill.when.keywords.join(', ')}`);
  if (skill.when.scenes && skill.when.scenes.length > 0) parts.push(`scenes: ${skill.when.scenes.join(', ')}`);
  if (skill.when.objectTypes && skill.when.objectTypes.length > 0) parts.push(`objects: ${skill.when.objectTypes.join(', ')}`);
  if (skill.when.preconditions && skill.when.preconditions.length > 0) parts.push(`requires: ${skill.when.preconditions.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'No explicit conditions';
}

/** 单规则信号详情（/api/butler/rules/signals?id= 的响应体） */
interface SignalsData {
  hits: Array<{ at: string; scene?: string; rule_version?: number; producedRef?: string }>;
  outputEdited: Array<{ at: string; diff?: string; rule_version?: number }>;
  ruleViolated: Array<{ at: string; detail?: string; rule_version?: number }>;
  userDismissed: Array<{ at: string; source?: string; rule_version?: number }>;
  conflicts: Array<{ at: string; inputFeature?: string; chosen?: string; versions?: [number, number]; key: string }>;
  revision: Revision;
}

/** 负样本记录（append-only 日志的一行；class/objectType 由路由聚合补齐） */
interface NegativeSample {
  at: string;
  pattern: string;
  action: string;
  class?: 'signal_mismatch' | 'not_a_habit';
  objectType?: string;
}

/** 规则 → 表单草稿 */
function toDraft(rule: RuleRecord): StepDraft[] {
  return rule.steps.map((s) => ({ kind: s.kind, text: s.text, annex: s.annex === true }));
}

/** 表单草稿 → 提交用 steps（丢空文本；annex 只随 judgment 携带） */
function toSteps(drafts: StepDraft[]): RuleStep[] {
  return drafts
    .filter((d) => d.text.trim())
    .map((d) => ({
      kind: d.kind,
      text: d.text.trim(),
      ...(d.kind === 'judgment' && d.annex ? { annex: true } : {}),
    }));
}

/** 逗号（中英）分隔的触发词 → 数组 */
function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 新建草稿：默认一个确定性步骤（承诺 = Guaranteed） */
function emptyDraft(): Draft {
  return {
    mode: 'create',
    name: '',
    intent: '',
    keywords: '',
    steps: [{ kind: 'deterministic', text: '', annex: false }],
  };
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`（无效输入原样返回） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 承诺级别 → 英文显示名（未知值原样返回，避免空展示） */
function commitmentLabel(c: string): string {
  return COMMITMENT_LABELS[c as keyof typeof COMMITMENT_LABELS] ?? c;
}

/** 独立浮窗默认样式（embedded 时改为填满父栏，由抽屉提供边框与背景） */
function panelStyle(embedded?: boolean): React.CSSProperties {
  if (embedded) {
    return {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
    };
  }
  return {
    position: 'fixed',
    right: 20,
    top: 64,
    width: 420,
    maxHeight: 'calc(100vh - 108px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 16,
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    zIndex: 1200,
  };
}

const smallBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--surface-muted)',
  color: 'var(--foreground)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const dangerBtn: React.CSSProperties = { ...smallBtn, color: 'var(--danger)', borderColor: 'var(--danger)' };

/** 徽标（kind / status / commitment） */
const badge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  lineHeight: '16px',
  border: '1px solid var(--border)',
  color: 'var(--muted-foreground)',
};

const commitmentBadge: React.CSSProperties = {
  ...badge,
  borderColor: 'var(--primary-strong)',
  color: 'var(--primary-strong)',
  background: 'var(--primary-soft)',
};

/** 修订建议标记（醒目但不抢承诺徽标的位） */
const revisionBadge: React.CSSProperties = {
  ...badge,
  borderColor: 'var(--danger)',
  color: 'var(--danger)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 8,
  border: '1px solid var(--border)',
  padding: '6px 8px',
  fontSize: 13,
  background: 'var(--popover)',
  color: 'var(--foreground)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--muted-foreground)',
  marginBottom: 4,
  display: 'block',
};

/** 分区标题（Signals / Preferences 段内的小标题） */
const sectionHeading: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  margin: '2px 0 6px',
};

const mutedText: React.CSSProperties = { fontSize: 12, color: 'var(--muted-foreground)' };

/** 药丸按钮样式（Signals 段的规则选择器仍在用；总览层已改成脑图，不再有横向标签） */
function tabBtn(active: boolean): React.CSSProperties {
  return {
    border: '1px solid ' + (active ? 'var(--primary-strong)' : 'var(--border)'),
    background: active ? 'var(--primary-soft)' : 'transparent',
    color: active ? 'var(--primary-strong)' : 'var(--muted-foreground)',
    borderRadius: 999,
    padding: '3px 12px',
    fontSize: 12,
    cursor: 'pointer',
  };
}

/**
 * 脑图落点（Customize 首屏）——「大脑 + 突触」四节点总览。
 *
 * 进入 Customize 先落在脑图，点某个节点才进对应分区页；分区页不再保留横向标签，
 * 只留左上角 `← All` 回到脑图。
 *
 * 几何是**算出来的、不是估的**，改坐标前先读懂这套映射：
 *   - 平面坐标系固定为 720 × 400（与容器 aspect-ratio 同比例），脑与节点的位置全用百分比，
 *     因此百分比 → 平面坐标是确定的：x = pct × 720，y = pct × 400。
 *   - 脑容器宽 26% 且 aspect-ratio 1 → 187.2 × 187.2，居中于 (360, 200)，
 *     即 x ∈ [266.4, 453.6]、y ∈ [106.4, 293.6]；脑 SVG 用 viewBox 0 0 120 120，
 *     故 平面坐标 = (266.4 + 1.56·vx, 106.4 + 1.56·vy)。
 *   - 突触终点取脑轮廓曲线上的实点（反解三次贝塞尔得到），所以连线端点必然贴在皮层上；
 *     起点取卡片左右边的垂直中点（卡片宽 22%、居中定位 → 左卡右边 = 0.208×720 + 0.11×720）。
 *   - 脑、连线、卡片必须同处一个 z 平面（不设 translateZ）：一旦给其中一层加 z，
 *     透视会把它额外放大并位移，端点就会脱离皮层——这里踩过一次坑。
 */
const BRAIN_MAP_CSS = `
.czb-flow { animation: czb-run 1.5s linear infinite; }
.czb-spark { animation: czb-run 2.2s linear infinite; }
.czb-cortex { animation: czb-run 4.2s linear infinite; }
.czb-port { animation: czb-pulse 1.9s ease-in-out infinite; }
.czb-burst { opacity: 0; animation: czb-burst 2.2s linear infinite; }
@keyframes czb-run { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
@keyframes czb-pulse { 50% { opacity: .35; } }
@keyframes czb-burst {
  0% { opacity: 0; transform: scale(.45); }
  4% { opacity: 1; transform: scale(1); }
  13% { opacity: .6; transform: scale(1.35); }
  24% { opacity: 0; transform: scale(1.55); }
  100% { opacity: 0; transform: scale(1.55); }
}
@media (prefers-reduced-motion: reduce) {
  .czb-flow, .czb-spark, .czb-cortex, .czb-port, .czb-burst { animation: none; }
}
`;

/** 突触：起点在卡片边缘中点，终点在皮层实点；pathLength=100 把虚线周期归一化，四条长短不一的线才不会跳帧 */
const SYNAPSES = [
  'M229 92 C 261 92 261 165 292.9 165',
  'M490.6 92 C 458.9 92 458.9 165 427.1 165',
  'M229 308 C 260.3 308 260.3 216.8 291.5 216.8',
  'M490.6 308 C 459.6 308 459.6 216.8 428.5 216.8',
];

/** 皮层上的四个接入焊点（与 SYNAPSES 的终点一一对应） */
const CORTEX_PORTS = [
  [292.9, 165],
  [427.1, 165],
  [291.5, 216.8],
  [428.5, 216.8],
];

/** 简笔画大脑：单线双半球，Z 收口自然形成中线 */
const BRAIN_SHELL = [
  'M60 15 C 45 8 28 16 23 32 C 13 37 11 53 18 62 C 13 73 18 88 30 92 C 33 103 46 108 60 103 Z',
  'M60 15 C 75 8 92 16 97 32 C 107 37 109 53 102 62 C 107 73 102 88 90 92 C 87 103 74 108 60 103 Z',
];

const BRAIN_GYRI = [
  'M48 42 C 42 47 43 57 50 61',
  'M72 42 C 78 47 77 57 70 61',
  'M43 77 C 48 75 53 78 54 84',
  'M77 77 C 72 75 67 78 66 84',
];

/** 四个入口节点：标签 + 一行说明（说明文案与各分区页的实际内容对应） */
const BRAIN_NODES: { key: Section; label: string; sub: string; left: string; top: string }[] = [
  { key: 'rules', label: 'RULES', sub: 'commitments', left: '20.8%', top: '23%' },
  { key: 'skills', label: 'SKILLS', sub: 'learned', left: '79.2%', top: '23%' },
  { key: 'signals', label: 'SIGNALS', sub: 'hit timeline', left: '20.8%', top: '77%' },
  { key: 'memories', label: 'MEMORIES', sub: 'about you', left: '79.2%', top: '77%' },
];

const CURRENT = '#10B981';
const CURRENT_BRIGHT = '#34D399';
const CURRENT_GLOW = 'rgba(16, 185, 129, 0.6)';

function BrainMap({ onPick }: { onPick: (s: Section) => void }) {
  const [tilt, setTilt] = useState({ rx: 12, ry: 0 });
  const [hover, setHover] = useState<Section | null>(null);

  /** 鼠标位置驱动轻微视差：只是 2.5D 观感，不参与几何计算 */
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setTilt({
      rx: 12 - ((e.clientY - b.top) / b.height - 0.5) * 7,
      ry: ((e.clientX - b.left) / b.width - 0.5) * 9,
    });
  };

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', padding: 12, perspective: 1000 }}
      onMouseMove={handleMove}
      onMouseLeave={() => setTilt({ rx: 12, ry: 0 })}
    >
      <style>{BRAIN_MAP_CSS}</style>
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '720 / 400',
          transformStyle: 'preserve-3d',
          transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
          transition: 'transform 200ms ease-out',
        }}
      >
        {/* 突触：透明导线 + 绿色电流（光晕 / 流动虚线 / 跑动电花 / 焊点） */}
        <svg viewBox="0 0 720 400" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} aria-hidden>
          <g fill="none" strokeLinecap="round">
            {SYNAPSES.map((d) => (
              <path key={`halo-${d}`} d={d} stroke={CURRENT} strokeWidth={7} opacity={0.2} style={{ filter: 'blur(3.5px)' }} />
            ))}
            {SYNAPSES.map((d) => (
              <path
                key={`flow-${d}`}
                className="czb-flow"
                d={d}
                pathLength={100}
                stroke={CURRENT_BRIGHT}
                strokeWidth={2}
                strokeDasharray="4 16"
                style={{ filter: `drop-shadow(0 0 3px ${CURRENT_GLOW})` }}
              />
            ))}
            {SYNAPSES.map((d, i) => (
              <path
                key={`spark-${d}`}
                className="czb-spark"
                d={d}
                pathLength={100}
                stroke={CURRENT_BRIGHT}
                strokeWidth={3.2}
                strokeDasharray="3 97"
                style={{ animationDuration: `${2.2 + i * 0.45}s`, filter: `drop-shadow(0 0 6px ${CURRENT_GLOW})` }}
              />
            ))}
            {CORTEX_PORTS.map(([cx, cy]) => (
              <circle
                key={`port-${cx}-${cy}`}
                className="czb-port"
                cx={cx}
                cy={cy}
                r={2.6}
                fill={CURRENT_BRIGHT}
                style={{ filter: `drop-shadow(0 0 5px ${CURRENT_GLOW})` }}
              />
            ))}
            {/* 交汇火花：电花（czb-spark）沿路径走完一个周期恰好抵达皮层焊点，故本组用
                animationDelay = animationDuration = 同一索引的周期，与电花到达时刻对齐；
                延迟期间由 .czb-burst 的 opacity:0 保持不可见 */}
            {CORTEX_PORTS.map(([x, y], i) => {
              const dur = 2.2 + i * 0.45;
              return (
                <g
                  key={`burst-${x}-${y}`}
                  className="czb-burst"
                  style={{
                    transformBox: 'view-box',
                    transformOrigin: `${x}px ${y}px`,
                    animationDuration: `${dur}s`,
                    animationDelay: `${dur}s`,
                    filter: `drop-shadow(0 0 5px ${CURRENT_GLOW})`,
                  }}
                >
                  <circle cx={x} cy={y} r={7} fill="none" stroke={CURRENT_BRIGHT} strokeWidth={1.4} />
                  <g stroke={CURRENT_BRIGHT} strokeWidth={1.8}>
                    <path d={`M${x - 12} ${y} h5 M${x + 7} ${y} h5 M${x} ${y - 12} v5 M${x} ${y + 7} v5`} />
                    <path
                      d={`M${x - 8} ${y - 8} l3.5 3.5 M${x + 4.5} ${y + 4.5} l3.5 3.5 M${x + 8} ${y - 8} l-3.5 3.5 M${x - 4.5} ${y + 4.5} l-3.5 3.5`}
                    />
                  </g>
                  <circle cx={x} cy={y} r={2.6} fill={CURRENT_BRIGHT} />
                </g>
              );
            })}
          </g>
        </svg>

        {/* 大脑：黑色线稿；皮层上叠一道绿色电流 */}
        <div
          style={{ position: 'absolute', left: '50%', top: '50%', width: '26%', aspectRatio: '1', transform: 'translate(-50%, -50%)' }}
          aria-hidden
        >
          <svg viewBox="0 0 120 120" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
            <g fill="none" strokeLinejoin="round" strokeLinecap="round">
              {BRAIN_SHELL.map((d) => (
                <path key={`shell-${d}`} d={d} stroke="var(--foreground)" strokeWidth={3} />
              ))}
              {BRAIN_SHELL.map((d) => (
                <path
                  key={`cortex-${d}`}
                  className="czb-cortex"
                  d={d}
                  pathLength={100}
                  stroke={CURRENT_BRIGHT}
                  strokeWidth={3.2}
                  strokeDasharray="9 91"
                  style={{ filter: `drop-shadow(0 0 5px ${CURRENT_GLOW})` }}
                />
              ))}
              {BRAIN_GYRI.map((d) => (
                <path key={`gyri-${d}`} d={d} stroke="var(--foreground)" strokeWidth={2} opacity={0.5} />
              ))}
            </g>
          </svg>
        </div>

        {BRAIN_NODES.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => onPick(n.key)}
            onMouseEnter={() => setHover(n.key)}
            onMouseLeave={() => setHover(null)}
            style={{
              position: 'absolute',
              left: n.left,
              top: n.top,
              width: '22%',
              transform: 'translate(-50%, -50%)',
              padding: '8px 0',
              textAlign: 'center',
              borderRadius: 8,
              background: 'transparent',
              border: '1px solid var(--foreground)',
              boxShadow: hover === n.key ? `0 0 12px ${CURRENT_GLOW}` : 'none',
              cursor: 'pointer',
              transition: 'box-shadow 120ms ease-out',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.02em', color: hover === n.key ? CURRENT : 'var(--foreground)' }}>
              {n.label}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{n.sub}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ButlerRulesPanel({ onClose, embedded, initialSection }: ButlerRulesPanelProps) {
  const [section, setSection] = useState<Section>(initialSection ?? 'rules');
  /** 是否停在脑图落点：默认是；被外部指定分区（如 openButlerMemories）时直接进页 */
  const [landing, setLanding] = useState(!initialSection);

  /** 规则列表（Rules 段 + Signals 段的规则选择器共用） */
  const [items, setItems] = useState<RuleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 正在编辑 / 新建的草稿（null = 无表单） */
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 待确认删除的规则 id（两步确认，避免误删规则） */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 悬挂规则 id 集合（scope_target 项目已不存在） */
  const [dangling, setDangling] = useState<Set<string>>(new Set());
  /** 各规则修订评估（用于列表上的「修订建议」标记） */
  const [revisions, setRevisions] = useState<Record<string, Revision>>({});

  /** Signals 段：当前查看的规则与详情 */
  const [signalRuleId, setSignalRuleId] = useState<string | null>(null);
  const [signals, setSignals] = useState<SignalsData | null>(null);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [signalsError, setSignalsError] = useState<string | null>(null);

  /** Rules 段的「被拉黑模式」（负样本）：可见与解封 */
  const [negatives, setNegatives] = useState<NegativeSample[]>([]);
  const [negativesLoading, setNegativesLoading] = useState(false);
  const [negativesError, setNegativesError] = useState<string | null>(null);
  const [unblockBusy, setUnblockBusy] = useState<string | null>(null);

  /** Skills 段：技能列表 + 成败信号 + 展开的详情 + 治理动作忙碌标记 */
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillSignals, setSkillSignals] = useState<Record<string, SkillSignal>>({});
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillDetailId, setSkillDetailId] = useState<string | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);

  /** 拉取规则列表（纯读，供多处复用） */
  const fetchRules = useCallback(async (): Promise<RuleRecord[]> => {
    const res = await fetch('/api/butler/rules');
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error ?? 'Failed to load rules');
    return data.rules as RuleRecord[];
  }, []);

  /** 拉取全部规则的修订评估（一次批量，避免列表逐规则 N 次请求） */
  const loadRevisions = useCallback(async () => {
    try {
      const res = await fetch('/api/butler/rules/signals');
      const data = await res.json();
      if (data?.success) setRevisions((data.revisions ?? {}) as Record<string, Revision>);
    } catch {
      /* 修订标记拿不到不阻塞规则列表 */
    }
  }, []);

  /** 拉取规则 + 项目列表，做悬挂惰性对账，并刷新修订标记 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rules, projRes] = await Promise.all([
        fetchRules(),
        fetch('/api/projects').catch(() => null),
      ]);
      setItems(rules);
      setError(null);

      // 悬挂判定：仅当项目列表成功返回时才判定，避免拉取失败导致项目级规则被误转 paused
      let projectIds: Set<string> | null = null;
      if (projRes && projRes.ok) {
        try {
          const pd = await projRes.json();
          if (pd?.success && Array.isArray(pd.projects)) {
            projectIds = new Set<string>((pd.projects as Array<{ id: string }>).map((p) => p.id));
          }
        } catch {
          projectIds = null;
        }
      }

      if (!projectIds) {
        setDangling(new Set());
        return;
      }

      const dangle = new Set(
        rules
          .filter((r) => r.scope === 'project' && !!r.scopeTarget && !projectIds!.has(r.scopeTarget))
          .map((r) => r.id),
      );
      setDangling(dangle);

      // 惰性对账：生效中的悬挂规则转 paused（不接调度器，见计划 D9）
      const toPause = rules.filter((r) => dangle.has(r.id) && r.status === 'active');
      if (toPause.length > 0) {
        await Promise.all(
          toPause.map((r) =>
            fetch('/api/butler/rules', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: r.id, status: 'paused', expected_version: r.version }),
            }),
          ),
        );
        setItems(await fetchRules());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, [fetchRules]);

  /** 规则变更后的统一刷新（列表 + 修订标记） */
  const refresh = useCallback(async () => {
    await Promise.all([load(), loadRevisions()]);
  }, [load, loadRevisions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 外部指定分区变化时跟随（如抽屉里再点一次「记忆」入口）——同时跳过脑图直接进页 */
  useEffect(() => {
    if (initialSection) {
      setSection(initialSection);
      setLanding(false);
    }
  }, [initialSection]);

  const startCreate = () => {
    setPendingDelete(null);
    setError(null);
    setDraft(emptyDraft());
  };

  const startEdit = (rule: RuleRecord) => {
    setPendingDelete(null);
    setError(null);
    setDraft({
      mode: 'edit',
      id: rule.id,
      version: rule.version,
      name: rule.name,
      intent: rule.intentRaw,
      keywords: (rule.trigger?.keywords ?? []).join(', '),
      steps: toDraft(rule),
    });
  };

  const save = async () => {
    if (!draft) return;
    const steps = toSteps(draft.steps);
    if (!draft.name.trim()) {
      setError('Name is required');
      return;
    }
    if (!draft.intent.trim()) {
      setError('Intent is required');
      return;
    }
    if (steps.length === 0) {
      setError('At least one step is required');
      return;
    }
    setBusy(true);
    try {
      const isEdit = draft.mode === 'edit' && draft.id;
      const res = await fetch('/api/butler/rules', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isEdit
            ? {
                id: draft.id,
                name: draft.name,
                intent_raw: draft.intent,
                steps,
                trigger: { keywords: parseKeywords(draft.keywords) },
                expected_version: draft.version,
              }
            : {
                name: draft.name,
                intent_raw: draft.intent,
                steps,
                trigger: { keywords: parseKeywords(draft.keywords) },
              },
        ),
      });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.conflict ? 'This rule changed elsewhere — reloaded.' : (data?.error ?? 'Failed to save'));
        if (data?.conflict) setDraft(null);
        await refresh();
        return;
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  /** 改状态（pause/resume/retire），带乐观锁版本 */
  const setStatus = async (rule: RuleRecord, status: RuleRecord['status']) => {
    setBusy(true);
    try {
      const res = await fetch('/api/butler/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, status, expected_version: rule.version }),
      });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.conflict ? 'This rule changed elsewhere — reloaded.' : (data?.error ?? 'Failed to update'));
        await refresh();
        return;
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/butler/rules?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? 'Failed to delete');
        return;
      }
      setPendingDelete(null);
      if (signalRuleId === id) {
        setSignalRuleId(null);
        setSignals(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  };

  const updateStep = (i: number, patch: Partial<StepDraft>) => {
    setDraft((d) => (d ? { ...d, steps: d.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) } : d));
  };

  /** 查看某规则的信号详情 */
  const openSignals = async (rule: RuleRecord) => {
    setSignalRuleId(rule.id);
    setSignals(null);
    setSignalsError(null);
    setSignalsLoading(true);
    try {
      const res = await fetch(
        `/api/butler/rules/signals?id=${encodeURIComponent(rule.id)}&version=${rule.version}`,
      );
      const data = await res.json();
      if (!data?.success) {
        setSignalsError(data?.error ?? 'Failed to load signals');
        return;
      }
      setSignals(data as SignalsData);
    } catch (e) {
      setSignalsError(e instanceof Error ? e.message : 'Failed to load signals');
    } finally {
      setSignalsLoading(false);
    }
  };

  /** 拉取被拉黑模式（负样本，Rules 段展示 + 解封） */
  const loadNegatives = useCallback(async () => {
    setNegativesLoading(true);
    setNegativesError(null);
    try {
      const res = await fetch('/api/butler/rules/negative-samples');
      const data = await res.json();
      if (data?.success) setNegatives((data.blocked ?? []) as NegativeSample[]);
      else setNegativesError(data?.error ?? 'Failed to load blocked patterns');
    } catch (e) {
      setNegativesError(e instanceof Error ? e.message : 'Failed to load blocked patterns');
    } finally {
      setNegativesLoading(false);
    }
  }, []);

  // 负样本块住在 Rules 段，进面板即拉取（不再依赖切到某个分区才加载）
  useEffect(() => {
    void loadNegatives();
  }, [loadNegatives]);

  /** 拉取技能列表 + 成败信号（按需，切到 Skills 段时） */
  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const res = await fetch('/api/butler/skills');
      const data = await res.json();
      if (!data?.success) {
        setSkillsError(data?.error ?? 'Failed to load skills');
        return;
      }
      setSkills((data.skills ?? []) as SkillRecord[]);
      setSkillSignals((data.signals ?? {}) as Record<string, SkillSignal>);
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : 'Failed to load skills');
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  /** 技能治理动作：停用（retire）/ 解封（unquarantine），带乐观锁版本 */
  const changeSkillLifecycle = async (skill: SkillRecord, action: 'retire' | 'unquarantine') => {
    setSkillBusy(skill.id);
    try {
      const res = await fetch('/api/butler/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skill.id, action, expected_version: skill.version }),
      });
      const data = await res.json();
      if (!data?.success) {
        setSkillsError(data?.conflict ? 'This skill changed elsewhere — reloaded.' : (data?.error ?? 'Failed to update'));
        await loadSkills();
        return;
      }
      await loadSkills();
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setSkillBusy(null);
    }
  };

  /** 从脑图进入某分区；Skills 按需拉取（Memories 段由内嵌面板自行加载） */
  const openSection = (s: Section) => {
    setSection(s);
    setLanding(false);
    if (s === 'skills') void loadSkills();
  };

  /** 解封某模式（追加 unblocked 记录，读侧 latest-wins 立即恢复候选；按 类 + 对象类型 精确定位） */
  const unblock = async (n: NegativeSample) => {
    const key = `${n.objectType ?? 'rule'}__${n.pattern}__${n.class ?? 'signal_mismatch'}`;
    setUnblockBusy(key);
    try {
      const params = new URLSearchParams({
        pattern: n.pattern,
        object_type: n.objectType ?? 'rule',
        class: n.class ?? 'signal_mismatch',
      });
      const res = await fetch(
        `/api/butler/rules/negative-samples?${params.toString()}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!data?.success) {
        setNegativesError(data?.error ?? 'Failed to unblock');
        return;
      }
      await loadNegatives();
    } catch (e) {
      setNegativesError(e instanceof Error ? e.message : 'Failed to unblock');
    } finally {
      setUnblockBusy(null);
    }
  };

  /** 表单实时预览的承诺级别（与保存后服务端派生同一函数，所见即所得） */
  const previewCommitment = draft ? deriveCommitment(toSteps(draft.steps)) : null;

  /** 规则名反查（负样本 pattern 是规则 id，展示时映射成名字） */
  const ruleName = (id: string): string => items.find((r) => r.id === id)?.name ?? id;

  /** Signals 段：一小段信号列表的通用渲染 */
  const renderSignalBlock = (label: string, rows: React.ReactNode[]) => (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionHeading}>{label}</div>
      {rows.length === 0 ? (
        <div style={mutedText}>None yet</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{rows}</div>
      )}
    </div>
  );

  /** 信号条目行 */
  const signalRow = (key: string, at: string, text: string) => (
    <div key={key} style={{ display: 'flex', gap: 8, lineHeight: 1.5 }}>
      <span style={{ ...mutedText, flexShrink: 0 }}>{fmtTime(at)}</span>
      <span>{text}</span>
    </div>
  );

  return (
    <aside style={panelStyle(embedded)} role="dialog" aria-label="Customize panel">
      <header style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {!landing && (
              <button
                type="button"
                onClick={() => setLanding(true)}
                style={{ ...smallBtn, border: 'none', background: 'transparent', padding: '2px 4px' }}
                aria-label="Back to map"
              >
                ← All
              </button>
            )}
            <div style={{ fontSize: 14, fontWeight: 500 }}>Customize</div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} style={{ ...smallBtn, border: 'none', background: 'transparent' }} aria-label="Close">
              ✕
            </button>
          )}
        </div>
      </header>

      {/* 首屏：脑图落点；点节点才进分区页（页面内不再有横向标签，靠左上角 ← All 返回） */}
      {landing ? (
        <BrainMap onPick={openSection} />
      ) : section === 'memories' ? (
        /* Memories 段直接嵌整个面板（它自带栏头与滚动区），不再套这层带内边距的滚动容器。
           外面这层 flex-1/min-h-0 是必需的：内嵌面板是 height:100% 的 column，
           直接放在本栏 header 之下会被 header 顶出去，留出可收缩的槽位才对。 */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ButlerMemoryPanel embedded />
        </div>
      ) : (
      <div style={{ padding: 12, overflowY: 'auto', ...(embedded ? { flex: 1, minHeight: 0 } : {}) }}>
        {/* ==================== Rules ==================== */}
        {section === 'rules' && (
          <>
            {loading && <p style={mutedText}>Loading…</p>}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

            {!draft && (
              <div style={{ marginBottom: 12 }}>
                <button type="button" onClick={startCreate} style={smallBtn}>
                  + New rule
                </button>
              </div>
            )}

            {draft && (
              <section
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: 'var(--surface-muted)',
                  marginBottom: 12,
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ fontWeight: 500, marginBottom: 8 }}>{draft.mode === 'create' ? 'New rule' : 'Edit rule'}</div>

                <label style={labelStyle} htmlFor="rule-name">
                  Name
                </label>
                <input
                  id="rule-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. No coriander"
                  style={inputStyle}
                />

                <label style={{ ...labelStyle, marginTop: 8 }} htmlFor="rule-intent">
                  Intent (your words)
                </label>
                <textarea
                  id="rule-intent"
                  value={draft.intent}
                  onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                  rows={2}
                  placeholder="Keep the original wording, don't rewrite it"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />

                <label style={{ ...labelStyle, marginTop: 8 }} htmlFor="rule-keywords">
                  Trigger words (comma separated, optional)
                </label>
                <input
                  id="rule-keywords"
                  value={draft.keywords}
                  onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                  placeholder="coriander, cilantro"
                  style={inputStyle}
                />

                <div style={{ ...labelStyle, marginTop: 10 }}>Steps</div>
                {draft.steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <select
                      value={s.kind}
                      onChange={(e) => updateStep(i, { kind: e.target.value as StepKind })}
                      aria-label="Step kind"
                      style={{ ...inputStyle, width: 118, flexShrink: 0 }}
                    >
                      <option value="deterministic">Deterministic</option>
                      <option value="judgment">Judgment</option>
                    </select>
                    <input
                      value={s.text}
                      onChange={(e) => updateStep(i, { text: e.target.value })}
                      aria-label="Step text"
                      placeholder="What to do"
                      style={inputStyle}
                    />
                    {s.kind === 'judgment' && (
                      <label
                        title="Annex step: a secondary check, keeps commitment at 'Mostly reliable'"
                        style={{ fontSize: 11, color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
                      >
                        <input type="checkbox" checked={s.annex} onChange={(e) => updateStep(i, { annex: e.target.checked })} />
                        annex
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) })}
                      disabled={draft.steps.length <= 1}
                      style={{ ...smallBtn, flexShrink: 0 }}
                      aria-label="Remove step"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, steps: [...draft.steps, { kind: 'deterministic', text: '', annex: false }] })}
                  style={smallBtn}
                >
                  + Step
                </button>

                {previewCommitment && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    Commitment: <span style={commitmentBadge}>{COMMITMENT_LABELS[previewCommitment]}</span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={() => void save()} disabled={busy} style={smallBtn}>
                    Save
                  </button>
                  <button type="button" onClick={() => setDraft(null)} style={smallBtn}>
                    Cancel
                  </button>
                </div>
              </section>
            )}

            {!loading && !error && items.length === 0 && !draft && (
              <p style={mutedText}>Nothing yet.</p>
            )}

            {items.map((rule) => {
              const keywords = rule.trigger?.keywords ?? [];
              const isRetired = rule.status === 'retired';
              const isDangling = dangling.has(rule.id);
              const rev = revisions[rule.id];
              return (
                <div
                  key={rule.id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    background: 'var(--surface-muted)',
                    marginBottom: 8,
                    opacity: isRetired ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500, lineHeight: 1.5 }}>{rule.name}</span>
                    <span style={badge}>{KIND_LABELS[rule.kind] ?? rule.kind}</span>
                    <span style={badge}>{STATUS_LABELS[rule.status] ?? rule.status}</span>
                    <span style={commitmentBadge}>{commitmentLabel(rule.commitment)}</span>
                    {rev?.shouldPropose && <span style={revisionBadge}>Revision suggested</span>}
                  </div>

                  {rule.intentRaw && (
                    <div style={{ marginTop: 4, color: 'var(--muted-foreground)', lineHeight: 1.6 }}>{rule.intentRaw}</div>
                  )}

                  {/* 悬挂提示：所属项目已不存在（该规则已按惰性对账转为 paused） */}
                  {isDangling && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
                      Owning project no longer exists
                    </div>
                  )}

                  {/* 修订建议：最近窗口否定率超阈值（点击 Signals 可看明细） */}
                  {rev?.shouldPropose && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
                      Dismissed {Math.round((rev.ratio ?? 0) * 100)}% of the last {REVISION_WINDOW} hits — consider revising
                    </div>
                  )}

                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    {keywords.map((k) => (
                      <span key={k} style={badge}>
                        {k}
                      </span>
                    ))}
                    <span style={mutedText}>
                      {rule.steps.length} step{rule.steps.length === 1 ? '' : 's'} · {rule.scope}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button type="button" onClick={() => void openSignals(rule)} style={smallBtn}>
                      Signals
                    </button>
                    <button type="button" onClick={() => startEdit(rule)} style={smallBtn}>
                      Edit
                    </button>
                    {rule.status === 'active' ? (
                      <button type="button" onClick={() => void setStatus(rule, 'paused')} disabled={busy} style={smallBtn}>
                        Pause
                      </button>
                    ) : rule.status === 'paused' ? (
                      <button type="button" onClick={() => void setStatus(rule, 'active')} disabled={busy} style={smallBtn}>
                        Resume
                      </button>
                    ) : null}
                    {!isRetired && (
                      <button type="button" onClick={() => void setStatus(rule, 'retired')} disabled={busy} style={smallBtn}>
                        Retire
                      </button>
                    )}
                    {pendingDelete === rule.id ? (
                      <>
                        <button type="button" onClick={() => void doDelete(rule.id)} disabled={busy} style={dangerBtn}>
                          Confirm delete
                        </button>
                        <button type="button" onClick={() => setPendingDelete(null)} style={smallBtn}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setPendingDelete(rule.id)} style={smallBtn}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* 被拉黑模式（负样本）：从 Preferences 段迁来——它的写口是
                /api/butler/rules/negative-samples，属规则学习闭环，与记忆不是一件事 */}
            <div style={{ ...sectionHeading, marginTop: 14 }}>Blocked patterns</div>
            <p style={{ ...mutedText, marginTop: 0, marginBottom: 8 }}>
              Patterns you said no to. Unblock to re-enable.
            </p>
            {negativesLoading && <p style={mutedText}>Loading…</p>}
            {negativesError && <p style={{ color: 'var(--danger)' }}>{negativesError}</p>}
            {!negativesLoading && negatives.length === 0 && <p style={mutedText}>No blocked patterns.</p>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {([
                { cls: 'signal_mismatch', title: 'No longer ask' },
                { cls: 'not_a_habit', title: 'Not a habit' },
              ] as const).map((g) => {
                const rows = negatives.filter((n) => (n.class ?? 'signal_mismatch') === g.cls);
                return (
                  <div key={g.cls}>
                    <span style={badge}>{g.title}</span>
                    {!negativesLoading && rows.length === 0 && <p style={{ ...mutedText, marginTop: 6 }}>None.</p>}
                    {rows.map((n) => {
                      const key = `${n.objectType ?? 'rule'}__${n.pattern}__${n.class ?? 'signal_mismatch'}`;
                      const label = n.objectType === 'rule' || !n.objectType ? ruleName(n.pattern) : n.pattern;
                      return (
                        <div
                          key={key}
                          style={{
                            padding: 10,
                            borderRadius: 10,
                            background: 'var(--surface-muted)',
                            marginBottom: 8,
                          }}
                        >
                          <div style={{ lineHeight: 1.5 }}>{label}</div>
                          <div style={mutedText}>
                            {n.action} · {fmtTime(n.at)}
                          </div>
                          <button
                            type="button"
                            onClick={() => void unblock(n)}
                            disabled={unblockBusy === key}
                            style={{ ...smallBtn, marginTop: 6 }}
                          >
                            Unblock
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ==================== Signals ==================== */}
        {section === 'signals' && (
          <>
            {items.length === 0 ? (
              <p style={mutedText}>No rules yet.</p>
            ) : (
              <>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Pick a rule</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {items.map((rule) => (
                    <button
                      key={rule.id}
                      type="button"
                      onClick={() => void openSignals(rule)}
                      style={tabBtn(signalRuleId === rule.id)}
                    >
                      {rule.name}
                    </button>
                  ))}
                </div>

                {!signalRuleId && <p style={mutedText}>Select a rule.</p>}
                {signalsLoading && <p style={mutedText}>Loading…</p>}
                {signalsError && <p style={{ color: 'var(--danger)' }}>{signalsError}</p>}

                {signals && signalRuleId && (
                  <>
                    <div style={{ ...sectionHeading, fontSize: 13 }}>{ruleName(signalRuleId)}</div>
                    <div style={{ ...mutedText, marginBottom: 12 }}>
                      {signals.revision.active
                        ? `Dismissed ${Math.round((signals.revision.ratio ?? 0) * 100)}% of last ${REVISION_WINDOW} hits`
                        : `Needs ${REVISION_WINDOW} hits`}
                      {signals.revision.shouldPropose ? ' · revision suggested' : ''}
                    </div>

                    {renderSignalBlock(
                      'Hits',
                      signals.hits.map((h, i) => signalRow(`h${i}`, h.at, h.scene ? `Hit · ${h.scene}` : 'Hit')),
                    )}
                    {renderSignalBlock(
                      'Output edited',
                      signals.outputEdited.map((o, i) => signalRow(`o${i}`, o.at, o.diff || 'Output changed')),
                    )}
                    {renderSignalBlock(
                      'Rule violated',
                      signals.ruleViolated.map((v, i) => signalRow(`v${i}`, v.at, v.detail || 'Rule violated')),
                    )}
                    {renderSignalBlock(
                      'Dismissed',
                      signals.userDismissed.map((d, i) => signalRow(`d${i}`, d.at, d.source ? `Dismissed · ${d.source}` : 'Dismissed')),
                    )}
                    {renderSignalBlock(
                      'Conflict resolutions',
                      signals.conflicts.map((c, i) =>
                        signalRow(`c${i}`, c.at, `${c.inputFeature ?? 'overlap'} → chose ${c.chosen ?? '?'}`),
                      ),
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* ==================== Skills ==================== */}
        {section === 'skills' && (
          <>
            {skillsLoading && <p style={mutedText}>Loading…</p>}
            {skillsError && <p style={{ color: 'var(--danger)' }}>{skillsError}</p>}

            {!skillsLoading && !skillsError && skills.length === 0 && <p style={mutedText}>No skills yet.</p>}

            {skills.map((skill) => {
              const sig = skillSignals[skill.id];
              const isRetired = skill.lifecycle === 'retired';
              const isQuarantined = skill.lifecycle === 'quarantine';
              const open = skillDetailId === skill.id;
              const busy = skillBusy === skill.id;
              return (
                <div
                  key={skill.id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    background: 'var(--surface-muted)',
                    marginBottom: 8,
                    opacity: isRetired ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500, lineHeight: 1.5 }}>{skill.name}</span>
                    <span style={badge}>{ORIGIN_LABELS[skill.origin] ?? skill.origin}</span>
                    <span style={badge}>{RUNTIME_LABELS[skill.runtime] ?? skill.runtime}</span>
                    <span style={badge}>v{skill.version}</span>
                    <span style={isQuarantined ? revisionBadge : badge}>
                      {LIFECYCLE_LABELS[skill.lifecycle] ?? skill.lifecycle}
                    </span>
                  </div>

                  {skill.description && (
                    <div style={{ marginTop: 4, color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
                      {skill.description}
                    </div>
                  )}

                  {/* 适用条件：什么时候会被自动调用 */}
                  <div style={{ ...mutedText, marginTop: 4 }}>{describeWhen(skill)}</div>

                  {/* 成败：用过几次、成功 / 失败 / 被否 */}
                  {sig && (
                    <div style={{ ...mutedText, marginTop: 4 }}>
                      {sig.runs.ok} ok · {sig.runs.failed} failed · {sig.runs.dismissed} dismissed
                    </div>
                  )}

                  {/* 隔离提示（连续失败达阈值，已自动隔离，可解封） */}
                  {isQuarantined && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
                      Auto-quarantined after {SKILL_FAIL_QUARANTINE} consecutive failures
                    </div>
                  )}

                  {sig?.revision.shouldPropose && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
                      Dismissed {Math.round((sig.revision.ratio ?? 0) * 100)}% of recent runs — consider revising
                    </div>
                  )}

                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      onClick={() => setSkillDetailId(open ? null : skill.id)}
                      style={smallBtn}
                    >
                      {open ? 'Hide' : 'Details'}
                    </button>
                    {isQuarantined && (
                      <button
                        type="button"
                        onClick={() => void changeSkillLifecycle(skill, 'unquarantine')}
                        disabled={busy}
                        style={smallBtn}
                      >
                        Unquarantine
                      </button>
                    )}
                    {!isRetired && (
                      <button
                        type="button"
                        onClick={() => void changeSkillLifecycle(skill, 'retire')}
                        disabled={busy}
                        style={smallBtn}
                      >
                        Retire
                      </button>
                    )}
                  </div>

                  {/* 详情：步骤 / 副作用 / 修订历史（查看 diff） */}
                  {open && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                      <div style={sectionHeading}>Steps</div>
                      {skill.steps.length === 0 ? (
                        <div style={{ ...mutedText, marginBottom: 8 }}>No steps.</div>
                      ) : (
                        <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                          {skill.steps.map((st, i) => (
                            <li key={i} style={{ lineHeight: 1.6 }}>
                              {st.text || st.primitive}
                              {st.params && Object.keys(st.params).length > 0 ? (
                                <span style={mutedText}>
                                  {' '}
                                  · {Object.entries(st.params).map(([k, v]) => `${k}=${v}`).join(', ')}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      )}

                      <div style={sectionHeading}>Effects</div>
                      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                        {describeEffects(skill.grants).map((eff) => (
                          <li key={eff} style={{ lineHeight: 1.6 }}>
                            {eff}
                          </li>
                        ))}
                      </ul>

                      <div style={sectionHeading}>Revisions</div>
                      {skill.revisions.length === 0 ? (
                        <div style={mutedText}>No revisions yet.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {skill.revisions.map((r, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, lineHeight: 1.5 }}>
                              <span style={{ ...mutedText, flexShrink: 0 }}>{fmtTime(r.at)}</span>
                              <span>
                                {r.kind === 'flow' ? `Flow change (v${r.fromVersion} → v${r.fromVersion + 1})` : 'Param change'}
                                {r.note ? ` · ${r.note}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

      </div>
      )}
    </aside>
  );
}