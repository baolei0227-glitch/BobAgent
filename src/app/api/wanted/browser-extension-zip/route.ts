/**
 * BobWork 内置「下载浏览器扩展」兜底端点
 *
 * 场景：Bob Browser MCP 的桥（127.0.0.1:9473）未运行时，扩展 zip 无法从桥的
 * /setup/extension.zip 获取。本端点从**已安装的 bob-browser-mcp 包**中读取
 * assets/extension 并实时打包返回——BobWork MCP 用户必然已全局安装该包
 * （stdio command 就是 bob-browser-mcp），因此面板上的 Download 不依赖桥运行。
 *
 * 定位方式：① `npm root -g` + 包名（npm 全局安装）；② `which bob-browser-mcp`
 * 解析 symlink 上溯到包根（pnpm / 其他包管理器）。
 */
import { NextRequest } from 'next/server';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { join, dirname } from 'path';

export const runtime = 'nodejs';

function locateExtensionDir(): string | null {
  const candidates: string[] = [];
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    if (root) candidates.push(join(root, 'bob-browser-mcp', 'assets', 'extension'));
  } catch {
    /* npm 不可用 */
  }
  try {
    const bin = execSync('which bob-browser-mcp', { encoding: 'utf8' }).trim();
    if (bin) {
      let real = bin;
      try {
        real = realpathSync(bin);
      } catch {
        /* 非 symlink */
      }
      // 从可执行文件上溯到包根（含 package.json 的目录）
      let cur = real;
      while (true) {
        if (existsSync(join(cur, 'package.json'))) {
          candidates.push(join(cur, 'assets', 'extension'));
          break;
        }
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
  } catch {
    /* 命令不存在 */
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function GET(_req: NextRequest) {
  const dir = locateExtensionDir();
  if (!dir) {
    return Response.json(
      { error: 'bob-browser-mcp 未安装，无法生成扩展包。请先全局安装：npm install -g bob-browser-mcp' },
      { status: 404 },
    );
  }
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(dir); // zip 内为扩展根（manifest.json 在根），解压后直接 Load unpacked
    const buf = zip.toBuffer();
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="bob-webbridge.zip"',
      },
    });
  } catch (e) {
    console.error('[browser-extension-zip] 打包失败:', e);
    return Response.json(
      { error: '扩展打包失败：' + (e instanceof Error ? e.message : String(e)) },
      { status: 500 },
    );
  }
}
