'use client';

/**
 * ImageGen 节点：独立图像生成节点，与 aiChat 节点并列。
 * 完全复用成熟的 ImageAiEditor 作为节点的编辑/预览窗口（纯展示用，不含 prompt 输入栏）
 *
 *  布局：节点固定 620×440 + 下方跟随式 Prompt Bar
 *   · 节点尺寸固定 620×440，与 AiChat / Doc 节点整齐划一
 *   · 文件自动保存到 homework/ 根目录，无手动 Save 按钮
 *   · Prompt Bar 紧贴节点正下方（absolute 定位），宽度与节点一致（620px）
 *       → 当且仅当本 ImageGen 节点 selected=true 时显示
 *       → 选中其他类型节点 / 点击画布空白：Prompt Bar 自动消失
 *       → 跟随节点移动/缩放（作为 react-flow__node 子元素）
 *   · 图片 object-fit: contain，自动适配节点预览区，不再跟随比例切高度
 */
import React, { useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, Handle, Position } from '@xyflow/react';
import { X, Album, Maximize2, Minimize2 } from 'lucide-react';
import type { ImageGenNodeData, ImageGenVersion, RegionRef, TriplotGroup } from '@/lib/types';
import { ImageAiEditor, type ImageGenApiRef, type AttachmentImage, type TriplotResult } from './viewers/ImageAiEditor';
import { ImageGenPromptBar } from './ImageGenPromptBar';
import type { ImageGenAlbumNodeData } from './ImageGenAlbumNode';
import { useConfirm } from './ConfirmDialog';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';

/** dataUrl 下载为 PNG 文件 */
function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** 把生成的图片写入当前项目的 homework/ 根目录（存储平铺，不生成 kind 子文件夹）；失败则回退为浏览器下载
 *  @returns 磁盘相对路径（如 homework/img-yyy.png），失败返回 null
 */
async function saveGeneratedImage(dataUrl: string, filename: string): Promise<string | null> {
  try {
    const resp = await fetch('/api/imagegen/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename }),
    });
    const data = await resp.json();
    if (data.success) return data.path as string;
    downloadDataUrl(dataUrl, filename);
    return null;
  } catch {
    downloadDataUrl(dataUrl, filename);
    return null;
  }
}

