import { NextRequest, NextResponse } from 'next/server';
import { getTextPresets, updateTextPresets } from '@/lib/settings';

export async function GET() {
  try {
    const presets = await getTextPresets();
    return NextResponse.json({ success: true, presets });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!Array.isArray(body.presets)) {
      return NextResponse.json({ success: false, error: 'presets array required' }, { status: 400 });
    }
    await updateTextPresets(body.presets);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
