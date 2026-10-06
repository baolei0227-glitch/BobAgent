/**
 * 管家「等待口语」——话风判定 + 静默分档 + 轮换取句（2026-10-06 从 ButlerDrawer 抽出并扩写）。
 *
 * 为什么单独成模块：这套文案有三条硬规矩（见下），规矩靠人记必然漂移；抽成纯函数后由
 * `wait-lines.test.ts` 逐条守住——扩写文案时不会再写出"猜进度"或"省略号说两遍"的句子。
 *
 * 三条规矩（2026-09-27 立，2026-10-06 保留并扩写）：
 *   ① **句式不重样**：口头反射（"On it."）、自言自语（"Thinking, one sec."）、安抚（"Hands full, hold on."）、
 *      自嘲（"This is rougher than it looks."）各来一点；档位之间也换腔调，越久越软。
 *   ② **只写永远成立的话**：不写「在查资料 / 在写代码」这类**具体动作**——那是在猜进度，猜错就露馅。
 *      创意全落在**怎么说**，不在**说什么**，所以它不可能说错话。
 *   ③ **句尾不写省略号**：行尾已经挂了三个跳动点，再缀一个省略号就是同一个"话没说完"说两遍。
 *      （cool 档句首的 `...` 是语气停顿，不在此列。）
 *
 * **分档按「距上次可见输出」的静默时长**，不是整轮总时长（2026-10-06 改）：
 * 一旦又吐字，静默计时归零、回到第一档 —— 于是「久到用户开始怀疑」时才升级安抚，
 * 而不是整轮越跑越像出事了（实测事故：一轮 74 秒无新字，三个跳动点也早已随首个字退场）。
 */

/** 等待话风：温和（默认）/ 高冷（傲娇·毒舌·冷静…）/ 简洁（少话·利落） */
export type WaitVoice = 'warm' | 'cool' | 'brief';

/** 静默分档上界（秒）：0-5 先应一声 / 5-25 说明还在动 / 25-60 认真安抚 / 60+ 承认这件事很大 */
export const WAIT_TIER_BOUNDS = [5, 25, 60] as const;

/**
 * 流式气泡的**状态条**至少静默多少秒才出场（见 ButlerDrawer 的 ButlerStatusStrip）。
 * 为什么不是 0：正常吐字时每秒都有新字，状态条恒定显示就只是给每条回复加噪音；
 * 取 8s —— 比第一档上界（5s）略大，避开正常顿挫的闪烁，又能在"开始让人犯嘀咕"的时刻立刻出现。
 */
export const WAIT_STRIP_MIN_SILENCE_SEC = 8;

/** 等待口语表：话风 → 四档，每档多句（每 5 秒轮换一句；档内越靠前越先出现） */
export const WAIT_LINES: Record<WaitVoice, string[][]> = {
  // 温和：像个熟人同事，先应一声；久了自己也着急，会道歉、会道谢
  warm: [
    ['On it.', 'Let me take a look.', 'Right with you.', 'Give me a moment.'],
    [
      'Thinking, one sec.',
      'Hands full, hold on.',
      'Let me sort this out.',
      'Still here, working through it.',
      'Give me a bit more.',
    ],
    [
      'This is rougher than it looks, pushing on.',
      "Sorry for the wait, I'm not slacking.",
      'Just a bit longer, almost there.',
      "I haven't forgotten you, still on it.",
      'Bear with me, nearly through.',
    ],
    [
      'This one is bigger than I thought, still on it.',
      "Longer than I'd like, but it's moving.",
      "I haven't stalled — this just takes a while.",
      "You can leave me to it, I'll shout when it's done.",
      'Still pushing, thanks for waiting.',
    ],
  ],
  // 高冷：嘴上不饶人，手上没停；不解释、不道歉，但会认账
  cool: [
    ['...Mm, watching it.', "...What's the rush, looking now.", '...Fine, on it.', '...Not ignoring you.'],
    [
      'Not stuck, just thinking.',
      "Rushing won't make it faster.",
      '...Working on it, quit staring.',
      'It takes what it takes.',
      '...Still going, obviously.',
    ],
    [
      "...I know it's been a while — rushing won't help.",
      "Slow, but I'm not slacking.",
      "Hold on, this can't be rushed.",
      '...Still working. Obviously.',
      "You'll get it when it's right.",
    ],
    [
      "...Yes, still at it. It's a big one.",
      '...Not stalled. Just long.',
      "...You can stop watching, I'll finish it.",
      "...It's not quick, but it's moving.",
      '...Still here. Still working.',
    ],
  ],
  // 简洁：能省则省，但每个字都还在动
  brief: [
    ['Taking a look.', 'One sec.', 'On it.', 'Looking.'],
    ['Almost.', 'Still moving.', 'Working.', 'Not done yet.', 'Hang on.'],
    ['A bit more.', 'Nearly there, one sec.', 'Still on it.', 'Working through it.', 'Almost done.'],
    ['Still going.', 'Big one, still on it.', 'Not stalled.', 'Still working.', 'A while longer.'],
  ],
};

/**
 * 从**用户填的人设**里读性格与说话风格，关键词命中即取话风；未命中走温和。
 * 于是「换个人设，等待时的口吻也跟着换」，不需要用户额外配置。
 */
export function waitVoiceOf(persona: {
  template?: string;
  personality?: string;
  style?: string;
} | null): WaitVoice {
  const t = `${persona?.template ?? ''} ${persona?.personality ?? ''} ${persona?.style ?? ''}`;
  if (/tsundere|傲娇|毒舌|高冷|冷静|沉稳|严肃|冷淡/.test(t)) return 'cool';
  if (/简洁|简短|少话|利落|不啰嗦|直接/.test(t)) return 'brief';
  return 'warm';
}

/** 静默秒数 → 档位索引（0..3） */
export function waitTierIndex(silenceSec: number): number {
  const sec = Number.isFinite(silenceSec) && silenceSec > 0 ? silenceSec : 0;
  if (sec < WAIT_TIER_BOUNDS[0]) return 0;
  if (sec < WAIT_TIER_BOUNDS[1]) return 1;
  if (sec < WAIT_TIER_BOUNDS[2]) return 2;
  return 3;
}

/**
 * 取当前该说的那一句。
 * @param voice 话风（waitVoiceOf 的结果）
 * @param silenceSec **距上次可见输出**的秒数（不是整轮总时长）
 * @param addressUser 人设里对用户的称呼；仅温和档第一档会拼上（「老板，On it.」）
 */
export function waitLineFor(opts: { voice: WaitVoice; silenceSec: number; addressUser?: string }): string {
  const { voice, addressUser } = opts;
  const sec = Number.isFinite(opts.silenceSec) && opts.silenceSec > 0 ? opts.silenceSec : 0;
  const tier = waitTierIndex(sec);
  const pool = WAIT_LINES[voice][tier];
  // 每 5 秒轮换一句（档内循环）
  const line = pool[Math.floor(sec / 5) % pool.length];
  const addr = (addressUser || '').trim();
  // 温和档的第一档带上人设对用户的称呼（人设没填称呼就保持原样）
  if (voice === 'warm' && tier === 0 && addr) return `${addr}, ${line}`;
  return line;
}
