/**
 * lib/core/podcast.ts — 文本转播客（Text to Podcast）共享内核
 *
 * 把一份 md/txt 资料变成一段「双人对谈」播客，分三步，各自收在一个函数里：
 *   1. generatePodcastScript：调任务模型（resolveTaskModel，与 /api/core/meeting 同一路）把资料
 *      改写成 A/B 两位主播的对谈脚本（严格 JSON，便于逐句取说话人）；
 *   2. resolveHostVoices：把设置里**已选的那一款 TTS** 拆成两位主播各一份 TtsSettings 副本——
 *      扬声器（synthesizeSpeech）本来就接受完整 settings 对象，故换音色只是改副本字段（云端改 voice、
 *      本地预置模型改 localModel + localVoice、零样本克隆改 localRefAudio/localRefText），
 *      **TTS 引擎零改动、也不新增任何配置项**；本地预置的默认一男一女一律**优先取自同一模型**，
 *      同一模型凑不出男女双声时才跨模型拼；
 *   3. renderPodcastMarkdown：产物 md（首行音频指针 + 逐行台词），口径与会议记录一致——
 *      指针在首位，History 据此出 ▶ 回放，不需要回放侧改一行代码。
 *
 * 单一音色兜底（用户拍板）：引擎只有一条可用音色时（本地预置模型未凑齐第二个、云端无已知第二音色、
 * 内置参考音只生成了半套）**照常出产物**，但必须回一条 note 让界面显式提示——不静默降级。
 *
 * 仅供服务端使用（依赖 settings-server / 本地引擎探测）。
 */
import { resolveTaskModel, type ResolvedModel } from './task-model';
import { SPEECH_CHUNK_CHARS } from '@/lib/tts/plain-text';
import { TtsNotConfiguredError, SHERPA_LOCAL_PROVIDER } from '@/lib/tts';
import { findLocalTtsModel, listBuiltinRefs, listLocalPresetVoices, type LocalPresetVoice } from '@/lib/tts/sherpa-local';
import type { TtsSettings } from '@/lib/settings';

/** 送模型的资料上限（超出截断）：播客是「改写」，资料再长也放不进成片，截断比拒绝友好 */
export const PODCAST_MAX_INPUT_CHARS = 20000;

/** 成片口播总字数上限：TTS 逐句合成，字数直接换时间与成本，必须封顶（约 10 分钟音频） */
export const PODCAST_TARGET_CHARS = 3000;

/** 单条发言字数上限（对谈台词本来就短；超长会明显拉长合成时间） */
export const PODCAST_MAX_LINE_CHARS = 200;

/** 脚本行数硬上限（模型跑偏时的兜底，正常远低于此） */
export const PODCAST_MAX_LINES = 150;

/** 本地引擎的分段上限：零样本克隆每段都要重跑参考音编码，段更小以压低首字延迟 */
const LOCAL_NEURAL_CHUNK_CHARS = 800;
const ZERO_SHOT_CHUNK_CHARS = 400;

/** 一句台词（说话人 + 正文） */
export interface PodcastLine {
  speaker: 'A' | 'B';
  text: string;
}

/** 两位主播各自的合成设置（= 已选 TTS 的副本，仅音色字段不同） */
export interface HostVoices {
  hostA: TtsSettings;
  hostB: TtsSettings;
  /** 引擎只有单一音色时的可见提示（非空即界面必须显示，不静默） */
  note?: string;
}

/**
 * 云端音色表：首项 = host A 默认（必须与 lib/tts/index.ts 的 TTS_PROVIDER_PRESETS 对齐），
 * 其余项供 host B 自动取「另一条」，同时作为 UI 里的可选音色清单。
 * 只列**确知**的音色（OpenAI 官方六条固定、BobMultimodal 服务端枚举）；其它厂商未核实的一律不编造，留给 Settings 的自由文本输入。
 * ⚠️ siliconflow 的第二音色 id 未核实（同一模型下的另一个说话人后缀）：厂商拒绝时合成会明确报错，
 * 不会静默换回第一条。
 */
