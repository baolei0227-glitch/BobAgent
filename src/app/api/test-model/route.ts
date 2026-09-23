import { NextRequest, NextResponse } from 'next/server';
import { WebSocket } from 'ws';
import { sanitizeBaseUrl } from '@/lib/types';

/** 保存前连接测试：对每个已选模型发极简请求验证配置（API Key / Base URL / 模型名）真实可用。TRAE 式校验。
 *  按模型类型自动分流到正确端点：语言/视觉 → chat/completions；图片生成（seedream/seededit/gpt-image 等）→
 *  images/generations；TTS 语音合成（seed-tts）→ services/tts；STT/ASR 语音识别（seed-asr/whisper）→ audio/transcriptions。 */
interface TestTarget {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  /** 模型分类（前端从 fetchedModels 传入，'image' 时走 images API；缺失时按模型 ID 兜底判断） */
  category?: string;
}

interface TestResult {
  provider: string;
  modelId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** provider -> 默认 Base URL（与 /api/models 保持同一份映射，避免两处漂移） */
const providerBaseUrls: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  agentplan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  codingplan: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  siliconflow: 'https://api.siliconflow.cn/v1',
};

/**
 * 模型名 -> openspeech Resource ID 映射（与 audio-parser.ts 同逻辑）。
 * 火山 openspeech WebSocket 的 X-Api-Resource-Id 需要 Resource ID（volc.*），
 * 用户在 Model Pool 选的是模型名（doubao-seed-asr-2.0），此处转换。
 */
function asrModelToResourceId(model: string): string {
  if (/^volc\./.test(model)) return model;
  const id = model.toLowerCase();
  if (/seed.?asr.?2|asr.?2\.0/.test(id)) return 'volc.seedasr.sauc.duration';
  if (/seed.?asr.?1|asr.?1\.0|bigasr/.test(id)) return 'volc.bigasr.sauc.duration';
  if (/asr/.test(id)) return 'volc.seedasr.sauc.duration';
  return 'volc.seedasr.sauc.duration';
}

/** 端点类型 */
type EndpointKind = 'chat' | 'image' | 'tts' | 'stt';

/** 按模型类型解析目标端点与请求体：
 *  - 图片生成模型（seedream/seededit/gpt-image 等）→ images/generations
 *  - TTS 语音合成（seed-tts 等）→ services/tts
 *  - STT/ASR 语音识别（seed-asr/whisper 等）→ audio/transcriptions
 *  - 其余语言/视觉模型 → chat/completions
 * 优先用前端分类，缺失时按模型 ID 兜底判断。 */
function resolveEndpoint(category: string | undefined, modelId: string): { path: string; kind: EndpointKind } {
  const id = modelId.toLowerCase();
  if (category === 'image' || /seedream|seededit|gpt-image|qwen-image|dall-?e|flux|sdxl|stable-diffusion|image-edit/.test(id)) {
    return { path: 'images/generations', kind: 'image' };
  }
  if (category === 'audio' || /tts|asr|whisper|speech|qwen-audio/.test(id)) {
    if (/tts|speech|voice/.test(id)) return { path: 'services/tts', kind: 'tts' };
    return { path: 'audio/transcriptions', kind: 'stt' };
  }
  return { path: 'chat/completions', kind: 'chat' };
}

/** 构造各端点的极简验证请求体 */
function buildTestBody(kind: EndpointKind, modelId: string): object {
  switch (kind) {
    case 'image':
      // 不带 size 用默认档位，避免尺寸参数不兼容
      return { model: modelId, prompt: 'a red circle', n: 1 };
    case 'tts':
      // 语音合成：OpenAI 兼容 services/tts；voice 因音色而异，留空让服务端返回参数错误（端点可达即视为密钥/端点有效）
      return { model: modelId, input: 'hi' };
    case 'stt':
      // 语音识别：真实调用需 multipart 音频，测试仅发 JSON 触发参数校验，确认端点与鉴权有效
      return { model: modelId };
    default:
      return { model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 16 };
  }
}

