'use client';

/**
 * components/butler/useReadAloud.ts — butler 回复「朗读」(Read aloud) 播放控制器
 *
 * 定位：与输入侧的微信式语音输入对称的**出口**——把某条回复念出来。
 *
 * 引擎：不做第二套真相，直接走**设置里已选中的那一款** TTS（云端 / 本地离线引擎互斥单选），
 * 经 POST /api/tts/speak 合成；未配置时把后端的 "not_configured" 提示就地显示，不静默失败。
 *
 * 为什么是模块级单例而不是每条消息一个播放器：
 *   1) 同一时刻只该有一个声音（新起一条自动停上一条）；
 *   2) 关抽屉 / 切联系人要能**一条命令全停**（见下方 stopReadAloud 的 imperative 入口）。
 *
 * 分段串行播放：长回复按句子切成多段（见 lib/tts/plain-text），逐段请求**并预取下一段**——
 * 首字延迟小、且天然支持段间停止；同一段文本在本会话内缓存 blob URL，重播不再计费。
 */

import { useCallback, useEffect, useReducer } from 'react';
import { chunkForSpeech, SPEECH_CHUNK_CHARS, toSpeakableText } from '@/lib/tts/plain-text';

export type ReadAloudPhase = 'idle' | 'loading' | 'playing' | 'paused';

interface ReadAloudState {
  /** 正在朗读的消息 id（null = 无） */
  id: string | null;
  phase: ReadAloudPhase;
  error: string | null;
}

let state: ReadAloudState = { id: null, phase: 'idle', error: null };
const listeners = new Set<() => void>();

/** 代际令牌：stop / 换一条时 +1，旧的分段循环据此自行退出（避免旧请求回填状态） */
let token = 0;
/** 用户暂停意图（跨分段生效：暂停期间的分段边界处不启动下一段，避免"边暂停边出声"） */
let wantPaused = false;
/** 单例 audio 元素（客户端懒创建） */
let audio: HTMLAudioElement | null = null;
/** 中断当前段的等待（stop 时让分段循环立刻退出，不留悬挂 Promise） */
let interrupt: (() => void) | null = null;
/** 分段文本 → blob URL 会话内缓存（同段重播不再打后端、不再计费） */
const audioCache = new Map<string, string>();
const AUDIO_CACHE_MAX = 40;

function emit(): void {
  listeners.forEach((fn) => fn());
}

function update(next: Partial<ReadAloudState>): void {
  state = { ...state, ...next };
  emit();
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) audio = new Audio();
  return audio;
}

/** 缓存超量时回收最旧的一条（不动正在播的那条） */
function trimAudioCache(): void {
  if (audioCache.size <= AUDIO_CACHE_MAX) return;
  const playingUrl = audio?.src;
  for (const [key, url] of audioCache) {
    if (audioCache.size <= AUDIO_CACHE_MAX) break;
    if (url === playingUrl) continue;
    URL.revokeObjectURL(url);
    audioCache.delete(key);
  }
}

