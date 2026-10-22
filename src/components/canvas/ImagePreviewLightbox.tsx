'use client';

import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';

/**
 * 主对话正文 / 产物图片的「点击放大」预览（黑底全屏）。
 *
 * 为什么不用 yarl 默认尺寸（2026-10-17 用户反馈「图片放大后没有明显变大」）：
 * yarl 的 ImageSlide 默认把图片渲染成 `min(自然尺寸, 视口)`——图片的固有像素比视口小时，
 * 预览图就停在自然尺寸上，跟正文里已经按列宽渲染的内联图几乎一样大，点开黑底遮罩后
 * 「没有变大」。这里通过 `carousel.imageProps` 覆盖 yarl 的内联尺寸，让图片撑满整个视口
 * （width/height:100% + object-contain），小图等比放大 2–3 倍，大图仍是 contain 不裁切；
 * Zoom 插件保留滚轮 / 双击 / 工具栏按钮缩放，需要看细节时继续放大。
 *
 * 说明：这里只改「展示尺寸」，不改图片文件本身；小图放大后的模糊是源图分辨率决定的。
 */
export interface ImagePreviewSlide {
  src: string;
  alt?: string;
}

/** 撑满视口的图片样式：yarl 会把它合并在默认 maxWidth/maxHeight 之后（后者生效）。 */
const FILL_VIEWPORT_IMAGE_PROPS = {
  style: {
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    objectFit: 'contain' as const,
  },
};

export function ImagePreviewLightbox({
  open,
  slides,
  index = 0,
  onClose,
}: {
  open: boolean;
  slides: ImagePreviewSlide[];
  index?: number;
  onClose: () => void;
}) {
  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides}
      plugins={[Zoom]}
      carousel={{ imageProps: FILL_VIEWPORT_IMAGE_PROPS }}
      controller={{ closeOnBackdropClick: true }}
      zoom={{ maxZoomPixelRatio: 2, scrollToZoom: true }}
    />
  );
}
