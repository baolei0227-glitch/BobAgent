/**
 * 文件来源注册表（Step 2）
 *
 * 对应"空间站"的节点舱登记机制：来源实现注册后即插即用，
 * 调用方通过 kind 获取来源，不关心具体实现。
 */
import type { FileSourceKind, IFileSource } from './types';

const sources = new Map<FileSourceKind, IFileSource>();

export function registerSource(source: IFileSource): void {
  sources.set(source.kind, source);
}

export function getSource(kind: FileSourceKind): IFileSource {
  const s = sources.get(kind);
  if (!s) {
    // 未注册时回退到 local，保证容错
    const fallback = sources.get('local');
    if (fallback) return fallback;
    throw new Error(`未注册的文件来源: ${kind}`);
  }
  return s;
}

export function hasSource(kind: FileSourceKind): boolean {
  return sources.has(kind);
}

export function listSources(): IFileSource[] {
  return [...sources.values()];
}
