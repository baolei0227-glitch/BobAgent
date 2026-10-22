/**
 * `lib/bridge/mail-adapter.ts` —— 邮件归一化判定的回归用例（2026-10-10 感知面 ①）
 *
 * 工单 §二验收探针 ①：**必须成对**——目标邮件 → 期望条目；营销 / 系统退信 → 必须 null。
 * 并附一条「合格数为 0 时显式失败」的哨兵断言：防止将来把判据收紧到「什么都拦」时，
 * 用例仍因全是 null 而平凡通过（那等于静默失效）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeMailActivity, mailDedupeKey, isNonHumanSender, type RawMailActivity } from './mail-adapter';

/** 一封「应该被看见」的人工来信 */
function humanMail(over: Partial<RawMailActivity> = {}): RawMailActivity {
  return {
    messageId: 'abc123@example.com',
    from: 'Li Ming <liming@partner.com>',
    subject: 'Re: 合同第 3 条修改意见',
    receivedAt: Date.parse('2026-10-10T09:12:00+08:00'),
    snippet: '第三条我建议改成……',
    ...over,
  };
}

describe('normalizeMailActivity —— 该看见的邮件', () => {
  it('人工来信 → 合格条目（key 走 mail:<Message-ID>）', () => {
    const item = normalizeMailActivity(humanMail());
    expect(item).not.toBeNull();
    expect(item!.key).toBe('mail:abc123@example.com');
    expect(item!.title).toBe('Re: 合同第 3 条修改意见');
    expect(item!.startMs).toBe(Date.parse('2026-10-10T09:12:00+08:00'));
    expect(item!.time).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('无主题的人工来信 → 用 (no subject) 兜底，仍算合格', () => {
    const item = normalizeMailActivity(humanMail({ subject: '' }));
    expect(item).not.toBeNull();
    expect(item!.title).toBe('(no subject)');
  });

  it('无 Message-ID → 用 from+subject+receivedAt 合成稳定键（同输入同键）', () => {
    const raw = humanMail({ messageId: undefined });
    const a = normalizeMailActivity(raw);
    const b = normalizeMailActivity({ ...raw });
    expect(a!.key).toBe(b!.key);
    expect(a!.key.startsWith('mail:')).toBe(true);
  });

  it('哨兵：合格用例数必须非零（判据被收紧成「全拦」时这里会失败）', () => {
    const samples = [
      humanMail(),
      humanMail({ messageId: 'm2@x.com', from: 'wang@client.cn', subject: '明天会议改到几点？' }),
      humanMail({ messageId: 'm3@x.com', from: 'hr@company.com', subject: 'Offer 确认' }),
    ];
    const passed = samples.filter((s) => normalizeMailActivity(s) !== null);
    expect(passed.length).toBe(samples.length);
  });
});

describe('normalizeMailActivity —— 该拦下的邮件（全部返回 null）', () => {
  const rejected: Array<[string, RawMailActivity]> = [
    ['营销：带 List-Unsubscribe', humanMail({ hasListUnsubscribe: true, from: 'promo@sales.com' })],
    ['邮件列表：Precedence: bulk', humanMail({ precedence: 'bulk' })],
    ['营销：Precedence: junk', humanMail({ precedence: 'Junk' })],
    ['noreply 发件人', humanMail({ from: 'no-reply@shop.com', subject: '您的订单已发货' })],
    ['donotreply 发件人', humanMail({ from: 'DoNotReply@bank.com' })],
    ['newsletter 发件人', humanMail({ from: 'newsletter@aiweekly.io' })],
    ['系统退信：mailer-daemon 发件人', humanMail({ from: 'MAILER-DAEMON@mx.example.com' })],
    ['系统退信：投递失败主题', humanMail({ from: 'postmaster@mx.example.com', subject: 'Undelivered Mail Returned to Sender' })],
    ['系统退信：中文退信主题', humanMail({ from: 'service@corp.com', subject: '退信：无法投递' })],
    ['自动回复：Out of office', humanMail({ from: 'chen@corp.com', subject: 'Out of Office: Re: 合同' })],
    ['自动回复：Auto-Submitted 头', humanMail({ autoSubmitted: 'auto-replied' })],
    ['自动生成：Auto-Submitted: auto-generated', humanMail({ autoSubmitted: 'auto-generated', from: 'system@erp.com' })],
    ['无发件人', humanMail({ from: '' })],
  ];

  for (const [name, raw] of rejected) {
    it(`${name} → null`, () => {
      expect(normalizeMailActivity(raw)).toBeNull();
    });
  }

  it('哨兵：被拦用例数必须非零（判据被放宽成「全放行」时这里会失败）', () => {
    const blocked = rejected.filter(([, raw]) => normalizeMailActivity(raw) === null);
    expect(blocked.length).toBe(rejected.length);
  });
});

describe('辅助口径', () => {
  it('isNonHumanSender 只看 local part，不误伤业务信箱', () => {
    expect(isNonHumanSender('noreply@x.com')).toBe(true);
    expect(isNonHumanSender('Billing <do-not-reply@x.com>')).toBe(true);
    // 业务信箱是真人/真人轮值，不得误判为非人类
    expect(isNonHumanSender('info@x.com')).toBe(false);
    expect(isNonHumanSender('support@x.com')).toBe(false);
  });

  it('mailDedupeKey 去除尖括号包裹的 Message-ID', () => {
    expect(mailDedupeKey(humanMail({ messageId: '<m-1@x.com>' }))).toBe('mail:m-1@x.com');
  });
});
