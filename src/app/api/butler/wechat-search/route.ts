/**
 * Butler 搜索栏 · 微信公众号检索（搜狗微信通道）
 *
 * 前端联系人列顶部搜索栏用它取「搜狗微信」文章结果：
 * 服务端读主进程的 Hippo 桥文件（.runtime/hippo-bridge.json），
 * POST /wechat-mp { query } —— 由主进程在一条专属后台标签里完成检索，
 * 不打扰用户当前页面。桥离线（未启动桌面端）时返回 ok:false，由前端静默降级。
 *
 * 2026-09-30 新增「检索前 query 理解/改写/拆解」：
 *   用户原句先经 LLM 规划成 1–3 个最优搜狗关键词串（问题会拆成互补子方向），
 *   再顺序扇出多次检索、合并去重。模型不可用/规划失败 → 降级为原句直搜，
 *   行为与改动前完全一致（零回归）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { resolveModelConfig, type ResolvedModelConfig } from '@/lib/ai/resolve-model-config';

export const runtime = 'nodejs';

const HIPPO_BRIDGE_REL = join('.runtime', 'hippo-bridge.json');

/** 单条检索命中（与桥返回结构一致） */
interface Hit {
  title: string;
  url: string;
  account?: string;
  snippet?: string;
}
/** 合并后最多返回的候选数（enrich 会再精选 Top 3，留余量即可） */
const MERGE_CAP = 12;

async function readHippoBridge(): Promise<{ url: string; token: string }> {
  const raw = await readFile(join(resolveAppRoot(), HIPPO_BRIDGE_REL), 'utf-8');
  const parsed = JSON.parse(raw) as { url?: string; token?: string };
  if (!parsed || !parsed.url) throw new Error('桥文件缺 url');
  return { url: parsed.url, token: parsed.token || '' };
}

// ============ LLM 辅助（与 enrich 路由同模式，此处自包含，避免跨文件依赖） ============

/** 调用 LLM 拿文本内容；网关不支持 json_object 时降级重试 */
async function chatText(cfg: ResolvedModelConfig, system: string, user: string, temperature = 0.3): Promise<string> {
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
  let resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (resp.status === 400 || resp.status === 404) {
    delete payload.response_format;
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (
    data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.delta?.content
    || ''
  );
}

/** 从模型文本中抽取 JSON 对象 */
function extractJson<T>(content: string): T | null {
  let cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s !== -1 && e > s) cleaned = cleaned.slice(s, e + 1);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/** 调用模型并解析 JSON（失败重试 1 次） */
async function chatJson<T>(cfg: ResolvedModelConfig, system: string, user: string, temperature = 0.3): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await chatText(cfg, system, user, temperature);
    const parsed = extractJson<T>(content);
    if (parsed) return parsed;
  }
  return null;
}

// ============ 检索前规划：把用户原句改写成 1–3 个最优搜狗关键词串 ============

const PLAN_SYSTEM = `你是检索词规划助手，服务于「搜狗微信」公众号文章检索。用户会给出一个检索输入，可能是自然语言问题，也可能是关键词。
请把它规划成 1–3 个最适合搜狗微信的关键词检索串：
- 若输入是完整问题：先拆成若干子问题（最多 3 个，覆盖问题的主要侧面、避免重复），再把每个子问题改写成 2–8 个词的关键词串——去掉「怎么/为什么/有哪些/区别」等疑问词与连词，保留核心实体与概念；
- 若输入已是较好的关键词：微调或保持，不必硬拆；
- 关键词串要像真人会搜的那样简短自然，不要整句，不要堆砌标点；
- 不同检索串之间尽量互补而非重复。
只返回严格 JSON，不要 markdown：
{"isQuestion":true,"intent":"一句话概括用户真实意图","queries":["关键词串1","关键词串2"]}`;

interface PlanOut {
  isQuestion?: boolean;
  intent?: string;
  queries?: string[];
}

/**
 * 用 LLM 把用户原句规划成检索词。返回 null = 规划失败/不可用（调用方降级为原句直搜）。
 */
async function planQueries(cfg: ResolvedModelConfig, q: string): Promise<{ intent: string; queries: string[] } | null> {
  const raw = await chatJson<PlanOut>(cfg, PLAN_SYSTEM, `检索输入：${q}`, 0.2);
  if (!raw) return null;
  const queries = Array.from(
    new Set((raw.queries || []).map((s) => (s || '').trim()).filter(Boolean)),
  ).slice(0, 3);
  if (queries.length === 0) return null;
  return { intent: (raw.intent || '').trim(), queries };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ ok: false, error: 'q (keyword) is required' }, { status: 400 });
  try {
    const bridge = await readHippoBridge();
    const base = (bridge.url || 'http://127.0.0.1/').replace(/\/+$/, '');

    /** 经桥检索一次（顺序调用，共用同一条后台标签） */
    const callBridge = async (query: string, maxResults: number) => {
      const res = await fetch(`${base}/wechat-mp?token=${encodeURIComponent(bridge.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      });
      return (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        captcha?: boolean;
        results?: Hit[];
      };
    };

    // ---- 1) 检索前规划：改写/拆解原句（模型不可用时降级为原句直搜） ----
    let queries = [q];
    let intent = '';
    let decomposed = false;
    try {
      const cfg = await resolveModelConfig({});
      if (cfg) {
        const plan = await planQueries(cfg, q);
        if (plan && plan.queries.length) {
          queries = plan.queries;
          intent = plan.intent;
          decomposed = true;
        }
      }
    } catch {
      // 规划异常 → 降级原句直搜，不阻断主流程
      queries = [q];
      decomposed = false;
    }

    // ---- 2) 扇出检索（顺序，避免并发共用后台标签冲突）+ 合并去重 ----
    const merged: Hit[] = [];
    const seenUrls = new Set<string>();
    let captcha = false;
    const perQuery = queries.length > 1 ? Math.max(4, Math.ceil(MERGE_CAP / queries.length)) : 6;
    for (const qq of queries) {
      const data = await callBridge(qq, perQuery);
      if (data.captcha) {
        captcha = true;
        break;
      }
      for (const r of data.results || []) {
        if (!r.url) continue;
        if (seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        merged.push(r);
        if (merged.length >= MERGE_CAP) break;
      }
      if (merged.length >= MERGE_CAP) break;
    }

    return NextResponse.json({
      ok: true,
      captcha,
      results: merged,
      decomposed,
      intent,
      queries,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
