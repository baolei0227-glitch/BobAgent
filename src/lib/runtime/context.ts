// K2-S3 动态上下文链 runtime service 抽取，行为不变
// =====================================================================================
// 把 route.ts（src/app/api/chat/route.ts）中「动态上下文 prepend 链」的**内容生成**部分
// （四段低频变化注入文本的 provider）收敛为 ContextRuntime 单例 service：
//   ① 项目路径注入文本（原 projectPathInjection，route 2899-2901）；
//   ② 授权目录清单文本（原 authorizedRootsInjection，route 2904-2917）；
//   ③ 用户偏好类型目录文本（原 prefInjection，route 2941-2962 的 listPreferences/统计/拼装部分）；
//   ④ OCR/视觉引擎现状事实文本（原 module 级 buildOcrEngineFactInjection，route 1604-1674）。
// 统一入口 buildChain 按原 route 注入顺序（pathContext → userPreferences → ocrFact）依次生成，
// 各段独立容错（单段读取/解析失败仅该段返回 ''，不阻断后续段）——与原 route 各段独立 try/catch
// 语义一致；空串段 = 原代码该段不调用 prependDynamicContext。
// 硬约束（注入通道保留 route，K2-S3 红线）：
//   - prependDynamicContext 机制与三次 prepend 调用点、顺序、if 条件全部留在 route，本 service
//     只产出文本、绝不触碰消息数组；
//   - 各段文本字节与迁移前逐字节一致（换行/前缀/插值格式原样复刻，此处无任何格式"优化"）。
// 说明：AI Coding 沙盒上下文（route 2971-3174，readAppEntry/hasAppImplementation/
//   getBridgeActionsText 等）依赖深、文本量大，拆为 S3b 单独抽取，本文件暂不包含。
// =====================================================================================

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getLocalAuthorizedRoots } from '@/app/api/chat/tools';
import { pluginDataHome } from '@/lib/extensions/data-home';

/** 项目路径/授权目录段生成所需的最小入参（route 已解析好的请求级上下文） */
export interface PathContextInput {
  /** 展示用当前项目路径（已替换 homedir 为 ~）；空串 = 未激活项目 */
  currentProjectPath: string;
  /** 产物目录名（route 原常量 'homework'） */
  nodeHomeworkDir: string;
}

/** buildChain 统一入口返回：按原 route 注入顺序排列的三段注入文本 */
export interface ContextInjectionChain {
  /** 段①+②：项目路径文本 + 授权目录文本（原 pathContextInjection = projectPathInjection + authorizedRootsInjection） */
  pathContextInjection: string;
  /** 段③：用户偏好类型目录文本（无偏好/读取失败 = ''，不注入） */
  userPreferencesInjection: string;
  /** 段④：OCR/视觉引擎现状事实文本（未配置/读取失败 = ''，不注入） */
  ocrEngineFactInjection: string;
}

/** ContextRuntime：动态上下文链内容生成 provider（无实例状态，单例安全）。
 * 方法签名按 route 实读所需的最小入参设计：路径段传入已 ~ 化展示路径 + 产物目录名，
 * 偏好/OCR 段各自内部读取（与原 route 内联读取时机一致：均为"每轮生成时读一次"）。 */
export class ContextRuntime {
  /** 段①：项目路径注入文本（恒非空——无激活项目也有兜底文案，原 route 三元同语义） */
  buildProjectPathInjection(input: PathContextInput): string {
    const { currentProjectPath, nodeHomeworkDir } = input;
    return currentProjectPath
      ? `\n\n当前项目路径：${currentProjectPath}\n产出文档默认 .md，用 ${nodeHomeworkDir}/ 前缀相对路径写入（如 write_file(path="${nodeHomeworkDir}/报告.md")），不要写入 homework/.ai-workspace/ 临时工作区。\n【产物声明】写文件成功后，在最终回答末尾另起一行输出 \`OutputFile: ${nodeHomeworkDir}/文件名\`（每行一个），前端据此生成可点击打开的产物卡片；禁止声明未写入或写入失败的路径。\n【模板填充产物路径】模板填充生成的 .docx 保存在 homework/template/ 目录（Finder 可见），读取/检查须用 homework/template/ 前缀。`
      : `\n\n当前没有激活项目：所有相对路径将解析到临时工作区 ~/BobWork/.sandbox。如果你的产出属于某个项目，请提醒用户先在 BobWork 中激活该项目，再把文件写入该项目的 homework/ 目录。`;
  }

