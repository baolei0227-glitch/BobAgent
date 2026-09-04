export type ParseMode = 'general' | 'document' | 'screenshot' | 'chart' | 'casual' | 'ledger' | 'detectAll';

export interface ParseResult {
  file_name: string;
  file_type: 'image' | 'pdf' | 'video' | 'audio';
  mime_type: string;
  extracted_text: string;
  page_count?: number;
  frame_count?: number;
  parse_method: 'vision' | 'text_extract' | 'frame_extract' | 'stt';
  parsed_at: string;
  stats?: {
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
  };
  file_hash: string;
}

export interface VisionConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  mode: ParseMode;
  custom_prompt?: string;
  detail_level?: 'auto' | 'low' | 'high';
  /** 请求超时（毫秒）。默认 30000；重识别类任务（detectAll 等）模型响应可能超过 30s，按需调大 */
  timeout?: number;
}

export interface VisionResult {
  description: string;
  success: boolean;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
}

export type ImageInput =
  | { type: 'base64'; data: string; mimeType: string }
  | { type: 'file'; path: string };

export interface ParseCacheRecord {
  hash: string;
  result: ParseResult;
  cached_at: string;
}

export interface IpcSuccess<T> {
  success: true;
  data: T;
}

export interface IpcError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type IpcResult<T> = IpcSuccess<T> | IpcError;