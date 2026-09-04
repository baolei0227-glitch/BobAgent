/**
 * bob-notes-mcp 共享类型契约（宿主侧，纯类型、零运行时依赖）
 *
 * 宿主 UI / executor / chat 工具经 /api/notebook 与 bob-notes-mcp 通信，
 * 此处只声明数据形状，不包含任何笔记实现。类型定义与插件 src/store.ts 对齐。
 */

/** 笔记类型（Karpathy LLM Wiki 的概念分类） */
export type WikiEntryType = 'concept' | 'source' | 'note' | 'todo';

/** 编译层笔记条目元数据（正文在 wiki/{id}.md） */
export interface WikiEntry {
  id: string;
  title: string;
  type: WikiEntryType;
  tags: string[];
  links: string[];
  sourceIds: string[];
  weight: number;
  lastReviewedAt: string | null;
  date: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
}

/** 素材层条目（raw/index.json 单条） */
export interface RawItem {
  id: string;
  title: string;
  source?: string;
  status: 'uncompiled' | 'compiled';
  compiledEntryIds: string[];
  createdAt: string;
}

/** 笔记条目 + 正文（GET /api/notebook mode=full / /note check 返回） */
export type WikiEntryWithContent = WikiEntry & { content: string };

/** 查询过滤条件 */
export interface EntryFilter {
  query?: string;
  tag?: string;
  type?: WikiEntryType;
  from?: string;
  to?: string;
}

/** 标签索引分组（read index 模式用） */
export interface TagGroup {
  name: string;
  tags: Array<{ tag: string; count: number }>;
}

/** /api/notebook GET 响应 */
export interface NotebookQueryResponse {
  success: boolean;
  error?: string;
  total?: number;
  matched?: number;
  parsed?: { keywords: string[]; from?: string; to?: string } | null;
  groups?: TagGroup[];
  entries?: WikiEntryWithContent[];
}
