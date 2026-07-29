import { inferModelSpec } from './model-matcher';

/** 单次工具调用记录 */
export interface ToolCallRecord {
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  success: boolean;
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: 'image' | 'text' | 'file';
  mimeType: string;
  size: number;
  path: string;
  dataUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  attachments?: MessageAttachment[];
}

/** 托管模型（无需 API Key，通过 coze-coding-dev-sdk 调用） */
export interface ModelOption {
  id: string;
  label: string;
  description: string;
  thinking: boolean;
  temperature: number;
}

export const MODEL_OPTIONS: ModelOption[] = [];

export const DEFAULT_MODEL_ID = '';

/* ==================== 自定义提供商模型 ==================== */

export type ProviderType = 'deepseek' | 'glm' | 'moonshot' | 'qwen' | 'openai' | 'doubao';

export type ModelCapability = 'reasoning' | 'conversation' | 'coding' | 'creative' | 'analysis' | 'multilingual' | 'long-context';

export interface ModelSpec {
  capabilities: ModelCapability[];
  strengths: string[];
  weaknesses: string[];
  useCases: string[];
  pricePerMillionTokens?: { input: number; output: number };
  contextWindow?: number;
}

export interface ProviderModel {
  modelId: string;
  label: string;
  description: string;
  thinking: boolean;
  temperature: number;
  spec?: ModelSpec;
}

