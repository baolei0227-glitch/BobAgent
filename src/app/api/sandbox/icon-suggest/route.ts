/**
 * 小程序图标 AI 建议（路线 A）：文本 → 单个 emoji 的非流式单轮调用。
 *
 * 与 /api/nodes/suggest-title 同构：resolveTaskModel + chat/completions + 清洗 + 兜底错误。
 * 图标字段本身是 ≤8 字符的文本（见 apps.ts · updateAppMeta），故只生成 emoji，零 schema 改动。
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/core/task-model';

/** 单次调用超时（毫秒）：超时后由前端就地报错，保留原有图标 */
const TIMEOUT_MS = 10000;

/** 图标专用提示词：只做一件事——挑一个最贴切的 emoji */
const SYSTEM_PROMPT = `You are an app icon picker. Given a mini-app's name and description, choose the ONE emoji that best represents it.
Rules:
- Output exactly ONE emoji character. Nothing else.
- No words, no punctuation, no explanation, no quotes, no markdown.
Examples:
Name: 待办清单 Todo / 列表 + 增删改查 → ✅
Name: 番茄钟 Pomodoro / 25/5/15 三档计时器 → 🍅
Name: 数据表格 Table / KPI 卡片 + 表格 + 进度条 → 📊
Name: AI Chat / 流式 AI 对话 → 🤖`;

/** 清洗模型输出：只取第一个 emoji 字素（含 ZWJ/变体序列），过滤模型误答的纯文字 */
function cleanIcon(raw: string): string {
  const t = (raw || '').replace(/```[a-z]*|```/gi, '').replace(/[\s"'“”‘’]/g, '');
  if (!t) return '';
  let first = '';
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    first = seg.segment(t)[Symbol.iterator]().next().value?.segment ?? '';
  } catch {
    // 极端环境无 Intl.Segmenter：退化为按码点取首个
    first = Array.from(t)[0] ?? '';
  }
  // 只接受 emoji / 图形符号；模型若回了普通字母数字则视为无效，由前端兜底
  return /[\p{Extended_Pictographic}\u{2600}-\u{27BF}]/u.test(first) ? first.slice(0, 8) : '';
}

export async function POST(req: NextRequest) {
  try {
    let name = '';
    let description = '';
    try {
      const body = await req.json();
      name = String(body?.name || '').trim();
      description = String(body?.description || '').trim();
    } catch {
      /* body 解析失败按缺参处理 */
    }
    if (!name && !description) {
      return NextResponse.json(
        { success: false, error: '缺少小程序名称或描述（body.name / body.description）' },
        { status: 400 },
      );
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: '尚未配置任何模型，请在【设置 → Models】中配置' },
        { status: 400 },
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let content = '';
    try {
      const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Name: ${name || '(unnamed)'}\nDescription: ${description.slice(0, 300) || '(none)'}` },
          ],
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      content = data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.delta?.content
        || '';
    } finally {
      clearTimeout(timer);
    }

    const icon = cleanIcon(content);
    if (!icon) {
      return NextResponse.json({ success: false, error: '模型未返回有效图标' });
    }
    return NextResponse.json({ success: true, icon, model_used: cfg.model });
  } catch (e) {
    console.error('sandbox/icon-suggest error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error && e.message ? e.message : '图标生成失败' },
      { status: 500 },
    );
  }
}
