import { NextResponse } from 'next/server';
import { getCalendarDb, getOrCreateFeedToken, rotateFeedToken } from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 无当前项目时的占位 project_id（日历与项目独立） */
const GLOBAL_PROJECT_ID = '__global__';

async function getDb() {
  return await getCalendarDb();
}

/** 取当前项目 id 作为订阅归属（纯展示归属）；无项目时用占位 */
async function safeProjectId(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.id;
  } catch {
    return GLOBAL_PROJECT_ID;
  }
}

/** GET /api/calendar/feed → 返回订阅 token（自动创建；token 存全局日历库） */
export async function GET() {
  try {
    const db = await getDb();
    const projectId = await safeProjectId();
    const token = await getOrCreateFeedToken(db, projectId);
    return NextResponse.json({ ok: true, token });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Failed' }, { status: 500 });
  }
}

/** POST /api/calendar/feed → 旋转（吊销旧链接并生成新 token） */
export async function POST() {
  try {
    const db = await getDb();
    const projectId = await safeProjectId();
    const token = await rotateFeedToken(db, projectId);
    return NextResponse.json({ ok: true, token });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Failed' }, { status: 500 });
  }
}
