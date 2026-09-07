'use client';

/**
 * ImageGen Album 节点 — 版本相册的画布节点形态。
 *
 * 以「连线」方式挂在 ImageGen 节点右侧：从 ImageGen 的右侧 source handle 拉一条真实连线
 * 连到本节点（左侧 target handle）。内部复用 ImageGenHistoryModal 的嵌入式渲染
 * （embedded 模式：无全屏遮罩、无 portal），样式与操作逻辑与原来的弹窗完全一致；
 * 节点随画布缩放/拖动，删除连线或节点即关闭相册。
 */
import { memo } from 'react';
import { ImageGenHistoryModal } from './ImageGenHistoryModal';
import type { ImageGenVersion, TriplotGroup } from '@/lib/types';
import type { ImageGenApiRef, AttachmentImage } from './viewers/ImageAiEditor';
import type { MutableRefObject } from 'react';

export interface ImageGenAlbumNodeData {
  /** 关联的 ImageGen 节点 id（连线 source） */
  imageGenNodeId: string;
  versions: ImageGenVersion[];
  originalImage?: string;
  currentImage?: string;
  attachments?: AttachmentImage[];
  triplotGroups?: TriplotGroup[];
  triplotActiveGroupId?: string;
  triplotActiveView?: 'front' | 'side' | 'top';
  onSelect: (v: ImageGenVersion) => void;
  onTogglePin: (vId: string) => void;
  onDelete: (vId: string) => void;
  onTriplotViewSwitch?: (groupId: string, view: 'front' | 'side' | 'top') => void;
  onTriplotGroupDelete?: (groupId: string) => void;
  onClose: () => void;
  /** 编辑器 ref（Compare 用），由主节点持有 */
  editorRef: MutableRefObject<ImageGenApiRef | null>;
  /** React Flow 节点 data 要求 Record<string, unknown>，补 index signature 以兼容 */
  [key: string]: unknown;
}

/** Album 节点默认尺寸（接近原弹窗面板，随画布缩放） */
const ALBUM_NODE_W = 860;
const ALBUM_NODE_H = 560;

function ImageGenAlbumNodeInner({ data }: { data: ImageGenAlbumNodeData }) {
  return (
    <>
      {/* 画布连线已物理移除（2026-09）：ImageGen 的 source handle 已删，Album 不再需要接收 handle */}
      <div style={{ width: ALBUM_NODE_W, height: ALBUM_NODE_H, maxWidth: '80vw', maxHeight: '72vh' }}>
        <ImageGenHistoryModal embedded {...data} />
      </div>
    </>
  );
}

export const ImageGenAlbumNode = memo(ImageGenAlbumNodeInner);