  /** 段②：授权目录清单注入文本（无授权目录/读取失败返回 ''，原 route try/catch 忽略语义） */
  async buildAuthorizedRootsInjection(input: { nodeHomeworkDir: string }): Promise<string> {
    try {
      const authorizedRoots = await getLocalAuthorizedRoots();
      if (authorizedRoots.length > 0) {
        const list = authorizedRoots.map((r) => `- ${r.replace(homedir(), '~')}`).join('\n');
        return (
          `\n\n你已被授权操作的本地目录（与项目目录同级，可读可写）：\n${list}\n` +
          `- 用户明确要求操作某授权目录时，用完整绝对路径在该目录执行；未指定目录时默认当前项目目录\n` +
          `- 最终产出仍统一写入当前项目 ${input.nodeHomeworkDir}/ 目录（产物声明规则同上），授权目录仅用于读素材和写临时/中间文件，除非用户明确指定"把产出保存到某授权目录"\n` +
          `- 除当前项目目录和上述授权目录外，禁止读写其他本地路径`
        );
      }
      return '';
    } catch {
      // 无授权目录时忽略（与原 route 内联 catch 一致）
      return '';
    }
  }

  /** 段③：用户偏好类型目录注入文本（listPreferences 读取 + type 分组统计 + 目录文本，原 route 2941-2962 纯生成部分）。
   *  无偏好/读取失败返回 ''（原代码 prefs.length > 0 才注入、读取异常被 catch 忽略）。 */
  async buildUserPreferencesInjection(): Promise<string> {
    try {
      const { listPreferences } = await import('@/lib/wanted/preferences');
      const prefs = await listPreferences();
      if (prefs.length === 0) return '';
      // 类型目录：按 type 分组统计条数（不注入具体内容，节省上下文、避免无关偏好干扰）
      const typeCounts = new Map<string, number>();
      for (const p of prefs) {
        typeCounts.set(p.type, (typeCounts.get(p.type) || 0) + 1);
      }
      const typeLines = Array.from(typeCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `- [${type}] ×${count}`)
        .join('\n');
      return `\n\n## 用户偏好（全局长期记忆，类型目录，按需调取）\n已记录 ${prefs.length} 条偏好，类型目录：\n${typeLines}\n\n当前任务涉及上述某类偏好时（输出格式、引用规范、任务流程、沟通风格等），调用 read_preferences(type) 读取该类完整记录并严格遵守；需要全部记录时调用 read_preferences()。若用户明确要求记住新偏好，调用 remember_preference 写入（可带 type 分类）；遗忘用 delete_preference（按序号）。`;
    } catch {
      // 偏好读取失败忽略（与原 route 内联 try/catch 一致）
      return '';
    }
  }

