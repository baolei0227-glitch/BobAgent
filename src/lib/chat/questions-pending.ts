/**
 * AI 提问挂起机制（跨请求共享）
 *
 * 流程：模型调用 ask_user_questions 工具时，route.ts 解析出 questions 数组，
 * 调用 createPendingQuestions 生成 requestId + Promise，通过 SSE 的 questions_request
 * 事件把 questions 发给前端；前端弹结构化表单，用户提交后 POST /api/chat/questions
 * 回传 answers，resolvePendingQuestions 找到对应 Promise 并 resolve，工具循环把
 * answers 作为 tool_result 返回给模型继续生成。超时/关闭未回传按 null 处理，避免挂起泄漏。
 */

/** 单个问题定义（与前端 QuestionPopup 一致） */
export interface PendingQuestionItem {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

/** 用户对单个问题的回答 */
export interface PendingAnswerEntry {
  questionId: string;
  selected: string | null;
  custom: string;
}

type PendingEntry = {
  questions: PendingQuestionItem[];
  nodeId?: string;
  resolve: (answers: PendingAnswerEntry[] | null) => void;
  timer: NodeJS.Timeout;
};

const pendingMap = new Map<string, PendingEntry>();

/** 默认提问等待时长（毫秒），超时视为未回答（null） */
export const QUESTIONS_TIMEOUT_MS = 120_000;

/**
 * 登记一个待回传的提问请求。
 * 返回 requestId 与 Promise：前端回传后 resolve(answers)，超时/关闭 resolve(null)。
 */
export function createPendingQuestions(
  questions: PendingQuestionItem[],
  nodeId?: string,
): { requestId: string; promise: Promise<PendingAnswerEntry[] | null> } {
  const requestId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const promise = new Promise<PendingAnswerEntry[] | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingMap.delete(requestId);
      resolve(null); // 超时视为未回答
    }, QUESTIONS_TIMEOUT_MS);
    pendingMap.set(requestId, {
      questions,
      nodeId,
      resolve: (answers: PendingAnswerEntry[] | null) => {
        clearTimeout(timer);
        pendingMap.delete(requestId);
        resolve(answers);
      },
      timer,
    });
  });
  return { requestId, promise };
}

/**
 * 回传提问答案。找到并 resolve 对应挂起项，返回 true；无此 requestId 返回 false。
 */
export function resolvePendingQuestions(requestId: string, answers: PendingAnswerEntry[]): boolean {
  const entry = pendingMap.get(requestId);
  if (!entry) return false;
  entry.resolve(Array.isArray(answers) ? answers : []);
  return true;
}