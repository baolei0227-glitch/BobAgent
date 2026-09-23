/**
 * MD 语义导航：按主题检索条款（非流式 JSON）。
 *
 * 与关键词查找互补 —— 「涉及赔偿的条款」这类主题查询，靠子串匹配结构上够不到。
 * 路线：LLM 单次分块定位（零索引、零落盘、无新依赖，与账本 SCHEMA.md「不依赖向量检索」的口径一致）。
 *
 * 流程：md → 按标题/条款切块（块内含序号 + 标题路径 + 正文）→ 一次请求让模型返回命中块索引 + 理由
 *      → 服务端回校 quote 必须逐字存在于原文（防模型编造锚点）→ 返回 matches。
 *
 * 长文兜底：块数超上限时只取前 N 块并置 truncated=true（前端提示）。
 * 若后续需要，可在此处插入「先发标题清单粗筛 → 再发候选段精筛」的两段式，结构位已留。
 */
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { resolveModelConfig, type ModelRefRequest } from '@/lib/ai/resolve-model-config';

/** 单块正文送模型时的截断长度（头 + 尾），防单块过长挤掉其他块 */
const BLOCK_HEAD = 700;
const BLOCK_TAIL = 200;
/** 单次请求最多送出的块数（超出的块不参与本轮检索，置 truncated） */
const MAX_BLOCKS = 80;
/** 最多返回的命中条数 */
const MAX_MATCHES = 8;

interface MdNavigateRequest extends ModelRefRequest {
  md: string;
  query: string;
}

interface MdBlock {
  index: number;
  headingPath: string;
  text: string;
}

interface NavigateMatch {
  index: number;
  heading: string;
  quote: string;
  reason: string;
}

/** 条款式行首（作为切点）：第X条/章/节/款/项、X.Y 多级编号、（一）/ (一) */
const CLAUSE_RE = /^(第[一二三四五六七八九十百零〇0-9]+[条章节款项]|\d+(?:\.\d+)+[\s、.．]|[（(][一二三四五六七八九十]+[)）])/;

/** 按 h2–h6 标题与条款式编号行切块（h1 通常是文档标题，不切，作为标题路径起点保留） */
function splitBlocks(md: string): MdBlock[] {
  const lines = md.split('\n');
  const blocks: { headingPath: string; lines: string[] }[] = [];
  const stack: string[] = [];
  let cur: { headingPath: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur && cur.lines.join('\n').trim()) blocks.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const h = /^(#{2,6})\s+(.+)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      stack.length = level - 1;
      stack[level - 1] = h[2].trim();
      cur = { headingPath: stack.filter(Boolean).join(' › '), lines: [line] };
      continue;
    }
    if (CLAUSE_RE.test(line.trim())) {
      flush();
      cur = { headingPath: stack.filter(Boolean).join(' › '), lines: [line] };
      continue;
    }
    if (!cur) cur = { headingPath: stack.filter(Boolean).join(' › '), lines: [] };
    cur.lines.push(line);
  }
  flush();
  return blocks.map((b, i) => ({ index: i, headingPath: b.headingPath, text: b.lines.join('\n').trim() }));
}

/** 块正文截断（头 + 尾），返回是否被截断 */
function clipBlock(text: string): { text: string; clipped: boolean } {
  if (text.length <= BLOCK_HEAD + BLOCK_TAIL) return { text, clipped: false };
  return { text: `${text.slice(0, BLOCK_HEAD)}\n…（本块中间略）…\n${text.slice(-BLOCK_TAIL)}`, clipped: true };
}

/** 宽松解析模型输出为 JSON 数组：容忍代码围栏、前后解释文字、{"matches":[…] } 包裹 */
function parseMatches(raw: string): unknown[] {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = tryParse(text);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') {
    const arr = (direct as { matches?: unknown }).matches;
    if (Array.isArray(arr)) return arr;
  }
  // 兜底：截取首尾括号之间的内容
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
    const body = (await request.json()) as Partial<MdNavigateRequest>;
    const md = typeof body.md === 'string' ? body.md : '';
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!md.trim()) return NextResponse.json({ success: false, error: '文档为空' }, { status: 400 });
    if (!query) return NextResponse.json({ success: false, error: '检索主题为空' }, { status: 400 });

    const allBlocks = splitBlocks(md);
    if (allBlocks.length === 0) {
      return NextResponse.json({ success: true, matches: [], total: 0, truncated: false });
    }
    const blocks = allBlocks.slice(0, MAX_BLOCKS);
    let clipped = allBlocks.length > MAX_BLOCKS;
    const rendered = blocks.map((b) => {
      const c = clipBlock(b.text);
      if (c.clipped) clipped = true;
      const head = b.headingPath ? `【${b.headingPath}】` : '';
      return `#${b.index} ${head}\n${c.text}`;
    }).join('\n\n---\n\n');

    const config = await resolveModelConfig(body);
    if (!config) {
      return NextResponse.json({ success: false, error: '未配置可用模型，请先在设置中配置 API Key' }, { status: 400 });
    }

    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
    const completion = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: `你是文档条款导航器。用户给出一份按块切分的文档（每块含序号 #N、标题路径、正文）与一个检索主题，你找出与该主题相关的块，并说明命中理由。

❗️输出格式铁律（违反即失败）：
1. 只输出 JSON 数组，禁止输出任何解释、思考过程、markdown 代码块围栏
2. 每项形如 {"index": 3, "quote": "原文连续片段", "reason": "命中理由"}
3. index 必须是给出的块序号（整数）
4. quote 必须是该块正文中**逐字复制**的连续片段（20–60 字），不得改写、不得拼接
5. reason 用一句话说明为什么该块与主题相关（中文）
6. 最多返回 ${MAX_MATCHES} 项；没有任何块相关时输出 []`,
        },
        {
          role: 'user',
          content: `检索主题：${query}\n\n文档块：\n\n${rendered}`,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    const parsed = parseMatches(raw);
    const matches: NavigateMatch[] = [];
    const seen = new Set<number>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const index = typeof o.index === 'number' ? o.index : Number(o.index);
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length || seen.has(index)) continue;
      const quote = typeof o.quote === 'string' ? o.quote.trim() : '';
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      // 回校：quote 必须逐字存在于原文（防模型编造锚点，否则跳转定位必然失败）
      if (!quote || !md.includes(quote)) continue;
      seen.add(index);
      matches.push({
        index,
        heading: blocks[index].headingPath,
        quote,
        reason,
      });
      if (matches.length >= MAX_MATCHES) break;
    }

    return NextResponse.json({
      success: true,
      matches,
      total: blocks.length,
      truncated: clipped,
      model: config.model,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[md-navigate] failed:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
