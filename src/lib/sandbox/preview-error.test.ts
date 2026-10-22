import { describe, expect, it } from 'vitest';

import { previewErrorHtml } from './preview-error';

describe('friendly preview error page', () => {
  it('renders a human page, never raw JSON', () => {
    const html = previewErrorHtml('This mini-app didn\'t open', 'Please try again.');
    expect(html).toContain('This mini-app didn&#39;t open');
    expect(html).toContain('Try again');
    expect(html).toContain('ask AI to check');
    expect(html).not.toContain('"success"');
  });

  it('escapes title/message instead of injecting HTML', () => {
    const html = previewErrorHtml('<script>alert(1)</script>', 'a & b');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
