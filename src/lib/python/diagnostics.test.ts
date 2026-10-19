/**
 * lib/python/diagnostics 单测
 *
 * 判据取向：**每条规则都要有反例**。
 * 只断言「认得出 ModuleNotFoundError」不足以证明这套诊断可用 ——
 * 一个「见谁都说是缺依赖」的实现也能让所有正向断言通过，而它的危害更大：
 * 它会把真正的脚本 bug 盖住，让用户去装一个本来就不缺的包。
 *
 * 另外：这些断言**必须在 Windows 上也能过**（同一份文件在 CI 的 windows-latest 上跑），
 * 所以不写死某平台的提示文案，只断言与平台无关的事实。
 */

import { describe, expect, it } from 'vitest';
import { IS_WIN } from '@/lib/platform';
import { describePythonFailure } from './diagnostics';

const errWithStderr = (stderr: string) => ({ code: 1, message: 'Command failed: python3 x.py', stderr });

describe('缺模块', () => {
  it('认出 Python 3 的 ModuleNotFoundError，并把导入名换成 pip 名', () => {
    const r = describePythonFailure(errWithStderr("ModuleNotFoundError: No module named 'docx'"));
    expect(r?.kind).toBe('missing-module');
    expect(r?.moduleName).toBe('docx');
    expect(r?.pipName).toBe('python-docx');
    expect(r?.hint).toContain('pip install python-docx');
  });

  it('导入名与 pip 名不同的都要映射（PIL→Pillow）', () => {
    const r = describePythonFailure("ImportError: No module named PIL");
    expect(r?.pipName).toBe('Pillow');
  });

  it('子模块取顶层名（lxml.etree → lxml）', () => {
    const r = describePythonFailure(errWithStderr("ModuleNotFoundError: No module named 'lxml.etree'"));
    expect(r?.moduleName).toBe('lxml');
    expect(r?.pipName).toBe('lxml');
  });

  it('不认识的模块回落同名，且不编造 pip 名', () => {
    const r = describePythonFailure("No module named 'some_private_lib'");
    expect(r?.pipName).toBe('some_private_lib');
  });

  it('stderr 是 Buffer 时也能读出来（execFile 的真实形态）', () => {
    const r = describePythonFailure({ stderr: Buffer.from("ModuleNotFoundError: No module named 'pptx'") });
    expect(r?.kind).toBe('missing-module');
    expect(r?.pipName).toBe('python-pptx');
  });

  it('usedBy 会出现在提示里，便于定位是哪条链路', () => {
    const r = describePythonFailure(errWithStderr("No module named 'docx'"), { usedBy: 'Word 修订处理' });
    expect(r?.hint).toContain('Word 修订处理');
  });
});

describe('缺解释器', () => {
  it('Windows cmd 的措辞（is not recognized）', () => {
    const r = describePythonFailure(
      errWithStderr("'python' is not recognized as an internal or external command,\r\noperable program or batch file."),
    );
    expect(r?.kind).toBe('missing-interpreter');
    expect(r?.hint).toContain('Python 解释器');
  });

  it('POSIX shell 的措辞（command not found）', () => {
    const r = describePythonFailure(errWithStderr('/bin/sh: python3: command not found'));
    expect(r?.kind).toBe('missing-interpreter');
  });

  it('Node 的 spawn ENOENT（不是脚本报错，是压根没起来）', () => {
    const r = describePythonFailure({ code: 'ENOENT', message: 'spawn python3 ENOENT' });
    expect(r?.kind).toBe('missing-interpreter');
  });
});

describe('编码 / 权限 / 语法', () => {
  it('GBK 编码错误要指向代码页，而不是「文件损坏」', () => {
    const r = describePythonFailure(errWithStderr("UnicodeEncodeError: 'gbk' codec can't encode character '\\u4e2d'"));
    expect(r?.kind).toBe('encoding');
    // 提示文案按平台分支（Windows 提 PYTHONUTF8 注入，POSIX 提 LANG）——
    // 所以这里只断言与平台无关的部分，再按当前平台断言分支内容。
    expect(r?.hint).toContain('编码');
    if (IS_WIN) expect(r?.hint).toContain('PYTHONUTF8');
    else expect(r?.hint).toContain('LANG');
  });

  it('PermissionError 归为权限问题', () => {
    const r = describePythonFailure(errWithStderr('PermissionError: [Errno 13] Permission denied'));
    expect(r?.kind).toBe('permission');
  });

  it('SyntaxError 指向解释器版本不匹配（而不是脚本写错了）', () => {
    const r = describePythonFailure(errWithStderr("SyntaxError: invalid syntax (x.py, line 3)"));
    expect(r?.kind).toBe('syntax');
  });
});

describe('反例：与 Python 环境无关的失败必须原样透出', () => {
  it('业务错误码不被当成环境问题', () => {
    expect(describePythonFailure({ ok: false, error: 'docxBase64 is required' })).toBeNull();
  });

  it('空错误返回 null（不要凭空造提示）', () => {
    expect(describePythonFailure(undefined)).toBeNull();
    expect(describePythonFailure(null)).toBeNull();
    expect(describePythonFailure('')).toBeNull();
    expect(describePythonFailure({})).toBeNull();
  });

  it('脚本自己打印的中文业务失败不算环境问题', () => {
    expect(describePythonFailure(errWithStderr('修订失败：找不到 w:ins 节点'))).toBeNull();
  });

  it('不相关的英文报错也不算', () => {
    expect(describePythonFailure(errWithStderr('KeyError: content_type'))).toBeNull();
  });
});
