/**
 * WANTED 待办自动标签（跨待办共同主题提取）
 *
 * 规则（用户确认）：
 *   - 只提取"多条待办共同涉及的主体/主题"，如「为华为起草合同」+「回复华为的问题」→ 标签「华为」
 *   - 具体任务本身的通用词重复（起草…合同、回复…问题 中的 起草/合同/问题）不建标签
 *   - 提取方式：任意两条待办标题的公共子串作为候选，剔除含通用任务词的候选，剥离首尾单字虚词
 *   - 候选词出现在 ≥2 条待办标题中才成为标签（按覆盖条数降序展示）
 *   - 未命中任何标签的待办归入 Other
 */
import type { ScheduleEvent } from '@/lib/wanted/schedule';

/** 待办项（通知中心可渲染的最小结构化单元） */
export interface TaggedTodo {
  key: string;
  title: string;
  /** 展示时间（MM/DD HH:mm 或 All-day 描述）；保留原始 ISO 供排序 */
  time: string;
  startMs: number;
  status?: string;
  priority?: string;
  allDay?: boolean;
  /** 命中的主题标签（空数组 = 归入 Other） */
  tags: string[];
}

/** 通用任务词/对象词（多字）：候选标签若包含其中任一，视为任务结构而非共同主题，剔除 */
const GENERIC_WORDS: string[] = [
  '起草', '草拟', '拟定', '撰写', '编写', '制定', '修订', '更新', '修改', '整理', '梳理',
  '采购', '审阅', '回复', '发送', '接收', '提交', '准备', '安排', '召开', '参加', '出席',
  '跟进', '处理', '审核', '审批', '沟通', '联系', '拜访', '记录', '打印', '确认', '商量',
  '讨论', '对接', '购买', '汇报', '总结', '规划', '阅读', '学习', '复习', '检查', '测试',
  '修复', '开发', '完成', '交付', '协调', '分析', '评估', '统计', '收集', '提醒', '预约',
  '预订', '开会', '会议', '合同', '协议', '邮件', '报告', '问题', '材料', '文件', '文档',
  '方案', '设计', '表格', '清单', '纪要', '备忘', '备注', '事项', '内容', '工作', '项目',
  '请求', '要求', '通知', '公告', '说明', '资料', '信息', '日程', '安排表', '服务', '劳动',
  '工资', '费用', '金额', '时间', '地点', '流程', '制度', '规定', '部门', '公司', '账号',
  '进度', '情况', '反馈', '建议', '意见', '数据', '结果', '效果', '评审', '验收', '审批单',
  '报价单', '申请', '申报', '注册', '登记', '办理', '结算', '报销', '付款', '转账', '维护',
  '维修', '下单', '报名', '缴费', '缴纳', '协助', '配合', '告知', '组织', '举办', '开展',
  '推进', '落实', '执行', '实施', '启动', '上线', '发布', '部署', '报表', '台账', '发票',
  '票据', '订单', '单据', '账目', '预算', '决算', '条款', '明细', '汇总', '编制', '对接',
];

/** 单字虚词/介词：仅从候选词首尾剥离（不参与"包含即剔除"判定，避免误伤「华为」这类含「为」的实体） */
const LEADING_WORDS: string[] = ['为', '给', '向', '对', '和', '跟', '与', '在', '从', '把', '被', '到', '及', '并', '或', '与'];
const TRAILING_WORDS: string[] = ['的', '了', '吗', '呢', '啊', '等', '和', '与', '并', '或', '及', '到'];

/** 纯语气词/结构助词：候选标签内部出现即视为碎片拼接，剔除（华为等实体不含这些字） */
const PARTICLE_RE = /[的了吗呢啊]/;

/** 候选词最长提取长度（超长公共串多半是整句任务，主题意义弱） */
const MAX_TAG_LEN = 8;