export interface ProviderPreset {
  type: ProviderType;
  label: string;
  description: string;
  baseUrl: string;
  models: ProviderModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek AI',
    baseUrl: 'https://api.deepseek.com',
    models: [
      {
        modelId: 'deepseek-chat',
        label: 'DeepSeek V3',
        description: 'Chat Model · Fast Response',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'multilingual'],
          strengths: ['Fast response', 'Strong code generation', 'Multilingual support'],
          weaknesses: ['Limited complex reasoning', 'No thinking mode'],
          useCases: ['Daily conversation', 'Code writing', 'Translation', 'Information lookup'],
          pricePerMillionTokens: { input: 0.2, output: 0.6 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'deepseek-reasoner',
        label: 'DeepSeek R1',
        description: 'Reasoning Model · Thinking',
        thinking: true,
        temperature: 0.7,
        spec: {
          capabilities: ['reasoning', 'analysis', 'conversation'],
          strengths: ['Strong logical reasoning', 'Supports thinking mode', 'Excellent math ability'],
          weaknesses: ['Slower response', 'Average code generation'],
          useCases: ['Complex problem analysis', 'Math proofs', 'Logical reasoning', 'Decision support'],
          pricePerMillionTokens: { input: 0.8, output: 2.4 },
          contextWindow: 128000,
        },
      },
    ],
  },
  {
    type: 'glm',
    label: 'GLM',
    description: 'Zhipu AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      {
        modelId: 'glm-z1-flash',
        label: 'GLM-Z1 Flash',
        description: 'Reasoning Model · Thinking',
        thinking: true,
        temperature: 0.7,
        spec: {
          capabilities: ['reasoning', 'analysis', 'creative'],
          strengths: ['Excellent Chinese understanding', 'Supports thinking mode', 'High creativity'],
          weaknesses: ['Average English ability', 'Medium code generation'],
          useCases: ['Chinese writing', 'Deep analysis', 'Creative generation', 'Academic research'],
          pricePerMillionTokens: { input: 0.5, output: 1.5 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'glm-4-flash',
        label: 'GLM-4 Flash',
        description: 'Chat Model · Fast Response',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'multilingual'],
          strengths: ['Fast response', 'Cost effective', 'Multilingual support'],
          weaknesses: ['Weaker complex reasoning', 'No thinking mode'],
          useCases: ['Daily conversation', 'Quick Q&A', 'Simple code', 'Translation'],
          pricePerMillionTokens: { input: 0.15, output: 0.45 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'glm-4-plus',
        label: 'GLM-4 Plus',
        description: 'Flagship Chat Model',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'creative', 'multilingual'],
          strengths: ['Strong overall capability', 'Image understanding', 'Long text processing'],
          weaknesses: ['Higher cost', 'No thinking mode'],
          useCases: ['General Q&A', 'Multimodal understanding', 'Long-form writing', 'Complex tasks'],
          pricePerMillionTokens: { input: 1.0, output: 3.0 },
          contextWindow: 256000,
        },
      },
    ],
  },
  {
    type: 'moonshot',
    label: 'Moonshot',
    description: 'Moonshot AI',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      {
        modelId: 'kimi-k2-thinking',
        label: 'Kimi K2 Thinking',
        description: 'Reasoning Model · Thinking',
        thinking: true,
        temperature: 1.0,
        spec: {
          capabilities: ['reasoning', 'analysis', 'long-context'],
          strengths: ['Long context handling', 'Supports thinking mode', 'Strong knowledge integration'],
          weaknesses: ['Slower response', 'Higher cost'],
          useCases: ['Literature review', 'Code review', 'Complex reasoning', 'Long document analysis'],
          pricePerMillionTokens: { input: 1.0, output: 3.0 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'kimi-k2-5-260127',
        label: 'Kimi K2.5',
        description: 'Latest Reasoning Model · Thinking',
        thinking: true,
        temperature: 1.0,
        spec: {
          capabilities: ['reasoning', 'analysis', 'coding', 'long-context'],
          strengths: ['Best reasoning ability', 'Supports thinking mode', 'Improved coding ability'],
          weaknesses: ['Slow response', 'Highest cost'],
          useCases: ['Complex math', 'Deep analysis', 'Algorithm design', 'Scientific reasoning'],
          pricePerMillionTokens: { input: 1.2, output: 3.6 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'moonshot-v1-8k',
        label: 'Moonshot v1 8K',
        description: 'Chat Model · 8K Context',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'creative'],
          strengths: ['Fast response', 'Low cost', 'Natural Chinese conversation'],
          weaknesses: ['Short context', 'Weak reasoning'],
          useCases: ['Daily chat', 'Simple Q&A', 'Creative writing', 'Quick response'],
          pricePerMillionTokens: { input: 0.3, output: 0.9 },
          contextWindow: 8192,
        },
      },
    ],
  },
  {
    type: 'qwen',
    label: 'Qwen',
    description: 'Alibaba Cloud',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      {
        modelId: 'qwen-vl-max',
        label: 'Qwen VL Max',
        description: 'Vision Model · Best Image Understanding',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['analysis', 'conversation', 'multilingual'],
          strengths: ['Strong image understanding', 'Excellent in both Chinese and English', 'Document parsing'],
          weaknesses: ['Higher cost', 'No thinking mode'],
          useCases: ['Image description', 'Document parsing', 'Chart understanding', 'Visual Q&A'],
          pricePerMillionTokens: { input: 2.0, output: 6.0 },
          contextWindow: 32768,
        },
      },
      {
        modelId: 'qwen-vl-plus',
        label: 'Qwen VL Plus',
        description: 'Vision Model · Cost Effective',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['analysis', 'conversation'],
          strengths: ['Cost effective', 'Good image understanding', 'Fast response'],
          weaknesses: ['Slightly weaker than Max', 'No thinking mode'],
          useCases: ['Image description', 'Simple visual Q&A', 'Image-to-text'],
          pricePerMillionTokens: { input: 0.8, output: 2.0 },
          contextWindow: 32768,
        },
      },
      {
        modelId: 'qwen-max',
        label: 'Qwen Max',
        description: 'Chat Model · Flagship',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'creative', 'multilingual'],
          strengths: ['Excellent Chinese understanding', 'Strong overall capability', 'Long text processing'],
          weaknesses: ['No thinking mode', 'Higher cost'],
          useCases: ['Chinese writing', 'General Q&A', 'Code writing', 'Complex tasks'],
          pricePerMillionTokens: { input: 2.0, output: 6.0 },
          contextWindow: 32768,
        },
      },
    ],
  },
  {
    type: 'openai',
    label: 'OpenAI',
    description: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      {
        modelId: 'gpt-4o',
        label: 'GPT-4o',
        description: 'Multimodal · Vision',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'creative', 'analysis', 'multilingual'],
          strengths: ['Multimodal understanding', 'Strongest overall capability', 'Image understanding'],
          weaknesses: ['High cost', 'Requires proxy in China'],
          useCases: ['Image description', 'Complex analysis', 'Code writing', 'Multimodal tasks'],
          pricePerMillionTokens: { input: 2.5, output: 10.0 },
          contextWindow: 128000,
        },
      },
      {
        modelId: 'gpt-4o-mini',
        label: 'GPT-4o Mini',
        description: 'Lite Multimodal · Vision',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'coding', 'multilingual'],
          strengths: ['Image understanding', 'Cost effective', 'Fast response'],
          weaknesses: ['Average reasoning', 'Requires proxy in China'],
          useCases: ['Image description', 'Daily conversation', 'Simple Q&A', 'Quick response'],
          pricePerMillionTokens: { input: 0.15, output: 0.6 },
          contextWindow: 128000,
        },
      },
    ],
  },
  {
    type: 'doubao',
    label: 'Doubao',
    description: 'ByteDance',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      {
        modelId: 'doubao-1.5-vision-pro-32k',
        label: 'Doubao Vision Pro 32K',
        description: 'Multimodal Vision · Image Analysis',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'analysis', 'multilingual'],
          strengths: ['Excellent Chinese image understanding', 'Fast response', 'Cost effective'],
          weaknesses: ['No thinking mode'],
          useCases: ['Image description', 'Document recognition', 'Screenshot analysis', 'OCR'],
          pricePerMillionTokens: { input: 2.0, output: 8.0 },
          contextWindow: 32000,
        },
      },
      {
        modelId: 'doubao-vision-pro-32k',
        label: 'Doubao Vision Pro',
        description: 'Vision Model · Image Understanding',
        thinking: false,
        temperature: 0.7,
        spec: {
          capabilities: ['conversation', 'analysis', 'multilingual'],
          strengths: ['Strong image understanding', 'Accurate OCR', 'Chinese optimized'],
          weaknesses: ['No thinking mode'],
          useCases: ['Image description', 'Document scanning', 'Chart analysis', 'Photo Q&A'],
          pricePerMillionTokens: { input: 2.0, output: 8.0 },
          contextWindow: 32000,
        },
      },
    ],
  },
];

