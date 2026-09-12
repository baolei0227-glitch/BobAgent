'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCw, Pencil, Sparkles, X } from 'lucide-react';
import Lightbox, { ImageSlide, useLightboxState, useLightboxDispatch } from 'yet-another-react-lightbox';
import type { RenderSlideProps, SlideImage } from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Thumbnails from 'yet-another-react-lightbox/plugins/thumbnails';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Download from 'yet-another-react-lightbox/plugins/download';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import type { ViewerRenderProps } from './types';
import { ImageAnnotator } from './ImageAnnotator';

/**
 * 图片渲染器：yarl（yet-another-react-lightbox）内嵌模式 + 标注编辑。
 *  - 内嵌：portal.root 挂到组件内 div，覆盖 .yarl__portal 的 fixed 定位为 absolute inset:0，填满整个容器
 *  - 多图：slides 数组 + Thumbnails 插件（position 'bottom' 底部缩略图条，默认折叠）——所有图片共享一个标签页
 *  - 标注：工具栏 Pencil 按钮进入标注模式（ImageAnnotator Canvas 覆盖层），保存后合成 PNG 写回原文件
 *  - 全屏：切换 portal.root 为 null（挂 document.body），按钮切换
 *  - 旋转：自定义工具栏按钮 + 自定义 slide 渲染（zoom 的 transform 在 wrapper 层，互不冲突）
 */
type RotatableSlide = SlideImage & { rotation?: number };

/** 自定义工具栏按钮：每次点击当前图片 +90°（0/90/180/270 循环） */
function RotateButton() {
  const { state } = useLightboxState();
  const dispatch = useLightboxDispatch();
  const slide = state.currentSlide as RotatableSlide | undefined;
  const rotation = slide?.rotation ?? 0;
  return (
    <button
      type="button"
      className="yarl__button"
      aria-label="Rotate image 90°"
      title="旋转 90°"
      onClick={() => {
        const nextRotation = rotation + 90;
        dispatch({
          type: 'update',
          slides: state.slides.map((sl, i) =>
            i === state.currentIndex
              ? { ...sl, rotation: nextRotation }
              : sl,
          ),
          index: state.currentIndex,
        });
      }}
    >
      <RotateCw className="yarl__icon" />
    </button>
  );
}

/** 标注入口按钮：进入标注模式编辑当前图片 */
function AnnotateButton({ onAnnotate }: { onAnnotate: (index: number) => void }) {
  const { state } = useLightboxState();
  return (
    <button
      type="button"
      className="yarl__button"
      aria-label="标注图片"
      title="标注（箭头/矩形/文字/马赛克）"
      onClick={() => onAnnotate(state.currentIndex)}
    >
      <Pencil className="yarl__icon" />
    </button>
  );
}

/** AI 编辑入口按钮：进入 AI 编辑模式修改当前图片 */
function AiEditButton({ onAiEdit }: { onAiEdit: (index: number) => void }) {
  const { state } = useLightboxState();
  return (
    <button
      type="button"
      className="yarl__button"
      aria-label="AI 编辑图片"
      title="AI 编辑（自然语言指令修改图片）"
      onClick={() => onAiEdit(state.currentIndex)}
    >
      <Sparkles className="yarl__icon" />
    </button>
  );
}

/**
 * 自定义 slide 渲染：应用旋转 transform（zoom 的 transform 在 wrapper 层，互不冲突）。
 * 旋转 90°/270° 时宽高轴互换，需按视口（rect）交换 maxWidth/maxHeight，否则旋转后图片会溢出被裁切。
 */
function RotatableSlide({ slide, offset, rect }: RenderSlideProps) {
  const rotation = (slide as RotatableSlide).rotation ?? 0;
  const sideways = rotation % 180 !== 0;
  const style = rotation
    ? {
        transform: `rotate(${rotation}deg)`,
        // rect 在 yarl 中可能为 null（类型 Rect | null），旋转 90°/270° 交换宽高时必须判空，否则抛 TypeError 导致预览崩溃
        ...(sideways && rect ? { maxWidth: rect.height, maxHeight: rect.width } : null),
      }
    : undefined;
  return (
    <ImageSlide slide={slide} offset={offset} rect={rect} style={style} />
  );
}

