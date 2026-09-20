import { describe, it, expect } from 'vitest';
import {
  parseNodeMarkdown,
  appendConversation,
  type ConversationAttachment,
  type ConversationReference,
} from '../node-markdown';
import type { SubagentPanel } from '../types';

/**
 * 回归测试：question 块开头的 META / ATTACHMENTS 注释必须被完整剥净（顺序无关），
 * 不得残留进 question 正文（旧 bug：序列化顺序 META→ATTACHMENTS，解析按相反顺序各剥一次，
 * 导致 ATTACHMENTS 注释残留，前端以纯文本渲染时 JSON/文件路径原样露出）。
 */

const baseMd = `---
node_id: n_test_1
title: Test Node
created_at: 2026-08-26T00:00:00.000Z
updated_at: 2026-08-26T00:00:00.000Z
sources: []
---

## 对话记录
`;

/** 构造一个带指定 question 块的完整节点 .md（必填 frontmatter 齐全） */
function mdWithQuestion(questionBlock: string, answer = '这是回答。'): string {
  return `${baseMd}
### Q (2026-08-26T00:00:00.000Z)
${questionBlock}

### A (2026-08-26T00:00:00.000Z)
${answer}
`;
}

const attachment: ConversationAttachment = {
  id: 'att-1',
  name: '合同扫描件.pdf',
  type: 'file',
  mimeType: 'application/pdf',
  size: 12345,
  path: 'attachments/n_nodes/合同扫描件.pdf',
};
const attJson = JSON.stringify([attachment]);
const metaJson = JSON.stringify({ modelId: 'deepseek-chat', thinkingLevel: 'medium' });

/** 本轮 @引用 快照样例：覆盖四种 kind（资料 / 本地文件 / 链接 / 操作目录） */
const references: ConversationReference[] = [
  { id: 'ref-mat:materials/a/合同.pdf', kind: 'material', name: '合同.pdf', path: 'materials/a/合同.pdf', size: '176.5 KB' },
  { id: 'ref-dir:/Users/x/案卷', kind: 'file', name: '案卷', path: '/Users/x/案卷' },
  { id: 'ref-link:https://example.com/a', kind: 'link', name: 'https://example.com/a', url: 'https://example.com/a' },
  { id: 'ref-folder:/Users/x/out', kind: 'folder', name: 'out', path: '/Users/x/out', locked: true },
];
const refsJson = JSON.stringify(references);

