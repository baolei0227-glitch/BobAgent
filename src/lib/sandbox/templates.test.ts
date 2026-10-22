import { describe, expect, it } from 'vitest';

import { APP_TEMPLATES, SANDBOX_TEMPLATE_LIST, SMOKE_TEST_JS } from './templates';

describe('golden scaffold templates', () => {
  it('every template has an entry file present in its files map', () => {
    for (const tpl of Object.values(APP_TEMPLATES)) {
      expect(tpl.entry).toBeTruthy();
      expect(Object.keys(tpl.files)).toContain(tpl.entry);
    }
  });

  it('ships a dedicated AI Chat template with a streaming model picker + smoke test', () => {
    const ai = APP_TEMPLATES['ai-chat'];
    expect(ai).toBeTruthy();
    expect(ai.label).toBe('AI Chat');
    expect(ai.files['smoke-test.js']).toContain('__testResult');
    const html = ai.files['index.html'];
    expect(html).toContain('chatStream');
    expect(html).toContain('listConfiguredModels');
    expect(html).toContain('selectedModel');
    expect(html).toContain('id="model"');
  });

  it('generic smoke test writes __testResult', () => {
    expect(SMOKE_TEST_JS).toContain('__testResult');
    expect(SMOKE_TEST_JS).toContain('body-rendered');
  });

  it('template list includes the new AI Chat template exactly once', () => {
    expect(SANDBOX_TEMPLATE_LIST.filter((t) => t.id === 'ai-chat')).toHaveLength(1);
  });
});
