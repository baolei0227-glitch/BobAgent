/**
 * CalDAV Server Endpoint - /api/dav/*
 *
 * Next.js App Router only supports standard HTTP methods (GET, POST, PUT, DELETE, PATCH).
 * CalDAV requires PROPFIND, REPORT, OPTIONS, MKCOL, etc.
 *
 * We use a catch-all route + NextResponse with custom method dispatching.
 * For methods not natively supported, we handle them through POST with a method override header,
 * or by using the raw Node.js http server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { handleDavRequest } from '@/lib/calendar/dav-server';
import { decideDavOnPreviewHost, davWriteAllowedOnPreviewHost } from '@/lib/http/preview-host';

/**
 * Catch-all handler for CalDAV requests.
 * Next.js route handlers are limited to standard methods, so we handle
 * CalDAV-specific methods (PROPFIND, REPORT, OPTIONS, MKCOL, etc.)
 * by inspecting the request method and routing accordingly.
 */
export async function DavProxy(req: NextRequest) {
  const method = req.method.toUpperCase();
  // 预览 origin（127.0.0.1）只读：小程序代码不得修改系统日历（写方法 403）
  const dav = decideDavOnPreviewHost({
    host: req.headers.get('host') ?? '',
    method,
    allowWrite: await davWriteAllowedOnPreviewHost(),
  });
  if (dav.action === 'deny') {
    return NextResponse.json({ success: false, error: dav.message }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = req.url;
  const headers: Record<string, string> = {};

  // Collect all headers
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Handle body for PUT/POST/REPORT/PROPFIND
  let body: string | undefined;
  if (['PUT', 'POST', 'PROPFIND', 'REPORT'].includes(method)) {
    try {
      body = await req.text();
    } catch {
      body = undefined;
    }
  }

  const response = await handleDavRequest({
    method,
    url,
    headers,
    body,
  });

  return new NextResponse(response.body || '', {
    status: response.status,
    headers: response.headers,
  });
}

/** GET /api/dav/* - serves as default handler for GET requests */
export async function GET(req: NextRequest) {
  return DavProxy(req);
}

/** POST /api/dav/* - serves POST requests */
export async function POST(req: NextRequest) {
  return DavProxy(req);
}

/** PUT /api/dav/* - serves PUT requests */
export async function PUT(req: NextRequest) {
  return DavProxy(req);
}

/** DELETE /api/dav/* - serves DELETE requests */
export async function DELETE(req: NextRequest) {
  return DavProxy(req);
}

/** PATCH /api/dav/* - serves PATCH requests (fallback) */
export async function PATCH(req: NextRequest) {
  return DavProxy(req);
}

/** OPTIONS /api/dav/* - serves OPTIONS requests */
export async function OPTIONS(req: NextRequest) {
  return DavProxy(req);
}

/** HEAD /api/dav/* - serves HEAD requests */
export async function HEAD(req: NextRequest) {
  return DavProxy(req);
}