export interface SelectedModel {
  modelId: string;
  thinking: boolean;
}

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  selectedModels?: SelectedModel[]; // 用户勾选的模型列表（含 thinking 信息）
}

/* ==================== 搜索配置 ==================== */

export interface SearchConfig {
  apiKey: string;
  baseUrl: string;
}

/** localStorage 存储键 */
export const PROVIDER_STORAGE_KEY = 'ai-canvas-providers';
export const SEARCH_CONFIG_STORAGE_KEY = 'ai-canvas-search-config';

/** 从 localStorage 读取搜索配置 */
export function loadSearchConfig(): SearchConfig {
  if (typeof window === 'undefined') return { apiKey: '', baseUrl: '' };
  try {
    const raw = window.localStorage.getItem(SEARCH_CONFIG_STORAGE_KEY);
    if (!raw) return { apiKey: '', baseUrl: '' };
    const parsed = JSON.parse(raw) as SearchConfig;
    return {
      apiKey: parsed.apiKey ?? '',
      baseUrl: parsed.baseUrl ?? '',
    };
  } catch {
    return { apiKey: '', baseUrl: '' };
  }
}

/** 保存搜索配置到 localStorage */
export function saveSearchConfig(config: SearchConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SEARCH_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

/** 从 localStorage 读取已配置的提供商列表 */
export function loadProviderConfigs(): ProviderConfig[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProviderConfig[];
    return parsed
      .filter((p) => p.apiKey && p.apiKey.trim().length > 0)
      .map((p) => ({
        ...p,
        // 归一化旧格式 selectedModels (string[]) 为新格式 SelectedModel[]
        selectedModels: (p.selectedModels ?? []).map((sel): SelectedModel => {
          if (typeof sel === 'string') {
            return {
              modelId: sel,
              thinking: /think|reason|r1|z1|k2[.\-]5|k2[.\-]6|k3/i.test(sel),
            };
          }
          return sel;
        }),
      }));
  } catch {
    return [];
  }
}

/** 保存提供商配置到 localStorage */
export function saveProviderConfigs(configs: ProviderConfig[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    PROVIDER_STORAGE_KEY,
    JSON.stringify(configs),
  );
}

export interface AvailableModel {
  group: string;
  modelId: string;
  label: string;
  description: string;
  thinking: boolean;
  temperature: number;
  spec?: ModelSpec;
}

