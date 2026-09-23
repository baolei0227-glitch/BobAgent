/**
 * MD 一致性检查（仅当前文档，非流式 JSON）。
 *
 * 三类问题：
 *   ① 编号错误（条款重复 / 跳号 / 标题编号重复）—— 纯正则确定性判定
 *   ② 交叉引用断裂（引用「第X条」但全文无该定义）—— 纯正则确定性判定
 *   ③ 术语不一致 —— 抽候选后交模型分组，服务端回校「两种写法都真实出现」才报出（级别 warn）
 *
 * 模型不可用时仍返回 ①② 的结果，并附一条 warn 说明术语检查已跳过（不静默丢失）。
 */
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { resolveModelConfig, type ModelRefRequest } from '@/lib/ai/resolve-model-config';
import {
  runDeterministicChecks,
  extractTermCandidates,
  countTerm,
  type ConsistencyItem,
} from '@/lib/md-consistency/check';

/** 单次最多报出的术语不一致组数 */
const MAX_TERM_GROUPS = 5;
/** 送模型的术语候选上限 */
const MAX_CANDIDATES = 60;

interface MdConsistencyRequest extends ModelRefRequest {
  md: string;
}

interface TermGroup {
  canonical: string;
  variants: string[];
  note?: string;
}

/** 宽松解析模型输出为 JSON 数组（容忍围栏、前后解释、{"groups":[…]} 包裹） */
function parseGroups(raw: string): unknown[] {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = tryParse(text);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') {
    const arr = (direct as { groups?: unknown }).groups;
    if (Array.isArray(arr)) return arr;
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (Array.isArray(sliced)) return sliced;
  }
  return [];
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<MdConsistencyRequest>;
    const md = typeof body.md === 'string' ? body.md : '';
    if (!md.trim()) return NextResponse.json({ success: false, error: '文档为空' }, { status: 400 });

    const items: ConsistencyItem[] = runDeterministicChecks(md);

    // 术语检查：先抽候选，再交模型分组
    const candidates = extractTermCandidates(md, MAX_CANDIDATES);
    let model: string | undefined;
    if (candidates.length >= 2) {
      const config = await resolveModelConfig(body);
      if (!config) {
        items.push({
          key: 'term-skipped',
          level: 'warn',
          msg: 'Terminology check skipped — no model configured',
          fix: 'Configure an API key in Settings to enable terminology consistency checking.',
          kind: 'term',
          locate: '',
        });
      } else {
        model = config.model;
        const list = candidates
          .map((c) => `- ${c.term}（出现 ${c.count} 次${c.related ? `；关联写法：${c.related}` : ''}；来源：${c.source}）`)
          .join('\n');
        const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
        const completion = await client.chat.completions.create({
          model: config.model,
          temperature: 0,
          max_tokens: 1200,
          messages: [
            {
              role: 'system',
              content: `你是合同术语审校员。用户给出一份文档中抽取出的术语候选清单（含出现次数与关联写法），你找出其中**指同一概念却用了不同写法**的组。

❗️输出格式铁律（违反即失败）：
1. 只输出 JSON 数组，禁止输出解释、思考过程、markdown 代码块围栏
2. 每项形如 {"canonical": "推荐写法", "variants": ["另一种写法"], "note": "一句话说明"}
3. canonical 与 variants 里的每一项都必须**逐字复制**清单中出现的术语，不得改写、不得新增
4. 只有确实指同一概念、且全文混用的才报；同义词但语义有别（如「定金」与「订金」）不要报
5. 没有发现不一致时输出 []`,
            },
            {
              role: 'user',
              content: `术语候选清单：\n${list}`,
            },
          ],
        });

        const groups = parseGroups(completion.choices?.[0]?.message?.content ?? '');
        let emitted = 0;
        for (const g of groups) {
          if (emitted >= MAX_TERM_GROUPS) break;
          if (!g || typeof g !== 'object') continue;
          const o = g as Record<string, unknown>;
          const canonical = typeof o.canonical === 'string' ? o.canonical.trim() : '';
          const rawVariants = Array.isArray(o.variants) ? o.variants : [];
          const variants = rawVariants.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
          if (!canonical || variants.length === 0) continue;
          // 回校：每个写法都必须真实出现在原文（防模型编造）
          const forms = [canonical, ...variants];
          if (!forms.every((f) => countTerm(md, f) > 0)) continue;
          const key = `term-${forms.join('|')}`;
          if (items.some((it) => it.key === key)) continue;
          const note = typeof o.note === 'string' ? o.note.trim() : '';
          items.push({
            key,
            level: 'warn',
            msg: `Inconsistent terminology: ${forms.map((f) => `“${f}”`).join(' / ')} used for the same concept`,
            fix: note ? `${note} — unify to “${canonical}” throughout.` : `Unify to “${canonical}” throughout.`,
            kind: 'term',
            // 锚用另一种写法本身（纯文本，正文里逐字存在）
            locate: forms[forms.length - 1],
          });
          emitted++;
        }
        if (emitted === 0) {
          items.push({ key: 'term-ok', level: 'pass', msg: 'No terminology inconsistencies found', kind: 'term', locate: '' });
        }
      }
    }

    return NextResponse.json({ success: true, items, model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[md-consistency] failed:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
