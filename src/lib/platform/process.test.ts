/**
 * 平台进程层单测。
 *
 * 判据取向（沿用 platform.test.ts 的约定）：
 *   1. 每条解析器都用**另一平台的真实输出样例**驱动 —— Windows 分支在 mac 上不可能真跑，
 *      只能靠样例输出证明「它能从 Windows 的格式里解析出 pid」；
 *   2. 必须带**反例**：不同端口 / 不同状态 / 不同命令行不得命中。
 *      只断言「正向能解析」的实现，即使把端口判断整个删掉也能通过。
 */
import { describe, expect, it } from 'vitest';
import {
  cimCommandLineQueryScript,
  encodePowershell,
  filterCimByCommandLine,
  parseCimProcessJson,
  parseListeningPids,
  parseLsofCwdPids,
  parseLsofPids,
  parseNetstatListenPids,
  parsePsByCommandPrefix,
  parseSinglePid,
  systemExe,
} from './process';

describe('lsof 输出解析', () => {
  it('一行一个 pid，去重保序', () => {
    expect(parseLsofPids('8876\n8876\n9\n')).toEqual([8876, 9]);
  });

  it('空输出与非数字行不产生 pid（lsof 未安装/无权限时 stdout 为空）', () => {
    expect(parseLsofPids('')).toEqual([]);
    expect(parseLsofPids('lsof: command not found\n')).toEqual([]);
    expect(parseLsofPids('   \n')).toEqual([]);
  });
});

describe('netstat 输出解析（Windows 真实样例）', () => {
  // 中文 Windows 的表头是中文，但状态列恒为英文 —— 这正是不该按表头解析的原因
  const sample = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
    '  TCP    0.0.0.0:8321           0.0.0.0:0              LISTENING       8876',
    '  TCP    [::]:8321              [::]:0                 LISTENING       8876',
    '  TCP    127.0.0.1:8321         127.0.0.1:51820        ESTABLISHED     4321',
    '  TCP    0.0.0.0:18321          0.0.0.0:0              LISTENING       7777',
    '  UDP    0.0.0.0:8321           *:*                                    5555',
    '',
  ].join('\r\n');

  it('IPv4 + IPv6 双栈只算一个 pid', () => {
    const { pids } = parseNetstatListenPids(sample, 8321);
    expect(pids).toEqual([8876]);
  });

  it('反例：占用了「后缀相同」的其它端口不得命中', () => {
    const { pids } = parseNetstatListenPids(sample, 8321);
    expect(pids).not.toContain(7777); // 18321
    expect(pids).not.toContain(1024); // 135
  });

  it('非 LISTENING 状态不返回，但状态词要留下（供「一个都没杀到」时打日志）', () => {
    const { pids, otherStates } = parseNetstatListenPids(sample, 8321);
    expect(pids).not.toContain(4321); // ESTABLISHED：出站连接恰好用了同名本地端口
    expect(otherStates).toContain('ESTABLISHED');
  });

  it('UDP 行不参与（无监听语义）', () => {
    const { pids } = parseNetstatListenPids(sample, 8321);
    expect(pids).not.toContain(5555);
  });

  it('端口查不到时返回空', () => {
    expect(parseNetstatListenPids(sample, 65000)).toEqual({ pids: [], otherStates: [] });
  });
});

describe('ps / lsof cwd 输出解析（darwin 判据）', () => {
  const psOut = [
    '    1 /sbin/launchd',
    '  340 next-server (v15.5.0)',
    '  341 node /Applications/BobWork.app/Contents/Resources/next-standalone/server.js',
    '  342 next-server-not-really',
  ].join('\n');

  it('只匹配进程标题以 next-server 开头者（命令行无路径，不能用路径匹配）', () => {
    expect(parsePsByCommandPrefix(psOut, 'next-server')).toEqual([340, 342]);
  });

  it('反例：命令行里带 next-standalone 的 node 进程不在初筛结果里', () => {
    expect(parsePsByCommandPrefix(psOut, 'next-server')).not.toContain(341);
  });

  it('cwd 二次确认只认可命中 needle 的行', () => {
    const lsofOut = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'next-server 340 baolei cwd DIR 1,15 4160 123 /Applications/BobWork.app/Contents/Resources/next-standalone',
      'next-server 342 baolei cwd DIR 1,15 4160 124 /Users/baolei/other/next-standalone-like',
    ].join('\n');
    expect(parseLsofCwdPids(lsofOut, '/Resources/next-standalone')).toEqual([340]);
  });
});

