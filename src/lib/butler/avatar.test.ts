/**
 * 系统身份头像的回归测试（avatar.ts 的 SYSTEM_IDENTITIES）。
 *
 * 为什么值得测：系统身份的头像是**按显示名钉死**的（不参与性格推导），
 * 而三处消费方各自独立调用 `defaultAvatarId` / `avatarTint`（联系人列 + 中栏工具行
 * + 每条气泡的 ContactAvatar）。一旦这张表被改动时漏改、或名字与 storage.ts 的
 * 常量脱钩，症状是「同一个人在两处长得不一样」——静默、且只在界面上看得见。
 *
 * 另外钉住当前的口径：Bobby 用专用件 `bell` + 蓝 210°，小微用专用件 `wechat` + 微信绿 149°，
 * 且两张专用件都不入名字散列池（普通好友拿不到）。
 */
import { describe, expect, it } from 'vitest';
import {
  PERSONA_AVATAR_IDS,
  SYSTEM_AVATAR_IDS,
  avatarHue,
  avatarTint,
  defaultAvatarId,
  isPersonaAvatarId,
  resolveAvatarId,
} from './avatar';
import { NOTIFY_TITLE, SEARCH_TITLE } from './storage';

describe('系统身份头像按显示名钉死', () => {
  it('Bobby：专用件 bell（铃铛）+ 蓝底 210°', () => {
    expect(defaultAvatarId(NOTIFY_TITLE)).toBe('bell');
    expect(avatarHue(NOTIFY_TITLE)).toBe(210);
  });

  it('小微：专用件 wechat + 微信绿 149°', () => {
    expect(defaultAvatarId(SEARCH_TITLE)).toBe('wechat');
    expect(avatarHue(SEARCH_TITLE)).toBe(149);
  });

  it('两个身份两两可辨：形象互不相同、色相互不相同', () => {
    const names = [NOTIFY_TITLE, SEARCH_TITLE];
    const ids = names.map((n) => defaultAvatarId(n));
    const hues = names.map((n) => avatarHue(n));
    expect(new Set(ids).size).toBe(names.length);
    expect(new Set(hues).size).toBe(names.length);
  });

  it('钉死不受人设影响（Bobby / 小微 都允许用户改人设）', () => {
    // 「傲娇」「元气」都会命中关键词规则，但系统身份不参与推导
    expect(defaultAvatarId(NOTIFY_TITLE, '傲娇但心软')).toBe('bell');
    expect(defaultAvatarId(SEARCH_TITLE, '元气满满')).toBe('wechat');
  });

  it('专用件不入名字散列池：普通好友永远拿不到 bell / wechat', () => {
    // 系统池与性格池必须不相交，否则「第 11–12 张」会被名字散列抽给普通好友
    for (const id of SYSTEM_AVATAR_IDS) {
      expect(PERSONA_AVATAR_IDS as readonly string[]).not.toContain(id);
    }
    // 扫一批名字 + 性格，确认散列结果里不出现专用件
    const pool = new Set<string>();
    for (const name of ['小法', '张三', '李四', '王五', '小美', '阿强', '赵六', '钱七']) {
      pool.add(defaultAvatarId(name));
      pool.add(defaultAvatarId(name, '幽默风趣'));
    }
    for (const id of SYSTEM_AVATAR_IDS) expect(pool.has(id)).toBe(false);
  });

  it('底色跟着钉死色相走（不落回名字散列）', () => {
    expect(avatarTint(NOTIFY_TITLE).backgroundColor).toContain('hsl(210');
    expect(avatarTint(SEARCH_TITLE).backgroundColor).toContain('hsl(149');
  });

  it('普通好友仍走性格/名字推导，拿不到系统专用件', () => {
    expect(defaultAvatarId('小法', '严谨、专业')).toBe('rigorous');
    // 无性格时按名字散列，只在 10 张性格原型里挑；同一名字恒定
    const a = defaultAvatarId('张三');
    expect(defaultAvatarId('张三')).toBe(a);
    expect(a).not.toBe('wechat');
  });
});

/**
 * 2026-10-18「可换头像」新增：用户显式选定（内置 10 张 / 上传自定义图）必须被渲染侧认，
 * 但**系统身份例外**——否则改头像会变成一条给普通人穿上 Bobby / 小微形象的路子。
 * 自定义图（avatarImage）由调用方直接渲染，不在本模块口径内，故只测内置覆盖。
 */
describe('头像覆盖（resolveAvatarId / isPersonaAvatarId）', () => {
  it('无覆盖时与纯派生完全一致（引入覆盖不改变既有行为）', () => {
    expect(resolveAvatarId('小法', '严谨、专业')).toBe(defaultAvatarId('小法', '严谨、专业'));
    expect(resolveAvatarId('张三')).toBe(defaultAvatarId('张三'));
    expect(resolveAvatarId('张三', undefined, null)).toBe(defaultAvatarId('张三'));
  });

  it('合法内置 id 覆盖性格推导', () => {
    // 「严谨」本身会派生出 rigorous，覆盖成 genki 后必须生效
    expect(resolveAvatarId('小法', '严谨、专业', 'genki')).toBe('genki');
  });

  it('非法覆盖一律落回派生（脏数据不会把头像渲染空）', () => {
    expect(resolveAvatarId('小法', '严谨', 'not-a-real-id')).toBe('rigorous');
    expect(resolveAvatarId('小法', '严谨', '')).toBe('rigorous');
    // 系统专用件不在候选池：即便被塞进来也不认
    expect(resolveAvatarId('小法', '严谨', 'bell')).toBe('rigorous');
  });

  it('系统身份永不被覆盖：形象是身份的一部分', () => {
    expect(resolveAvatarId(NOTIFY_TITLE, '傲娇但心软', 'genki')).toBe('bell');
    expect(resolveAvatarId(SEARCH_TITLE, '元气满满', 'genki')).toBe('wechat');
  });

  it('isPersonaAvatarId 只认 10 张性格原型，拒系统专用件与非字符串', () => {
    for (const id of PERSONA_AVATAR_IDS) expect(isPersonaAvatarId(id)).toBe(true);
    for (const id of SYSTEM_AVATAR_IDS) expect(isPersonaAvatarId(id)).toBe(false);
    expect(isPersonaAvatarId('')).toBe(false);
    expect(isPersonaAvatarId(undefined)).toBe(false);
    expect(isPersonaAvatarId(3)).toBe(false);
  });
});
