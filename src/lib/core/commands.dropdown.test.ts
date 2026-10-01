import { describe, expect, it } from 'vitest';
import {
  BUTLER_COMMANDS,
  buildCommandTextAtLine,
  filterCommands,
  getLineAtCursor,
  hasCommandIntent,
  parseCommandToken,
} from '@/lib/core/commands';

/**
 * `/` 指令下拉所依赖的纯逻辑（Butler 抽屉渲染；画布 `UnifiedPalette` 的指令态已于 P1-c 移除）。
 *
 * 背景：输入框靠这四个函数决定「要不要展开下拉」与
 * 「选中后把 `/keyword` 注入到哪一行、光标落在哪」。这些是**纯函数**，
 * 但一旦算错就是静默错位（注入到别的行 / 光标跑到行首 / 覆盖掉已有内容），
 * 所以在这里锁住。UI 形态（抽屉底栏向上展开）不在此文件范围。
 */
describe('hasCommandIntent —— 是否该展开下拉', () => {
  it('行首是 / 才展开（允许前导空白）', () => {
    expect(hasCommandIntent('/todo 买牛奶')).toBe(true);
    expect(hasCommandIntent('/')).toBe(true);
    expect(hasCommandIntent('   /note 记一条')).toBe(true);
  });

  it('行中出现 / 不算指令（避免 URL、中文里夹的斜杠误触）', () => {
    expect(hasCommandIntent('去 https://example.com/docs')).toBe(false);
    expect(hasCommandIntent('问一下/todo 怎么用')).toBe(false);
    expect(hasCommandIntent('')).toBe(false);
  });

  it('已知误判面：/tmp 这类路径会被判为「指令意图」——靠候选为空来兜住', () => {
    // 纯文本判据分不清「指令」与「绝对路径」，所以 hasCommandIntent 会返回 true；
    // 但 UI 端还有一道 `候选.length > 0` 的闸门，而 filterCommands('/tmp') 为空 ⇒ 不会弹下拉。
    expect(hasCommandIntent('/tmp 下的文件')).toBe(true);
    expect(filterCommands('/tmp')).toEqual([]);
  });
});

describe('filterCommands —— 候选列表', () => {
  it('只输入 / 时列出**全部**指令（这是「所有命令一个下拉」的前提）', () => {
    expect(filterCommands('/').map((c) => c.keyword)).toEqual(BUTLER_COMMANDS.map((c) => c.keyword));
    expect(filterCommands('')).toHaveLength(BUTLER_COMMANDS.length);
  });

  it('按已输入 token 前缀过滤', () => {
    expect(filterCommands('/to').map((c) => c.keyword)).toEqual(['todo']);
    expect(filterCommands('/n').map((c) => c.keyword)).toEqual(['note']);
    expect(filterCommands('/zzz')).toEqual([]);
  });

  it('传 usage 时按使用次数降序；同频保持注册表顺序（不能因排序抖动）', () => {
    const out = filterCommands('/', { help: 9, notebook: 9 }).map((c) => c.keyword);
    // note（id=notebook，注册表第 2）早于 help（最后），同频时保持该相对顺序
    expect(out.slice(0, 2)).toEqual(['note', 'help']);
    expect(out.slice(2)).toEqual(['todo', 'meeting', 'inspect']);
  });
});

describe('parseCommandToken —— 已输入多少', () => {
  it('取 / 后到空白为止并小写化', () => {
    expect(parseCommandToken('/todo')).toBe('todo');
    expect(parseCommandToken('/TO')).toBe('to');
    expect(parseCommandToken('/todo 买牛奶')).toBe('todo');
    expect(parseCommandToken('随便写的')).toBe('');
  });
});

describe('getLineAtCursor —— 定位光标所在行', () => {
  const first = '/note 写合同';
  const second = '/to';
  const text = `${first}\n${second}`;

  it('多行文本里定位到正确的一行（含行首偏移）', () => {
    expect(getLineAtCursor(text, 0)).toEqual({ lineText: first, lineStart: 0, lineEnd: first.length });
    expect(getLineAtCursor(text, text.length)).toEqual({
      lineText: second,
      lineStart: first.length + 1,
      lineEnd: text.length,
    });
  });

  it('越界位置被夹紧，不抛错', () => {
    expect(getLineAtCursor(text, 9999).lineText).toBe(second);
    expect(getLineAtCursor(text, -5).lineText).toBe(first);
  });
});

describe('buildCommandTextAtLine —— 增量注入 /keyword', () => {
  it('补全当前行并给出行内新光标（紧跟指令之后，便于接着写内容）', () => {
    expect(buildCommandTextAtLine('/to', 3, 'todo')).toEqual({ text: '/todo', caret: 5 });
  });

  it('保留该行已有的任务内容，不覆盖', () => {
    const { text } = buildCommandTextAtLine('/to 买牛奶', 3, 'todo');
    expect(text).toBe('/todo 买牛奶');
  });

  it('换指令时**只改光标所在行**，其余行原样不动（多行 shift+enter 场景）', () => {
    const first = '/note 写合同';
    const text = `${first}\n/to`;
    const { text: out, caret } = buildCommandTextAtLine(text, text.length, 'todo');
    expect(out).toBe(`${first}\n/todo`);
    expect(caret).toBe(first.length + 1 + '/todo'.length);
  });

  it('注入结果必须仍能被指令路由命中（否则发送时找不到指令）', () => {
    const { text } = buildCommandTextAtLine('/me', 3, 'meeting');
    expect(/^\/meeting\b/.test(text)).toBe(true);
  });
});