function ImageGenNodeInner({ id, data, selected }: {
  id: string;
  data: ImageGenNodeData;
  selected?: boolean;
}) {
  const { setNodes, setEdges, getNode, getNodes, addNodes, addEdges, getViewport, setViewport, screenToFlowPosition } = useReactFlow();
  const { ask: confirmAsk, render: confirmRender } = useConfirm();

  const patch = useCallback((partial: Partial<ImageGenNodeData> | ((prev: ImageGenNodeData) => Partial<ImageGenNodeData>)) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const prevData = n.data as ImageGenNodeData;
      const next = typeof partial === 'function' ? partial(prevData) : partial;
      return { ...n, data: { ...prevData, ...next } };
    }));
  }, [id, setNodes]);

  const handleDelete = useCallback(async () => {
    const node = getNode(id);
    const nodeTitle = (node?.data as ImageGenNodeData | undefined)?.title || 'Image Generation';
    const nodeMdId = (node?.data as ImageGenNodeData | undefined)?.nodeMdId as string | undefined || id;

    const ok = await confirmAsk({
      title: 'Delete Node?',
      message: `Deleting "${nodeTitle}" will permanently remove this image generation node.\nThis action cannot be undone.`,
    });
    if (!ok) return;

    // 收集节点目录下所有需删除的磁盘图片文件名（versions + triplotGroups 3视角各一张）
    const filenames: string[] = [];
    (data.versions ?? []).forEach((v) => {
      if (v.savedPath) {
        const f = v.savedPath.split('/').pop();
        if (f) filenames.push(f);
      }
    });
    (data.triplotGroups ?? []).forEach((g) => {
      (['front', 'side', 'top'] as const).forEach((k) => {
        const sp = g[k].savedPath;
        if (sp) {
          const f = sp.split('/').pop();
          if (f) filenames.push(f);
        }
      });
    });
    // 批量删磁盘图片（异步 fire-and-forget）
    if (filenames.length > 0) {
      fetch('/api/imagegen/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames }),
      }).catch((err) => console.error('Node-delete disk image cleanup failed:', err));
    }

    // 从画布移除（节点 + 关联边 + Album 相册节点与连线）
    setNodes((nds) => nds.filter((n) => n.id !== id && n.id !== `album-${id}`));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id && e.id !== `edge-album-${id}`));

    // 调用 API 删除磁盘档案
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeMdId }),
    }).then((r) => {
      if (!r.ok) console.error('ImageGen node delete failed:', r.status);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
    }).catch((err) => console.error('ImageGen node delete request error:', err));
  }, [id, getNode, setNodes, setEdges, confirmAsk, data.versions, data.triplotGroups]);

  const title = data.title ?? 'Image Generation';
  const inputImage = data.inputImage;
  const editorRef = useRef<ImageGenApiRef>(null);

  // 原始 16:10 尺寸：620×440；整体 zoom:0.8 等比缩小至 80%（实际占位 496×352）
  const NODE_W = 620;
  const NODE_H = 440;
  const NODE_ZOOM = 0.8;          // 默认缩放（80%）
  const NODE_ZOOM_ENLARGED = 0.96; // 放大 20% 后的缩放（0.8×1.2=0.96）

  // 单独放大状态
  const [isEnlarged, setIsEnlarged] = useState(false);
  const currentZoom = isEnlarged ? NODE_ZOOM_ENLARGED : NODE_ZOOM;
  // 放大前画布视口快照（缩小回 80% 时恢复）
  const enlargeViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);

  const portal = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return document.body;
  }, []);

  // 节点卡 DOM 引用 + 屏幕位置：用于把 Prompt Bar 挂到 body（避开 RF wrapper overflow:hidden 裁剪）
  const nodeCardRef = useRef<HTMLDivElement>(null);

  /** 放大/缩小节点：放大时把节点中心定位到屏幕正中间（保持当前画布 zoom），缩小时恢复放大前视口 */
  const handleToggleEnlarge = useCallback(() => {
    const willEnlarge = !isEnlarged;
    if (willEnlarge) {
      enlargeViewportRef.current = getViewport();
      const rect = nodeCardRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const p = screenToFlowPosition({ x: cx, y: cy });
        // 桥接到 CanvasFlow 的 graphGateway.setCenter（手动计算），避免原生 setCenter 在挤压布局下的中心偏移。
        // 瞬时（无 duration）：带动画的视口移动会被紧随其后的放大重渲染中断，导致节点原地放大
        window.dispatchEvent(
          new CustomEvent('canvas-center-request', {
            detail: { x: p.x, y: p.y, zoom: getViewport().zoom },
          }),
        );
      }
    } else {
      const prev = enlargeViewportRef.current;
      enlargeViewportRef.current = null;
      if (prev) setViewport(prev, { duration: 300 });
    }
    setIsEnlarged(willEnlarge);
  }, [isEnlarged, getViewport, setViewport, screenToFlowPosition, nodeCardRef]);
  const [promptBarScreen, setPromptBarScreen] = useState<{ top: number; left: number; width: number } | null>(null);
  // Prompt Bar 浮层的 DOM 引用 + 上次写入的位置缓存：
  // 拖动节点时位置每帧变化，若走 setState 会整组件重渲染（含 ImageAiEditor 大图）→ 卡顿。
  // 改为位置变化直接写 DOM style，仅首次/宽度变化（zoom 切换、窗口 resize）才 setState。
  const promptBarWrapRef = useRef<HTMLDivElement>(null);
  const lastPromptBarPosRef = useRef<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!selected) { setPromptBarScreen(null); return; }
    // 重新选中 / zoom 切换时重置位置缓存：否则首次 compute 会被 1px 阈值短路，
    // promptBarScreen 保持 null → 输入框无法出现。
    lastPromptBarPosRef.current = null;
    const compute = () => {
      const el = nodeCardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = r.bottom + 8;
      const left = r.left;
      const width = r.width;
      const last = lastPromptBarPosRef.current;
      // 阈值 1px：无变化直接跳过（静止时每帧开销趋近于零）
      if (last && Math.abs(last.top - top) < 1 && Math.abs(last.left - left) < 1 && Math.abs(last.width - width) < 1) {
        return;
      }
      lastPromptBarPosRef.current = { top, left, width };
      // 位置跟随直接写 DOM（拖动跟手、不触发 React 重渲染 → 消除卡顿）
      const wrap = promptBarWrapRef.current;
      if (wrap) {
        wrap.style.top = `${top}px`;
        wrap.style.left = `${left}px`;
        wrap.style.width = `${width}px`;
      }
      // 仅首次 / 宽度变化才 setState（React bail-out：返回相同引用不重渲染）
      setPromptBarScreen((prev) => {
        if (!prev || Math.abs(prev.width - width) >= 1) return { top, left, width };
        return prev;
      });
    };
    compute();
    // 1. 尺寸变化（卡 zoom 切换 / 布局变化）
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    if (ro && nodeCardRef.current) ro.observe(nodeCardRef.current);
    // 2. 窗口 resize
    window.addEventListener('resize', compute);
    // 3. rAF 逐帧轮询：应对 ReactFlow 平移/缩放/节点拖拽后 viewport transform 变化（不触发 ResizeObserver）。
    //    不再节流 → 拖动时输入框逐帧跟手；静止时被 1px 阈值短路，无实际计算。
    let rafId = 0;
    const loop = () => { compute(); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
      cancelAnimationFrame(rafId);
    };
  }, [selected, isEnlarged]);

  const handleGenerated = useCallback(async (resultDataUrl: string | null) => {
    const img = resultDataUrl ?? inputImage ?? null;
    if (!img) return;

    const ts = Date.now();
    // 短文件名：v{N}.png（目录已标识节点）
    const verNum = (data.versions?.length ?? 0) + 1;
    const filename = `v${verNum}.png`;
    const savedPath = await saveGeneratedImage(img, filename);

    const version: ImageGenVersion = {
      id: `v-${ts}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: img,
      timestamp: ts,
      prompt: data.prompt ?? '',
      model: data.model,
      savedPath: savedPath ?? undefined,
      pinned: false,
    };

    patch({
      result: img,
      versions: [...(data.versions ?? []), version],
      // 策略 A：生成新图 → 旧图 regions/选中立即清空（坐标对新图已失效）；同步 regionsImageKey
      regions: undefined,
      regionsImageKey: img,
      selectedRegions: [],
    });

    // 首次生成完成（版本 0 → 1）→ 自动以连线方式打开 Album；仅自动打开一次
    if ((data.versions?.length ?? 0) === 0 && !albumAutoOpenedRef.current) {
      albumAutoOpenedRef.current = true;
      openAlbum();
    }
  }, [patch, inputImage, data.prompt, data.model, data.versions, data.originalImage]);

  /** 三视图生成完成回调：三张图分别持久化 + 组成 TriplotGroup 写入 triplotGroups */
  const handleTriplotGenerated = useCallback(async (triplot: TriplotResult) => {
    const ts = Date.now();
    const saved = async (key: 'front' | 'side' | 'top', img: string, prompt: string): Promise<ImageGenVersion> => {
      const filename = `${key}-${ts}.png`;
      const savedPath = await saveGeneratedImage(img, filename);
      return {
        id: `${key}-${ts}-${Math.random().toString(36).slice(2, 7)}`,
        dataUrl: img,
        timestamp: ts,
        prompt,
        model: data.model,
        savedPath: savedPath ?? undefined,
        pinned: false,
      };
    };
    const front = await saved('front', triplot.front.image, triplot.front.prompt);
    const side = await saved('side', triplot.side.image, triplot.side.prompt);
    const top = await saved('top', triplot.top.image, triplot.top.prompt);
    const groupId = `triplot-${ts}-${Math.random().toString(36).slice(2, 7)}`;
    patch((prev) => {
      const nextGroups: TriplotGroup[] = [...(prev.triplotGroups ?? []), {
        id: groupId,
        front,
        side,
        top,
        timestamp: ts,
        pinned: false,
        activeView: 'front' as const,
      }];
      return {
        triplotGroups: nextGroups,
        triplotActiveGroupId: groupId,
        triplotActiveView: 'front',
        result: front.dataUrl,          // 节点默认预览：front
        inputImage: front.dataUrl,      // 编辑器初始工作图：front，用户可单视角继续编辑
        // 同时把三视图的三个版本分别 append 到各视角专用 versions（若有）
        regions: undefined,
        regionsImageKey: front.dataUrl,
        selectedRegions: [],
      };
    });

    // 首次三视图生成完成（组 0 → 1）→ 自动以连线方式打开 Album；仅自动打开一次
    if ((data.triplotGroups?.length ?? 0) === 0 && !albumAutoOpenedRef.current) {
      albumAutoOpenedRef.current = true;
      openAlbum();
    }
  }, [patch, data.model, data.triplotGroups]);

  /** 三视图视角切换：切换 result / inputImage 指向所选视角的图，便于编辑器局部迭代 */
  const onTriplotViewSwitch = useCallback((view: 'front' | 'side' | 'top') => {
    const groupId = data.triplotActiveGroupId;
    if (!groupId) return;
    const group = data.triplotGroups?.find((g) => g.id === groupId);
    if (!group) return;
    const v = group[view];
    patch({
      triplotActiveView: view,
      result: v.dataUrl,
      inputImage: v.dataUrl,
      regions: undefined,
      regionsImageKey: v.dataUrl,
      selectedRegions: [],
    });
  }, [patch, data.triplotActiveGroupId, data.triplotGroups]);

  /** 版本操作：切换预览 / pin / 删除 */
  const onVersionSelect = useCallback((v: ImageGenVersion) => {
    // 原始图项不在 versions 数组里（Album 合成的 ORIGINAL 项无 regions 字段），
    // 从其独立缓存槽 originalRegions 恢复；版本项则读 v.regions（随版本持久化）
    const isOriginal = !!data.originalImage && v.dataUrl === data.originalImage;
    const cachedRegions = isOriginal ? (data.originalRegions ?? undefined) : (v.regions ?? undefined);
    patch({
      inputImage: v.dataUrl,
      result: v.dataUrl,
      mode: 'edit',
      regions: cachedRegions,
      regionsImageKey: v.dataUrl,
      selectedRegions: cachedRegions ? (isOriginal ? [] : (v.selectedRegions ?? [])) : [],
    });
  }, [patch, data.originalImage, data.originalRegions]);

  const onVersionTogglePin = useCallback((vId: string) => {
    const next = (data.versions ?? []).map((v) => (v.id === vId ? { ...v, pinned: !v.pinned } : v));
    patch({ versions: next });
  }, [patch, data.versions]);

  const onVersionDelete = useCallback(async (vId: string) => {
    const removed = (data.versions ?? []).find((v) => v.id === vId);
    // 同步删除磁盘 homework 文件（若有 savedPath）
    if (removed?.savedPath) {
      // savedPath 格式：homework/{filename}，提取文件名最后一段
      const filename = removed.savedPath.split('/').pop();
      if (filename) {
        try {
          await fetch('/api/imagegen/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
          });
        } catch (e) {
          console.error('Delete disk image failed:', e);
        }
      }
    }
    const next = (data.versions ?? []).filter((v) => v.id !== vId);
    patch({ versions: next });
    if (removed && inputImage === removed.dataUrl) {
      const latest = next[next.length - 1];
      if (latest) {
        patch({ inputImage: latest.dataUrl, result: latest.dataUrl, mode: 'edit' });
      } else {
        patch({ inputImage: undefined, result: undefined, mode: 'generate' });
      }
    }
  }, [patch, data.versions, inputImage]);

  /** 三视图组切换视角（从 Album Modal 点击某个视角时触发） */
  const onTriplotGroupViewSwitch = useCallback((groupId: string, view: 'front' | 'side' | 'top') => {
    const group = data.triplotGroups?.find((g) => g.id === groupId);
    if (!group) return;
    const v = group[view];
    patch({
      triplotActiveGroupId: groupId,
      triplotActiveView: view,
      result: v.dataUrl,
      inputImage: v.dataUrl,
      regions: undefined,
      regionsImageKey: v.dataUrl,
      selectedRegions: [],
    });
  }, [patch, data.triplotGroups]);

  /** 删除整个三视图组：同步删3张磁盘文件 + 从 triplotGroups 移除 + 清理激活态指向 */
  const onTriplotGroupDelete = useCallback(async (groupId: string) => {
    const group = data.triplotGroups?.find((g) => g.id === groupId);
    if (!group) return;
    // 1) 批量删3张磁盘文件
    const filenames: string[] = [];
    (['front', 'side', 'top'] as const).forEach((k) => {
      const sp = group[k].savedPath;
      if (sp) {
        const f = sp.split('/').pop();
        if (f) filenames.push(f);
      }
    });
    if (filenames.length > 0) {
      try {
        await fetch('/api/imagegen/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames }),
        });
      } catch (e) {
        console.error('Batch delete triplot disk images failed:', e);
      }
    }
    // 2) 从 triplotGroups 移除；若删除的是当前激活组，回退到上一组或清空
    patch((prev) => {
      const nextGroups = (prev.triplotGroups ?? []).filter((g) => g.id !== groupId);
      let nextActiveId = prev.triplotActiveGroupId;
      let nextActiveView = prev.triplotActiveView;
      let nextResult: string | undefined = prev.result;
      let nextInput: string | undefined = prev.inputImage;
      if (prev.triplotActiveGroupId === groupId) {
        const fallback = nextGroups[nextGroups.length - 1];
        if (fallback) {
          nextActiveId = fallback.id;
          nextActiveView = 'front';
          nextResult = fallback.front.dataUrl;
          nextInput = fallback.front.dataUrl;
        } else {
          nextActiveId = undefined;
          nextActiveView = undefined;
          // 激活组被删且无其他组时，若 versions 还有图，回退到最新版本；否则清空
          const latestVer = (prev.versions ?? []).slice(-1)[0];
          if (latestVer) {
            nextResult = latestVer.dataUrl;
            nextInput = latestVer.dataUrl;
          } else if (prev.originalImage) {
            nextResult = prev.originalImage;
            nextInput = prev.originalImage;
          } else {
            nextResult = undefined;
            nextInput = undefined;
          }
        }
      }
      return {
        triplotGroups: nextGroups,
        triplotActiveGroupId: nextActiveId,
        triplotActiveView: nextActiveView,
        result: nextResult,
        inputImage: nextInput,
        mode: nextActiveId ? 'triplot' : (nextInput ? 'edit' : 'generate'),
        regions: undefined,
        regionsImageKey: nextResult ?? undefined,
        selectedRegions: [],
      };
    });
  }, [patch, data.triplotGroups]);

  const [attachments, setAttachments] = useState<AttachmentImage[]>([]);
  /** Detect All 请求进行中 */
  const [detectAllLoading, setDetectAllLoading] = useState(false);

  // ── Album（版本相册）连线式打开/关闭 ──
  // 不再使用全屏弹窗：Album 作为画布节点挂在 ImageGen 右侧，用真实连线（右 source → Album 左 target）关联。
  const albumId = `album-${id}`;
  const albumEdgeId = `edge-album-${id}`;
  /** 首次生成完成自动打开过一次后不再自动开（后续手动打开） */
  const albumAutoOpenedRef = useRef(false);

  /** 关闭 Album：移除节点与连线 */
  const closeAlbum = () => {
    setNodes((nds) => nds.filter((n) => n.id !== albumId));
    setEdges((eds) => eds.filter((e) => e.id !== albumEdgeId));
  };

  /** 构建 Album 节点 data（版本/选中快照 + 回调；变化时由下方 useEffect 同步刷新） */
  const buildAlbumData = (): ImageGenAlbumNodeData => ({
    imageGenNodeId: id,
    versions: data.versions ?? [],
    originalImage: data.originalImage,
    currentImage: inputImage,
    attachments,
    triplotGroups: data.triplotGroups ?? [],
    triplotActiveGroupId: data.triplotActiveGroupId,
    triplotActiveView: data.triplotActiveView,
    onSelect: onVersionSelect,
    onTogglePin: onVersionTogglePin,
    onDelete: onVersionDelete,
    onTriplotViewSwitch: onTriplotGroupViewSwitch,
    onTriplotGroupDelete,
    onClose: closeAlbum,
    editorRef,
  });

  /** 以连线方式在 ImageGen 右侧打开 Album（若已打开则跳过，保持幂等） */
  const openAlbum = () => {
    if (getNodes().some((n) => n.id === albumId)) return; // 已打开
    const node = getNode(id);
    const pos = node?.position ?? { x: 0, y: 0 };
    addNodes([{
      id: albumId,
      type: 'imagegenAlbum',
      position: { x: pos.x + NODE_W + 60, y: pos.y - 40 },
      data: buildAlbumData(),
    }]);
    addEdges([{
      id: albumEdgeId,
      source: id,
      sourceHandle: 'right',   // ImageGenNode 右侧 source 手柄的 id 为 "right"（勿写成 right-source，否则边无锚点不渲染）
      target: albumId,
      targetHandle: 'left-target',
    }]);
  };

  // 版本/选中变化时同步 Album 节点 data（已打开时保持实时）
  useEffect(() => {
    if (!getNodes().some((n) => n.id === albumId)) return;
    setNodes((nds) => nds.map((n) => (n.id === albumId ? { ...n, data: buildAlbumData() } : n)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data.versions, data.triplotGroups, data.inputImage, data.originalImage, data.triplotActiveGroupId, data.triplotActiveView, attachments]);

  /** Detect All：调 VLM 全景识别 API（无需指令），持久化识别结果；重新识别会清空旧选中。
   *  关键：VLM 返回 0~1000 归一化坐标（与 VLM 内部缩放无关），服务端按原图自然尺寸
   *  （natW/natH）换算回原图像素坐标，前端无需再做等比映射。 */
  const handleDetectAll = useCallback(async () => {
    if (detectAllLoading || !inputImage) return;
    setDetectAllLoading(true);
    try {
      const img = new Image();
      img.src = inputImage;
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
      const natW = img.naturalWidth || 0;
      const natH = img.naturalHeight || 0;

      // 缩放原图到固定最长边（仅用于减小请求体积；坐标已归一化，缩放不影响定位精度）
      const MAX_VLM_DIM = 1568; // OpenAI detail=high 上限 / 多数 VLM 内部支持尺寸
      const longSide = Math.max(natW, natH);
      const scale = longSide > MAX_VLM_DIM ? MAX_VLM_DIM / longSide : 1;
      let sendDataUrl = inputImage;
      if (scale < 1) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(natW * scale));
        c.height = Math.max(1, Math.round(natH * scale));
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, c.width, c.height);
          // 用 PNG 而非 JPEG：保留透明通道（原图可能是带透明的 PNG/GIF，JPEG 会变黑底干扰 VLM 识别）
          sendDataUrl = c.toDataURL('image/png');
        }
      }

      const resp = await fetch('/api/imagegen/detect-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: sendDataUrl,
          natW: natW || undefined,
          natH: natH || undefined,
        }),
      });
      const res = await resp.json().catch(() => ({ success: false, error: 'Bad response' }));
      if (!res.success) {
        showImageAiEditToast(res.error || 'Detect All failed');
        return;
      }
      // 服务端已按原图自然尺寸换算好像素坐标，直接使用
      const detected = (res.regions ?? []) as RegionRef[];
      patch({
        regions: detected,
        regionsImageKey: inputImage,
        selectedRegions: [],
        // 当前工作图就是原始图时，同步写入 originalRegions 缓存（切回 ORIGINAL 时复用）
        ...(inputImage === data.originalImage ? { originalRegions: detected } : {}),
      });
      // 缓存到对应版本：当前工作图是某个版本时，把识别结果写回该版本，
      // 之后在 Album 中再次打开这张图即可直接复用，无需重复 Detect All
      patch((prev) => {
        const matches = (prev.versions ?? []).some((v) => v.dataUrl === inputImage);
        if (!matches) return prev;
        return {
          ...prev,
          versions: (prev.versions ?? []).map((v) =>
            v.dataUrl === inputImage ? { ...v, regions: detected, selectedRegions: [] } : v,
          ),
        };
      });
      if (detected.length === 0) {
        showImageAiEditToast('No editable object detected — whole-image edit will apply.');
      } else {
        showImageAiEditToast(`Detect All: ${detected.length} region(s) detected. Click a box to select it.`);
      }
    } catch (e) {
      showImageAiEditToast(e instanceof Error ? e.message : 'Detect All request failed');
    } finally {
      setDetectAllLoading(false);
    }
  }, [detectAllLoading, inputImage, data.originalImage, patch]);

  /** 点击高亮框 toggle 选中（与 PromptBar #chip 双向同步）；同时写回版本缓存 */
  const handleToggleRegion = useCallback((rid: string) => {
    const cur = data.selectedRegions ?? [];
    const next = cur.includes(rid) ? cur.filter((x) => x !== rid) : [...cur, rid];
    patch({ selectedRegions: next });
    patch((prev) => {
      if (!inputImage) return prev;
      return {
        ...prev,
        versions: (prev.versions ?? []).map((v) =>
          v.dataUrl === inputImage ? { ...v, selectedRegions: next } : v,
        ),
      };
    });
  }, [patch, data.selectedRegions, inputImage]);

  /** 一键清除识别结果（同时清除当前图片对应版本的缓存，避免重新打开后旧 regions 复活） */
  const handleClearRegions = useCallback(() => {
    patch({ regions: undefined, selectedRegions: [] });
    patch((prev) => {
      const isOriginal = !!data.originalImage && inputImage === data.originalImage;
      const next = isOriginal
        ? { ...prev, originalRegions: undefined }
        : prev;
      if (!inputImage) return next;
      const matches = (next.versions ?? []).some((v) => v.dataUrl === inputImage);
      if (!matches) return next;
      return {
        ...next,
        versions: (next.versions ?? []).map((v) =>
          v.dataUrl === inputImage ? { ...v, regions: undefined, selectedRegions: undefined } : v,
        ),
      };
    });
  }, [patch, inputImage, data.originalImage]);

  // 图片变化（新生成 / 切换 Album 版本 / 上传新图）→ 旧识别结果失效，自动清除
  useEffect(() => {
    const key = data.regionsImageKey;
    if (!key) return;
    if (inputImage !== key) {
      patch({ regions: undefined, regionsImageKey: undefined, selectedRegions: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputImage]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={nodeCardRef}
        className="ai-node-wrapper group relative flex flex-col overflow-hidden rounded-lg border text-sm"
        style={{
          width: NODE_W,
          height: NODE_H,
          zoom: currentZoom,
          backgroundColor: 'var(--paper)',
          borderColor: selected ? 'color-mix(in oklab, var(--info) 60%, transparent)' : 'var(--line)',
          // 立体感：顶部受光高光（inset）+ 接触阴影 + 环境投影；选中时叠加蓝色描边光晕
          boxShadow: selected
            ? 'inset 0 1px 0 color-mix(in srgb, #fff 16%, transparent), 0 1px 3px color-mix(in oklab, var(--ink) 16%, transparent), 0 8px 24px color-mix(in oklab, var(--ink) 12%, transparent), 0 0 0 1px color-mix(in oklab, var(--info) 40%, transparent)'
            : 'inset 0 1px 0 color-mix(in srgb, #fff 16%, transparent), 0 1px 3px color-mix(in oklab, var(--ink) 16%, transparent), 0 8px 24px color-mix(in oklab, var(--ink) 12%, transparent)',
        }}
      >
      {/* 左上角 Album 按钮：始终显示；点击以连线方式在节点右侧打开版本相册 */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openAlbum(); }}
          title={`Version Album (${data.versions?.length ?? 0})`}
          className="absolute left-2 top-2 z-30 flex h-6 items-center gap-1 rounded-md px-2 transition-all duration-150"
          style={{
            color: '#fff',
            backgroundColor: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.18)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(96,84,241,0.6)';
            e.currentTarget.style.borderColor = 'rgba(199,190,255,0.4)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.45)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
          }}
        >
          <Album className="h-3.5 w-3.5" />
          <span className="text-10 font-semibold">{data.versions?.length ?? 0}</span>
        </button>

      {/* 右上角放大/缩小按钮（删除按钮左侧） */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); handleToggleEnlarge(); }}
        title={isEnlarged ? 'Shrink to 80%' : 'Enlarge to 120%'}
        className="absolute right-9 top-2 z-30 flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150"
        style={{
          color: '#fff',
          backgroundColor: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.18)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(96,84,241,0.6)';
          e.currentTarget.style.borderColor = 'rgba(199,190,255,0.4)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.45)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
        }}
      >
        {isEnlarged ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>

      {/* 右上角删除按钮 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); handleDelete(); }}
        title="Delete node"
        className="absolute right-2 top-2 z-30 flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150"
        style={{
          color: '#fff',
          backgroundColor: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.18)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 0.7)';
          e.currentTarget.style.borderColor = 'rgba(254, 202, 202, 0.5)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.45)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {/* 连接点（Handle）：与普通 AI 节点一致，左右两对 target+source，供连线/拖拽生成节点 */}
      <Handle
        type="target"
        position={Position.Left}
        id="left-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'var(--paper)',
          borderColor: 'color-mix(in oklab, var(--success) 70%, transparent)',
          left: 0,
        }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'var(--paper)',
          borderColor: 'color-mix(in oklab, var(--success) 70%, transparent)',
          right: 0,
        }}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)',
          borderColor: 'var(--paper)',
          left: '-2px',
          boxShadow: '0 2px 8px color-mix(in oklab, var(--primary) 30%, transparent)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)',
          borderColor: 'var(--paper)',
          right: '-2px',
          boxShadow: '0 2px 8px color-mix(in oklab, var(--primary) 30%, transparent)',
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {/* 三视图视角 Tab 行：仅 triplot 模式且存在 triplotGroups 时显示 */}
        {data.mode === 'triplot' && data.triplotActiveGroupId && (() => {
          const group = data.triplotGroups?.find((g) => g.id === data.triplotActiveGroupId);
          if (!group) return null;
          const views: Array<{ key: 'front' | 'side' | 'top'; label: string }> = [
            { key: 'front', label: 'Front' },
            { key: 'side', label: 'Side' },
            { key: 'top', label: 'Top' },
          ];
          return (
            <div className="shrink-0 flex items-center justify-between gap-1 px-3 py-1.5" style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}>
              <div className="flex items-center gap-1">
                {views.map((v) => {
                  const active = (data.triplotActiveView ?? 'front') === v.key;
                  const vData = group[v.key];
                  return (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => onTriplotViewSwitch(v.key)}
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                      style={{
                        color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
                        backgroundColor: active ? 'color-mix(in oklab, var(--primary) 15%, transparent)' : 'transparent',
                        outline: active ? '1px solid color-mix(in oklab, var(--primary) 40%, transparent)' : 'none',
                      }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? 'var(--primary)' : 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }} />
                      {v.label}
                    </button>
                  );
                })}
              </div>
              <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                {`Group ${(data.triplotGroups ?? []).findIndex((g) => g.id === group.id) + 1} / ${data.triplotGroups?.length ?? 1}`}
              </span>
            </div>
          );
        })()}

        <ImageAiEditor
          ref={editorRef}
          src={inputImage}
          fileName={title}
          allowGenerate
          hideBottomBar
          hideHelp
          regions={data.regions ?? []}
          selectedRegions={data.selectedRegions ?? []}
          onDetectAll={handleDetectAll}
          detectAllLoading={detectAllLoading}
          onToggleRegion={handleToggleRegion}
          onClearRegions={handleClearRegions}
          onImageChange={(d) => patch((prev) => {
            // 首次生成且未捕获过原始图时，把输入图捕获为 originalImage（必须在清空 regions 之前判定）；
            // 若工作图已 Detect All（regionsImageKey 命中），把识别结果同步写入 originalRegions——
            // 保证「detect-all 早于 originalImage 捕获」时，切回 ORIGINAL 也能复用识别结果
            const captureOriginal = !!d && !prev.originalImage && !prev.versions?.length
              && !!prev.inputImage && prev.inputImage !== d;
            return {
              ...prev,
              inputImage: d ?? undefined,
              // triplot 模式时，用户在编辑器内单视角迭代保持 mode=triplot 不变，其他情况按是否有工作图切换
              mode: prev.mode === 'triplot' ? 'triplot' : (d ? 'edit' : 'generate'),
              regions: undefined,           // 策略 A：工作图变化 → 旧 regions 失效，立即清空
              regionsImageKey: d ?? undefined, // 同时更新 key，保证 useEffect 兜底路径也同步
              selectedRegions: [],
              ...(captureOriginal
                ? {
                    originalImage: prev.inputImage,
                    originalRegions: prev.regionsImageKey === prev.inputImage
                      ? (prev.regions ?? undefined)
                      : undefined,
                  }
                : {}),
            };
          })}
          onSave={(d) => {
            patch({ result: d });
            saveGeneratedImage(d, `v${(data.versions?.length ?? 0) + 1}.png`);
          }}
          onSaveAsCopy={(d) => {
            patch({ result: d });
            saveGeneratedImage(d, `v${(data.versions?.length ?? 0) + 1}-copy.png`);
          }}
          onCancel={() => { /* 取消键由编辑器内部处理状态切换 */ }}
        />

        {/* 三视图三面板缩略条：底部横排三张图，点击切视角，当前视角带边框 */}
        {data.mode === 'triplot' && data.triplotActiveGroupId && (() => {
          const group = data.triplotGroups?.find((g) => g.id === data.triplotActiveGroupId);
          if (!group) return null;
          const current = (data.triplotActiveView ?? 'front') as 'front' | 'side' | 'top';
          return (
            <div
              className="shrink-0 grid grid-cols-3 gap-1.5 px-3 py-2"
              style={{ borderTop: '1px solid var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}
            >
              {(['front', 'side', 'top'] as const).map((key) => {
                const v = group[key];
                const active = current === key;
                const label = key.charAt(0).toUpperCase() + key.slice(1);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onTriplotViewSwitch(key)}
                    className="relative overflow-hidden rounded-md"
                    style={{
                      border: `1.5px solid ${active ? 'var(--primary)' : 'var(--line-soft)'}`,
                      boxShadow: active ? '0 0 0 1px color-mix(in oklab, var(--primary) 40%, transparent)' : 'none',
                      backgroundColor: 'var(--paper)',
                      aspectRatio: '1 / 1',
                    }}
                  >
                    <img
                      src={v.dataUrl}
                      alt={`${label} view`}
                      className="h-full w-full object-contain"
                      draggable={false}
                    />
                    <div
                      className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-10 font-semibold"
                      style={{
                        color: active ? 'var(--paper)' : 'var(--ink-muted)',
                        backgroundColor: active ? 'var(--primary)' : 'rgba(0,0,0,0.45)',
                      }}
                    >
                      {label}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })()}
      </div>
      {confirmRender}
    </div>

    {/* 输入框浮层：紧贴节点正下方，宽度与节点屏幕宽度一致，选中本节点时显示。
        使用 createPortal 挂到 document.body + position:fixed，避免被 ReactFlow wrapper overflow:hidden 裁剪。
        z-index: 60 高于 Dialog(z-50) / Sidebar / 预览面板，保证模型/比例下拉不被遮挡。 */}
    {selected && portal && promptBarScreen && createPortal(
      <div
        ref={promptBarWrapRef}
        className="pointer-events-none"
        style={{
          position: 'fixed',
          // 优先读缓存的最新位置（拖动中由 rAF 直接写 DOM/ref 保持），避免 React 重渲染用旧 state 覆盖实时位置
          top: (lastPromptBarPosRef.current ?? promptBarScreen).top,
          left: (lastPromptBarPosRef.current ?? promptBarScreen).left,
          width: (lastPromptBarPosRef.current ?? promptBarScreen).width,
        zIndex: 30,   // 低于全局 Modal(z-50 / z-[120])，防止设置弹窗被 Bar 遮挡；但高于普通 canvas UI 层
        }}
      >
        <ImageGenPromptBar
          nodeTitle={title}
          data={data}
          onPatch={patch}
          editorRef={editorRef}
          onGenerated={handleGenerated}
          onTriplotGenerated={handleTriplotGenerated}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onToggleRegion={handleToggleRegion}
        />
      </div>,
      portal,
    )}
    </div>
  );
}

function areImageGenNodePropsEqual(
  prev: { id: string; data: ImageGenNodeData; selected?: boolean },
  next: { id: string; data: ImageGenNodeData; selected?: boolean },
): boolean {
  if (prev.id !== next.id) return false;
  if (prev.selected !== next.selected) return false;
  // 最关键：data 引用没变 → 拖拽位置变化，直接跳过重渲染
  if (prev.data === next.data) return true;
  const a = prev.data;
  const b = next.data;
  if (a.title !== b.title) return false;
  if (a.mode !== b.mode) return false;
  if (a.prompt !== b.prompt) return false;
  if (a.negativePrompt !== b.negativePrompt) return false;
  if (a.model !== b.model) return false;
  if (a.size !== b.size) return false;
  if (a.inputImage !== b.inputImage) return false;
  if (a.originalImage !== b.originalImage) return false;
  if (a.result !== b.result) return false;
  if (a.isGenerating !== b.isGenerating) return false;
  if (a.collapsed !== b.collapsed) return false;
  if (a.versions !== b.versions) return false;
  if (a.triplotGroups !== b.triplotGroups) return false;
  if (a.triplotActiveView !== b.triplotActiveView) return false;
  if (a.triplotActiveGroupId !== b.triplotActiveGroupId) return false;
  if (a.versionsOpen !== b.versionsOpen) return false;
  if (a.regions !== b.regions) return false;
  if (a.regionsImageKey !== b.regionsImageKey) return false;
  if (a.selectedRegions !== b.selectedRegions) return false;
  if (a.triplotProgress !== b.triplotProgress) return false;
  return true;
}

export const ImageGenNode = memo(ImageGenNodeInner, areImageGenNodePropsEqual);