const PODCAST_VOICES: Record<string, string[]> = {
  openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  siliconflow: ['fishaudio/fish-speech-1.5:alex', 'fishaudio/fish-speech-1.5:anna'],
  // BobMultimodal / Qwen3-TTS CustomVoice：服务端 voice 是固定枚举（枚举外的值直接 500），
  // 取自本地 MLX 服务 GET /api/tts/voices；首项 vivian 与 TTS_PROVIDER_PRESETS 的默认音色一致
  bobmultimodal: ['vivian', 'serena', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan'],
};

/** 一条可选音色：id 是回传给服务端的覆盖值（云端 = voice，本地 = localVoice / 参考音 id） */
export interface PodcastVoiceOption {
  id: string;
  label: string;
}

/** 当前引擎下两位主播的可选音色（Meeting 面板下拉的数据源，必须由服务端列举——配置与本地模型都在服务端） */
export interface PodcastVoiceChoices {
  /** 当前 TTS provider（如 sherpa-local / openai） */
  provider: string;
  /** 可选音色；空数组 = 该引擎无可枚举音色（UI 隐藏下拉，只保留 Auto） */
  voices: PodcastVoiceOption[];
  /** Auto 时两位主播各自的音色 id（UI 用它显示默认音色名） */
  autoA: string;
  autoB: string;
  /** 引擎只有单一音色时的可见提示（与 resolveHostVoices 同口径，不静默降级） */
  note?: string;
}

/** 音色覆盖（UI 的 Host A / Host B 选择）；缺省 = 走自动派生，行为与历史完全一致 */
export interface HostVoiceOverrides {
  hostA?: string;
  hostB?: string;
}

/** 单一音色兜底文案（云端：该厂商没有已知的第二音色） */
const NOTE_SINGLE_VOICE_CLOUD =
  'This engine exposes a single voice — both hosts will sound the same. Pick a two-voice engine in Settings → Roles → Audio TTS Model for distinct hosts.';

/** 单一音色兜底文案（本地：参考音只生成了半套） */
const NOTE_SINGLE_REF_LOCAL =
  'Only one offline reference voice is ready — both hosts will sound the same. Download the ZipVoice zh-en model in Settings → Roles → Audio TTS Model to get the built-in male and female voices.';

/** 单一音色兜底文案（本地：只就绪了一个预置模型，且该模型凑不出第二条音色） */
const NOTE_SINGLE_PRESET_LOCAL =
  'Only one offline voice is ready — both hosts will sound the same. Download another voice model in Settings → Roles → Audio TTS Model to get a male + female pair.';

/** 本地无就绪模型（未下载完成）：连一条音色都派生不出来 */
const NOTE_NO_LOCAL_MODEL =
  'No offline voice model is ready yet — download one in Settings → Roles → Audio TTS Model before generating a podcast.';

/** 把一条本地预置音色落成主播的合成设置：换模型（+ 换音色），其余字段原样透传 */
function presetSettings(base: TtsSettings, cand: LocalPresetVoice): TtsSettings {
  return {
    ...base,
    localModel: cand.modelId,
    localVoice: cand.voiceId,
  };
}

/** 当前已选的（localModel, localVoice）落在哪条候选上；该模型下查不到就取模型首条 */
function currentPresetCandidate(
  cands: LocalPresetVoice[],
  modelId: string,
  voiceId: string | undefined,
): LocalPresetVoice | undefined {
  const inModel = cands.filter((c) => c.modelId === modelId);
  if (inModel.length === 0) return undefined;
  return inModel.find((c) => c.voiceId === (voiceId || undefined)) ?? inModel[0];
}

/** 该模型内是否男女声俱全（能自成一男一女，无需跨模型拼） */
function modelHasPair(cands: LocalPresetVoice[], modelId: string): boolean {
  const inModel = cands.filter((c) => c.modelId === modelId);
  return inModel.some((c) => c.gender === 'male') && inModel.some((c) => c.gender === 'female');
}

/** 首选能自成一男一女的模型：用户当前模型优先，其次候选序列里首个男女俱全的模型 */
function preferredPairModel(cands: LocalPresetVoice[], modelId: string): string | undefined {
  if (modelId && modelHasPair(cands, modelId)) return modelId;
  return cands.find((c) => modelHasPair(cands, c.modelId))?.modelId;
}

/**
 * host A：UI 指定 > 同模型成对（用户当前模型优先）> 用户已选 > 首选女声 > 首条。
 * 同模型成对优先的理由：两位主播来自同一模型时音色、采样率、响度天然一致；
 * 跨模型拼出来的两条（分属两个模型的音色）会把模型间的差异直接暴露给听众。
 */
function pickPresetHostA(
  cands: LocalPresetVoice[],
  modelId: string,
  voiceId: string | undefined,
  override?: string,
): LocalPresetVoice | undefined {
  const explicit = cands.find((c) => c.id === override);
  if (explicit) return explicit;
  const pairModel = preferredPairModel(cands, modelId);
  if (pairModel) {
    const inModel = cands.filter((c) => c.modelId === pairModel);
    // 用户当前模型就是该模型时，沿用他在 Settings 里选的音色，不擅自改性别
    const chosen = pairModel === modelId && voiceId ? inModel.find((c) => c.voiceId === voiceId) : undefined;
    return chosen ?? inModel.find((c) => c.gender === 'female') ?? inModel[0];
  }
  return currentPresetCandidate(cands, modelId, voiceId) ?? cands.find((c) => c.gender === 'female') ?? cands[0];
}

/** host B：UI 指定 > A 同模型内的相反性别 > 跨模型相反性别 > 任意另一条 */
function pickPresetHostB(
  cands: LocalPresetVoice[],
  a: LocalPresetVoice,
  override?: string,
): LocalPresetVoice | undefined {
  const explicit = cands.find((c) => c.id === override);
  if (explicit) return explicit;
  const oppositeOf = (list: LocalPresetVoice[]) =>
    a.gender ? list.find((c) => c.id !== a.id && !!c.gender && c.gender !== a.gender) : undefined;
  return (
    oppositeOf(cands.filter((c) => c.modelId === a.modelId)) ?? oppositeOf(cands) ?? cands.find((c) => c.id !== a.id)
  );
}

/** 按当前引擎给出建议分段长度（与 /api/tts/local 的 GET 口径一致） */
export function speechChunkCharsFor(tts: TtsSettings | undefined): number {
  if ((tts?.provider || '').toLowerCase() !== SHERPA_LOCAL_PROVIDER) return SPEECH_CHUNK_CHARS;
  return findLocalTtsModel(tts?.localModel)?.kind === 'zero-shot' ? ZERO_SHOT_CHUNK_CHARS : LOCAL_NEURAL_CHUNK_CHARS;
}

/** 脚本生成的系统提示（内容恒定，不随调用变化——系统提示稳定性是本仓硬约束） */
const SCRIPT_SYSTEM_PROMPT = `你是一名播客脚本编剧。把用户提供的资料改写成两位主播（Host A 与 Host B）的脚本，供语音合成直接朗读。

要求：
1. 两人轮流发言、有来有回，不要写成一人独白；开场由 A 用一句话点题，结尾由 B 用一句话收束。
2. 口语化：短句、自然停顿，适合朗读；不要 Markdown 标记、不要表情符号、不要分镜/音效/括号提示（如「（笑）」）。
3. 真人对谈的"不完美"要留痕：偶尔用语气词起头（嗯、对、哎、这么说吧）、偶尔插话或替对方把话说完、偶尔半句改口（"我的意思是——""不对，应该说……"）。全篇这类痕迹 3～6 处即可，不要每句都有，更不能因此改变事实或数字。
4. 忠实原文：关键事实、数字、名称、结论必须来自资料，**不得编造**；资料没写的不要补。
5. 篇幅：全文口播总字数控制在 ${PODCAST_TARGET_CHARS} 字以内，单条发言不超过 ${PODCAST_MAX_LINE_CHARS} 字。

只输出 JSON，不要任何解释或代码块标记：
{"lines":[{"speaker":"A","text":"…"},{"speaker":"B","text":"…"}]}`;

/** 播客形式：两位主播的互动方式（默认 qa = 原先的采访问答，行为不变） */
export type PodcastForm = 'qa' | 'relay' | 'debate' | 'chat';

/**
 * 各形式的互动指令。刻意放进 **user message** 而不是系统提示：
 * 本仓要求系统提示恒定（利于缓存与复现），换形式只换这一句，不动上面那段。
 */
const FORMAT_DYNAMICS: Record<PodcastForm, string> = {
  qa: '采访问答：A 负责引出话题与追问，B 负责展开与回应，像一场访谈。',
  relay:
    '接力讲述：两人共同推进同一条叙事线，轮流承接对方的话继续说下去、互相补充细节；不设主问方，避免「你问我答」的采访腔。',
  debate:
    '正反对辩：A 持支持立场、B 持质疑立场，轮流给出论据并回应对方的质疑，形成交锋；资料里没有某一方的依据时，该方要明确表示「资料里没有相关依据」，绝不编造论据。',
  chat: '闲聊评论：两人像朋友聊天一样对资料各抒己见、互相附和或打趣，可以用语气词和个人感受，但必须始终围绕资料内容，不跑题、不改事实。',
};

/** 形式值校验（路由用它兜住非法输入，避免脏值走进 prompt 表） */
export function isPodcastForm(v: unknown): v is PodcastForm {
  return v === 'qa' || v === 'relay' || v === 'debate' || v === 'chat';
}

/** 一次 chat 调用（OpenAI 兼容 /chat/completions）；失败抛出带响应体摘要的错误 */
async function callChat(cfg: ResolvedModel, system: string, user: string): Promise<string> {
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Model call failed (HTTP ${resp.status}): ${errText.slice(0, 200) || '(empty body)'}`);
  }
  const data = await resp.json();
  return String(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.delta?.content || '');
}

/**
 * 解析模型返回的脚本 JSON。
 * 容错口径：剥 ``` 围栏 → 取首个 `{` 到末个 `}`（模型常加一句解说）→ speaker 归一（含 B 即 B，其余归 A）
 * → 丢空行。解析不出返回空数组，由调用方决定重试。
 */
function parseScript(raw: string): PodcastLine[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (data as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(list)) return [];
  const out: PodcastLine[] = [];
  for (const item of list) {
    const text = String((item as { text?: unknown } | null)?.text ?? '').trim();
    if (!text) continue;
    const speaker = String((item as { speaker?: unknown } | null)?.speaker ?? '').toUpperCase();
    out.push({ speaker: speaker.includes('B') ? 'B' : 'A', text: text.slice(0, PODCAST_MAX_LINE_CHARS) });
    if (out.length >= PODCAST_MAX_LINES) break;
  }
  return out;
}

/**
 * 资料 → 双主播脚本（form 决定两人的互动方式，默认 qa）。
 * 空内容/解析失败自动重试 1 次（与 /api/core/meeting 同口径）；仍失败抛错，由路由转成错误帧。
 */
export async function generatePodcastScript(
  title: string,
  sourceText: string,
  form: PodcastForm = 'qa',
): Promise<{ lines: PodcastLine[]; model: string }> {
  const cfg = await resolveTaskModel();
  if (!cfg) {
    throw new Error(
      'No model is configured. Add an API key in Settings → Models and pick a chat model, or set Task Model in Role Assignment.',
    );
  }
  const text = sourceText.slice(0, PODCAST_MAX_INPUT_CHARS);
  const user = `形式要求：${FORMAT_DYNAMICS[form]}\n\n资料标题：${title || '未命名资料'}\n\n--- 资料开始 ---\n${text}\n--- 资料结束 ---\n\n请按系统提示的结构输出 JSON。`;

  const first = parseScript(await callChat(cfg, SCRIPT_SYSTEM_PROMPT, user));
  if (first.length > 0) return { lines: first, model: cfg.model };
  const second = parseScript(await callChat(cfg, SCRIPT_SYSTEM_PROMPT, user));
  if (second.length > 0) return { lines: second, model: cfg.model };
  throw new Error('The model did not return a usable dialogue script — try again or switch the task model.');
}

/**
 * 把已选的 TTS 拆成两位主播的合成设置（只改音色字段，其余原样透传）：
 *   - 本地神经引擎 · 预置模型（vits-zh-ll）：候选 = 所有已就绪的预置音色；默认一男一女**优先
 *     取自同一模型**（如 vits-zh-ll 的 gunian + fushiyu，采样率与响度天然一致），用户当前模型能成对
 *     就用它、否则取首个男女俱全的模型；同一模型凑不出双声时才跨模型拼成一对；凑不出第二条 → 同音色 + note；
 *   - 本地神经引擎 · 零样本模型：内置「通用男/女声」参考音（host A 优先沿用用户已配的参考音）；
 *     参考音只生成了半套 → 同音色 + note；
 *   - 云端：host A = 用户已配 voice（否则厂商默认），host B = PODCAST_VOICES 里的另一条；
 *     厂商不在表中 → 同音色 + note。
 * overrides（UI 的 Host A / Host B 下拉）给出时覆盖对应主播音色；值在本引擎里查不到则回落自动派生。
 * @throws TtsNotConfiguredError 未配置任何 TTS 引擎（合成前就报，别等第一句才失败）
 */
export async function resolveHostVoices(
  tts: TtsSettings | undefined,
  overrides?: HostVoiceOverrides,
): Promise<HostVoices> {
  const base: TtsSettings = tts ?? {};
  const provider = (base.provider || '').toLowerCase();

  if (provider === SHERPA_LOCAL_PROVIDER) {
    const modelId = base.localModel ?? '';
    const def = findLocalTtsModel(modelId);
    if (!def) {
      throw new Error(
        'The offline speech engine has no local model selected — pick one in Settings → Roles → Audio TTS Model.',
      );
    }
    // 预置模型（vits-zh-ll）：候选来自所有已就绪的预置音色，默认一男一女优先同模型
    // （用户当前模型能成对就用它，否则取首个男女俱全的模型；都不行才跨模型拼）
    if (def.kind !== 'zero-shot') {
      const cands = await listLocalPresetVoices();
      const candA = pickPresetHostA(cands, modelId, base.localVoice, overrides?.hostA);
      if (!candA) return { hostA: base, hostB: base, note: NOTE_NO_LOCAL_MODEL };
      const candB = pickPresetHostB(cands, candA, overrides?.hostB);
      // 只就绪一个模型（凑不出第二条）：照常出产物，但同音色 + note，不静默降级
      if (!candB) return { hostA: presetSettings(base, candA), hostB: presetSettings(base, candA), note: NOTE_SINGLE_PRESET_LOCAL };
      return { hostA: presetSettings(base, candA), hostB: presetSettings(base, candB) };
    }
    // 零样本模型：内置通用男/女声（generic-female / generic-male）开箱两条；生成失败时可能只剩一条
    const refs = await listBuiltinRefs(modelId).catch(() => []);
    const refA =
      refs.find((r) => r.id === overrides?.hostA) ??
      refs.find((r) => r.wavPath === base.localRefAudio) ??
      refs.find((r) => r.id === 'generic-female') ??
      refs[0];
    const refB =
      refs.find((r) => r.id === overrides?.hostB) ??
      refs.find((r) => r.wavPath !== refA?.wavPath && r.id === 'generic-male') ??
      refs.find((r) => r.wavPath !== refA?.wavPath);
    if (!refA || !refB) return { hostA: base, hostB: base, note: NOTE_SINGLE_REF_LOCAL };
    const withRef = (r: { wavPath: string; text: string }): TtsSettings => ({
      ...base,
      localRefAudio: r.wavPath,
      localRefText: r.text,
    });
    return { hostA: withRef(refA), hostB: withRef(refB) };
  }

  if (!base.model) throw new TtsNotConfiguredError();

  const pair = PODCAST_VOICES[provider] ?? [];
  // host A：UI 指定 > 用户已配 voice > 厂商默认
  const voiceA = overrides?.hostA?.trim() || base.voice?.trim() || pair[0] || '';
  // host B：UI 指定 > 表里「另一条」（用户把 voice 设成表里第二条时也能换到第一条，而不是两边同声）
  const voiceB = overrides?.hostB?.trim() || pair.find((v) => v !== voiceA) || '';
  const hostA: TtsSettings = overrides?.hostA?.trim()
    ? { ...base, voice: voiceA }
    : base.voice?.trim()
      ? base
      : { ...base, ...(voiceA ? { voice: voiceA } : {}) };
  if (!voiceB) return { hostA, hostB: base, note: NOTE_SINGLE_VOICE_CLOUD };
  return { hostA, hostB: { ...base, voice: voiceB } };
}

/**
 * 列举当前引擎下两位主播的可选音色（Meeting 面板下拉的数据源）。
 * 为什么必须由服务端列举：TTS 配置在服务端文件里、本地模型定义与内置参考音都是服务端模块，客户端 import 不到。
 * 口径与 resolveHostVoices 自动派生一致（本地预置模型列举全部已就绪音色，可跨模型选择；ZipVoice 取内置参考音；
 * 云端取 PODCAST_VOICES），autoA/autoB 即「Auto」时实际用的是哪两条；
 * 凑不出两条时返回空/单条 + note，界面据此隐藏下拉。
 */
export async function listPodcastVoices(tts: TtsSettings | undefined): Promise<PodcastVoiceChoices> {
  const base: TtsSettings = tts ?? {};
  const provider = (base.provider || '').toLowerCase();

  if (provider === SHERPA_LOCAL_PROVIDER) {
    const modelId = base.localModel ?? '';
    const def = findLocalTtsModel(modelId);
    if (!def) {
      return {
        provider,
        voices: [],
        autoA: '',
        autoB: '',
        note: 'No offline model is selected — pick one in Settings → Roles → Audio TTS Model.',
      };
    }
    // 预置模型：候选 = 所有已就绪的预置音色（可跨模型），autoA/autoB 即自动派生出的「一男一女」（优先同模型）
    if (def.kind !== 'zero-shot') {
      const cands = await listLocalPresetVoices();
      if (cands.length === 0) {
        return { provider, voices: [], autoA: '', autoB: '', note: NOTE_NO_LOCAL_MODEL };
      }
      const a = pickPresetHostA(cands, modelId, base.localVoice);
      const b = a ? pickPresetHostB(cands, a) : undefined;
      return {
        provider,
        voices: cands.map((c) => ({ id: c.id, label: c.label })),
        autoA: a?.id ?? '',
        autoB: b?.id ?? '',
        ...(a && b ? {} : { note: NOTE_SINGLE_PRESET_LOCAL }),
      };
    }
    const refs = await listBuiltinRefs(modelId).catch(() => []);
    const refA =
      refs.find((r) => r.wavPath === base.localRefAudio) ??
      refs.find((r) => r.id === 'generic-female') ??
      refs[0];
    const refB =
      refs.find((r) => r.wavPath !== refA?.wavPath && r.id === 'generic-male') ??
      refs.find((r) => r.wavPath !== refA?.wavPath);
    return {
      provider,
      voices: refs.map((r) => ({ id: r.id, label: r.label })),
      autoA: refA?.id ?? '',
      autoB: refB?.id ?? '',
      ...(refA && refB ? {} : { note: NOTE_SINGLE_REF_LOCAL }),
    };
  }

  const pair = PODCAST_VOICES[provider] ?? [];
  const voiceA = base.voice?.trim() || pair[0] || '';
  const voiceB = pair.find((v) => v !== voiceA) || '';
  return {
    provider,
    voices: pair.map((v) => ({ id: v, label: v })),
    autoA: voiceA,
    autoB: voiceB,
    ...(voiceB ? {} : { note: NOTE_SINGLE_VOICE_CLOUD }),
  };
}

/**
 * 产物 md：首行音频指针（History 回放据此配对）+ 逐行台词。
 * 台词写成 `Host A: …` 纯文本口径——回放字幕直接读这一份，不出现裸 Markdown 标记。
 */
export function renderPodcastMarkdown(title: string, lines: PodcastLine[], audioHint: string): string {
  const body = lines.map((l) => `Host ${l.speaker}: ${l.text}`).join('\n\n');
  return `<!-- bob-audio: ${audioHint} -->\n\n# Podcast: ${title}\n\n${body}\n`;
}