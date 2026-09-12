/**
 * Agent 工具系统 — ocr 场景（独立 OCR / 图像 ROI 裁剪）
 *
 * 从 tools/index.ts 按 ToolScene 抽出，零行为变更。
 * 工具定义由 tools/index.ts 通过 `...ocrToolDefs` 聚合回 toolDefs。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { stat, mkdir } from 'fs/promises';
import { join } from 'path';
import type { Tool } from './index';
import { getProjectRootPath, resolvePath, truncate, OCR_MAX_LENGTH } from './shared';

const execFileAsync = promisify(execFile);

/** 独立 OCR 工具（ocr_document）：复用 ocr-service 引擎，返回文本 + 质量/勾稽元数据。
 *  聚焦纯 OCR（PDF/图片），不处理 docx/视频等附件类型。 */
async function toolOcrDocument(args: Record<string, unknown>): Promise<string> {
  const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
  if (!pathArg) return 'Error: path is required（文件路径必填）';
  try {
    const filePath = await resolvePath(pathArg);
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) return `Error: 文件不存在或不可读: ${pathArg}`;

    const { ocrFile } = await import('@/lib/pdf/ocr-service');
    // upgrade 参数透传给 bob-ocr-mcp：off=不升级（默认）；auto=质量低/勾稽异常自动升级；always=全部升级。
    // 仅 off/auto/always 合法，其余（含缺失）一律回退 off。
    const upgradeArg = typeof args.upgrade === 'string' ? args.upgrade.trim() : '';
    const upgrade = upgradeArg === 'auto' || upgradeArg === 'always' ? upgradeArg : 'off';
    const result = await ocrFile(filePath, { upgrade });
    if (!result.success) {
      return `Error: OCR 失败（${result.error ?? '未知原因'}）`;
    }

    const lines: string[] = [];
    // 附注（消除静默失败）：Online OCR 已配置但未生效等原因透传给 AI
    for (const note of result.notes ?? []) {
      lines.push(`[Note] ${note}`);
    }
    if (result.method === 'pdf-text') {
      lines.push(`OCR 结果（原生文本 PDF，共 ${result.pageCount} 页）`);
      lines.push(result.text);
    } else {
      const upgradedMeta = (result as { upgradedCount?: number }).upgradedCount ?? 0;
      lines.push(
        `OCR 结果（扫描件，共 ${result.pageCount} 页，仅识别辅助，原图保留）` +
          (upgradedMeta > 0 ? `，其中 ${upgradedMeta} 页采用在线模型升级` : ''),
      );
      for (const p of result.pages) {
        const meta = [
          `quality=${p.qualityScore.toFixed(2)}`,
          p.ledgerVerified >= 0 ? `勾稽=${p.ledgerVerified}行` : null,
          p.rotated ? '旋转表格已转置' : null,
          p.enhanced ? '图像增强' : null,
          p.upgraded
            ? `${p.upgradeChain === 'online-ocr' ? '在线OCR' : 'VLM'}(${p.upgradeModel ?? '模型未知'})`
            : null,
        ].filter(Boolean).join(', ');
        lines.push(`[Page ${p.index}]${meta ? `（${meta}）` : ''}\n${p.text.trim()}`);
      }
    }
    return truncate(lines.join('\n\n'), OCR_MAX_LENGTH);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 图像 ROI 裁剪（crop_image）：从整页图中裁出手写字段/印章区域，供后续单独喂 VLM 复核。
 *  治"反复整页重识别"的痛点：只对可疑 ROI 重试，不整页跑。 */
async function toolCropImage(args: Record<string, unknown>): Promise<string> {
  const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
  if (!pathArg) return 'Error: path is required（图片路径必填）';
  const bbox = Array.isArray(args.bbox) ? args.bbox.map(Number) : [];
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return 'Error: bbox 必须是 [x1,y1,x2,y2] 四个像素坐标（图片左上角为原点，x 向右、y 向下，x1<x2 且 y1<y2）';
  }
  const [x1, y1, x2, y2] = bbox;
  if (!(x1 < x2 && y1 < y2)) return 'Error: 无效 bbox，需满足 x1<x2 且 y1<y2';
  const margin = Math.max(0, Number(args.margin ?? 8)); // 外扩像素，避免裁掉笔画
  const scale = Math.max(1, Number(args.scale ?? 2));   // 放大倍率，便于 VLM 看清手写
  try {
    const filePath = await resolvePath(pathArg);
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) return `Error: 文件不存在或不可读: ${pathArg}`;
    // 输出到 homework/.crops/（隐藏中间产物目录：侧边栏与 Finder 均不可见，任务结束即清理）
    const outDir = join(await getProjectRootPath(), 'homework', '.crops');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `crop-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-c',
        `import json,sys;sys.path.insert(0,'src/lib/pdf/core');` +
          `from PIL import Image;` +
          `im=Image.open(sys.argv[1]);` +
          `w,h=im.size;` +
          `x1,y1,x2,y2=${x1},${y1},${x2},${y2};` +
          `m=${margin};` +
          `L=max(0,x1-m);T=max(0,y1-m);R=min(w,x2+m);B=min(h,y2+m);` +
          `crop=im.crop((L,T,R,B));` +
          `s=${scale};` +
          `crop=crop.resize((int(crop.width*s),int(crop.height*s)),Image.LANCZOS) if s!=1 else crop;` +
          `crop.save(sys.argv[2],format='PNG');` +
          `print(json.dumps({'w':w,'h':h,'crop':[L,T,R,B],'out':sys.argv[2]}))`,
        // 路径经 argv 传递（execFile 不经 shell）：空格/中文/特殊字符不再被 shell 拆词/转义破坏
        filePath,
        outPath,
      ],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout.trim()) as { w: number; h: number; crop: number[]; out: string };
    return [
      `ROI 裁剪完成：`,
      `  原图尺寸：${parsed.w} × ${parsed.h} px`,
      `  裁剪区域（含外扩 ${margin}px）：[${parsed.crop}]`,
      `  输出路径：${parsed.out}`,
      `下一步：把该路径传给 ocr_document / read_attachment 单独识别，或直接传给视觉模型复核该字段。`,
    ].join('\n');
  } catch (e) {
    return `Error: 裁剪失败（${e instanceof Error ? e.message : String(e)}）。请确认 Python + Pillow 可用、路径为图片文件。`;
  }
}

/** ocr 场景工具定义（由 tools/index.ts 聚合进 toolDefs） */
export const ocrToolDefs: Tool[] = [
  {
    name: 'ocr_document',
    description: 'OCR 识别（独立工具）：对 PDF 扫描件/图片做高质量文字识别，返回逐页文本 + qualityScore（0-1）+ ledgerVerified（流水勾稽）。【级联】印刷体默认走本地 macOS Vision（确定性、零成本），仅本地质量低（qualityScore<0.30）/文本为空/勾稽异常时自动升级 VLM。手写字段（姓名/身份证/日期）多次识别结果波动属正常——不要整页反复重试，改用 crop_image 裁可疑区域单独复核，或标注【需人工复核】。区别于 read_attachment：纯 OCR，不处理 docx/视频，返回精简且带质量元数据。传入 attachments/、homework/ 相对或绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径：attachments/{nodeId}/{filename}（项目内附件）、homework/ 相对路径或绝对路径。支持 PDF（扫描件自动 OCR）与图片（png/jpg/jpeg/gif/webp/bmp/tif）。',
        },
        upgrade: {
          type: 'string',
          enum: ['off', 'auto', 'always'],
          description: '可选，VLM 升级：off=纯本地（默认）；auto=本地质量低（qualityScore<0.30）/勾稽异常/文本为空时该页升级视觉大模型；always=全部走 VLM。auto/always 需在 Role Assignment 配置 Vision Model，未配置则静默退化为纯本地。',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolOcrDocument,
    maxOutput: 8000,
  },
  {
    name: 'crop_image',
    description: '图像 ROI 裁剪（中文）：从整页图裁出指定坐标区域（手写字段栏/印章/签名/日期），输出到 homework/.crops/（隐藏中间产物，任务结束清理）——用于扫描件"只对可疑区域单独复核"，避免整页反复重识别。传图片路径 + bbox=[x1,y1,x2,y2]（像素，原点左上，x 向右 y 向下，需 x1<x2 且 y1<y2）；可选 margin=外扩像素（默认 8）、scale=放大倍率（默认 2）。裁完把返回的输出路径交给 ocr_document / read_attachment / 视觉模型单独识别该字段。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '图片路径：attachments/{nodeId}/{filename}、homework/ 相对路径或绝对路径。',
        },
        bbox: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '裁剪区域 [x1,y1,x2,y2]（像素）。图片左上角为原点，x 向右、y 向下，需 x1<x2 且 y1<y2。',
        },
        margin: {
          type: 'number',
          description: '可选，外扩像素，默认 8，避免裁掉笔画边缘。',
        },
        scale: {
          type: 'number',
          description: '可选，放大倍率，默认 2，便于 VLM 看清手写小字。',
        },
      },
      required: ['path', 'bbox'],
    },
    category: '文件',
    execute: toolCropImage,
    maxOutput: 2000,
  },
];
