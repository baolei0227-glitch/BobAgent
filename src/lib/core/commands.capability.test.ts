import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  BUTLER_COMMANDS,
  buildHelpText,
  detectCommand,
  filterCommands,
  normalizeSlashInput,
} from '@/lib/core/commands';

/**
 * 斜杠命令 = 管家能力别名（P0 统一入口）的不变量。
 *
 * 设计（见 .trae/documents/Butler统一入口与斜杠命令体系_*.md）：
 *   · BUTLER_COMMANDS 是**唯一真源**，五处派生：入口归一化 / 提示词注入 / /help 文本 /
 *     `/` 下拉（filterCommands）/ 微信欢迎语（buildHelpText）。
 *   · 入口只做**翻译**（normalizeSlashInput：`/todo X` → 「意图：…」X），不执行；
 *     管家据注入的命令表调用自己手里的工具。
 *
 * 本用例锁住：归一化的输入/输出契约、未命中命令的原样透传、以及各派生点确由真源驱动。
 */
describe('斜杠命令归一化（入口只翻译，不执行）', () => {
  it('命中命令：剥前缀 + 前置意图标签，正文原样保留', () => {
    const out = normalizeSlashInput('/todo 今天下午六点开会，讨论产品开发');
    expect(out).not.toContain('/todo');
    expect(out.startsWith('「意图：')).toBe(true);
    expect(out).toContain('今天下午六点开会，讨论产品开发');
    // 意图标签取自真源（不是硬编码副本）
    expect(out).toContain(detectCommand('/todo')!.intent);
  });

  it('只发命令名（无正文）：提示按该意图回应或追问', () => {
    for (const keyword of ['todo', 'help', 'inspect']) {
      const out = normalizeSlashInput(`/${keyword}`);
      expect(out.startsWith('「意图：'), keyword).toBe(true);
      expect(out, keyword).toContain('没有正文');
    }
  });

  it('未命中命令（/foo）与纯文本：原样透传，交由管家如实告知不存在', () => {
    expect(normalizeSlashInput('/foo 随便写点')).toBe('/foo 随便写点');
    expect(normalizeSlashInput('今天天气怎么样')).toBe('今天天气怎么样');
  });

  it('每条命令都有非空 intent（注入文本依赖它做意图路由）', () => {
    for (const c of BUTLER_COMMANDS) {
      expect(c.intent.trim().length, c.keyword).toBeGreaterThan(0);
    }
  });

  it('P2 收敛后 capability 集合：/clip 并入 /note raw、/chat 退役，管家手里的命令全有承接', () => {
    const withCap = new Set(BUTLER_COMMANDS.filter((c) => c.capability).map((c) => c.keyword));
    expect([...withCap].sort()).toEqual(['help', 'inspect', 'meeting', 'note', 'todo']);
    // /clip 已退役：命令族收进 /note（/note raw），注册表不再有独立条目
    expect(BUTLER_COMMANDS.some((c) => c.keyword === 'clip')).toBe(false);
    // /chat 已退役：统一入口后纯文本直连管家同一 agent，该命令只剩同义反复的意图前缀
    expect(BUTLER_COMMANDS.some((c) => c.keyword === 'chat')).toBe(false);
    expect(detectCommand('/chat 写一份合同')).toBeNull();
    expect(detectCommand('/note')!.description).toContain('/note raw');
    // /meeting 自 P1-b 工具化：承接能力是管家的会议三件套（会议缓冲是进程内会话状态）
    expect(detectCommand('/meeting')!.capability).toContain('meeting_start');
    expect(detectCommand('/meeting')!.capability).toContain('meeting_end');
  });
});

describe('派生点同源（改一处真源，五处自动跟随）', () => {
  it('/help 文本覆盖全部命令（微信欢迎语复用同一函数）', () => {
    const help = buildHelpText();
    for (const c of BUTLER_COMMANDS) {
      expect(help, c.keyword).toContain(`/${c.keyword}`);
    }
  });

  it('`/` 下拉候选来自真源（前缀过滤生效）', () => {
    expect(filterCommands('/to').map((c) => c.keyword)).toEqual(['todo']);
    expect(filterCommands('/').length).toBe(BUTLER_COMMANDS.length);
  });
});

/**
 * 防回流：给模型看的斜杠命令文案里，不许出现**已退役**的命令。
 *
 * 为什么需要：命令退役后（`/clip` 并入 `/note raw`、`/chat` 移除），残留文案会**按需注入**模型——
 * 内置技能手册（assets/skills）经 load_skill 读进上下文，工具描述常驻上下文。文案里留着已退役命令，
 * 模型就会把它当可用指令介绍给用户（用户侧表现：「这个命令早没了，怎么还提示我」）。
 *
 * 为什么不做成「白名单」：文案里合法的斜杠 token 太多非命令（路径 `/abs` `/mnt`、charset 值
 * `/https`、正则 `/^\/todo\b/`），白名单会淹在误报里；退役名是有限集合，用黑名单最精确。
 */
describe('斜杠命令文案防回流（已退役命令不许出现在给模型的文案里）', () => {
  /** 退役命令名。命令退役（从 BUTLER_COMMANDS 移除）时把名字加进来。 */
  const RETIRED = [
    'clip', // 能力并入 /note raw（只囤素材不编译），不再有独立命令
    'chat', // 统一入口后纯文本直连管家同一 agent，该命令只剩同义反复的意图前缀
  ];
  const ROOT = process.cwd();

  it('退役名单与真源不相交（名字被重新注册时必须从名单移除，防止测试假通过）', () => {
    for (const name of RETIRED) {
      expect(BUTLER_COMMANDS.some((c) => c.keyword === name), name).toBe(false);
    }
  });

  it('内置技能手册与工具描述里不出现退役命令', () => {
    /** 嫌疑 token：前导须是空白/括号/顿逗号/冒号/反引号，
     *  避免命中路径与正则（`/api/chat`、`/^\/todo\b/` 的前导字符都不在集合内）。 */
    const CANDIDATE = new RegExp(`(?:^|[\\s(（,，:：\`])/(${RETIRED.join('|')})\\b`, 'g');

    function collectFiles(dir: string, exts: string[]): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...collectFiles(p, exts));
        else if (exts.some((e) => name.endsWith(e))) out.push(p);
      }
      return out;
    }

    const files = [
      ...collectFiles(join(ROOT, 'assets/skills'), ['.md']),
      ...collectFiles(join(ROOT, 'src/app/api/chat/tools'), ['.ts']),
    ];
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(CANDIDATE)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${relative(ROOT, file)}:${line} → /${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});