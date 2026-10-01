/**
 * 记忆写入回归：敏感信息守卫 + 同类型相似度硬闸 + 去重。
 *
 * 记忆以**明文** Markdown 落盘并每轮注入，凭证/证件一旦写入等于长期留痕，故 addPreference
 * 必须拦截；同为防「同一事实换措辞重复累积」，同类型高相似条目也拒绝追加（倒逼走 update_preference）。
 * 普通偏好与跨类型相似不得被误判（词表与相似度均保持收敛）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；preferences.ts 的 APP_ROOT 在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let prefs: typeof import('./preferences');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-pref-'));
  process.env.BOBWORK_HOME = home;
  prefs = await import('./preferences');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('detectSensitive 敏感信息识别', () => {
  it('命中凭证 / 证件类特征', () => {
    for (const s of [
      '我的登录密码是 abc123',
      'API key: sk-xxxx',
      '记住我的银行卡号',
      '身份证号 110101199001011234',
      'db password 是 root',
      'access_token 换过一次',
    ]) {
      expect(prefs.detectSensitive(s), s).not.toBeNull();
    }
  });

  it('普通偏好不误判', () => {
    for (const s of [
      '用户习惯用表格输出',
      '引用法条必须标注时效性',
      '喜欢用命令行处理批量文件',
      '周五下午留深度工作',
    ]) {
      expect(prefs.detectSensitive(s), s).toBeNull();
    }
  });
});

describe('addPreference 写入守卫', () => {
  it('敏感内容被拒绝，且不落盘', async () => {
    const res = await prefs.addPreference('我的密码是 hunter2');
    expect(res.added).toBe(false);
    expect(res.blocked).toBeTruthy();

    const list = await prefs.listPreferences();
    expect(list).toHaveLength(0);
    const raw = await readFile(join(home, 'butler', 'preferences.md'), 'utf-8');
    expect(raw).not.toContain('hunter2');
  });

  it('普通内容正常写入并可去重', async () => {
    const first = await prefs.addPreference('用户习惯用表格输出', { type: '偏好习惯' });
    expect(first.added).toBe(true);

    const dup = await prefs.addPreference('用户习惯用表格输出');
    expect(dup.added).toBe(false);
    expect(dup.duplicate).toBe('用户习惯用表格输出');

    const list = await prefs.listPreferences();
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('用户习惯用表格输出');
    expect(list[0].type).toBe('偏好习惯');
  });
});

describe('addPreference 同类型相似度硬闸', () => {
  // 前置状态（承接上文用例）：已有 #1「用户习惯用表格输出」(偏好习惯)

  it('similarity：同文本为 1，无关文本为 0', () => {
    expect(prefs.similarity('用户习惯用表格输出', '用户习惯用表格输出')).toBe(1);
    expect(prefs.similarity('引用法条必须标注时效性', '用户习惯用表格输出')).toBe(0);
  });

  it('同类型高相似被拦，回执带既有序号 / 内容 / 分数，且不落盘', async () => {
    const res = await prefs.addPreference('用户习惯用表格的形式输出', { type: '偏好习惯' });
    expect(res.added).toBe(false);
    expect(res.conflict?.index).toBe(1);
    expect(res.conflict?.content).toBe('用户习惯用表格输出');
    expect(res.conflict?.score).toBeGreaterThanOrEqual(0.5);
    expect(await prefs.listPreferences()).toHaveLength(1);
  });

  it('同类型低相似正常写入', async () => {
    const res = await prefs.addPreference('引用法条必须标注时效性', { type: '偏好习惯' });
    expect(res.added).toBe(true);
  });

  it('跨类型高相似不拦（类型不同不算矛盾）', async () => {
    const res = await prefs.addPreference('用户习惯用表格输出结果', { type: '工作上下文' });
    expect(res.added).toBe(true);
  });

  it('完全重复仍走旧去重路径（返回 duplicate 而非 conflict）', async () => {
    const res = await prefs.addPreference('用户习惯用表格输出');
    expect(res.added).toBe(false);
    expect(res.duplicate).toBe('用户习惯用表格输出');
    expect(res.conflict).toBeUndefined();
  });
});