/** 获取所有可用模型（托管 + 已配置提供商），用于模型选择器 */
export function getAvailableModels(
  providerConfigs: ProviderConfig[],
): AvailableModel[] {
  const result: AvailableModel[] = [];

  // 托管模型
  for (const m of MODEL_OPTIONS) {
    result.push({
      group: '托管模型',
      modelId: m.id,
      label: m.label,
      description: m.description,
      thinking: m.thinking,
      temperature: m.temperature,
    });
  }

  // 已配置提供商模型
  for (const preset of PROVIDER_PRESETS) {
    const config = providerConfigs.find((c) => c.type === preset.type);
    if (!config) continue;
    // 用户从 API 获取并勾选的模型（兼容旧格式 string[] 和新格式 SelectedModel[]）
    const selected = config.selectedModels ?? [];
    for (const sel of selected) {
      // 兼容旧格式：如果 sel 是字符串，则视为 modelId，thinking 用正则推断
      const modelId = typeof sel === 'string' ? sel : sel.modelId;
      if (!modelId) continue; // 跳过无效条目
      const isThinking = typeof sel === 'string'
        ? /think|reason|r1|z1|k2[.\-]5|k2[.\-]6|k3/i.test(modelId)
        : sel.thinking;
      // 先查预设模型，匹配则用预设信息
      const presetModel = preset.models.find((m) => m.modelId === modelId);
      if (presetModel) {
        result.push({
          group: preset.label,
          modelId: `${preset.type}:${presetModel.modelId}`,
          label: presetModel.label,
          description: presetModel.description,
          thinking: presetModel.thinking,
          temperature: presetModel.temperature,
          spec: presetModel.spec,
        });
      } else {
        const spec = inferModelSpec(modelId, isThinking);
        result.push({
          group: preset.label,
          modelId: `${preset.type}:${modelId}`,
          label: modelId,
          description: isThinking ? '推理模型' : '对话模型',
          thinking: isThinking,
          temperature: isThinking ? 1.0 : 0.7,
          spec,
        });
      }
    }
  }

  return result;
}

/** 判断模型 ID 是否为自定义提供商模型 */
export function isCustomModel(modelId: string): boolean {
  return modelId.includes(':');
}

/** 从模型 ID 解析提供商类型和实际模型 ID */
export function parseCustomModel(modelId: string): { provider: ProviderType; modelId: string } | null {
  const idx = modelId.indexOf(':');
  if (idx === -1) return null;
  const provider = modelId.slice(0, idx) as ProviderType;
  const id = modelId.slice(idx + 1);
  return { provider, modelId: id };
}

/** 根据提供商类型获取预设信息 */
export function getProviderPreset(type: ProviderType): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.type === type);
}

/* ==================== 思考深度控制系统 ==================== */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_LEVELS: { value: ThinkingLevel; label: string; shortLabel: string }[] = [
  { value: 'off', label: 'Intuition', shortLabel: '关' },
  { value: 'low', label: 'Awareness', shortLabel: '浅' },
  { value: 'medium', label: 'Deliberation', shortLabel: '中' },
  { value: 'high', label: 'Retrospection', shortLabel: '深' },
  { value: 'max', label: 'Transcendence', shortLabel: '极' },
];

/** reasoning_effort API 参数映射 */
export const REASONING_EFFORT_MAP: Record<ThinkingLevel, string | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',  // API 最高只支持 high，max 通过更强的系统提示实现差异
};

/** 系统提示注入 */
const _MOOD_SPEC = '## MOOD\n每轮回答前，输出一个 <mood> 块，捕捉当前的情绪和想法。包含四个维度：\n- Vibe：最直接的感受（一条）\n- Sparks：联想和灵感（三条）\n- Reflections：反思和质疑（三条）\n- Will：想做的事（两条）\nMOOD 用 <mood></mood> 标签包裹，在 <think> 之前输出。';

