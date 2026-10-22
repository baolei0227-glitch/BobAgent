import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { describeImageWithVisionModel, PREVIEW_VISION_PROMPT } from './vision-model';

const cfg = { providerModelId: 'deepseek-flash', apiKey: 'key', baseUrl: 'https://api.deepseek.com' };

describe('native preview vision', () => {
  beforeEach(() => createMock.mockReset());

  it('returns the model text and sends an image_url part', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'layout is clean' } }] });
    const out = await describeImageWithVisionModel('data:image/png;base64,AAAA', PREVIEW_VISION_PROMPT, cfg);
    expect(out).toBe('layout is clean');
    const req = createMock.mock.calls[0]?.[0] as { messages?: Array<{ content?: Array<{ type?: string }> }> };
    expect(req.messages?.[0]?.content?.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('returns null when the provider response is unusable (caller falls back to OCR)', async () => {
    createMock.mockResolvedValue(null);
    await expect(describeImageWithVisionModel('data:image/png;base64,AAAA', PREVIEW_VISION_PROMPT, cfg)).resolves.toBeNull();
  });

  it('returns null without an api key or image', async () => {
    await expect(describeImageWithVisionModel('', PREVIEW_VISION_PROMPT, cfg)).resolves.toBeNull();
    await expect(describeImageWithVisionModel('data:image/png;base64,AAAA', PREVIEW_VISION_PROMPT, { ...cfg, apiKey: '' })).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});
