import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/wanted/task-model';

/** 标题长度上限（与前端规则层 deriveInstantTitle 保持一致） */
const MAX_TITLE_LENGTH = 20;
/** 单次调用超时（毫秒）：超时后由前端回退规则标题 */
const TIMEOUT_MS = 10000;

/** 会话命名专用提示词：只做一件事，避免与主对话的长规则竞争 */
const SYSTEM_PROMPT = `你是会话标题生成器。根据用户的第一条消息，生成一个简洁的中文标题。
规则：
- 标题为「主题名词短语」，6~18 字，概括用户想做的事情或主题；
- 严禁照抄或截断用户原话；禁止以"请/帮我/如何/怎么/为什么"开头；
- 结尾不加标点符号（不写问号、句号、冒号）；
- 只输出标题本身，不要引号、不要解释、不要输出任何其他内容。
示例：
用户：帮我看看这份合同有什么风险 → 合同风险审查
用户：写个快速排序 → 快速排序实现
用户：帮我分析一下上个月的销售数据 → 销售数据分析`;

/** 清洗模型输出：去代码块/引号/换行，归一空白，超长截断 */
function cleanTitle(raw: string): string {
  let t = (raw || '').replace(/```[a-z]*|```/gi, '');
  t = t.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  t = t.replace(/^["'“”‘’《》\s]+|["'“”‘’《》\s]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TITLE_LENGTH) t = t.slice(0, MAX_TITLE_LENGTH).trim();
  return t;
}

export async function POST(req: NextRequest) {
  try {
    let question = '';
    try {
      const body = await req.json();
      question = String(body.question || body.text || '').trim();
    } catch { /* body 解析失败按缺参处理 */ }
    if (!question) {
      return NextResponse.json(
        { success: false, error: '缺少用户消息（body.question）' },
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
          temperature: 0.3,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `用户消息：${question.slice(0, 2000)}` },
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

    const title = cleanTitle(content);
    if (!title) {
      return NextResponse.json({ success: false, error: '模型未返回有效标题' });
    }
    return NextResponse.json({ success: true, title, model_used: cfg.model });
  } catch (e: any) {
    console.error('nodes/suggest-title error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || '标题生成失败' },
      { status: 500 },
    );
  }
}
