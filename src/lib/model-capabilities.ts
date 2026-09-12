/**
 * 共享多模态能力注册表
 *
 * 解决「模型池判定」与「聊天直连判定」口径不一致的问题：
 *  - 模型池 /api/models 依赖厂商声明的能力位（supports_vision / input_modalities 含 image）
 *    能把「名字无 vision/vl 但实际多模态」的模型（如 deepseek-v4.1-flash-…）正确标为 vision；
 *  - 而聊天直连判定只靠名字正则（model-tags.isVisionModel），读不到这些能力位，导致漏判，
 *    视觉模型被错误降级为 bob-ocr 描述注入。
 *
 * 本模块是两者之间的桥：模型池解析出 type==='vision' 的模型 id 在此登记，
 * 聊天直连在注册表里命中即视为视觉模型（与名字正则取或）。
 *
 * 说明：Electron 内 Next.js standalone 单进程运行，route handler 模块级单例可跨请求共享；
 * 注册依赖模型池被加载过（刷新模型列表/选模时触发 /api/models）。注册表为空时退化为纯
 * 名字正则判定（即原行为，无回归）。
 */

/** 已知多模态（视觉）模型 id，小写登记 */
const visionModelIds = new Set<string>();

/** 登记一批视觉模型 id（由模型池 /api/models 在解析出 type==='vision' 后调用） */
export function registerVisionModels(ids: Iterable<string>): void {
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().toLowerCase();
    if (id) visionModelIds.add(id);
  }
}

/** 是否命中模型池登记的多模态能力（忽略大小写） */
export function isDeclaredVisionModel(id: string): boolean {
  return visionModelIds.has((id || '').trim().toLowerCase());
}

/** 当前已登记视觉模型数量（诊断/测试用） */
export function declaredVisionCount(): number {
  return visionModelIds.size;
}