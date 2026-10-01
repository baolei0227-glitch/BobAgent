/**
 * Butler 搜索栏 · 微信公众号「AI 精选」（搜狗微信通道 + LLM 精编）
 *
 * 流程（SSE 逐阶段推送，前端逐渐替换原始结果列表）：
 *   1) 精选：LLM 从候选（标题/摘要/公众号）中判出最相关的 3 篇
 *   2) 读正文：经主进程桥 /wechat-mp {action:'read'} 打开文章抽正文（专属后台标签，串行）
 *   3) 逐篇一句摘要 + 一段带来源的综合综述
 *   4) 简版 CoVe 校验：论断须在正文有支撑，否则剔除/改写
 * 只在 3 篇精选上读正文与做摘要，成本可控；模型不可用时不再静默丢弃候选 ——
 * 直接把候选落库成卡片（见 fallbackCards），保证「检索了哪些文章」始终有账可查。
 *
 * SSE 事件均为单通道 message，data 为 `{ type, ... }`：
 *   phase / curated / article / summary / digest / captcha / error / done
 */
import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { resolveModelConfig, type ResolvedModelConfig } from '@/lib/ai/resolve-model-config';
import { recordSearchExchange } from '@/lib/core/butler-search';
import type { WechatArticleCard } from '@/lib/bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HIPPO_BRIDGE_REL = join('.runtime', 'hippo-bridge.json');
/** 精选篇数 */
const MAX_PICK = 3;
/** 喂给模型的单篇正文上限（字符） */
const TEXT_BUDGET = 3500;

interface Hit {
  title: string;
  url: string;
  account?: string;
  snippet?: string;
}

/**
 * 候选 → 卡片（无 LLM 摘要时的兜底）：只在模型不可用 / 精编中途失败时用，
 * 用候选本身的 snippet 顶替「一句话摘要」，保证卡片列表不空。
 */
function fallbackCards(hits: Hit[]): WechatArticleCard[] {
  return hits.slice(0, MAX_PICK).map((h) => {
    const card: WechatArticleCard = { title: h.title, url: h.url };
    if (h.account) card.account = h.account;
    const sum = (h.snippet || '').slice(0, 120);
    if (sum) card.summary = sum;
    return card;
  });
}

async function readHippoBridge(): Promise<{ url: string; token: string }> {
  const raw = await readFile(join(resolveAppRoot(), HIPPO_BRIDGE_REL), 'utf-8');
  const parsed = JSON.parse(raw) as { url?: string; token?: string };
  if (!parsed || !parsed.url) throw new Error('桥文件缺 url');
  return { url: parsed.url, token: parsed.token || '' };
}

