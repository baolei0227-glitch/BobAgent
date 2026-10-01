/**
 * IFileSource 统一文件接口（Step 2）
 *
 * 设计原则（评审采纳）：
 * - 任何文件来源（本地/项目/附件/素材）实现同一接口，调用方只认接口不认来源。
 * - capabilities 声明字段：避免调用方通过来源类型做分支判断。
 * - 能力分层：可写来源实现 IWritableSource，不把 optional 方法塞进 IFileSource。
 */

/** 来源类型（对应"空间站"的对接端口标识）
 *  - transient：临时（未保存）来源——内容驻留内存，只读展示，由用户决定是否落盘到项目 */
export type FileSourceKind = 'local' | 'project' | 'attachment' | 'material' | 'transient';

/** 来源能力声明（调用方据此决定可用操作，而非判断来源类型） */
export interface FileSourceCapabilities {
  writable: boolean;
  searchable: boolean;
  watchable: boolean;
}

/** 统一文件信息（UnifiedViewer 等消费方使用） */
export interface FileInfo {
  name: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  size: number;
  /** 扩展名（带点号，如 ".pdf"） */
  extension: string;
  full_path?: string;
}

/** 搜索命中项 */
export interface SearchHit {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: string;
  extension?: string;
  /** 来源标识（后端 search API 返回：local/attachment/material） */
  source?: string;
}

/** 统一文件来源接口 */
export interface IFileSource {
  readonly kind: FileSourceKind;
  readonly label: string;
  readonly capabilities: FileSourceCapabilities;
  /** 读取文件（文本/图片/base64 / 二进制元信息） */
  read(path: string): Promise<FileInfo>;
  /** 返回可直接请求的代理 URL（供 PdfViewer/iframe/img 使用），二进制流由调用方 fetch */
  proxy(path: string): Promise<string>;
  /** 文件名检索（来源支持时可用） */
  search?(query: string): Promise<SearchHit[]>;
}

/** 可写来源接口（能力分层，不并入 IFileSource） */
export interface IWritableSource extends IFileSource {
  write(path: string, content: string): Promise<void>;
  rename(path: string, newName: string): Promise<{ newPath: string }>;
  remove(path: string): Promise<void>;
}

/** file.open 事件载荷：任意舱发布，查看舱订阅 */
export interface FileOpenPayload {
  source: FileSourceKind;
  path: string;
  name: string;
  /** 可选定位锚点：跳转到 PDF 指定页（1-based，来自检索命中/对话引用/批注） */
  page?: number;
  /** 可选定位锚点：在文档内检索并高亮的关键词片段 */
  query?: string;
}