/** 把服务端错误转成可读文案（限流/配额/模型未开通类错误给出明确指引） */
function friendlyError(text: string): string {
  if (/ModelAccountRpmRateLimitExceeded|RPM\s*\(|rate.?limit|RateLimit/i.test(text)) {
    return 'RPM 限流：该模型每分钟请求数超限（账号配额），请稍后重试或检查方舟控制台模型配额';
  }
  if (/ModelNotFound|model.*not.*found|NoSuchModel|does not exist|do not have access|InvalidEndpointOrModel|UnsupportedModel/i.test(text)) {
    return '模型不存在或未开通：请确认模型 ID 正确并在方舟控制台开通该模型服务（订阅制还需确认该模型在当前套餐档位内）';
  }
  return text.slice(0, 150);
}

export async function POST(request: NextRequest) {
  let body: { providers?: TestTarget[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const targets = (body.providers || []).filter((t) => t && t.apiKey && t.models?.length > 0);
  if (targets.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results: TestResult[] = [];
  // 整体绝对超时 120s：图片生成模型实测需要 60-90s 才返回结果，必须给足时间；
  // 聊天模型单请求 8s 快速反馈，整体 120s 对并发多模型也够用
  const overallCtrl = new AbortController();
  const overallT = setTimeout(() => overallCtrl.abort(new DOMException('Aborted', 'AbortError')), 120000);

  try {
    const jobs: Promise<void>[] = [];
    for (const t of targets) {
      // 防御性清理：历史版本可能把完整端点 URL（如 /images/generations）存进了 Base URL
      const base = sanitizeBaseUrl(t.baseUrl || providerBaseUrls[t.provider] || '');
      // Agent Plan / Coding Plan 语音模型走 openspeech 网关（WebSocket 协议），
      // 而非 ark.cn-beijing.volces.com 大模型网关的 HTTP 兼容端点
      const isAgentGate = /agentplan|codingplan/i.test(t.provider);
      for (const modelId of t.models) {
        jobs.push(
          (async () => {
            if (!base) {
              results.push({ provider: t.provider, modelId, ok: false, error: 'Unknown provider or missing Base URL' });
              return;
            }
            const ep = resolveEndpoint(t.category, modelId);
            const timeout = ep.kind === 'image' ? 100000 : 8000;

            // Agent Plan 订阅制语音模型
            if ((ep.kind === 'tts' || ep.kind === 'stt') && isAgentGate) {
              // STT 只有 WebSocket 双向接口（无 HTTP unidirectional），用最小 WS 握手探测：
              //  - 鉴权：Agent Plan /plan/ 路由用 Authorization: Bearer（与大模型网关一致）
              //  - doubao-stream 独立语音平台用 X-Api-Key，与 Agent Plan 完全不同
              if (ep.kind === 'stt') {
                // Agent Plan ASR 端点：/api/v3/plan/sauc/bigmodel_nostream（单流，上传完整音频后统一返回）
                // 或 bigmodel_async（双流，增量返回）。鉴权用 X-Api-Key（方舟 API Key 通用），非 Bearer。
                const wsUrl = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream';
                // 模型名（doubao-seed-asr-2.0）-> Resource ID（volc.seedasr.sauc.duration）
                const resourceId = asrModelToResourceId(modelId);
                await new Promise<void>((resolve) => {
                  let settled = false;
                  const finish = (ok: boolean, msg?: string) => {
                    if (settled) return;
                    settled = true;
                    if (ok) results.push({ provider: t.provider, modelId, ok: true });
                    else results.push({ provider: t.provider, modelId, ok: false, error: msg || 'Agent Plan STT 握手失败' });
                    resolve();
                  };
                  const timer = setTimeout(() => {
                    try { ws?.close(); } catch { /* ignore */ }
                    // WS 握手超时但连接没有被鉴权拒绝（通常是对端未及时响应 close），视为端点可达
                    finish(true);
                  }, 4000);
                  let ws: WebSocket | undefined;
                  try {
                    ws = new WebSocket(wsUrl, {
                      headers: {
                        // Agent Plan 语音模型鉴权：X-Api-Key（方舟控制台 API Key 通用）+ Resource-Id + 必要请求头
                        'X-Api-Key': t.apiKey,
                        'X-Api-Resource-Id': resourceId,
                        'X-Api-Request-Id': crypto.randomUUID(),
                        'X-Api-Connect-Id': crypto.randomUUID(),
                        'X-Api-Sequence': '-1',
                      },
                      handshakeTimeout: 4000,
                    });
                    ws.on('open', () => {
                      clearTimeout(timer);
                      try { ws!.close(); } catch { /* ignore */ }
                      finish(true);
                    });
                    ws.on('unexpected-response', (_req, res) => {
                      clearTimeout(timer);
                      const s = res.statusCode;
                      // 读取服务端响应体：openspeech 网关在拒绝时会返回详细排障指引
                      //（套餐未包含 / 超额后付费 / Resource-Id 对照 / Base URL 对照），原样透传便于用户定位
                      let bodyText = '';
                      let bodyDone = false;
                      const respondWithBody = () => {
                        if (bodyDone) return;
                        bodyDone = true;
                        const hint = bodyText.trim();
                        if (s === 401 || s === 403) {
                          finish(false, `Agent Plan STT 鉴权失败（HTTP ${s}）：API Key 无效或该语音模型未在套餐内开通${hint ? `\n服务端提示：${hint.slice(0, 400)}` : ''}`);
                        } else if (s === 404) {
                          finish(false, `模型 ${modelId} 在 Agent Plan 语音网关不存在或未开通（套餐未包含或 Resource-Id 错误）。\n正确的 Resource-Id：doubao-seed-asr-2.0（豆包流式语音识别2.0）→ volc.seedasr.sauc.duration；doubao-seed-tts-2.0（语音合成2.0）→ seed-tts-2.0。若套餐不含该模型，请在方舟控制台开启超额后付费。${hint ? `\n服务端提示：${hint.slice(0, 400)}` : ''}`);
                        } else {
                          // 其他状态视为网关可达 + 鉴权通过（HTTP 响应只在握手错误时返回，非 2xx 但非鉴权失败说明端点正常）
                          finish(true);
                        }
                      };
                      try {
                        res.on('data', (chunk: Buffer) => {
                          if (bodyText.length < 2000) bodyText += chunk.toString('utf-8');
                        });
                        res.on('end', respondWithBody);
                        res.on('error', respondWithBody);
                        // 兜底：body 迟迟不 end 时 3s 后按已收集内容响应
                        setTimeout(respondWithBody, 3000);
                      } catch {
                        respondWithBody();
                      }
                    });
                    ws.on('error', (e: Error) => {
                      clearTimeout(timer);
                      finish(false, `Agent Plan STT 连接错误：${e.message}`);
                    });
                    ws.on('close', (code: number) => {
                      clearTimeout(timer);
                      // close code: 1000=正常关闭，1008=策略拒绝（鉴权/模型未开通），1002=协议错误，其余待定
                      if (code === 1008) finish(false, `模型 ${modelId} 在 Agent Plan 语音网关鉴权失败或未开通（close code=1008）`);
                      else finish(true);
                    });
                  } catch (e) {
                    clearTimeout(timer);
                    finish(false, `Agent Plan STT 初始化错误：${e instanceof Error ? e.message : String(e)}`);
                  }
                });
                return;
              }
              // TTS 有 HTTP 单向接口，正常测
              const voicePath = '/api/v3/plan/tts/unidirectional';
              try {
                const resp = await fetch(`https://openspeech.bytedance.com${voicePath}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: modelId, input: 'hi' }),
                  signal: AbortSignal.any([AbortSignal.timeout(timeout), overallCtrl.signal]),
                });
                if (resp.ok) {
                  results.push({ provider: t.provider, modelId, ok: true });
                } else if (resp.status === 401 || resp.status === 403) {
                  const text = await resp.text().catch(() => '');
                  results.push({ provider: t.provider, modelId, ok: false, status: resp.status,
                    error: `Agent Plan TTS 鉴权失败：${friendlyError(text)}` });
                } else if (resp.status === 404) {
                  results.push({ provider: t.provider, modelId, ok: false, status: 404,
                    error: `模型 ${modelId} 在 Agent Plan 语音网关不存在或未开通，请确认 medium+ 套餐已包含该模型` });
                } else {
                  results.push({ provider: t.provider, modelId, ok: true });
                }
              } catch (err) {
                results.push({ provider: t.provider, modelId, ok: false,
                  error: `Agent Plan TTS 连接失败：${err instanceof Error ? err.message : String(err)}` });
              }
              return;
            }

            try {
              const resp = await fetch(`${base}/${ep.path}`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${t.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(buildTestBody(ep.kind, modelId)),
                signal: AbortSignal.any([AbortSignal.timeout(timeout), overallCtrl.signal]),
              });
              if (resp.ok) {
                results.push({ provider: t.provider, modelId, ok: true });
              } else {
                const status = resp.status;
                const text = await resp.text().catch(() => '');
                if (ep.kind === 'tts' || ep.kind === 'stt') {
                  if (status === 404) {
                    results.push({
                      provider: t.provider, modelId, ok: false, status,
                      error: '当前网关不支持语音端点（TTS/STT）：语音合成/识别模型需在火山语音平台（openspeech.bytedance.com）单独开通，并使用语音平台的 App ID / Token 验证',
                    });
                  } else if (status === 401 || status === 403) {
                    results.push({ provider: t.provider, modelId, ok: false, status, error: friendlyError(text) || `HTTP ${status} 鉴权/权限失败` });
                  } else {
                    results.push({ provider: t.provider, modelId, ok: true });
                  }
                } else {
                  results.push({ provider: t.provider, modelId, ok: false, status, error: friendlyError(text) });
                }
              }
            } catch (err) {
              const isAbort =
                (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
                (err instanceof Error && /abort|timeout/i.test(err.message));
              results.push({
                provider: t.provider,
                modelId,
                ok: false,
                error: isAbort ? 'Timeout (image generation can take 60-90s, retry later or check the Ark console)' : err instanceof Error ? err.message : String(err),
              });
            }
          })()
        );
      }
    }
    await Promise.allSettled(jobs);
    return NextResponse.json({ results });
  } finally {
    clearTimeout(overallT);
  }
}
