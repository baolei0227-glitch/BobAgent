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
  PS_EXIT_NOT_FOUND,
  cimCommandLineQueryScript,
  cimParentPidScript,
  describeExecFailure,
  encodePowershell,
  filterCimByCommandLine,
  interpretPidQuery,
  isRetryableExecFailure,
  parseCimProcessJson,
  parseListeningPids,
  parseLsofCwdPids,
  parseLsofPids,
  parseNetstatListenPids,
  parsePsByCommandPrefix,
  parseSinglePid,
  systemExe,
  withParentPidRetry,
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

  // 这条脚本是「CI 红灯无法归因」的根因所在：早期版本用 SilentlyContinue 把 WMI 报错
  // 吞成空输出，与「进程不存在」不可区分。下面三条断言锁住修复后的三个契约。
  it('ppid 脚本不再 SilentlyContinue（否则错误与空结果不可区分）', () => {
    expect(cimParentPidScript(9480)).not.toContain('SilentlyContinue');
    expect(cimParentPidScript(9480)).toContain("-ErrorAction Stop");
  });

  it('ppid 脚本用专用退出码表示「进程不存在」', () => {
    expect(cimParentPidScript(9480)).toContain(`exit ${PS_EXIT_NOT_FOUND}`);
  });

  it('ppid 脚本把 WMI 报错写进 stderr（Node 侧才能读到原文）', () => {
    const s = cimParentPidScript(9480);
    expect(s).toContain('[Console]::Error.WriteLine');
    expect(s).toContain('ProcessId=9480');
  });
});

// 真机上「父 pid 查询偶发失败」的根因无法在 mac 上复现，但**重试判据**必须能单测：
// 只有通道失败（error !== null）才重试；「进程不在了」重试没有意义。
// 这段是本次「CI 红灯无法归因」的根因修复：退出码必须先被翻译成三态，
// 否则「进程不存在」与「WMI 拒绝访问」在 Node 侧长得一模一样。
describe('ppid 查询结果翻译（退出码 → 三态）', () => {
  it('专用「不存在」退出码 = 合法结论（不是通道故障，不重试）', () => {
    const r = interpretPidQuery({ code: PS_EXIT_NOT_FOUND }, '', '', [PS_EXIT_NOT_FOUND]);
    expect(r).toEqual({ pid: null, error: null });
  });

  it('POSIX 的 ps 用退出码 1 表示进程已退出', () => {
    expect(interpretPidQuery({ code: 1 }, '', '', [1])).toEqual({ pid: null, error: null });
  });

  it('别的非零退出码 = 通道故障，且正文要带上 stderr', () => {
    const r = interpretPidQuery({ code: 1 }, '', 'CIMERR: Access denied', [PS_EXIT_NOT_FOUND]);
    expect(r.pid).toBeNull();
    expect(r.error).toContain('Access denied');
  });

  it('退出码 0 但输出不是数字：按通道故障处理（不能当成「进程不在」）', () => {
    const r = interpretPidQuery(null, 'garbage', '', [PS_EXIT_NOT_FOUND]);
    expect(r.pid).toBeNull();
    expect(r.error).toContain('输出无法解析为 pid');
  });

  it('退出码 0 + 正常数字 = 成功', () => {
    expect(interpretPidQuery(null, '  9480', '', [PS_EXIT_NOT_FOUND])).toEqual({ pid: 9480, error: null });
  });

  it('spawn 层的字符串 code 不可重试（确定性失败），数字退出码可重试', () => {
    expect(isRetryableExecFailure({ code: 'ENOENT' })).toBe(false);
    expect(isRetryableExecFailure({ code: 'EPERM' })).toBe(false);
    expect(isRetryableExecFailure({ code: 1 })).toBe(true);
    expect(isRetryableExecFailure({ killed: true })).toBe(true);
  });
});

describe('父 pid 探测重试', () => {
  const noSleep = () => Promise.resolve();

  it('通道失败后重试成功：attempts 记录第几次成功', async () => {
    let n = 0;
    const r = await withParentPidRetry(
      async () => {
        n += 1;
        return n === 1 ? { pid: null, error: 'code=ENOENT' } : { pid: 42, error: null };
      },
      { sleep: noSleep },
    );
    expect(r).toEqual({ pid: 42, error: null, attempts: 2 });
  });

  it('「进程确实不在了」不重试（否则每次启动都被拖慢 N 倍）', async () => {
    let n = 0;
    const r = await withParentPidRetry(
      async () => {
        n += 1;
        return { pid: null, error: null };
      },
      { sleep: noSleep },
    );
    expect(r).toEqual({ pid: null, error: null, attempts: 1 });
    expect(n).toBe(1);
  });

  it('全部失败时保留最后一次原因，且不超过上限次数', async () => {
    const errors: string[] = [];
    let n = 0;
    const r = await withParentPidRetry(
      async () => {
        n += 1;
        const error = `第 ${n} 次失败`;
        errors.push(error);
        return { pid: null, error };
      },
      { sleep: noSleep },
    );
    expect(n).toBe(3);
    expect(r.attempts).toBe(3);
    expect(r.error).toBe('第 3 次失败');
    expect(errors).toHaveLength(3);
  });

  it('反例：成功路径一次 sleep 都不该发生', async () => {
    const sleeps: number[] = [];
    await withParentPidRetry(async () => ({ pid: 7, error: null }), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([]);
  });

  it('退避次数 = 失败次数 - 1（3 次尝试只睡 2 次）', async () => {
    const sleeps: number[] = [];
    await withParentPidRetry(async () => ({ pid: null, error: 'boom' }), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([200, 500]);
  });

  it('标记为不可重试的失败只尝试一次（确定性失败重试只会让启动变慢）', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withParentPidRetry(
      async () => {
        n += 1;
        return { pid: null, error: 'code=ENOENT', retryable: false };
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(n).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.error).toBe('code=ENOENT');
    expect(sleeps).toEqual([]);
  });
});

describe('execFile 失败原因', () => {
  it('超时被杀要说「超时」，不能说成 spawn 失败', () => {
    expect(describeExecFailure({ killed: true, signal: 'SIGTERM' })).toBe('超时被杀（signal=SIGTERM）');
  });

  it('stderr 原文优先于 message（PowerShell 的报错在 stderr 里）', () => {
    const s = describeExecFailure(
      { code: '1', message: 'Command failed: powershell.exe -EncodedCommand AAAA…' },
      'Get-CimInstance : 拒绝访问\r\n',
    );
    expect(s).toContain('code=1');
    expect(s).toContain('拒绝访问');
    expect(s).not.toContain('EncodedCommand');
  });

  it('没有 stderr 时退回 code（ENOENT = 机器上根本没有 PowerShell）', () => {
    expect(describeExecFailure({ code: 'ENOENT' })).toBe('code=ENOENT');
  });

  it('超长 stderr 截断，避免一条 annotation 被撑爆', () => {
    expect(describeExecFailure({ code: '1' }, 'x'.repeat(2000)).length).toBeLessThanOrEqual(330);
  });
});
