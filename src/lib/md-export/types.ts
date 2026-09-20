/**
 * 多端分发契约（见《md阅读器多端分发方案》§3.3）
 *
 * 平台约束（limits）与产物形态（ExportArtifact）在此集中定义：
 * 各平台 target 只导出自己的 PlatformSpec + 渲染/序列化函数，
 * 体检（check.ts）与导出入口（ExportMenu）都只依赖这里。
 */

import type { DocBlock } from './ir';

export type ExportFormat = 'png' | 'clipboard-html' | 'text' | 'docx' | 'pdf' | 'html';

export type ExportRatio = '1:1' | '3:4' | '4:3' | '9:16' | '2.35:1' | 'long';

export interface PlatformSpec {
  id: 'poster' | 'wechat' | 'xhs' | 'weibo' | 'docx' | 'html';
  label: string;
  limits: {
    titleMax?: number;
    bodyMax?: number;
    imageMin?: number;
    imageMax?: number;
    ratios?: ExportRatio[];
    /** 该平台渲染不了的块类型（用于体检降级提示） */
    unsupported?: Array<DocBlock['t']>;
  };
  formats: ExportFormat[];
}

export type ExportArtifact =
  | { kind: 'images'; pages: string[]; pixel: { w: number; h: number } }
  | { kind: 'clipboard-html'; html: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'file'; name: string; blob: Blob };
