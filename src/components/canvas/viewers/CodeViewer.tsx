'use client';

import type { ViewerRenderProps } from './types';
import { CodeEditor } from '../CodeEditor';

/** 代码渲染器：CodeMirror 只读语法高亮 */
export function CodeViewer({ fileInfo }: ViewerRenderProps) {
  return (
    <div className="flex-1 overflow-hidden">
      <CodeEditor content={fileInfo.content || ''} extension={fileInfo.extension} editable={false} />
    </div>
  );
}