/** 经桥读取单篇文章正文 */
async function bridgeRead(
  bridge: { url: string; token: string },
  url: string,
): Promise<{ ok: boolean; captcha?: boolean; missing?: boolean; title?: string; account?: string; text?: string }> {
  const base = (bridge.url || 'http://127.0.0.1/').replace(/\/+$/, '');
  const res = await fetch(`${base}/wechat-mp?token=${encodeURIComponent(bridge.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'read', url }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    captcha?: boolean;
    missing?: boolean;
    title?: string;
    account?: string;
    text?: string;
  };
  return { ok: !!data.ok, captcha: data.captcha, missing: data.missing, title: data.title, account: data.account, text: data.text };
}

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

const CURATE_SYSTEM = `你是微信公众号文章的检索精选助手。用户给出一个检索关键词和一组候选文章（含序号、标题、摘要、公众号）。
请从中精选最多 ${MAX_PICK} 篇：优先「与关键词高度相关」「信息量或权威性高（知名公众号、原创、深度分析）」「时效较新」的文章。
明显无关、软文广告、标题党、纯营销导流一律不选；宁可少选，也不要凑数。
只返回严格 JSON，不要 markdown：
{"picks":[{"index":0,"reason":"一句话说明入选理由"}]}
index 为候选文章序号（从 0 开始）。按相关度从高到低排序。`;

const SUMMARIZE_SYSTEM = `你是文章摘要助手。用户给出一组微信公众号文章的正文（已截断）与检索关键词。
请为每篇文章写一句中文摘要：不超过 60 字，直接陈述核心内容，不要用「本文」「这篇文章」开头；再给出文章最关键的一个要点短语（不超过 15 字）。
只返回严格 JSON：
{"items":[{"index":0,"summary":"...","keypoint":"..."}]}
index 与输入一致；无法总结的文章不要出现在结果里。`;

const SYNTH_SYSTEM = `你是检索综述助手。用户给出检索关键词，以及多篇微信公众号文章的标题、公众号与摘要。
请基于这些材料写一段简洁的中文综合综述（120-200 字），概括关键词相关的主要观点与最新情况；只能依据给定材料，不得编造。
再把综述拆成 2-4 条要点，每条要点用 sources 数组标注它依据的文章 index。
若用户额外提供了「用户意图」与「检索方向」，综述与要点应覆盖这些方向的主要侧面，不要只复述材料顺序。
只返回严格 JSON：
{"digest":"...","points":[{"text":"...","sources":[0,1]}]}`;

const VERIFY_SYSTEM = `你是事实校验员。用户给出检索关键词、若干文章正文材料，以及一段待校验的综述与要点。
请逐条检查每个要点：能否在给定材料中找到直接支撑。
- 有支撑的：保留，sources 保持为支撑它的文章 index。
- 无支撑的：从结果中剔除；若综述句子里含无支撑的论断，就改写综述去掉该论断。
若提供了「检索方向」，校验时一并确认要点是否覆盖主要方向（覆盖不全不强制，但勿编造）。
只返回严格 JSON：
{"digest":"修订后的综述","points":[{"text":"...","sources":[0]}]}
不得新增材料中没有的信息，不得改变要点原意。`;

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
      };

      /** 提问词与候选（在 try 外声明：catch 兜底落库也要用） */
      let query = '';
      let hits: Hit[] = [];
      /** 本轮是否已落库；catch 据此判断要不要补兜底，避免重复写同一条 */
      let persisted = false;
      try {
        const body = (await req.json().catch(() => ({}))) as { q?: string; hits?: Hit[]; intent?: string; queries?: string[] };
        query = (body.q || '').trim();
        // 检索前规划出的用户意图与拆解方向（来自 wechat-search GET），让综述对齐问题
        const intent = (body.intent || '').trim();
        const planCtx = intent
          ? `用户意图：${intent}\n检索方向：${(body.queries || []).filter((s) => (s || '').trim()).join('、')}\n`
          : '';
        hits = (Array.isArray(body.hits) ? body.hits : [])
          .filter((h) => h && typeof h.url === 'string' && typeof h.title === 'string')
          .slice(0, 20);
        if (!query || hits.length === 0) {
          send({ type: 'error', error: 'q and hits are required' });
          finish();
          return;
        }

        const cfg = await resolveModelConfig({});
        if (!cfg) {
          // 模型不可用：精编全部做不了，但候选已经到手 —— 落库成卡片，不让这一轮静默消失。
          await recordSearchExchange(query, '（AI 精编不可用，以下是召回的候选文章）', fallbackCards(hits));
          persisted = true;
          send({ type: 'error', error: 'model-unavailable' });
          finish();
          return;
        }

        // 桥（读正文用）；读不到桥时降级：只做精选+综述，无正文
        let bridge: { url: string; token: string } | null = null;
        try { bridge = await readHippoBridge(); } catch { bridge = null; }

        // ---- 1) 精选 ----
        send({ type: 'phase', phase: 'curating' });
        const candidateList = hits
          .map((h, i) => `[${i}] ${h.title} | ${h.account || '未知公众号'} | ${(h.snippet || '').slice(0, 120)}`)
          .join('\n');
        const curateRaw = await chatJson<{ picks?: Array<{ index?: number; reason?: string }> }>(
          cfg,
          CURATE_SYSTEM,
          `检索关键词：${query}\n\n候选文章：\n${candidateList}`,
        );
        // 精选失败 → 兜底取前 MAX_PICK 篇
        let picks: Array<{ index: number; reason: string }> = [];
        const seen = new Set<number>();
        for (const p of curateRaw?.picks || []) {
          const idx = Number(p?.index);
          if (Number.isInteger(idx) && idx >= 0 && idx < hits.length && !seen.has(idx)) {
            seen.add(idx);
            picks.push({ index: idx, reason: (p?.reason || '').trim() });
          }
          if (picks.length >= MAX_PICK) break;
        }
        if (picks.length === 0) {
          picks = hits.slice(0, MAX_PICK).map((_, i) => ({ index: i, reason: '' }));
        }
        const curated = picks.map((p) => ({
          id: p.index,
          title: hits[p.index].title,
          url: hits[p.index].url,
          account: hits[p.index].account || '',
          snippet: hits[p.index].snippet || '',
          reason: p.reason,
        }));
        send({ type: 'curated', items: curated });

        // ---- 2) 读正文（串行：共用同一条后台标签） ----
        send({ type: 'phase', phase: 'reading' });
        const readResults: Array<{ id: number; ok: boolean; text: string; title: string; account: string }> = [];
        let captchaHit = false;
        for (const item of curated) {
          let text = '';
          let title = item.title;
          let account = item.account;
          let ok = false;
          if (bridge) {
            try {
              const r = await bridgeRead(bridge, item.url);
              if (r.captcha) captchaHit = true;
              if (r.ok && !r.missing && (r.text || '').length >= 120) {
                text = r.text || '';
                title = r.title || title;
                account = r.account || account;
                ok = true;
              }
            } catch { /* 单篇失败不影响其它篇 */ }
          }
          readResults.push({ id: item.id, text, title, account, ok });
          send({
            type: 'article',
            id: item.id,
            title,
            url: item.url,
            account,
            ok,
            excerpt: (text || item.snippet || '').slice(0, 120),
          });
        }
        if (captchaHit) send({ type: 'captcha' });

        // ---- 3a) 逐篇一句摘要（批量一次调用） ----
        send({ type: 'phase', phase: 'summarizing' });
        const materials = readResults.map((r) => {
          const base = r.text
            ? `正文：${r.text.slice(0, TEXT_BUDGET)}`
            : `仅有摘要：${curated.find((c) => c.id === r.id)?.snippet || ''}`;
          return `[${r.id}] 标题：${r.title} | 公众号：${r.account || '未知'}\n${base}`;
        }).join('\n\n---\n\n');
        const sumRaw = await chatJson<{ items?: Array<{ index?: number; summary?: string; keypoint?: string }> }>(
          cfg,
          SUMMARIZE_SYSTEM,
          `检索关键词：${query}\n\n文章材料：\n${materials}`,
        );
        const summaries = new Map<number, { summary: string; keypoint: string }>();
        for (const it of sumRaw?.items || []) {
          const idx = Number(it?.index);
          if (Number.isInteger(idx) && (it?.summary || '').trim()) {
            summaries.set(idx, { summary: (it.summary || '').trim(), keypoint: (it.keypoint || '').trim() });
          }
        }
        for (const r of readResults) {
          const s = summaries.get(r.id);
          if (s) send({ type: 'summary', id: r.id, summary: s.summary, keypoint: s.keypoint });
        }

        // ---- 3b) 综合综述（带来源） ----
        send({ type: 'phase', phase: 'digest' });
        const digMaterials = readResults.map((r) => {
          const s = summaries.get(r.id);
          const body = r.text ? r.text.slice(0, TEXT_BUDGET) : (curated.find((c) => c.id === r.id)?.snippet || '');
          return `[${r.id}] ${r.title}（${r.account || '未知'}）\n摘要：${s?.summary || '（无）'}\n正文节选：${body}`;
        }).join('\n\n---\n\n');
        const digRaw = await chatJson<{ digest?: string; points?: Array<{ text?: string; sources?: number[] }> }>(
          cfg,
          SYNTH_SYSTEM,
          `${planCtx}检索关键词：${query}\n\n文章材料：\n${digMaterials}`,
        );
        let digest = (digRaw?.digest || '').trim();
        let points = (digRaw?.points || [])
          .map((p) => ({ text: (p?.text || '').trim(), sources: Array.isArray(p?.sources) ? p.sources.map(Number).filter(Number.isInteger) : [] }))
          .filter((p) => p.text);
        send({ type: 'digest', digest, points, verified: false });

        // ---- 4) CoVe 校验（论断须有正文支撑） ----
        if (digest && points.length) {
          send({ type: 'phase', phase: 'verifying' });
          const verMaterials = readResults.map((r) => {
            const body = r.text ? r.text.slice(0, TEXT_BUDGET) : (curated.find((c) => c.id === r.id)?.snippet || '');
            return `[${r.id}] ${r.title}\n${body}`;
          }).join('\n\n---\n\n');
          const verRaw = await chatJson<{ digest?: string; points?: Array<{ text?: string; sources?: number[] }> }>(
            cfg,
            VERIFY_SYSTEM,
            `${planCtx}检索关键词：${query}\n\n待校验综述：${digest}\n待校验要点：\n${points.map((p, i) => `${i + 1}. ${p.text}（依据 ${p.sources.join(',') || '无'}）`).join('\n')}\n\n文章材料：\n${verMaterials}`,
            0.1,
          );
          const vDigest = (verRaw?.digest || '').trim();
          const vPoints = (verRaw?.points || [])
            .map((p) => ({ text: (p?.text || '').trim(), sources: Array.isArray(p?.sources) ? p.sources.map(Number).filter(Number.isInteger) : [] }))
            .filter((p) => p.text);
          if (vDigest && vPoints.length) {
            digest = vDigest;
            points = vPoints;
            send({ type: 'digest', digest, points, verified: true });
          } else {
            send({ type: 'digest', digest, points, verified: true });
          }
        }

        // 把「用户提问 + 小微综述 + 文章卡片」作为一条对话补进小微常驻线程（落库，供续聊保持上下文）。
        // 卡片随 assistant 消息落库（cards 字段）→「检索了哪些文章」成为会话历史的一部分，刷新后可回看。
        // 综述写失败（模型不可用）但已召回到文章时也落库：至少留下列表，不让这一轮彻底消失。
        if (digest || curated.length) {
          const sourceTitles = (idx: number) => curated[idx]?.title || `[${idx}]`;
          const md = digest
            ? [
                '## 检索综述',
                digest,
                '',
                ...points.map(
                  (p) =>
                    `- ${p.text}${p.sources?.length ? `（来源：${p.sources.map(sourceTitles).join('、')}）` : ''}`,
                ),
              ].join('\n')
            : '';
          const cards: WechatArticleCard[] = curated.map((c) => {
            const s = summaries.get(c.id);
            const r = readResults.find((x) => x.id === c.id);
            const card: WechatArticleCard = { title: r?.title || c.title, url: c.url };
            const acc = r?.account || c.account;
            if (acc) card.account = acc;
            const sum = s?.summary || (c.snippet || '').slice(0, 120);
            if (sum) card.summary = sum;
            if (s?.keypoint) card.keypoint = s.keypoint;
            return card;
          });
          await recordSearchExchange(query, md, cards);
          persisted = true;
        }

        send({ type: 'done', ok: true });
        finish();
      } catch (e) {
        // 精编中途抛错（模型 HTTP 失败等）：综述没了，但候选到手过 —— 兜底落库，
        // 保证用户至少能看到「检索了哪些文章」，而不是整轮静默消失。
        if (!persisted && query && hits.length) {
          await recordSearchExchange(query, '（AI 精编中断，以下是召回的候选文章）', fallbackCards(hits)).catch(() => { /* 兜底失败不再外抛 */ });
        }
        send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
        finish();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}