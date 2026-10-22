import { describe, expect, it } from 'vitest';

import { CODING_DOC_SECTIONS, codingDocIndex, renderCodingDoc } from './coding-docs';

describe('coding bridge docs (on-demand)', () => {
  it('index lists every section', () => {
    const idx = codingDocIndex();
    for (const s of CODING_DOC_SECTIONS) {
      expect(idx).toContain(s.key);
    }
  });

  it('renders each section with its key APIs', () => {
    expect(renderCodingDoc('storage')).toContain('BobStorage.save');
    expect(renderCodingDoc('host')).toContain('BobWork.listActions');
    expect(renderCodingDoc('graph')).toContain('graphGetPermission');
    expect(renderCodingDoc('chat')).toContain('chatStream');
    expect(renderCodingDoc('hostTool')).toContain('BobWork.host');
  });

  it('unknown section returns the index + guidance', () => {
    const out = renderCodingDoc('nope');
    expect(out).toContain('未知分区');
    expect(out).toContain('storage');
    expect(out).toContain('hostTool');
  });
});
