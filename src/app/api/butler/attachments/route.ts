/**
 * Butler 附件上传 —— 落 **Butler 自己的存储空间**
 *
 * 与「节点对话附件」方案（POST /api/attachments）**刻意不复用**，两者形似而语义不同：
 *   - 节点方案：文件夹键 = `nodeId`（子目录 `{nodeId前4位}_{节点标题}`），落 `<项目>/materials/`
 *     或 `<项目>/attachments/`；生命周期绑画布节点（随节点删除回收），materials 一侧还会登记进
 *     项目材料 manifest 并参与 search_materials 正文检索；
 *   - 本端点：Butler 不是画布节点，**没有 nodeId**，也不属于任何「项目资料」语义，且同一份文件
 *     不该因为换了项目就失效。故按 **角色 + 日期**归档，落
 *     `<APP_ROOT>/butler/<角色名>/<YYYY-MM-DD>/attachments/`（角色名 = 会话人设 persona.name，
 *     未建会话时归「未分类」；路径真源见 lib/butler/storage.ts）——不进任何项目的材料 manifest、
 *     不参与正文检索。
 *
 * 模型怎么读到它：read_attachment 的路径解析在越出项目根时会走 isReadablePath 校验
 * （app/api/chat/tools/shared.ts），该校验对 **appRoot 全量放行**，butler/ 正在其内 ——
 * 所以本端点回传的是**绝对路径**。相对路径不行：read_attachment 会把相对路径解析到项目根下，
 * 必然落空（"路径不存在"硬错误）。
 *
 * 回传形态与 /api/attachments 保持一致（`attachment: { id, name, type, mimeType, size, path, dataUrl? }`），
 * 前端因此可以共用同一套 chip 渲染与「--- 资料列表 ---」拼装。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { basename, extname, join } from 'path';
import { roleDateDir } from '@/lib/butler/storage';
import { getAttachmentType } from '@/lib/files/attachment-type';
import type { MessageAttachment } from '@/lib/types';

export const maxDuration = 60;

/** 与 /api/attachments 同档（500MB） */
const MAX_SIZE = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      threadId?: string;
      fileName?: string;
      fileType?: string;
      data?: string;
    };

    const fileName = typeof body.fileName === 'string' ? body.fileName : '';
    const base64 = typeof body.data === 'string' ? body.data : '';
    if (!fileName || !base64) {
      return NextResponse.json({ error: 'fileName and data are required' }, { status: 400 });
    }

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const fileType = body.fileType || 'application/octet-stream';
    // 服务端自行按 threadId 解析角色，再按上传日归档（协议不变：客户端只传 threadId）
    const dir = join(await roleDateDir(body.threadId, new Date()), 'attachments');
    await fs.mkdir(dir, { recursive: true });

    const safeName = basename(fileName).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const ext = extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);

    // 同名冲突加数字后缀，如 name.ext -> name (1).ext（同一天传两次同名文件不覆盖）
    let destName = safeName;
    let counter = 1;
    while (true) {
      try {
        await fs.access(join(dir, destName));
        destName = `${stem} (${counter})${ext}`;
        counter++;
      } catch {
        break;
      }
    }

    const filePath = join(dir, destName);
    await fs.writeFile(filePath, buffer);

    // 小文件附 dataUrl（与节点方案一致：前端做缩略图/预览时不必再跑一次 GET）
    let dataUrl: string | undefined;
    if (buffer.length < 2 * 1024 * 1024) {
      dataUrl = `data:${fileType};base64,${base64}`;
    }

    const attachment: MessageAttachment = {
      id: destName,
      name: fileName,
      type: getAttachmentType(fileType, fileName),
      mimeType: fileType,
      size: buffer.length,
      // 绝对路径：read_attachment 靠 isReadablePath 的 appRoot 全量放行读到它
      path: filePath,
      dataUrl,
    };
    return NextResponse.json({ success: true, attachment });
  } catch (e) {
    console.error('[butler/attachments] 上传失败:', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}