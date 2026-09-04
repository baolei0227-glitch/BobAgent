/**
 * 数据出口审计（本地留存，可追溯；不拦截、不限制）
 *
 * 立场：图片是否敏感由用户自己判断，应用不做任何限制/拦截。
 * 本模块只做"透明"：每次把图片（base64）上传到第三方模型服务时，追加一条本地审计记录，
 * 写明 何时 / 哪个文件 / 发给哪个服务 / 多大 / 是否成功 —— 供用户（如律师）自行追溯。
 *
 * 落盘：~/BobWork/.logs/egress-audit.log（JSONL，与 dispatch.jsonl 分开，语义聚焦）
 * 规则：logEgressUpload 永不抛错；文件行数超限保留最近 MAX_LINES 行。
 */

import { join } from 'path';
import { resolveAppRoot } from './app-root';

export interface EgressAuditEvent {
  /** ISO 时间 */
  ts: string;
  /** 被上传的文件绝对路径（可追溯） */
  filePath: string;
  /** 文件字节数 */
  bytes: number;
  /** 目标模型服务地址（数据发往哪里） */
  baseUrl: string;
  /** 使用的模型 id */
  model: string;
  /** 链路：glm-ocr | online-ocr | vlm-upgrade | vision-fallback | sandbox-chat */
  chain: 'glm-ocr' | 'online-ocr' | 'vlm-upgrade' | 'vision-fallback' | 'sandbox-chat';
  /** 是否成功 */
  ok: boolean;
  /** 耗时 ms */
  ms?: number;
  error?: string;
}

const MAX_LINES = 5000;

function auditPath(): string {
  return join(resolveAppRoot(), '.logs', 'egress-audit.log');
}

/** 追加一条数据出口审计记录（永不抛错） */
export function logEgressUpload(ev: Omit<EgressAuditEvent, 'ts'>): void {
  try {
    const fs = require('fs');
    const path = auditPath();
    fs.mkdirSync(join(resolveAppRoot(), '.logs'), { recursive: true });
    try {
      const st = fs.statSync(path);
      if (st.size > MAX_LINES * 260) {
        const kept = fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean).slice(-MAX_LINES);
        fs.writeFileSync(path, kept.join('\n') + '\n', 'utf-8');
      }
    } catch { /* 文件不存在等 */ }
    fs.appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n', 'utf-8');
  } catch { /* 审计失败绝不影响上传主链路 */ }
}