/** 取某段音频的可播 URL：命中缓存直返，否则请求 /api/tts/speak 合成 */
async function resolveChunkUrl(chunk: string): Promise<string> {
  const hit = audioCache.get(chunk);
  if (hit) return hit;
  const res = await fetch('/api/tts/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: chunk }),
  });
  if (!res.ok) {
    let msg = `Speech failed (HTTP ${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch {
      /* 非 JSON 响应：用上面的兜底文案 */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioCache.set(chunk, url);
  trimAudioCache();
  return url;
}

/** 播放一段，直到自然播完 / 出错 / 被 stop 中断 */
function playUrl(url: string, myToken: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = ensureAudio();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      interrupt = null;
      fn();
    };
    const onEnded = () => done(resolve);
    const onError = () =>
      done(() => reject(new Error('Playback failed — the audio could not be decoded by the player.')));
    interrupt = () => done(resolve);

    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.src = url;
    void el
      .play()
      .then(() => {
        if (myToken === token) update({ phase: wantPaused ? 'paused' : 'playing' });
      })
      .catch((e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

/** 暂停期间在分段边界处等待（而不是暂停后再 play 一下，避免漏出半个字） */
async function waitWhilePaused(myToken: number): Promise<void> {
  while (wantPaused && myToken === token) {
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function runQueue(id: string, chunks: string[], myToken: number): Promise<void> {
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (myToken !== token) return;
      await waitWhilePaused(myToken);
      if (myToken !== token) return;
      // 预取下一段：与当前段播放并行，段间无缝
      if (i + 1 < chunks.length) void resolveChunkUrl(chunks[i + 1]).catch(() => undefined);
      const url = await resolveChunkUrl(chunks[i]);
      if (myToken !== token) return;
      await waitWhilePaused(myToken);
      if (myToken !== token) return;
      await playUrl(url, myToken);
    }
    if (myToken === token) update({ id: null, phase: 'idle', error: null });
  } catch (e) {
    if (myToken !== token) return;
    update({ phase: 'idle', error: e instanceof Error ? e.message : String(e) });
  }
}

/** 后端按当前引擎给出的建议分段长度（本地神经引擎段更小、首字更快）；探测失败用默认 */
async function resolveChunkChars(): Promise<number> {
  try {
    const res = await fetch('/api/tts/local');
    const data = (await res.json()) as { suggestedChunkChars?: number };
    if (typeof data?.suggestedChunkChars === 'number' && data.suggestedChunkChars > 0) {
      return data.suggestedChunkChars;
    }
  } catch {
    /* 本地探测失败：回落到默认分段 */
  }
  return SPEECH_CHUNK_CHARS;
}

/** 开始朗读某条回复（自动停掉上一条） */
function start(id: string, text: string): void {
  stop();
  // 令牌同步递增：分段长度是异步取的，须先把本次朗读定格，避免探测期间被另一次 start 顶掉
  const myToken = ++token;
  wantPaused = false;
  update({ id, phase: 'loading', error: null });
  void (async () => {
    const max = await resolveChunkChars();
    if (myToken !== token) return;
    const chunks = chunkForSpeech(toSpeakableText(text), max);
    if (chunks.length === 0) {
      if (myToken === token) update({ id, phase: 'idle', error: 'Nothing to read in this message.' });
      return;
    }
    await runQueue(id, chunks, myToken);
  })();
}

/** 暂停（进行中或待播放的下一段都会停住） */
function pause(): void {
  wantPaused = true;
  audio?.pause();
  update({ phase: 'paused' });
}

/** 继续 */
function resume(): void {
  wantPaused = false;
  update({ phase: 'playing' });
  void audio?.play().catch(() => undefined);
}

/** 全停并清空状态（关抽屉 / 切联系人 / 新起一条都走这里） */
export function stopReadAloud(): void {
  token += 1;
  wantPaused = false;
  const f = interrupt;
  interrupt = null;
  f?.();
  audio?.pause();
  update({ id: null, phase: 'idle', error: null });
}

/**
 * 某条消息的朗读状态与控制（同一时刻只有一条消息处于非 idle）。
 * @param messageId 消息 id（用于区分"这条在播"与"别的在播"）
 * @param getText 取**原始 Markdown**正文（净化与分段在 start 里做，调用方不必预处理）
 */
export function useReadAloud(messageId: string, getText: () => string) {
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const fn = () => force();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const active = state.id === messageId;
  const phase: ReadAloudPhase = active ? state.phase : 'idle';
  const error = active ? state.error : null;

  const toggle = useCallback(() => {
    if (active && state.phase === 'playing') return pause();
    if (active && state.phase === 'paused') return resume();
    start(messageId, getText());
  }, [active, messageId, getText]);

  const stop = useCallback(() => {
    if (active) stopReadAloud();
  }, [active]);

  return { phase, error, toggle, stop };
}