'use client';

/**
 * Butler 通知的客户端信道（模块级 store）
 *
 * 由 ButlerNoticeHost 单点写入（bus 事件 / 日报与提醒轮询 → 落库 / 桌面通知 → store），
 * ButlerDrawer 订阅渲染。
 *
 * 为什么用模块级 store 而不是 React Context：
 *   轮询与 bus 订阅必须常驻（抽屉可能没打开），store 在模块作用域天然常驻，
 *   且与画布/面板 UI 树解耦——沿用 butlerEvents 的取舍（window 事件 + 模块 store）。
 */
import type { ChatMessage, ButlerNoticeItem } from '@/lib/bus';

export interface ButlerNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  time: number;
  done: boolean;
  /**
   * 是否已点开（微信里「听过的语音」那颗红点）。
   * 2026-09-28 起它不是一颗可切的按钮，而是**点开卡片**这一动作写下的结果：
   * 未点开 → 卡片右上角亮红点、好友头像角标计数 +1；点开即置 true（只前不退）。
   */
  read: boolean;
  /** 结构化待办项（日历提醒 / 日报），卡片内渲染为可勾选 chip 行 */
  items: ButlerNoticeItem[] | null;
  /** 点击通知时的动作（open-calendar 等） */
  actionType: string | null;
  source: string | null;
  threadId: string | null;
  /** kind='web'/'info' 时携带的对话存档（详情内可展开） */
  messages: ChatMessage[] | null;
  /**
   * 服务端幂等去重键（`morning:YYYY-MM-DD` / `sticky:YYYY-MM-DD` / `evt:…`）。
   * 每日报告同日归组靠它认（标题正则只是兜底，见 lib/butler/report-group.ts）；
   * 存量行的历史数据也可能为空 → 归组时回落到标题。
   */
  dedupeKey?: string | null;
}

let notices: ButlerNotice[] = [];
const listeners = new Set<(list: ButlerNotice[]) => void>();
const MAX_NOTICES = 200;

function emit(): void {
  for (const l of listeners) l(notices);
}

export function getButlerNotices(): ButlerNotice[] {
  return notices;
}

/** 整体替换（历史拉取后的合并结果） */
export function setButlerNotices(next: ButlerNotice[]): void {
  notices = next.slice(0, MAX_NOTICES);
  emit();
}

/** 新增或整体替换单条（实时事件到达 / 落库后换服务端 id） */
export function upsertButlerNotice(n: ButlerNotice): void {
  const idx = notices.findIndex((x) => x.id === n.id);
  if (idx >= 0) {
    const next = notices.slice();
    next[idx] = n;
    notices = next;
  } else {
    notices = [n, ...notices].slice(0, MAX_NOTICES);
  }
  emit();
}

export function patchButlerNotice(id: string, patch: Partial<ButlerNotice>): void {
  let hit = false;
  const next = notices.map((n) => {
    if (n.id !== id) return n;
    hit = true;
    return { ...n, ...patch };
  });
  if (!hit) return;
  notices = next;
  emit();
}

export function removeButlerNotice(id: string): void {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

/** 订阅（订阅时立即回调一次当前值，供对话框首次渲染直接用） */
export function subscribeButlerNotices(fn: (list: ButlerNotice[]) => void): () => void {
  listeners.add(fn);
  fn(notices);
  return () => {
    listeners.delete(fn);
  };
}
