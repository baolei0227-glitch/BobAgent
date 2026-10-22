/**
 * Coding 小程序质量基准（wish → app 回归用）。
 *
 * 定位：不是自动跑模型（那需要真实 API Key 与长时间等待），而是给「已经生成出来的 app」
 * 一把可重复的尺子。流程：
 *   1) 在 UI 里用对应愿望生成一个 app；
 *   2) 运行 `pnpm coding:benchmark --app <appId> --case <caseId>`；
 *   3) 检查项失败即视为该 case 回归（退出码 1）。
 *
 * 纯函数 + 无 fs：便于单测，也便于脚本/接口复用。
 */

export interface BenchmarkPattern {
  label: string;
  /** 正则源码（不带 /.../） */
  regex: string;
  flags?: string;
}

export interface CodingBenchmarkCase {
  id: string;
  label: string;
  /** 生成该 app 时使用的愿望（用于人工复现） */
  wish: string;
  /** 建议模板（不是硬门禁；模板只是起点） */
  template: string;
  expect: {
    /** 必须出现在入口或 smoke-test.js 里的能力标记 */
    patterns: BenchmarkPattern[];
    /** 出现即失败（UI/交互红线） */
    forbid?: BenchmarkPattern[];
    /** 是否要求 smoke-test.js 存在且写 __testResult */
    requireSmokeTest?: boolean;
  };
}

export const CODING_BENCHMARKS: CodingBenchmarkCase[] = [
  {
    id: 'todo',
    label: 'Todo — list + disk persistence',
    wish: '做一个待办清单：可以添加、勾选完成、删除，关掉再打开历史记录还在。',
    template: 'todo',
    expect: {
      patterns: [
        { label: 'disk persistence (BobStorage.save)', regex: 'BobStorage\\.save' },
        { label: 'add/remove interaction', regex: 'addEventListener|onclick' },
        { label: 'render list', regex: '<ul|<li|tbody|list' },
      ],
      requireSmokeTest: true,
    },
  },
  {
    id: 'calculator',
    label: 'Calculator — pure tool, no AI',
    wish: '做一个加班费计算器：输入月薪和加班小时，自动算出应付金额，不需要保存。',
    template: 'calculator',
    expect: {
      patterns: [
        { label: 'input handling', regex: 'addEventListener|oninput|onchange' },
        { label: 'numeric output', regex: 'toFixed|Math\\.|Number\\(' },
      ],
      requireSmokeTest: false,
    },
  },
  {
    id: 'form',
    label: 'Form — validation + persistent history',
    wish: '做一个客户登记表单：姓名/电话必填，提交后保存历史记录，关掉再打开还能看到。',
    template: 'contact-form',
    expect: {
      patterns: [
        { label: 'form/input', regex: '<form|<input' },
        { label: 'validation', regex: 'required|trim\\(\\)|length|if \\(' },
        { label: 'disk persistence', regex: 'BobStorage\\.save' },
      ],
      requireSmokeTest: true,
    },
  },
  {
    id: 'dashboard',
    label: 'Dashboard — charts + theme variables',
    wish: '做一个销售数据看板：KPI 卡片 + 趋势图 + 明细表，配色跟随 BobWork 主题。',
    template: 'data-table',
    expect: {
      patterns: [
        { label: 'chart/visualization', regex: 'echarts|Chart|canvas|<svg' },
        { label: 'theme CSS variables', regex: 'var\\(--primary\\)|var\\(--paper\\)|getTheme' },
      ],
      requireSmokeTest: false,
    },
  },
  {
    id: 'ai-chat',
    label: 'AI chat — streaming model call + model picker',
    wish: '做一个 AI 聊天小助手：可以流式输出，右上角能切换模型。',
    template: 'blank',
    expect: {
      patterns: [
        { label: 'streaming chat', regex: 'chatStream' },
        { label: 'model picker / model id', regex: 'selectedModel|provider:|Model:' },
        { label: 'messages rendering', regex: 'messages|onDelta' },
      ],
      requireSmokeTest: true,
    },
  },
  {
    id: 'graph',
    label: 'Canvas graph — nodes map',
    wish: '做一个当前项目的节点地图：列出节点，点击能定位/查看上游关系。',
    template: 'blank',
    expect: {
      patterns: [
        { label: 'graph/request API', regex: 'graphGetSnapshot|graphRequestPermission|listNodes|readNode' },
        { label: 'canvas fallback', regex: 'Preview|独立页面|catch' },
      ],
      requireSmokeTest: false,
    },
  },
  {
    id: 'host-tool',
    label: 'hostTool — call a host capability',
    wish: '做一个项目文件浏览器：列出当前项目文件，点击能读取内容。',
    template: 'blank',
    expect: {
      patterns: [
        { label: 'hostTool call', regex: 'BobWork\\.host|hostTool|list_directory|read_file' },
        { label: 'error handling', regex: 'catch|try \\{' },
      ],
      requireSmokeTest: false,
    },
  },
];