  /**
   * 段④：OCR/视觉引擎现状事实注入（[SYS FACT]）——原 route.ts module 级 buildOcrEngineFactInjection
   * 整体随迁（实现逐字节保留，含 v2 schema（vision.* 与 ocr.*）与旧版 schema 顶层 glmOcr / onlineOcr 兜底）。
   *
   * 问题背景：BASE_SYSTEM_PROMPT 曾硬编码「bob-ocr-mcp 已配置本地视觉模型（Qwen2.5-VL）」，
   * 而插件真实配置由用户随时可改（云端 DeepSeek VL / GLM-OCR / 本地 MLX 等皆可能）——
   * 配置变了、缓存头里的静态断言没变，模型据 stale 文案向用户转述错误引擎归属。
   * 根因：易变配置被写进了字节稳定的 system 缓存头。
   *
   * 方案：system 保持零插值（C8）；每轮从插件数据根 config.json
   * （BobWork 托管：~/BobWork/extensions/bob-ocr-mcp）读真实生效值，
   * 以固定格式事实行经 prependDynamicContext 低频通道注入（注入动作仍在 route 原位）。
   * 只原样转述字段值，不做本地/云端的语义推断（provider/baseUrl 字段本身已表达），绝不输出 apiKey。
   *
   * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），跨轮前缀
   * （system + 工具 + 历史）字节不变，命中率不受影响；用户改插件配置的瞬间
   * 仅影响本轮及之后的消息前缀，属预期失效（事实必须反映最新配置）。
   */
  buildOcrEngineFactInjection(): string {
    try {
      const cfgPath = join(pluginDataHome('bob-ocr-mcp'), 'config.json');
      if (!existsSync(cfgPath)) return '';
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');
      const lines: string[] = [];

      // 视觉理解（v2：vision.selected 指向 vision.models[] 中某条目）
      if (raw.vision && typeof raw.vision === 'object') {
        const vision = raw.vision as { selected?: unknown; models?: unknown };
        const selected = str(vision.selected);
        const models = Array.isArray(vision.models)
          ? (vision.models as { id?: unknown; provider?: unknown; baseUrl?: unknown }[]).filter(
              (m): m is NonNullable<typeof m> => !!m && typeof m === 'object',
            )
          : [];
        const entry = selected ? models.find((m) => str(m.id) === selected) : undefined;
        if (entry) {
          lines.push(`- 视觉理解模型：${selected}（provider=${str(entry.provider) || '未声明'}，baseUrl=${str(entry.baseUrl) || '默认'}）`);
        } else if (selected) {
          lines.push(`- 视觉理解模型：${selected}（模型清单中未找到对应条目）`);
        } else {
          lines.push('- 视觉理解模型：未选择');
        }
      }

      // 文字识别（v2：ocr.source / ocr.glm / ocr.local；旧版兜底：顶层 glmOcr / onlineOcr）
      if (raw.ocr && typeof raw.ocr === 'object') {
        const ocr = raw.ocr as Record<string, unknown>;
        const src = str(ocr.source);
        const sel = str(ocr.selected);
        const detail: string[] = [];
        if (ocr.glm && typeof ocr.glm === 'object') {
          const glm = ocr.glm as { model?: unknown; baseUrl?: unknown; enabled?: unknown };
          const state = glm.enabled === true ? '启用' : glm.enabled === false ? '停用' : '未声明';
          detail.push(`glm=${str(glm.model) || state}@${str(glm.baseUrl) || '默认'}`);
        }
        if (ocr.local && typeof ocr.local === 'object') {
          const local = ocr.local as { baseUrl?: unknown; enabled?: unknown };
          const state = local.enabled === true ? '' : local.enabled === false ? '（停用）' : '';
          detail.push(`local=${str(local.baseUrl) || '默认'}${state}`);
        }
        lines.push(`- 文字识别主力：${src || sel || '未配置'}${src && sel ? `（selected=${sel}）` : ''}${detail.length ? `｜${detail.join('｜')}` : ''}`);
      } else if (
        ((raw.glmOcr ?? null) && typeof raw.glmOcr === 'object') ||
        ((raw.onlineOcr ?? null) && typeof raw.onlineOcr === 'object')
      ) {
        const seg: string[] = [];
        if (raw.glmOcr && typeof raw.glmOcr === 'object') {
          const leg = raw.glmOcr as { model?: unknown; enabled?: unknown };
          seg.push(`glm=${str(leg.model) || (leg.enabled === false ? '停用' : '已配置')}`);
        }
        if (raw.onlineOcr && typeof raw.onlineOcr === 'object') {
          const onl = raw.onlineOcr as { model?: unknown; provider?: unknown; enabled?: unknown };
          seg.push(`online=${str(onl.model) || str(onl.provider) || (onl.enabled === false ? '停用' : '已配置')}`);
        }
        lines.push(`- 文字识别主力（旧版配置）：${seg.join('｜')}`);
      }

      if (!lines.length) return '';
      return (
        `\n\n## OCR/视觉引擎现状（[SYS FACT]）\n以下为 bob-ocr-mcp 插件本轮实际生效的引擎配置（读取自其 config.json 原样字段值）。` +
        `回答任何"用的什么视觉模型 / OCR 引擎是本地还是云端 / 是否已配置"等引擎归属类问题时，必须以此为准：\n` +
        lines.join('\n')
      );
    } catch {
      /* 配置缺失/损坏一律静默跳过——此时 system 护栏要求如实回答"无法确认"，不得虚构 */
    }
    return '';
  }

  /** 统一入口：按原 route 注入顺序依次生成三段注入文本（pathContext → userPreferences → ocrFact）。
   *  各段独立容错；route 拿到结果后仍按原三个 prepend 原位执行注入。 */
  async buildChain(input: PathContextInput): Promise<ContextInjectionChain> {
    const pathContextInjection =
      this.buildProjectPathInjection(input) +
      (await this.buildAuthorizedRootsInjection({ nodeHomeworkDir: input.nodeHomeworkDir }));
    const userPreferencesInjection = await this.buildUserPreferencesInjection();
    const ocrEngineFactInjection = this.buildOcrEngineFactInjection();
    return { pathContextInjection, userPreferencesInjection, ocrEngineFactInjection };
  }
}

/** 全局单例：内容生成无实例状态，跨请求共享安全（对齐 K2-S2 sessionRuntime 单例风格）。 */
export const contextRuntime = new ContextRuntime();
