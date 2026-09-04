import { memo } from 'react';
import type { CSSProperties } from 'react';

interface FileNameProps {
  name: string;
  className?: string;
  style?: CSSProperties;
}

/** 中段省略文件名：保留名称头部 + 扩展名，超长时省略中间；无扩展名时退化为头部省略 */
export const FileName = memo(function FileName({ name, className = '', style }: FileNameProps) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';

  return (
    <span className={`flex min-w-0 items-center ${className}`} style={style}>
      <span className="min-w-0 truncate">{base}</span>
      {ext && <span className="flex-shrink-0">{ext}</span>}
    </span>
  );
});