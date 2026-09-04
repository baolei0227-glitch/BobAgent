import { NextRequest, NextResponse } from 'next/server';
import { resolveAppRoot, isDevIsolation } from '@/lib/app-root';

export async function GET(_req: NextRequest) {
  return NextResponse.json({
    success: true,
    app_root: resolveAppRoot(),
    isolation: isDevIsolation(),
    bobwork_home: process.env.BOBWORK_HOME || null,
    node_env: process.env.NODE_ENV || 'development',
  });
}
