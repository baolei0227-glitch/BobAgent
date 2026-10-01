'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { desktop, type ScreenOcrGeometry } from '@/lib/desktop-adapter';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { ScreenOcrEditor } from '@/components/screen-ocr/ScreenOcrEditor';

/**
 * 全局截图 OCR 宿主（Cmd+Shift+O）
 *
 * 订阅 Electron 主进程下发的截图事件并渲染编辑面板，挂在应用根部（layout.tsx），
 * 与页面/画布挂载状态彻底解耦——任何时刻按快捷键都能弹出编辑面板。
 *
 * 历史教训：订阅与渲染曾写在 CanvasFlow（画布页）内，非画布页或挂载间隙按快捷键时，
 * 主进程整屏截图成功但 `screen-ocr:captured` 无人接收，表现为「弹窗无法使用」，
 * 截图文件残留在 ~/Library/Caches/bobwork-capture/。
 *
 * 注意：OCR 结果直插输入框（screen-ocr:result）链路已废弃（主进程不再发送），
 * 仅保留 start/captured/canceled/error 四类事件。
 */
export function ScreenOcrHost() {
  const pathname = usePathname();
  /** 待编辑截图 dataUrl（主进程 screen-ocr:captured 下发） */
  const [editImage, setEditImage] = useState<string | null>(null);
  /** 初始选区模式：region（原生 -i 已选区）→ 整图全选区直接标注；full（整屏待选）→ 用户自行拖选 */
  const [initialSelection, setInitialSelection] = useState<'full' | 'none'>('none');
  /** 截图时刻的窗口几何（整屏链路才有）：供编辑面板做窗口吸附 */
  const [geometry, setGeometry] = useState<ScreenOcrGeometry | null>(null);
  /** 画面属于哪一屏（geometry.screens 下标）；-1/null = 全部屏幕并集 */
  const [screenIndex, setScreenIndex] = useState<number | null>(null);

  useEffect(() => {
    const offStart = desktop.screenOcr.onStart(() => {
      /* 系统选区截图已开始，无需额外 UI */
    });
    const offError = desktop.screenOcr.onError(({ message }) => {
      showImageAiEditToast(message || '截图 OCR 失败', 'error');
    });
    const offCanceled = desktop.screenOcr.onCanceled(() => {
      /* 用户按 Esc 取消选区：静默 */
    });
    const offCaptured = desktop.screenOcr.onCaptured(({ dataUrl, mode, geometry: geo, screenIndex: si }) => {
      setEditImage(dataUrl);
      setInitialSelection(mode === 'region' ? 'full' : 'none');
      setGeometry(geo ?? null);
      setScreenIndex(si ?? null);
    });
    return () => {
      offStart();
      offError();
      offCanceled();
      offCaptured();
    };
  }, []);

  // Hippo 对话侧栏（/browser-chat）是主进程 WebContentsView 加载的独立页面，设计上「零 App 外壳」，
  // 但该路由没有自己的 layout → 继承根 layout；截图编辑面板不该出现在那个窄侧栏里。
  if (!editImage || pathname === '/browser-chat') return null;

  return (
    <ScreenOcrEditor
      dataUrl={editImage}
      initialSelection={initialSelection}
      geometry={geometry}
      screenIndex={screenIndex}
      onDone={async (editedDataUrl) => {
        setEditImage(null);
        // 编辑完成（✓）：清理主进程暂存截图，避免 shot.png/result.json 残留
        desktop.screenOcr.finishEdit();
        const r = await desktop.screenOcr.copyImage(editedDataUrl);
        if (r.ok) {
          showImageAiEditToast('截图已复制到剪贴板', 'success');
        } else {
          showImageAiEditToast(`复制图片失败：${r.error ?? '未知错误'}`, 'error');
        }
      }}
      onOcr={(dataUrl) => desktop.screenOcr.ocrRegion(dataUrl)}
      onCancel={() => {
        setEditImage(null);
        desktop.screenOcr.cancelEdit();
      }}
    />
  );
}
