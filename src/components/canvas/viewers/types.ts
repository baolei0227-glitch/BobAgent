'use client';

/**
 * 预览渲染器平台（统一分发机制）
 *
 * 调度层（UnifiedViewer）只负责：读文件元数据（IFileSource）、生成代理 URL、按扩展名匹配渲染器。
 * 每个文件类型对应一个独立渲染器插件，渲染器自己管理内部加载/解析/UI，通过 onError 向调度层上报错误。
 * 未来新增类型（视频/音频等）= 新增一个渲染器组件 + 在 registry 注册一行，主组件零改动。
 *
 * 数据源选择：
 *   - 文本类（md/code/text）：用 fileInfo.content（已读入内存的文本）
 *   - 二进制类（pdf/image/docx/xlsx）：用 proxyUrl（代理 URL，供 fetch/iframe/img）
 */
import type { ComponentType } from 'react';
import type { FileInfo, FileSourceKind } from '@/lib/files/types';

/** 渲染器收到的统一 props（由调度层注入） */
export interface ViewerRenderProps {
  fileInfo: FileInfo;
  /** 可直接请求的代理 URL（PDF/iframe/img 用），可能为空 */
  proxyUrl: string | null;
  fileName?: string;
  source: FileSourceKind;
  /** 渲染器内部出错时上报，由调度层统一展示错误态 */
  onError: (message: string) => void;
  /** .md 专用：节点 ID（节点模式时传入，用于保存到 .md） */
  nodeMdId?: string;
  /** .md 专用：打开文件时传入的相对路径（DocEditor 保存回写必须用相对路径，不能用 fileInfo.full_path 绝对路径） */
  filePath?: string;
  /** .md 专用：项目 ID（配合 filePath 保存到项目文件系统，write_file 通道需要） */
  projectId?: string;
  /** 图片集（多图）专用：一次性渲染多张图（yarl slides），无此字段时回退到 fileInfo.content 单图 */
  slides?: Array<{ src: string; alt?: string; path?: string }>;
  /** 图片集专用：初始激活第几张（默认 0） */
  initialIndex?: number;
}

/** 文件类型渲染器插件：test 匹配 → load 懒加载组件 */
export interface ViewerRenderer {
  id: string;
  /** 匹配规则：ext 为无点号扩展名（如 'pdf'），fileInfo 提供类型/内容 */
  test: (ext: string, fileInfo: FileInfo) => boolean;
  /** 懒加载渲染器组件（named export） */
  load: () => Promise<ComponentType<ViewerRenderProps>>;
}
