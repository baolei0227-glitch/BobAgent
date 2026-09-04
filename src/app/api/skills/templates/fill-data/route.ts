/**
 * /api/skills/templates/fill-data — 模板填充「填写数据」保存（跟当前项目走）
 *
 * 存储位置：<项目>/homework/template/.fill-data/<scene>.json
 * （项目 homework/template/ 下隐藏目录，与生成产物 template-fill-* 批次目录隔离；
 *   模板库 GET 列表会跳过 . 开头目录，不影响场景列表）
 *
 * GET    ?scene=xxx    读取该场景已保存的填写数据（无则 data: null）
 * POST   { scene, rows }  保存 / 覆盖该场景填写数据（rows 为表格行数组）
 * DELETE ?scene=xxx    删除该场景已保存数据
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 场景名 → 安全文件名（替换路径非法字符，防目录穿越 / 跨场景串写） */
function safeSceneFile(scene: string): string {
  const s = scene.replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
  return s || 'untitled';
}

/** 填充数据文件路径：<项目>/homework/template/.fill-data/<scene>.json；无活跃项目返回 null */
async function fillDataLoc(scene: string): Promise<{ path: string; root: string } | null> {
  const project = await getCurrentProject();
  if (!project?.path) return null;
  const root = join(project.path, 'homework', 'template', '.fill-data');
  return { path: join(root, `${safeSceneFile(scene)}.json`), root };
}

export async function GET(request: NextRequest) {
  try {
    const scene = request.nextUrl.searchParams.get('scene') || '';
    if (!scene) return NextResponse.json({ success: false, error: 'scene is required' }, { status: 400 });
    const loc = await fillDataLoc(scene);
    if (!loc) return NextResponse.json({ success: false, error: 'No active project' }, { status: 400 });
    try {
      const raw = await fs.readFile(loc.path, 'utf-8');
      const parsed = JSON.parse(raw);
      return NextResponse.json({
        success: true,
        scene,
        data: {
          savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
          rows: Array.isArray(parsed.rows) ? parsed.rows : [],
          // 模板指纹：保存时的模板文件 + 字段列表，用于加载时校验是否仍匹配
          templateFiles: Array.isArray(parsed.templateFiles) ? parsed.templateFiles : [],
          fields: Array.isArray(parsed.fields) ? parsed.fields : [],
        },
      });
    } catch {
      // 文件不存在或损坏 → 视为无保存数据
      return NextResponse.json({ success: true, scene, data: null });
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scene, rows, templateFiles, fields } = body as {
      scene?: string;
      rows?: Record<string, string>[];
      templateFiles?: string[];
      fields?: string[];
    };
    if (!scene) return NextResponse.json({ success: false, error: 'scene is required' }, { status: 400 });
    if (!Array.isArray(rows)) return NextResponse.json({ success: false, error: 'rows must be an array' }, { status: 400 });
    const loc = await fillDataLoc(scene);
    if (!loc) return NextResponse.json({ success: false, error: 'No active project' }, { status: 400 });
    await fs.mkdir(loc.root, { recursive: true });
    const savedAt = new Date().toISOString();
    await fs.writeFile(
      loc.path,
      JSON.stringify(
        {
          scene,
          savedAt,
          rows,
          templateFiles: Array.isArray(templateFiles) ? templateFiles : [],
          fields: Array.isArray(fields) ? fields : [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    return NextResponse.json({ success: true, scene, savedAt });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const scene = request.nextUrl.searchParams.get('scene') || '';
    if (!scene) return NextResponse.json({ success: false, error: 'scene is required' }, { status: 400 });
    const loc = await fillDataLoc(scene);
    if (!loc) return NextResponse.json({ success: false, error: 'No active project' }, { status: 400 });
    try {
      await fs.unlink(loc.path);
    } catch {
      /* 文件不存在即视为已删除 */
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