describe('parseConversations: question 块注释剥离（方案 2 循环剥）', () => {
  it('回归：META 在前、ATTACHMENTS 在后（序列化顺序）→ 两条注释全部剥净，元信息解析正确', () => {
    const md = mdWithQuestion(
      `<!-- META: ${metaJson} -->\n<!-- ATTACHMENTS: ${attJson} -->\n请分析这份合同的风险。`,
    );
    const node = parseNodeMarkdown(md);
    const turn = node.conversations[0];

    expect(turn.question).toBe('请分析这份合同的风险。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.question).not.toContain('ATTACHMENTS');
    expect(turn.question).not.toContain('/Users');
    expect(turn.modelId).toBe('deepseek-chat');
    expect(turn.thinkingLevel).toBe('medium');
    expect(turn.questionAttachments).toEqual([attachment]);
  });

  it('顺序无关：ATTACHMENTS 在前、META 在后（逆序）→ 同样全部剥净', () => {
    const md = mdWithQuestion(
      `<!-- ATTACHMENTS: ${attJson} -->\n<!-- META: ${metaJson} -->\n请分析这份合同的风险。`,
    );
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('请分析这份合同的风险。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.modelId).toBe('deepseek-chat');
    expect(turn.thinkingLevel).toBe('medium');
    expect(turn.questionAttachments).toEqual([attachment]);
  });

  it('仅 META（无附件）→ 注释剥净，modelId/thinkingLevel 解析', () => {
    const md = mdWithQuestion(`<!-- META: ${metaJson} -->\n什么是诉讼时效？`);
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('什么是诉讼时效？');
    expect(turn.question).not.toContain('<!-- META');
    expect(turn.modelId).toBe('deepseek-chat');
    expect(turn.thinkingLevel).toBe('medium');
    expect(turn.questionAttachments).toBeUndefined();
  });

  it('仅 ATTACHMENTS（无 META）→ 注释剥净，附件解析', () => {
    const md = mdWithQuestion(`<!-- ATTACHMENTS: ${attJson} -->\n请查看附件。`);
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('请查看附件。');
    expect(turn.question).not.toContain('<!-- ATTACHMENTS');
    expect(turn.questionAttachments).toEqual([attachment]);
    expect(turn.modelId).toBeUndefined();
  });

  it('无任何注释 → question 原样，不误伤正文', () => {
    const md = mdWithQuestion('请直接回答。');
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('请直接回答。');
    expect(turn.questionAttachments).toBeUndefined();
    expect(turn.modelId).toBeUndefined();
  });

  it('正文首行恰好是注释样式文本（正文应保留，仅剥元信息注释）', () => {
    // 用户问题以 markdown 注释开头（用户主动写的）：元信息注释在开头被剥，
    // 但正文里的注释应保留原样
    const md = mdWithQuestion(
      `<!-- META: ${metaJson} -->\n<!-- 用户写的一个注释 -->\n请回答。`,
    );
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('<!-- 用户写的一个注释 -->\n请回答。');
    expect(turn.modelId).toBe('deepseek-chat');
  });

  it('JSON payload 内含 " -->"（如内嵌注释标记）→ 按行尾 lastIndexOf 正确截断，不提前断开', () => {
    const trickyAttJson = JSON.stringify([
      { ...attachment, path: 'attachments/n_nodes/合同 <!-- TITLE: x --> 扫描件.pdf' },
    ]);
    const md = mdWithQuestion(
      `<!-- ATTACHMENTS: ${trickyAttJson} -->\n查看附件。`,
    );
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('查看附件。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.questionAttachments).toEqual([
      { ...attachment, path: 'attachments/n_nodes/合同 <!-- TITLE: x --> 扫描件.pdf' },
    ]);
  });

  it('连续多条同类注释（3 条 META）→ 循环剥离干净，正文保留', () => {
    const md = mdWithQuestion(
      `<!-- META: ${metaJson} -->\n<!-- META: ${metaJson} -->\n<!-- META: ${metaJson} -->\n测试正文。`,
    );
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('测试正文。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.modelId).toBe('deepseek-chat');
  });

  it('三条注释（META + REFERENCES + ATTACHMENTS）→ 全部剥净，引用快照解析正确', () => {
    const md = mdWithQuestion(
      `<!-- META: ${metaJson} -->\n<!-- REFERENCES: ${refsJson} -->\n<!-- ATTACHMENTS: ${attJson} -->\n引用这些材料分析。`,
    );
    const turn = parseNodeMarkdown(md).conversations[0];

    // 核心断言：正文不残留任何注释 JSON（旧 bug 会让 JSON 原样展示给用户）
    expect(turn.question).toBe('引用这些材料分析。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.questionAttachments).toEqual([attachment]);
    expect(turn.questionReferences).toEqual(references);
  });
});

describe('round-trip: appendConversation（真实数据流）', () => {
  it('带附件追加 → 重新解析后 question 纯净、附件与元信息完整保留', () => {
    // 模拟前端落盘：append 带 questionAttachments + modelId + thinkingLevel
    const md = appendConversation(baseMd, '请分析这份合同的风险。', '这是分析结论。', {
      questionTime: '2026-08-26T00:00:00.000Z',
      answerTime: '2026-08-26T00:00:01.000Z',
      questionAttachments: [attachment],
      modelId: 'deepseek-chat',
      thinkingLevel: 'medium',
    });

    // 落盘内容必须包含两条注释（验证 fixture 与真实序列化格式一致）
    expect(md).toContain('<!-- META:');
    expect(md).toContain('<!-- ATTACHMENTS:');

    const node = parseNodeMarkdown(md);
    const turn = node.conversations[0];

    // 核心断言：正文不再露出注释 JSON
    expect(turn.question).toBe('请分析这份合同的风险。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.question).not.toContain('attachments/');
    // 元信息仍可追溯
    expect(turn.modelId).toBe('deepseek-chat');
    expect(turn.thinkingLevel).toBe('medium');
    expect(turn.questionAttachments).toEqual([attachment]);
  });

  it('带 @引用 追加 → 落盘 REFERENCES 注释，重新解析后引用快照完整保留', () => {
    const md = appendConversation(baseMd, '参考这些资料写一份意见。', '好的。', {
      questionTime: '2026-08-26T00:00:00.000Z',
      answerTime: '2026-08-26T00:00:01.000Z',
      questionReferences: references,
    });

    expect(md).toContain('<!-- REFERENCES:');

    const turn = parseNodeMarkdown(md).conversations[0];
    expect(turn.question).toBe('参考这些资料写一份意见。');
    expect(turn.question).not.toContain('<!--');
    expect(turn.questionReferences).toEqual(references);
  });

  it('无附件追加 → question 不引入任何注释，保持纯净', () => {
    const md = appendConversation(baseMd, '什么是诉讼时效？', '回答。', {
      modelId: 'deepseek-chat',
      thinkingLevel: 'high',
    });
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.question).toBe('什么是诉讼时效？');
    expect(turn.question).not.toContain('<!--');
    expect(turn.modelId).toBe('deepseek-chat');
    expect(turn.thinkingLevel).toBe('high');
  });

  it('多智能体协作：subagents 分支面板 append → 重新解析后完整保留', () => {
    const panel: SubagentPanel = {
      teamId: 'team_1',
      goal: '核对三份合同条款差异',
      done: 1,
      total: 2,
      failed: 0,
      members: [
        { id: 'm1', name: 'Reviewer', role: '审阅条款', state: 'done', subject: '审阅 A 合同', durationMs: 1200, resultSummary: '发现 2 处风险' },
        { id: 'm2', name: 'Researcher', role: '检索判例', state: 'running', subject: '检索类案' },
      ],
    };
    const md = appendConversation(baseMd, '帮我核对合同差异。', '结论如下。', {
      modelId: 'deepseek-chat',
      thinkingLevel: 'medium',
      subagents: panel,
    });
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(turn.subagents).toEqual(panel);
    // 面板不污染正文
    expect(turn.question).toBe('帮我核对合同差异。');
    expect(turn.answer).not.toContain('subagents');
  });

  it('无成员时 subagents 不落盘，旧文件解析后为 undefined（向前兼容）', () => {
    const md = appendConversation(baseMd, '普通提问。', '普通回答。', { modelId: 'deepseek-chat' });
    const turn = parseNodeMarkdown(md).conversations[0];

    expect(md).not.toContain('subagents');
    expect(turn.subagents).toBeUndefined();
  });
});