describe('CIM(Windows) 输出解析', () => {
  it('单个对象时 PowerShell 输出 {...} 而不是 [...]，不能直接 .map', () => {
    const one = JSON.stringify({
      ProcessId: 8876,
      ParentProcessId: 1000,
      ExecutablePath: 'C:\\Program Files\\BobWork\\BobWork.exe',
      CommandLine: '"C:\\Program Files\\BobWork\\BobWork.exe" --max-old-space-size=1024 C:\\Program Files\\BobWork\\resources\\next-standalone\\server.js',
    });
    expect(parseCimProcessJson(one)).toHaveLength(1);
  });

  it('数组形式与空输出', () => {
    const arr = JSON.stringify([{ ProcessId: 1 }, { ProcessId: 2 }]);
    expect(parseCimProcessJson(arr).map((p) => p.ProcessId)).toEqual([1, 2]);
    expect(parseCimProcessJson('')).toEqual([]);
    expect(parseCimProcessJson('not json')).toEqual([]);
  });

  it('按 CommandLine 匹配并排除自身', () => {
    const list = parseCimProcessJson(
      JSON.stringify([
        { ProcessId: process.pid, CommandLine: 'x\\next-standalone\\server.js' },
        { ProcessId: 4242, CommandLine: 'C:\\BobWork\\resources\\next-standalone\\server.js' },
        { ProcessId: 4243, CommandLine: 'C:\\Other\\app.js' },
        { ProcessId: 4244, CommandLine: null },
      ]),
    );
    expect(filterCimByCommandLine(list, 'next-standalone')).toEqual([4242]);
  });
});

describe('单值 pid 解析', () => {
  it('ps -o ppid= 输出带空白也要能取到', () => {
    expect(parseSinglePid('  12345\n')).toBe(12345);
  });

  it('反例：空 / 0 / 非法', () => {
    expect(parseSinglePid('')).toBeNull();
    expect(parseSinglePid('0')).toBeNull();
    expect(parseSinglePid('abc')).toBeNull();
    expect(parseSinglePid('-1')).toBeNull();
  });
});

describe('命令构造', () => {
  it('端口探测按平台分派（darwin 保持历史实现）', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fake = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return { ok: true, stdout: '8876\n' };
    };

    const darwin = parseListeningPids('darwin', 8321, fake);
    expect(calls[0]).toEqual({ cmd: '/usr/sbin/lsof', args: ['-tiTCP:8321', '-sTCP:LISTEN'] });
    expect(darwin.pids).toEqual([8876]);

    calls.length = 0;
    parseListeningPids('win32', 8321, fake);
    expect(calls[0].cmd).toMatch(/System32[\\/]netstat\.exe$/);
    expect(calls[0].args).toEqual(['-ano', '-p', 'tcp']);
  });

  it('System32 绝对路径不依赖 PATH', () => {
    const env = { SystemRoot: 'D:\\Win', windir: 'C:\\Windows' } as unknown as NodeJS.ProcessEnv;
    expect(systemExe('taskkill.exe', env, 'win32')).toBe('D:\\Win\\System32\\taskkill.exe');
  });

  it('PowerShell 用 -EncodedCommand：脚本文本可完整还原（含中文与引号）', () => {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*next-standalone*' } 中文";
    const b64 = encodePowershell(script);
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe(script);
  });

  it('查询脚本对单引号做 PowerShell 转义', () => {
    expect(cimCommandLineQueryScript("a'b")).toContain("'*a''b*'");
  });
});
