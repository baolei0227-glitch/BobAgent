'use client';

import { useEffect } from 'react';

/**
 * 全局错误边界：捕获未处理的客户端异常，显示错误堆栈便于排查。
 * Next.js App Router 的 global-error.js 会捕获 root layout 及子树的渲染异常。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 将错误写入文件（通过 fetch 发送到服务端日志）
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body className="antialiased" style={{ background: 'var(--background, #1a1a1a)', color: 'var(--ink, #fff)', fontFamily: "var(--font-sans)", padding: '40px', minHeight: '100vh' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <h2 style={{ color: '#ff6b6b', fontSize: '18px', marginBottom: '16px' }}>
            Application Error (captured by global-error)
          </h2>
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '8px', marginBottom: '16px', overflow: 'auto' }}>
            <p style={{ color: '#ff6b6b', fontWeight: 'bold', marginBottom: '8px' }}>{error.message}</p>
            <pre style={{ color: '#aaa', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '1.5' }}>
              {error.stack || '(no stack trace)'}
            </pre>
            {error.digest && (
              <p style={{ color: '#666', fontSize: '0.733333rem', marginTop: '8px' }}>digest: {error.digest}</p>
            )}
          </div>
          <button
            onClick={reset}
            style={{
              background: '#ff6b6b',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.866667rem',
            }}
          >
            Retry
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'transparent',
              color: '#aaa',
              border: '1px solid #444',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.866667rem',
              marginLeft: '8px',
            }}
          >
            Reload Page
          </button>
        </div>
      </body>
    </html>
  );
}