/** 归一化候选：剥离首尾单字虚词（各剥离一次即可） */
function normalizeCandidate(s: string): string {
  let out = s;
  if (out.length > 1 && LEADING_WORDS.includes(out[0])) out = out.slice(1);
  if (out.length > 1 && TRAILING_WORDS.includes(out[out.length - 1])) out = out.slice(0, -1);
  return out;
}

/** 是否可作为主题标签：长度/字符约束 + 不含通用任务词 + 不含内部语气词 */
function isGoodTag(s: string): boolean {
  if (s.length < 2 || s.length > MAX_TAG_LEN) return false;
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(s)) return false;
  if (PARTICLE_RE.test(s)) return false;
  if (GENERIC_WORDS.some((w) => s.includes(w))) return false;
  return true;
}

/** 标题中被任一通用词覆盖的字符下标集合（用于识别"跨通用词"的碎片候选） */
function genericCoveredIndices(title: string): Set<number> {
  const covered = new Set<number>();
  for (const w of GENERIC_WORDS) {
    let idx = title.indexOf(w);
    while (idx !== -1) {
      for (let k = idx; k < idx + w.length; k++) covered.add(k);
      idx = title.indexOf(w, idx + 1);
    }
  }
  return covered;
}

/** 标签 t 在标题中是否完全不与通用词覆盖位重叠（出现多次时全部须干净） */
function tagIsCleanInTitle(t: string, title: string, covered: Set<number>): boolean {
  let idx = title.indexOf(t);
  while (idx !== -1) {
    let overlaps = false;
    for (let k = idx; k < idx + t.length; k++) {
      if (covered.has(k)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) return false;
    idx = title.indexOf(t, idx + 1);
  }
  return true;
}

/** 生成字符串的全部连续子串（长度 2..MAX_TAG_LEN） */
function allSubstrings(s: string): Set<string> {
  const out = new Set<string>();
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const maxLen = Math.min(MAX_TAG_LEN, n - i);
    for (let len = 2; len <= maxLen; len++) {
      out.add(s.slice(i, i + len));
    }
  }
  return out;
}

/**
 * 为一组待办分配主题标签：
 *   1. 任意两条标题的公共子串 → 候选池（归一化 + 通用词/语气词剔除）
 *   2. 候选出现在 ≥2 条标题中 → 标签（按覆盖条数降序）
 *   3. 每条待办分配命中的标签；未命中任何标签 → Other
 */
export function assignTopicTags(events: ScheduleEvent[]): { tags: string[]; todos: TaggedTodo[] } {
  const titles = events.map((ev) => ev.title);
  const subSets = titles.map(allSubstrings);
  const covered = titles.map(genericCoveredIndices);

  // 1. 候选池：任意两条标题的公共子串
  const candidates = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      for (const s of subSets[i]) {
        if (subSets[j].has(s)) {
          const n = normalizeCandidate(s);
          if (isGoodTag(n)) candidates.add(n);
        }
      }
    }
  }

  // 2. 覆盖条数过滤：出现在 ≥2 条标题中（且不跨通用词）才成为标签
  const withCount = [...candidates].map((c) => ({
    tag: c,
    count: titles.filter((t, ti) => t.includes(c) && tagIsCleanInTitle(c, t, covered[ti])).length,
  }));
  const tags = withCount
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count || b.tag.length - a.tag.length)
    .map((x) => x.tag);

  // 3. 每条待办分配命中的标签
  const todos: TaggedTodo[] = events.map((ev, i) => {
    const hit = tags.filter((t) => ev.title.includes(t) && tagIsCleanInTitle(t, ev.title, covered[i]));
    const d = new Date(ev.start_time);
    const startMs = Number.isFinite(d.getTime()) ? d.getTime() : 0;
    const time = ev.all_day
      ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} All-day`
      : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return {
      key: ev.event_id || `${ev.start_time}-${ev.title}`,
      title: ev.title,
      time,
      startMs,
      status: ev.status,
      priority: ev.priority,
      allDay: ev.all_day,
      tags: hit,
    };
  });

  return { tags, todos };
}
