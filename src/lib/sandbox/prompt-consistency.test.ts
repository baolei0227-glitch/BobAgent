/**
 * 提示词 ↔ 代码一致性 + coding 工具可达性 回归（2026-10-10 评估 B3）。
 *
 * 评估里最贵的一类 bug 是"提示词承诺了代码里不存在的能力"：模型据此写出必然失败的代码。
 * 这组测试把「提示词/描述」当代码来锁：
 *   1) 上下文提示词不得再出现不存在的工具名 `rollback_sandbox_file`；
 *   2) 桥动作描述不得再声称 2048 token 上限 / 需要授权；
 *   3) coding 画像必须能看到 sandbox_rollback / sandbox_export（原来只在 admin 场景）；
 *   4) 客户端脚本：chat 必须有独立的长超时（原来 30s/10s，长回复被误判失败）。
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildBridgeClientScript, getBridgeActionsText } from '@/lib/sandbox/bridge';
import { codingDocIndex, renderCodingDoc } from './coding-docs';
import { getToolDefinitions } from '@/app/api/chat/tools';

const ctxSrc = readFileSync(new URL('../runtime/context.ts', import.meta.url), 'utf-8');

describe('B3 提示词与代码一致', () => {
  it('不再引用不存在的工具名 rollback_sandbox_file', () => {
    expect(ctxSrc).not.toContain('rollback_sandbox_file');
    expect(ctxSrc).toContain('sandbox_rollback');
  });

  it('CSS 变量数量与主题事实写实（61 个 / 单一 warm 主题）', () => {
    expect(ctxSrc).not.toContain('44 个 CSS 变量');
    expect(ctxSrc).toContain('61 个 CSS 变量');
  });

  it('chat 动作描述与真实上限一致（8192/32768，不再说 2048 或需要授权）', () => {
    const text = getBridgeActionsText();
    expect(text).not.toContain('2048 tokens');
    expect(text).not.toContain('requires chat permission');
    expect(text).toContain('32768');
  });

  it('BobStorage 详细说明拆到 read_bridge_docs，仍覆盖 writeWanted 与 async 语义', () => {
    // 2026-10-18 上下文分层：核心 prompt 只留索引，详细 API 走 read_bridge_docs。
    expect(ctxSrc).toContain('read_bridge_docs');
    expect(codingDocIndex()).toContain('storage');
    const storage = renderCodingDoc('storage');
    expect(storage).toContain('writeWanted');
    expect(storage).toMatch(/第 2\/3 层是 async/);
  });
});

describe('B3 coding 节点能拿到回滚/导出工具', () => {
  it('sandbox_rollback / sandbox_export 归入 coding 场景', () => {
    const names = getToolDefinitions(new Set(['coding'] as never)).map((d) => d.function?.name);
    expect(names).toContain('sandbox_rollback');
    expect(names).toContain('sandbox_export');
    expect(names).toContain('read_bridge_docs');
  });
});

describe('B3 客户端 chat 超时', () => {
  it('chat 有独立的 120s 预算，不再落回 10s/30s 默认值', () => {
    const script = buildBridgeClientScript('app_timeout_1', { fullTrust: true });
    expect(script).toContain('var CHAT_TIMEOUT = 120000;');
    expect(script).toContain("action === 'chat' ? CHAT_TIMEOUT");
  });
});
