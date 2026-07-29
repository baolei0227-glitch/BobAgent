import {
  appendConversation,
  parseNodeMarkdown,
  serializeNode,
  updateNodeFile,
  findNodeFileById,
  cleanTitleText,
  renameNodeFile,
  isTemporaryFileName,
  type NodeMood,
  type NodeMarkdown,
} from './node-markdown';
import { promises as fs } from 'fs';
import { basename } from 'path';

const SUMMARY_MAX_LEN = 100;
const SUMMARY_TIMEOUT_MS = 30000;

function fallbackSummary(text: string): string {
  const clean = text.replace(/\n/g, ' ').trim();
  return clean.length > SUMMARY_MAX_LEN
    ? clean.slice(0, SUMMARY_MAX_LEN) + '...'
    : clean;
}

export interface GenerateSummaryOptions {
  question: string;
  answer: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

export interface GenerateSummaryResult {
  content: string;
  isFallback: boolean;
}

export async function generateSummary({
  question,
  answer,
  apiKey,
  baseUrl,
  providerModelId,
}: GenerateSummaryOptions): Promise<GenerateSummaryResult> {
  if (apiKey && baseUrl && providerModelId) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      const completionPromise = client.chat.completions.create({
        model: providerModelId,
        messages: [
          {
            role: 'system',
            content:
              '你是一个摘要生成器。请用一句话（100字以内）总结用户问题和AI回答的核心内容。直接输出摘要，不要加任何前缀或解释。',
          },
          {
            role: 'user',
            content: `问题：${question}\n\n回答：${answer.slice(0, 50000)}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 150,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('摘要生成超时')), SUMMARY_TIMEOUT_MS),
      );

      const completion = await Promise.race([completionPromise, timeoutPromise]);
      const result = completion.choices[0]?.message?.content?.trim() || '';

      if (result) {
        return { content: result, isFallback: false };
      }
    } catch (e) {
      console.warn('摘要生成失败，使用 fallback:', e instanceof Error ? e.message : String(e));
    }
  }

  return { content: fallbackSummary(answer), isFallback: true };
}

export interface HandleQaCompleteOptions {
  nodeId: string;
  question: string;
  answer: string;
  questionTime?: string;
  answerTime?: string;
  mood?: NodeMood;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

export interface HandleQaCompleteResult {
  success: boolean;
  nodeId: string;
  summary?: string;
  isFallback?: boolean;
  wasRenamed?: boolean;
  error?: string;
}

export async function handleQaComplete(
  options: HandleQaCompleteOptions,
): Promise<HandleQaCompleteResult> {
  const { nodeId, question, answer, questionTime, answerTime, mood, apiKey, baseUrl, providerModelId } = options;

  try {
    const filePath = await findNodeFileById(nodeId);
    if (!filePath) {
      return { success: false, nodeId, error: '节点文件不存在' };
    }

    let wasRenamed = false;
    let currentFilePath = filePath;

    const content = await fs.readFile(filePath, 'utf-8');
    const node = parseNodeMarkdown(content);

    const isFirstQa = node.conversations.length === 0;

    let derivedTitle: string | undefined;
    if (isFirstQa) {
      derivedTitle = cleanTitleText(question).slice(0, 20) || '未命名节点';

      const fileName = basename(filePath);
      if (isTemporaryFileName(fileName)) {
        try {
          const newPath = await renameNodeFile(filePath, derivedTitle);
          if (newPath !== filePath) {
            currentFilePath = newPath;
            wasRenamed = true;
          }
        } catch (renameErr) {
          console.warn('首次问答重命名文件失败:', renameErr instanceof Error ? renameErr.message : String(renameErr));
        }
      }
    }

    const summaryResult = await generateSummary({
      question,
      answer,
      apiKey,
      baseUrl,
      providerModelId,
    });

    const updatedContent = appendConversation(content, question, answer, {
      questionTime,
      answerTime,
      mood,
      summary: summaryResult.content,
      title: derivedTitle,
    });

    await updateNodeFile(currentFilePath, updatedContent, { validate: false });

    return {
      success: true,
      nodeId,
      summary: summaryResult.content,
      isFallback: summaryResult.isFallback,
      wasRenamed,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, nodeId, error: message };
  }
}
