import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';

/** 生成与 lib/share-links.ts 同源的访问 Token（12 字节 base64url）。 */
function genToken(): string {
  return randomBytes(12).toString('base64url');
}

type Action = 'enable' | 'disable' | 'rotate' | 'setMode';

// 本路由由 server.ts 的远程访问网关保护：非本机无 Bearer 即 401，无法触达此处。
// 桌面端（loopback）可直接调用。

export async function GET() {
  try {
    const s = await readSettingsFromFile();
    const ra = s.remoteAccess ?? { enabled: false, token: '', mode: 'loopback-exempt' };
    return NextResponse.json({
      enabled: !!ra.enabled,
      token: ra.token || '',
      mode: ra.mode === 'strict' ? 'strict' : 'loopback-exempt',
    });
  } catch {
    return NextResponse.json({ enabled: false, token: '', mode: 'loopback-exempt' });
  }
}

export async function POST(req: NextRequest) {
  let body: { action?: Action; mode?: 'loopback-exempt' | 'strict' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid body' }, { status: 400 });
  }

  const action = body.action;
  if (!action || !['enable', 'disable', 'rotate', 'setMode'].includes(action)) {
    return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 });
  }

  try {
    const s = await readSettingsFromFile();
    const ra = {
      enabled: !!s.remoteAccess?.enabled,
      token: s.remoteAccess?.token || '',
      mode: s.remoteAccess?.mode === 'strict' ? ('strict' as const) : ('loopback-exempt' as const),
    };

    switch (action) {
      case 'enable':
        ra.enabled = true;
        if (!ra.token) ra.token = genToken();
        break;
      case 'disable':
        ra.enabled = false;
        // 保留 token，便于再次开启时不换密
        break;
      case 'rotate':
        ra.token = genToken();
        ra.enabled = true;
        break;
      case 'setMode':
        ra.mode = body.mode === 'strict' ? 'strict' : 'loopback-exempt';
        break;
    }

    s.remoteAccess = ra;
    await writeSettingsToFile(s);

    return NextResponse.json({
      success: true,
      enabled: ra.enabled,
      token: ra.token,
      mode: ra.mode,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message || 'write failed' },
      { status: 500 },
    );
  }
}
