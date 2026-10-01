import { describe, it, expect } from 'vitest';
import { isPodcastForm, listPodcastVoices, resolveHostVoices } from './podcast';
import type { TtsSettings } from '@/lib/settings';

/** 云端 openai 基准设置（不触盘） */
const cloud: TtsSettings = { provider: 'openai', model: 'gpt-x', apiKey: 'k' };

describe('isPodcastForm', () => {
  it('accepts known forms and rejects everything else', () => {
    for (const v of ['qa', 'relay', 'debate', 'chat']) expect(isPodcastForm(v)).toBe(true);
    for (const v of ['', 'QA', 'x', undefined, 1]) expect(isPodcastForm(v)).toBe(false);
  });
});

describe('resolveHostVoices — cloud auto vs overrides', () => {
  it('auto keeps historical behaviour (alloy / echo)', async () => {
    const { hostA, hostB, note } = await resolveHostVoices(cloud);
    expect(hostA.voice).toBe('alloy');
    expect(hostB.voice).toBe('echo');
    expect(note).toBeUndefined();
  });

  it('honours explicit overrides for both hosts', async () => {
    const { hostA, hostB } = await resolveHostVoices(cloud, { hostA: 'nova', hostB: 'shimmer' });
    expect(hostA.voice).toBe('nova');
    expect(hostB.voice).toBe('shimmer');
  });

  it('override on A only: B auto-picks a different preset', async () => {
    const { hostA, hostB } = await resolveHostVoices(cloud, { hostA: 'fable' });
    expect(hostA.voice).toBe('fable');
    expect(hostB.voice).not.toBe('fable');
  });

  it('unknown provider with no voice still falls back with a note', async () => {
    const { note } = await resolveHostVoices({ provider: 'custom-x', model: 'm', apiKey: 'k' });
    expect(note).toBeTruthy();
  });
});

describe('listPodcastVoices — cloud', () => {
  it('lists the six known OpenAI voices with no note', async () => {
    const c = await listPodcastVoices(cloud);
    expect(c.provider).toBe('openai');
    expect(c.voices.map((v) => v.id)).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(c.autoA).toBe('alloy');
    expect(c.autoB).toBe('echo');
    expect(c.note).toBeUndefined();
  });

  it('lists the nine BobMultimodal voices and derives a distinct pair', async () => {
    const c = await listPodcastVoices({ provider: 'bobmultimodal', model: 'qwen3-tts' });
    expect(c.provider).toBe('bobmultimodal');
    expect(c.voices.map((v) => v.id)).toEqual([
      'vivian', 'serena', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan',
    ]);
    expect(c.autoA).toBe('vivian');
    expect(c.autoB).toBe('serena');
    expect(c.note).toBeUndefined();
  });

  it('unlisted provider yields no options + a note', async () => {
    const c = await listPodcastVoices({ provider: 'custom-x', model: 'm', apiKey: 'k' });
    expect(c.voices).toHaveLength(0);
    expect(c.note).toBeTruthy();
  });
});

describe('local engine — preset pairing (same model preferred)', () => {
  it('pairs two ready preset voices and defaults to one male + one female', async () => {
    // vits-zh-ll 是唯一的预置模型，自带男女双声，应直接凑出一对
    const base: TtsSettings = { provider: 'sherpa-local', localModel: 'vits-zh-ll' };
    const choices = await listPodcastVoices(base);
    if (choices.voices.length < 2) return; // 本机未装该模型：无可验证，跳过

    expect(choices.note).toBeUndefined();
    expect(choices.autoA).toBeTruthy();
    expect(choices.autoB).toBeTruthy();
    expect(choices.autoA).not.toBe(choices.autoB);

    const { hostA, hostB, note } = await resolveHostVoices(base);
    expect(note).toBeUndefined();
    const keyA = `${hostA.localModel}:${hostA.localVoice ?? ''}`;
    const keyB = `${hostB.localModel}:${hostB.localVoice ?? ''}`;
    expect(keyA).not.toBe(keyB);

    // 两位主播都取自 vits-zh-ll（同模型成对，不跨模型拼）
    expect(hostA.localModel).toBe('vits-zh-ll');
    expect(hostB.localModel).toBe('vits-zh-ll');

    // UI 指定 hostB 时按候选 id 覆盖（模型 + 音色一起换；单音色候选 id 即模型 id）
    const other = choices.voices.find((v) => v.id !== choices.autoA)!.id;
    const [otherModel, otherVoice] = other.split(':');
    const picked = await resolveHostVoices(base, { hostB: other });
    expect(picked.hostB.localModel).toBe(otherModel);
    expect(picked.hostB.localVoice ?? '').toBe(otherVoice ?? '');
  });

  it('keeps the user-selected voice as host A and completes the pair in the same model', async () => {
    // 用户已选 vits-zh-ll 的男声：A 保持男声不被改性别，B 从同一模型补女声
    const base: TtsSettings = { provider: 'sherpa-local', localModel: 'vits-zh-ll', localVoice: 'gunian' };
    if ((await listPodcastVoices(base)).voices.length < 2) return; // 该模型未就绪：无可验证，跳过
    const { hostA, hostB, note } = await resolveHostVoices(base);
    expect(note).toBeUndefined();
    expect(hostA.localModel).toBe('vits-zh-ll');
    expect(hostA.localVoice).toBe('gunian');
    expect(hostB.localModel).toBe('vits-zh-ll');
    expect(hostB.localVoice).not.toBe('gunian');
  });
});

describe('local engine — overrides round-trip against the real installed refs', () => {
  it('resolveHostVoices honours an id listed by listPodcastVoices', async () => {
    const base: TtsSettings = { provider: 'sherpa-local', localModel: 'zipvoice-zh-en' };
    const choices = await listPodcastVoices(base);
    if (choices.voices.length < 2) return; // 本机未装参考音：无可验证，跳过
    const ids = choices.voices.map((v) => v.id);
    const second = ids.find((id) => id !== choices.autoA) as string;
    const { hostA, hostB } = await resolveHostVoices(base, { hostA: choices.autoA, hostB: second });
    expect(hostA.localRefAudio).not.toBe(hostB.localRefAudio);
    expect(choices.autoA).toBeTruthy();
  });
});