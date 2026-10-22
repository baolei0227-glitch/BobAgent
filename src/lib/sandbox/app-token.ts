/**
 * 小程序身份令牌（2026-10-10）—— 替代客户端自报的 `_appId`。
 *
 * 为什么必须做：`_appId` 由页面脚本自己填。A5 的「导入包只读」判定、被 Revoke 的
 * 小程序是否还能调模型、审计归因，全都建立在这个自报值上 —— 实测过：一个 imported
 * 小程序只要把 `_appId` 填成任意 built 小程序的 id，就重新拿到 `run_command` 全量工具
 * （还能写别人的私有数据目录）。
 *
 * 做法：预览路由（iframe 与应用内、Hippo 独立页都走它）在注入桥脚本时**签一个短期令牌**
 * （`appId.exp.sig`，HMAC-SHA256），桥与流式路由只认令牌解出的 appId，自报值仅作为
 * 「与令牌不一致」的攻击信号记录进审计。
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { getSandboxBridgeSecret } from '@/lib/settings-server';

/** 令牌有效期：12 小时（Hippo 标签页可能开一整天；过期后刷新页面即可） */
export const APP_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 签发令牌（服务端：预览路由用） */
export async function mintAppToken(appId: string, ttlMs: number = APP_TOKEN_TTL_MS): Promise<string> {
  const secret = await getSandboxBridgeSecret();
  const exp = Date.now() + ttlMs;
  const payload = `v1|${appId}|${exp}`;
  return `v1.${appId}.${exp}.${sign(payload, secret)}`;
}

export interface AppTokenVerifyResult {
  ok: boolean;
  appId?: string;
  reason?: string;
}

/** 校验令牌（纯函数式：密钥由调用方传入，便于单测） */
export function verifyAppTokenWithSecret(token: string, secret: string, now: number = Date.now()): AppTokenVerifyResult {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, reason: 'malformed token' };
  const [, appId, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!appId || !Number.isFinite(exp)) return { ok: false, reason: 'malformed token' };
  if (exp < now) return { ok: false, reason: 'token expired (reload the preview page)' };
  const expected = sign(`v1|${appId}|${exp}`, secret);
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return { ok: false, reason: 'bad token signature' };
    }
  } catch {
    return { ok: false, reason: 'bad token signature' };
  }
  return { ok: true, appId };
}

/** 校验令牌（服务端入口：自行取密钥） */
export async function verifyAppToken(token: string): Promise<AppTokenVerifyResult> {
  const secret = await getSandboxBridgeSecret();
  return verifyAppTokenWithSecret(token, secret);
}

export interface AppIdentity {
  /** 权威 appId（来自令牌）。令牌无效时为 undefined */
  appId?: string;
  /** 客户端自报的 appId（仅用于审计/攻击信号） */
  claimedAppId?: string;
  /** 自报值与令牌值不一致（= 有人在冒充别人） */
  mismatch: boolean;
  /** 令牌校验失败原因 */
  error?: string;
}

/**
 * 纯函数：从「令牌 + 自报 appId」解析出权威身份（令牌无效/缺失 → error）。
 * 桥路由用它决定用哪个 appId，并把 mismatch 记进审计。
 */
export function resolveAppIdentityWithSecret(
  input: { token?: string; claimedAppId?: string },
  secret: string,
  now: number = Date.now(),
): AppIdentity {
  const claimed = typeof input.claimedAppId === 'string' && input.claimedAppId ? input.claimedAppId : undefined;
  const token = String(input.token ?? '');
  if (!token) return { claimedAppId: claimed, mismatch: false, error: 'missing app token (reload the preview page)' };
  const v = verifyAppTokenWithSecret(token, secret, now);
  if (!v.ok || !v.appId) return { claimedAppId: claimed, mismatch: false, error: v.reason ?? 'invalid token' };
  return {
    appId: v.appId,
    claimedAppId: claimed,
    mismatch: !!claimed && claimed !== v.appId,
  };
}

/** 服务端入口：解析身份（自行取密钥） */
export async function resolveAppIdentity(input: { token?: string; claimedAppId?: string }): Promise<AppIdentity> {
  const secret = await getSandboxBridgeSecret();
  return resolveAppIdentityWithSecret(input, secret);
}
