import { NextRequest } from 'next/server';
import { handleBridgeRequest } from '@/lib/sandbox/bridge';

/**
 * Bob Sandbox postMessage Bridge API
 *
 * POST /api/sandbox/bridge  { action, data }
 *
 * Called by the host window (CanvasFlow) when a sandbox iframe sends
 * a bob_request via postMessage. Executes the whitelisted action
 * server-side and returns the result.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? '');
    const data = (body?.data as Record<string, unknown>) || {};

    if (!action) {
      return Response.json({ success: false, error: 'action is required' }, { status: 400 });
    }

    const result = await handleBridgeRequest(action, data);
    return Response.json({ success: true, data: result });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