export const SYSTEM_PROMPT_INJECTIONS: Record<ThinkingLevel, string> = {
  off: '\n## 提问限制\n每次最多向用户提 1 个问题。优先直接回答，仅在信息严重不足时才提问。\n',
  low: '\n## 思考要求\n在回答前进行简要思考，但不要过度分析。思考过程用 <think></think> 标签包裹。\n\n## 提问限制\n每次最多向用户提 1-2 个问题。判断确实需要用户补充信息时才提问，不要为提问而提问。\n',
  medium: '\n## 思考要求\n每轮回答前先进行充分的思考，用 <think></think> 标签包裹。\n思考内容应包括：\n- 对用户问题的理解和拆解\n- 需要确认的前提条件\n- 推理的关键步骤\n\n## 提问限制\n每次最多向用户提 1-3 个问题。当需求、偏好或关键信息不明确时，主动向用户澄清。\n' + _MOOD_SPEC,
  high: '\n## 深度思考要求\n对于每一个问题，请进行深度、结构化的思考。思考过程用 <think></think> 标签包裹。\n必须包含以下步骤：\n1. 用自己的话复述问题，确认理解正确\n2. 列出已知条件和未知信息\n3. 识别真正的问题（用户问的和用户需要的可能不同）\n4. 构建推理链条，逐步推导\n5. 检查每一步的可靠性，标注不确定的地方\n6. 考虑多种可能的答案或方案，比较优劣\n思考深度应足够：如果一个问题有隐含的前提假设，必须挖出来审视；如果有多种解法，必须全部列出并对比。\n\n## 提问限制\n每次最多向用户提 2-4 个问题。深度思考过程中发现的不确定因素、隐含假设和方案歧义都应向用户确认。\n' + _MOOD_SPEC,
  max: '\n## 极致推理要求\n本模式下，你必须投入全部推理能力。思考过程用 <think></think> 标签包裹。\n强制执行的推理框架：\n### Phase 1: 理解\n- 用自己的话完整复述问题\n- 标记所有不确定的信息和假设\n- 识别问题的隐含前提和边界条件\n### Phase 2: 拆解\n- 将问题拆解为 2~5 个子问题\n- 理清子问题之间的依赖关系\n- 确定哪些可以并行思考，哪些必须串行\n### Phase 3: 深度推理\n- 对每个子问题，从第一性原理出发逐步推导\n- 列举所有合理的替代方案或解释\n- 对每种方案进行优劣比较\n- 标注推理中的薄弱环节\n### Phase 4: 整合\n- 检查子问题之间的衔接是否自洽\n- 回溯到原始问题，确认是否完整回答\n- 标注遗留的未解决问题\n### Phase 5: 验证\n- 如果可能，用另一种方式验证结论\n- 设定检验标准：什么情况下你的答案会被证明是错的？\n思考不设上限。宁可多想一步，不可遗漏关键。所有分析用 <think> 标签包裹。\n\n## 提问限制\n每次最多向用户提 2-5 个问题。极致推理要求穷尽所有不确定因素，对发现的任何歧义、遗漏或需确认的前提都应向用户追问。\n' + _MOOD_SPEC,
};

/** 前端展示策略 */
export interface ThinkingDisplayConfig {
  showThinkBlock: boolean;
  thinkCollapsed: boolean;
  thinkDimmed: boolean;
  showMood: boolean;
  moodCollapsed: boolean;
}

export const DISPLAY_CONFIGS: Record<ThinkingLevel, ThinkingDisplayConfig> = {
  off: { showThinkBlock: false, thinkCollapsed: true, thinkDimmed: true, showMood: false, moodCollapsed: true },
  low: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true, showMood: false, moodCollapsed: true },
  medium: { showThinkBlock: true, thinkCollapsed: false, thinkDimmed: true, showMood: true, moodCollapsed: true },
  high: { showThinkBlock: true, thinkCollapsed: false, thinkDimmed: true, showMood: true, moodCollapsed: false },
  max: { showThinkBlock: true, thinkCollapsed: false, thinkDimmed: true, showMood: true, moodCollapsed: false },
};

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

export type AiChatNodeData = {
  title: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  nodeMdId?: string;  // .md 文件持久化 ID（UUID），首次对话时生成
  [key: string]: unknown;
};

export type GuideDirection = 'top' | 'bottom' | 'left' | 'right';

/** 上下方向创建子节点（层级关系），左右方向创建同级节点（平等关系） */
export type NodeRelation = 'child' | 'sibling';

export const GUIDE_OFFSET = 280;
export const NODE_WIDTH = 320;

/** 根据引导方向推断节点关系类型 */
export function getRelation(direction: GuideDirection): NodeRelation {
  return direction === 'top' || direction === 'bottom' ? 'child' : 'sibling';
}
