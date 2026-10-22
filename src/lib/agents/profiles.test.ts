import { describe, expect, it } from 'vitest';

import { BROWSER_TOOL_NAMES } from '../browser-tools/specs';
import { AGENT_PROFILES, BROWSER_CORE_TOOLS, supportsTeamCollab } from './profiles';

describe('browser sidebar core toolset', () => {
  it('every core tool name exists in the browser spec list', () => {
    for (const name of BROWSER_CORE_TOOLS) {
      expect(BROWSER_TOOL_NAMES.has(name), `${name} is not a registered browser tool`).toBe(true);
    }
  });

  it('browser profile applies the core allowlist and can bypass it with the Full setting', () => {
    expect(AGENT_PROFILES.browser.toolAllowlist).toEqual(BROWSER_CORE_TOOLS);
    expect(AGENT_PROFILES.browser.toolAllowlistBypassOnFull).toBe(true);
  });

  it('keeps the high-value tools and leaves advanced diagnostics to Full', () => {
    expect(BROWSER_CORE_TOOLS).toContain('browser_download');
    expect(BROWSER_CORE_TOOLS).toContain('browser_read_pdf');
    expect(BROWSER_CORE_TOOLS).not.toContain('browser_get_cookies');
    expect(BROWSER_CORE_TOOLS).not.toContain('browser_network_requests');
  });
});

describe('team collaboration capability', () => {
  it('dynamic chat can activate team; coding cannot', () => {
    expect(supportsTeamCollab(AGENT_PROFILES.chat)).toBe(true);
    // coding 是 fixed 画像且 fixedScenes 不含 team → team_run 不会注入，UI 也不该给入口
    expect(supportsTeamCollab(AGENT_PROFILES.coding)).toBe(false);
  });

  it('fixed profiles support team only when fixedScenes lists it explicitly', () => {
    expect(supportsTeamCollab({ scenes: 'fixed', fixedScenes: ['general', 'team'] })).toBe(true);
    expect(supportsTeamCollab({ scenes: 'fixed', fixedScenes: ['general', 'coding'] })).toBe(false);
  });
});
