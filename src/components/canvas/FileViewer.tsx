'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, FileText, Image as ImageIcon, File as FileIcon, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react';
import { HtmlRenderer } from './HtmlRenderer';

interface FileInfo {
  name: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  size: number;
  extension: string;
  full_path?: string;
}

interface FileViewerProps {
  projectId: string | null;
  fileName: string;
  filePath: string;
  onClose: () => void;
  mode?: 'standalone' | 'tabbed';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 剥离 .md 文件的 frontmatter */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? match[2] : content;
}

/** 代码文件扩展名到语言的映射 */
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.java': 'java',
  '.cpp': 'cpp', '.c': 'c', '.h': 'c',
  '.go': 'go', '.rs': 'rust',
  '.css': 'css', '.html': 'html',
  '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql',
};

export function FileViewer({ projectId, fileName, filePath, onClose, mode = 'standalone' }: FileViewerProps) {
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const visibleRef = useRef(false);

  useEffect(() => {
    visibleRef.current = true;
    return () => { visibleRef.current = false; };
  }, []);

  useEffect(() => {
    if (!projectId || !filePath) return;
    setLoading(true);
    setError(null);

    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: filePath }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!visibleRef.current) return;
        if (data.success) {
          setFileInfo(data);
        } else {
          setError(data.error || 'Failed to read file');
        }
      })
      .catch((e) => {
        if (!visibleRef.current) return;
        setError(e instanceof Error ? e.message : 'Network error');
      })
      .finally(() => {
        if (visibleRef.current) setLoading(false);
      });
  }, [projectId, filePath]);

  const ext = fileInfo?.extension || '';

  /** 渲染文本内容 */
  const renderTextContent = () => {
    if (!fileInfo?.content) return null;

    // .md 用 HtmlRenderer（先剥离 frontmatter）
    if (ext === '.md') {
      return (
        <div className="px-6 py-4">
          <HtmlRenderer content={stripFrontmatter(fileInfo.content)} />
        </div>
      );
    }

    // .json 格式化
    if (ext === '.json') {
      let formatted = fileInfo.content;
      try {
        formatted = JSON.stringify(JSON.parse(fileInfo.content), null, 2);
      } catch { /* use raw */ }
      return (
        <pre className="px-6 py-4 text-[12px] leading-relaxed whitespace-pre-wrap font-mono"
          style={{ color: 'oklch(0.30 0.01 260)', fontFamily: '"SF Mono", Menlo, monospace' }}>
          {formatted}
        </pre>
      );
    }

    // 代码文件
    const lang = LANG_MAP[ext];
    if (lang) {
      return (
        <pre className="px-6 py-4 text-[12px] leading-relaxed whitespace-pre-wrap font-mono"
          style={{ color: 'oklch(0.30 0.01 260)', fontFamily: '"SF Mono", Menlo, monospace' }}>
          {fileInfo.content}
        </pre>
      );
    }

    // 其他文本文件
    return (
      <pre className="px-6 py-4 text-[12px] leading-relaxed whitespace-pre-wrap"
        style={{ color: 'oklch(0.30 0.01 260)', fontFamily: '"SF Mono", Menlo, monospace' }}>
        {fileInfo.content}
      </pre>
    );
  };

  /** 渲染图片 */
  const renderImage = () => {
    if (!fileInfo?.content) return null;
    return (
      <div className="flex items-center justify-center p-6">
        <img
          src={fileInfo.content}
          alt={fileInfo.name}
          className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-lg"
          style={{ backgroundColor: 'oklch(0.94 0.005 260)' }}
        />
      </div>
    );
  };

  /** 渲染 PDF（内嵌预览） */
  const renderPdf = () => {
    const proxyUrl = `/api/projects?action=file_proxy&project_id=${encodeURIComponent(projectId || '')}&file_path=${encodeURIComponent(filePath)}`;
    return (
      <div className="flex-1">
        <iframe
          src={proxyUrl}
          className="h-full w-full border-0"
          title={fileName}
        />
      </div>
    );
  };

  /** 渲染二进制文件占位（支持用系统默认程序打开） */
  const renderBinary = () => {
    const handleOpen = async () => {
      try {
        const absPath = fileInfo?.full_path;
        if (absPath && typeof window !== 'undefined' && window.api?.openFile) {
          await window.api.openFile(absPath);
        }
      } catch (e) {
        console.error('打开文件失败:', e);
      }
    };

    const ext = fileInfo?.extension?.toLowerCase() || '';
    const isWord = ['.doc', '.docx'].includes(ext);
    const label = isWord ? 'Word 文档' : '二进制文件';

    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <FileIcon className="h-12 w-12" style={{ color: 'oklch(0.55 0.02 60)' }} />
        <p className="text-[13px]" style={{ color: 'oklch(0.40 0.01 260)' }}>
          {label} — 无法在线预览
        </p>
        <p className="text-[11px]" style={{ color: 'oklch(0.50 0.01 260)' }}>
          {formatSize(fileInfo?.size || 0)}
        </p>
        <button
          onClick={handleOpen}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-medium transition-colors"
          style={{ backgroundColor: '#537D96', color: '#fff' }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          用默认程序打开
        </button>
      </div>
    );
  };

  return (
    <div
      className={mode === 'standalone' ? 'fixed right-0 top-0 flex h-full flex-col' : 'flex h-full flex-col'}
      style={{
        width: mode === 'standalone' ? '48%' : '100%',
        minWidth: mode === 'standalone' ? '480px' : undefined,
        maxWidth: mode === 'standalone' ? '780px' : undefined,
        backgroundColor: '#faf8f3',
        borderLeft: mode === 'standalone' ? '1px solid rgba(0, 0, 0, 0.07)' : undefined,
        boxShadow: mode === 'standalone' ? '-12px 0 32px rgba(0, 0, 0, 0.06)' : undefined,
        zIndex: mode === 'standalone' ? 50 : undefined,
      }}
    >
      {/* 头部 */}
      <div
        className="flex shrink-0 items-center gap-3 px-5 py-3"
        style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.05)', backgroundColor: '#faf8f3' }}
      >
        {fileInfo?.type === 'image' ? (
          <ImageIcon className="h-4 w-4 shrink-0" style={{ color: '#537D96' }} />
        ) : (
          <FileText className="h-4 w-4 shrink-0" style={{ color: '#537D96' }} />
        )}
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-semibold truncate block" style={{ color: '#2c2416' }}>
            {fileName}
          </span>
          {fileInfo && (
            <span className="text-[10px]" style={{ color: '#8a8270' }}>
              {fileInfo.type === 'binary' ? 'Binary' : ''} {formatSize(fileInfo.size)}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: '#7a7260' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex flex-1 flex-col overflow-y-auto ai-canvas-scroll">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: '#537D96' }} />
            <span className="text-[12px]" style={{ color: '#8a8270' }}>Loading...</span>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 px-6">
            <AlertCircle className="h-8 w-8" style={{ color: '#c0392b' }} />
            <p className="text-center text-[13px]" style={{ color: '#5c5342' }}>{error}</p>
          </div>
        ) : fileInfo ? (
          fileInfo.type === 'image' ? renderImage() :
          fileInfo.extension === '.pdf' ? renderPdf() :
          fileInfo.type === 'binary' ? renderBinary() :
          renderTextContent()
        ) : null}
      </div>
    </div>
  );
}
