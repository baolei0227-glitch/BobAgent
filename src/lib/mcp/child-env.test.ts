/**
 * child-env 单测：插件启动层统一出口（工单《插件启动层统一》P0）
 *
 * 判据要点：本机 JS 插件（command=node）必须被改写到 Electron 内置 Node 运行时，
 * 且带上 ELECTRON_RUN_AS_NODE=1；其余命令（npx / 自定义）保持原样 —— 二者不能混。
 * 负向对照：若把 npx 也改写成 execPath，说明判定过宽（会劫持市场插件的 npm 语义）。
 */

import { describe, it, expect } from 'vitest';
import { resolveStdioRuntime } from './child-env';

describe('resolveStdioRuntime', () => {
  it('本机 JS 插件（command=node）改走 Electron 内置 Node，并注入 ELECTRON_RUN_AS_NODE', () => {
    const rt = resolveStdioRuntime('node');
    expect(rt.command).toBe(process.execPath);
    expect(rt.env.ELECTRON_RUN_AS_NODE).toBe('1');
    // 不能保留裸 'node'（否则仍会落到用户系统 PATH）
    expect(rt.command).not.toBe('node');
  });

  it('大小写不敏感地识别 node/node.exe', () => {
    expect(resolveStdioRuntime('Node').command).toBe(process.execPath);
    expect(resolveStdioRuntime('NODE.EXE').command).toBe(process.execPath);
  });

  it('npx 类市场插件原样保留（不劫持 npm 语义）', () => {
    const rt = resolveStdioRuntime('npx');
    expect(rt.command).toBe('npx');
    expect(rt.env).toEqual({});
  });

  it('未声明 command 时回退 npx（保持既有行为）', () => {
    expect(resolveStdioRuntime(undefined).command).toBe('npx');
    expect(resolveStdioRuntime('').command).toBe('npx');
  });

  it('自定义命令（python3 / 绝对路径）原样保留', () => {
    expect(resolveStdioRuntime('python3').command).toBe('python3');
    expect(resolveStdioRuntime('/opt/bin/mytool').command).toBe('/opt/bin/mytool');
  });
});
