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
  /** 用户在弹窗末页「补充信息」自由填写的附加说明，随答案一并透传给模型（仅存内存） */
  supplement: string;
  resolve: (answers: PendingAnswerEntry[] | null) => void;
  timer: NodeJS.Timeout;
};

const pendingMap = new Map<string, PendingEntry>();

/** 提问等待时长（毫秒）：10 分钟。用户可能切走处理别的事情（弹窗可最小化稍后回来作答）；
 *  页面关闭/刷新时前端会经 pagehide + keepalive fetch 立即按「未回答」解除挂起，
 *  此超时仅作为「用户消失且无任何兜底信号」时的最后防线，正常路径不会触发。 */
export const QUESTIONS_TIMEOUT_MS = 600_000;

/**
 * 登记一个待回传的提问请求。
 * 返回 requestId 与 Promise：前端回传后 resolve(answers)，超时/关闭 resolve(null)；
 * getSupplement 供 route.ts 在 await promise 之后读取用户补充说明
 * （闭包持有 entry 引用，resolve 触发 pendingMap 删除后仍可读取）。
 */
export function createPendingQuestions(
  questions: PendingQuestionItem[],
  nodeId?: string,
): {
  requestId: string;
  promise: Promise<PendingAnswerEntry[] | null>;
  getSupplement: () => string;
} {
  const requestId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  let resolveFn!: (answers: PendingAnswerEntry[] | null) => void;
  const promise = new Promise<PendingAnswerEntry[] | null>((resolve) => {
    resolveFn = resolve;
  });
  const entry: PendingEntry = {
    questions,
    nodeId,
    supplement: '',
    resolve: (answers: PendingAnswerEntry[] | null) => {
      clearTimeout(entry.timer);
      pendingMap.delete(requestId);
      resolveFn(answers);
    },
    timer: setTimeout(() => {
      pendingMap.delete(requestId);
      resolveFn(null); // 超时视为未回答
    }, QUESTIONS_TIMEOUT_MS),
  };
  pendingMap.set(requestId, entry);
  return { requestId, promise, getSupplement: () => entry.supplement };
}

/**
 * 回传提问答案。找到并 resolve 对应挂起项，返回 true；无此 requestId（已超时/已回传）返回 false。
 * supplement 为弹窗末页「补充信息」的自由文本（可选），随答案一并暂存到挂起项上。
 */
export function resolvePendingQuestions(
  requestId: string,
  answers: PendingAnswerEntry[],
  supplement?: string,
): boolean {
  const entry = pendingMap.get(requestId);
  if (!entry) return false;
  if (typeof supplement === 'string') entry.supplement = supplement;
  entry.resolve(Array.isArray(answers) ? answers : []);
  return true;
}
