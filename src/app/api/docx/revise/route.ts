/**
 * docx OOXML 修订 API：生成修订标记 / 接受拒绝 / 修订清单
 *
 * POST /api/docx/revise
 * body: {
 *   mode: 'apply' | 'resolve' | 'inspect',
 *   docxBase64: string,            // 原始 docx（base64）
 *   ops?: ReviseOp[],              // apply 模式
 *   decisions?: {id: string; accept: boolean}[], // resolve 模式
 *   author?: string, date?: string // apply 模式（作者署名）
 * }
 * 返回: { ok, docxBase64?, ins, del, total, revisions?, results?, accepted?, rejected?, error? }
 *
 * 底层调用 src/lib/docx/ooxml-revise.py（python-docx + lxml），与合同修订通道同一套 OOXML 机制。
 */
import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { accessSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pythonBin } from '@/lib/platform';

const execFileAsync = promisify(execFile);

export const runtime = 'nodejs';

interface ReviseOp {
  type: 'replace_paragraph' | 'replace_text' | 'insert_paragraph_after' | 'replace_table_cell';
  locate: Record<string, unknown>;
  new?: string;
  label?: string;
}

interface ReviseResponse {
  ok: boolean;
  docxBase64?: string;
  ins?: number;
  del?: number;
  total?: number;
  revisions?: Array<{ id: string; kind: string; text: string; author?: string; date?: string }>;
  results?: Array<{ ok: boolean; label: string; error?: string }>;
  accepted?: number;
  rejected?: number;
  error?: string;
}

/**
 * Python 解释器：走平台解析（darwin 仍为 /usr/bin/python3；Windows 取随包内置运行时）。
 * 缺失时抛可读错误，而不是让 execFile 报 ENOENT。
 */
function pythonInterpreter(): string {
  return pythonBin('Word 修订处理');
}

/**
 * 脚本路径：standalone 模式（next-standalone/scripts/ooxml-revise.py，由构建脚本复制）优先；
 * dev 模式回退 src/lib/docx/ooxml-revise.py。
 */
function resolveScript(): string {
  const standalone = join(process.cwd(), 'scripts', 'ooxml-revise.py');
  try {
    accessSync(standalone);
    return standalone;
  } catch { /* 回退 dev 路径 */ }
  return join(process.cwd(), 'src', 'lib', 'docx', 'ooxml-revise.py');
}

function cleanBase64(input: string): string {
  // 兼容 dataURL（data:...;base64,xxx）与纯 base64
  const idx = input.indexOf('base64,');
  return idx >= 0 ? input.slice(idx + 7) : input;
}

async function runRevise(mode: string, docxPath: string, outPath: string | null, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args = [resolveScript(), '--mode', mode, '--input', docxPath];
  if (outPath) args.push('--output', outPath);
  args.push('--payload', JSON.stringify(payload));
  const { stdout } = await execFileAsync(pythonInterpreter(), args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout || '{}') as Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  let workDir: string | null = null;
  try {
    const body = (await request.json()) as {
      mode?: string;
      docxBase64?: string;
      ops?: ReviseOp[];
      decisions?: Array<{ id: string; accept: boolean }>;
      author?: string;
      date?: string;
    };
    const mode = body.mode || 'apply';
    if (!body.docxBase64) {
      return NextResponse.json({ ok: false, error: 'docxBase64 is required' } as ReviseResponse, { status: 400 });
    }

    workDir = await mkdtemp(join(tmpdir(), 'bob-docx-'));
    const inPath = join(workDir, 'input.docx');
    const outPath = join(workDir, 'output.docx');
    await writeFile(inPath, Buffer.from(cleanBase64(body.docxBase64), 'base64'));

    let res: Record<string, unknown>;
    if (mode === 'inspect') {
      res = await runRevise('inspect', inPath, null, {});
    } else if (mode === 'apply') {
      if (!Array.isArray(body.ops)) {
        return NextResponse.json({ ok: false, error: 'ops is required for apply mode' } as ReviseResponse, { status: 400 });
      }
      res = await runRevise('apply', inPath, outPath, {
        ops: body.ops,
        author: body.author || 'BobWork',
        date: body.date,
      });
    } else if (mode === 'resolve') {
      if (!Array.isArray(body.decisions)) {
        return NextResponse.json({ ok: false, error: 'decisions is required for resolve mode' } as ReviseResponse, { status: 400 });
      }
      res = await runRevise('resolve', inPath, outPath, { decisions: body.decisions });
    } else {
      return NextResponse.json({ ok: false, error: `unknown mode: ${mode}` } as ReviseResponse, { status: 400 });
    }

    if (res.ok !== true) {
      return NextResponse.json({ ok: false, error: String(res.error || 'OOXML 修订失败') } as ReviseResponse, { status: 500 });
    }

    const response: ReviseResponse = {
      ok: true,
      ins: res.ins as number,
      del: res.del as number,
      total: res.total as number,
      revisions: res.revisions as ReviseResponse['revisions'],
      results: res.results as ReviseResponse['results'],
      accepted: res.accepted as number | undefined,
      rejected: res.rejected as number | undefined,
    };
    if (mode !== 'inspect') {
      const outBuf = await readFile(outPath);
      response.docxBase64 = outBuf.toString('base64');
    }
    return NextResponse.json(response);
  } catch (e) {
    console.error('[docx/revise] failed:', e);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg } as ReviseResponse, { status: 500 });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}