/** 图片渲染器：yarl 内嵌（多图缩略图 / 缩放 / 旋转 / 标注 / 下载），可切换全屏 */
export function ImageViewer({ fileInfo, slides, initialIndex, source, projectId, onAiEditOverride }: ViewerRenderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // false = 内嵌在容器内；true = 挂到 document.body 全屏
  const [fullscreen, setFullscreen] = useState(false);
  // 标注模式：非 null 时进入 ImageAnnotator 编辑第 index 张图
  const [annotateIndex, setAnnotateIndex] = useState<number | null>(null);
  
  const [saveError, setSaveError] = useState<string | null>(null);

  const baseGallery = slides && slides.length > 0
    ? slides
    : (fileInfo.content ? [{ src: fileInfo.content, alt: fileInfo.name }] : []);

  // yarl slides 受控副本：标注保存后替换对应 src（保留 rotation 等字段），props 变化时重新同步
  const [mySlides, setMySlides] = useState(baseGallery);
  const [myIndex, setMyIndex] = useState(initialIndex ?? 0);
  useEffect(() => {
    setMySlides(baseGallery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, fileInfo.content]);

  if (baseGallery.length === 0) return <div className="flex-1" />;

  const portalRoot = fullscreen ? null : () => containerRef.current;

  /** 标注保存：合成 PNG 写回原文件（local 走 local-files，project/attachment 走 projects），并更新显示 */
  const handleAnnotateSave = async (dataUrl: string) => {
    if (annotateIndex == null) return;
    const slide = mySlides[annotateIndex];
    const path = slide?.path || fileInfo.full_path;
    const base64 = dataUrl.split(',')[1] || '';
    setSaveError(null);
    try {
      if (path) {
        const resp = await fetch(source === 'local' ? '/api/local-files' : '/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            source === 'local'
              ? { action: 'write', path, content: base64, encoding: 'base64' }
              : { action: 'write_file', project_id: projectId, file_path: path, content: base64, encoding: 'base64' },
          ),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '保存失败');
      }
      // 更新显示（保留 rotation 等自定义字段）
      setMySlides(prev => prev.map((s, i) => (i === annotateIndex ? { ...s, src: dataUrl } : s)));
      setMyIndex(annotateIndex);
      setAnnotateIndex(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 关闭当前预览的这张图：从图库（slides）中移除当前张（仅移除展示，不删除文件）；至少保留一张 */
  const handleRemoveCurrent = () => {
    if (mySlides.length <= 1) {
      return;
    }
    const removingLast = myIndex >= mySlides.length - 1;
    setMySlides((prev) => prev.filter((_, i) => i !== myIndex));
    if (removingLast) setMyIndex(Math.max(0, mySlides.length - 2));
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 底部缩略图条：选中图片的高亮外框（amber 描边 + 光晕，区别于默认 1px 白边） */}
      <style>{`
        .yarl__thumbnails_thumbnail {
          transition: border-color .15s ease, box-shadow .15s ease;
        }
        .yarl__thumbnails_thumbnail_active {
          border-width: 2px !important;
          border-color: #f59e0b !important;
          box-shadow: 0 0 0 1px rgba(245, 158, 11, .35), 0 0 10px rgba(245, 158, 11, .55) !important;
        }
      `}</style>
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        style={{ backgroundColor: 'var(--paper-soft)' }}
      >
        <Lightbox
          key={fullscreen ? 'fullscreen' : 'inline'}
          open
          index={myIndex}
          close={() => setFullscreen(false)}
          slides={mySlides}
          plugins={[Zoom, Thumbnails, Counter, Fullscreen, Download]}
          render={{ slide: RotatableSlide }}
          toolbar={{
            buttons: [
              <RotateButton key="rotate" />,
              <AnnotateButton key="annotate" onAnnotate={(i) => setAnnotateIndex(i)} />,
              <AiEditButton
                key="ai-edit"
                onAiEdit={(i) => onAiEditOverride?.(i)}
              />,
              <button
                key="toggle-fullscreen"
                type="button"
                className="yarl__button"
                aria-label={fullscreen ? '退出全屏' : '全屏查看'}
                title={fullscreen ? '退出全屏' : '全屏查看'}
                onClick={() => setFullscreen((f) => !f)}
              >
                {fullscreen ? <Minimize2 className="yarl__icon" /> : <Maximize2 className="yarl__icon" />}
              </button>,
              /* 关闭当前图的小角标（右上角圆形 ×）：从预览图库移除该张，不删除文件 */
              <button
                key="remove-current"
                type="button"
                className="yarl__button"
                aria-label="Close this image"
                title="从预览中关闭这张图（不移除文件）"
                onClick={handleRemoveCurrent}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  marginLeft: 8,
                  borderRadius: '50%',
                  backgroundColor: 'rgba(0,0,0,0.6)',
                  border: '1px solid rgba(255,255,255,0.25)',
                }}
              >
                <X className="yarl__icon" style={{ width: 14, height: 14, color: '#fff' }} />
              </button>,
            ],
          }}
          counter={{ container: { style: { top: 12 } } }}
          thumbnails={{ position: 'bottom', width: 96, height: 80, showToggle: true, hidden: true }}
          carousel={{ finite: true }}
          controller={{ closeOnEscape: fullscreen }}
          noScroll={{ disabled: !fullscreen }}
          portal={{
            root: portalRoot,
            ...(fullscreen ? {} : { container: { style: { position: 'absolute', inset: 0, zIndex: 10 } } }),
          }}
        />

        {/* 标注覆盖层 */}
        {annotateIndex != null && mySlides[annotateIndex] && (
          <div className="absolute inset-0 z-30">
            <ImageAnnotator
              src={mySlides[annotateIndex].src}
              fileName={mySlides[annotateIndex].alt || fileInfo.name}
              onSave={handleAnnotateSave}
              onCancel={() => { setAnnotateIndex(null); setSaveError(null); }}
            />
          </div>
        )}

        {/* 保存错误提示 */}
        {saveError && (
          <div
            className="absolute bottom-3 left-3 z-40 rounded-md px-3 py-1.5 text-xs"
            style={{ backgroundColor: 'var(--popover)', color: 'var(--danger)', border: '1px solid rgba(225,29,72,0.35)', boxShadow: '0 2px 12px rgba(0,0,0,0.12)' }}
          >
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
