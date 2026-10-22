/**
 * 独立 OCR 服务（ocr-service）—— 已收敛为 bob-ocr-mcp 插件代理
 *
 * BobWork 的 OCR 识别完全走 bob-ocr-mcp 常驻服务（http://127.0.0.1:9478/mcp），
 * 本地识别引擎已移除。本模块仅保留对外签名与类型：
 *   1. `ocr_document` AI 工具（tools.ts 注册）——主节点可直接调用
 *   2. `POST /api/ocr` 端点——外部/测试调用
 *   3. PDF Bridge 后台预热 / 微信桥图片识别——经 ocrFile 统一走 MCP
 *
 * 服务不可用（未配置 / 未启动 / 调用失败）时返回明确错误，不再回退本地引擎。
 */

import type { OcrPage, CellCandidate } from './layout-score';

/** VLM 升级策略 */
export type OcrUpgrade = 'off' | 'auto' | 'always';

/** ocrFile 选项 */
export interface OcrServiceOptions {
  /** VLM 升级：auto=质量低/复杂页自动升级（默认，质量优先）；off=不升级；always=全部升级。 */
  upgrade?: OcrUpgrade;
  /** 项目路径（VLM 结果缓存目录用）；缺省取当前活跃项目 */
  projectPath?: string;
}

/** 每页 OCR 结果（含质量/勾稽/方向元数据） */
export interface OcrPageResult {
  index: number;
  text: string;
  /** 文本质量分 0-1（qualityScore） */
  qualityScore: number;
  /** 余额勾稽一致行数；-1 = 非流水表格页（信号不可用） */
  ledgerVerified: number;
  /** 是否判定为旋转 90° 扫描并已转置 bbox */
  rotated: boolean;
  /** 是否启用了图像增强 */
  enhanced: boolean;
  /** 是否经在线/VLM 兜底重识别 */
  upgraded: boolean;
  /** 采用的链路：glm-ocr=智谱官方 GLM-OCR 文档解析；online-ocr=Online OCR 专用模型；vlm-upgrade=VLM 视觉模型兜底 */
  upgradeChain?: 'glm-ocr' | 'online-ocr' | 'vlm-upgrade';
  /** 实际采用的模型 id（如 qwen3.5-ocr / glm-5v-turbo）；未升级时缺省 */
  upgradeModel?: string;
  /** 本地 Mac Vision 坐标骨架（证据回溯，保留） */
  blocks?: OcrPage['blocks'];
  /** 云端候选（按页聚合） */
  candidates?: CellCandidate[];
}

/** OCR 服务结果 */
export interface OcrServiceResult {
  success: boolean;
  text: string;
  method: 'pdf-text' | 'vision-ocr' | 'glm-ocr' | 'empty' | 'error';
  pageCount: number;
  pages: OcrPageResult[];
  /** 实际发生 VLM 升级的页数 */
  upgradedCount: number;
  /** 过程性说明/告警（如"Online OCR 已配置但未生效：原因X"），消除静默失败 */
  notes?: string[];
  /** bob-ocr-mcp 识别缓存命中：本次未重新识别，text/notes 均为历史结果 */
  cached?: boolean;
  /** 缓存写入时间（ISO），仅 cached=true 时有值 */
  cachedAt?: string;
  error?: string;
  /** 逐页骨架（blocks / 勾稽 / 质量画像）；MCP 经 HTTP 返回 JSON 时可能缺失，调用方需自行降级 */
  rawPages?: OcrPage[];
}

/** 服务不可用时的统一错误结果 */
function serviceUnavailable(reason: string): OcrServiceResult {
  return {
    success: false,
    text: '',
    method: 'error',
    pageCount: 0,
    pages: [],
    upgradedCount: 0,
    error:
      `识别服务 bob-ocr-mcp 不可用：${reason}。` +
      'Bob OCR 的本地常驻桥随 BobWork 分发、由宿主自动托管拉起（127.0.0.1:9478）；' +
      '请先在 设置 → Extensions Store → Plugins 确认 "Bob OCR" 处于启用状态，' +
      '仍未就绪时查看插件日志 <数据根>/host-bridge.log，或手动执行 bob-ocr-mcp --serve 排障。',
  };
}

/**
 * OCR 核心入口：识别一个文件（图片或 PDF）——完全走 bob-ocr-mcp。
 * @param filePath 绝对路径
 * @param opts upgrade 升级策略 / projectPath 缓存目录（透传）
 * @returns 结构化 OCR 结果；MCP 不可用时返回 error 结果（不再回退本地引擎）
 */
export async function ocrFile(filePath: string, opts: OcrServiceOptions = {}): Promise<OcrServiceResult> {
  try {
    const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
    const mcp = await tryOcrViaMcp(filePath, opts.upgrade ?? 'auto');
    if (mcp) return mcp as unknown as OcrServiceResult;
    return serviceUnavailable('未配置或未启动');
  } catch (e) {
    return serviceUnavailable(e instanceof Error ? e.message : String(e));
  }
}
