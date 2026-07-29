export type ParseMode = 'general' | 'document' | 'screenshot' | 'chart' | 'casual';

export interface ParseResult {
  file_name: string;
  file_type: 'image' | 'pdf' | 'video';
  mime_type: string;
  extracted_text: string;
  page_count?: number;
  frame_count?: number;
  parse_method: 'vision' | 'text_extract' | 'frame_extract';
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