export interface BenchmarkInput {
  /** 入口文件名（manifest.entry，通常是 index.html） */
  entry: string;
  /** 入口文件内容 */
  content: string;
  /** smoke-test.js 内容（缺省 = 没有） */
  smoke?: string;
}

export interface BenchmarkCheck {
  id: string;
  label: string;
  pass: boolean;
  detail?: string;
}

export interface BenchmarkResult {
  caseId: string;
  passed: boolean;
  score: number;
  checks: BenchmarkCheck[];
}

function regexOf(p: BenchmarkPattern): RegExp {
  return new RegExp(p.regex, p.flags ?? 'i');
}

/** 通用质量门禁（所有小程序都该满足） */
export function genericQualityChecks(input: BenchmarkInput): BenchmarkCheck[] {
  const html = input.content || '';
  const smoke = input.smoke || '';
  const all = `${html}\n${smoke}`;
  const checks: BenchmarkCheck[] = [
    { id: 'entry', label: 'entry file exists and is non-empty', pass: !!input.entry && html.trim().length > 0 },
    { id: 'doctype', label: '<!DOCTYPE html> present', pass: /<!doctype html>/i.test(html) },
    { id: 'viewport', label: 'viewport meta present', pass: /<meta[^>]+name=["']viewport["']/i.test(html) },
    { id: 'no-alert', label: 'no alert() (UI spec forbids it)', pass: !/\balert\s*\(/.test(all), detail: /\balert\s*\(/.test(all) ? 'alert() found' : undefined },
  ];
  return checks;
}

/** 按 case 评估一个已生成的 app。 */
export function evaluateCodingBenchmark(
  input: BenchmarkInput,
  bench: CodingBenchmarkCase,
): BenchmarkResult {
  const checks = genericQualityChecks(input);
  const all = `${input.content || ''}\n${input.smoke || ''}`;
  for (const p of bench.expect.patterns) {
    const re = regexOf(p);
    const hit = re.test(all);
    checks.push({
      id: `pattern:${p.label}`,
      label: p.label,
      pass: hit,
      detail: hit ? undefined : `missing /${p.regex}/`,
    });
  }
  for (const p of bench.expect.forbid ?? []) {
    const re = regexOf(p);
    const hit = re.test(all);
    checks.push({
      id: `forbid:${p.label}`,
      label: `must NOT contain: ${p.label}`,
      pass: !hit,
      detail: hit ? `found /${p.regex}/` : undefined,
    });
  }
  if (bench.expect.requireSmokeTest) {
    const smoke = input.smoke || '';
    checks.push({
      id: 'smoke-test',
      label: 'smoke-test.js exists and writes __testResult',
      pass: smoke.trim().length > 0 && /__testResult/.test(smoke),
      detail: !smoke.trim() ? 'smoke-test.js missing' : /__testResult/.test(smoke) ? undefined : 'missing __testResult',
    });
  }
  const passedCount = checks.filter((c) => c.pass).length;
  return {
    caseId: bench.id,
    passed: checks.every((c) => c.pass),
    score: checks.length > 0 ? passedCount / checks.length : 0,
    checks,
  };
}

export function findCodingBenchmark(id: string): CodingBenchmarkCase | undefined {
  return CODING_BENCHMARKS.find((b) => b.id === id);
}
