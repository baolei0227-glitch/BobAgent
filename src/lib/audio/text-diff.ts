/**
 * 行级 AI 润色的**修订对照**（"改了哪些字"的纯函数，UI 只负责上色）。
 *
 * 为什么单独一个文件：差异算法要可测、要能在客户端组件里值引入（不能拖 node 内置模块）；
 * 摘要与面板共用同一份口径，避免"预览里显示改了三个字、落盘后却不一样"。
 *
 * 分词口径（**按字符**，空白连成一段）：
 *   - 中英文都按**单个字符**比 —— AI 修的是错字/标点，按词比会把整个词判成"删掉再插入"，
 *     反而看不出到底改了哪个字（Word 的修订也是按字符着色）；
 *   - 空白（空格/换行）连成一段，避免逐空格比较产出一堆碎片。
 *
 * 代价与兜底：LCS 动态规划是 O(n·m)；一行稿子通常 ≤400 字，规模很小。
 * 超过 `maxTokens` 时退回"公共前后缀 + 中间整块替换"——对照会变粗，但不会把界面卡住。
 */

/** 一段差异：`same` 原文保留、`del` 被删掉、`ins` 新增 */
export interface DiffOp {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** 空白连成一段，其余每个字符（含中文、拉丁字母、标点）各成一个 token */
const TOKEN_RE = /\s+|[\s\S]/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** 相邻同类 op 合并（否则渲染出来是"删一个字、再删一个字"的一堆碎片） */
function push(out: DiffOp[], type: DiffOp['type'], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === type) last.text += text;
  else out.push({ type, text });
}

/** 规模过大时的粗对照：公共前缀/后缀原样保留，中间整块"删旧 + 插新" */
function coarseDiff(a: string[], b: string[]): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const out: DiffOp[] = [];
  push(out, 'same', a.slice(0, head).join(''));
  push(out, 'del', a.slice(head, a.length - tail).join(''));
  push(out, 'ins', b.slice(head, b.length - tail).join(''));
  push(out, 'same', a.slice(a.length - tail).join(''));
  return out;
}

/**
 * `before` → `after` 的最小差异序列。
 *
 * 完全相同时返回单个 `same`（调用方据此判断"没改"，不要渲染空的修订条）。
 */
export function diffText(before: string, after: string, maxTokens = 1200): DiffOp[] {
  const src = String(before ?? '');
  const dst = String(after ?? '');
  if (src === dst) return src ? [{ type: 'same', text: src }] : [];

  const a = tokenize(src);
  const b = tokenize(dst);
  if (a.length === 0) return b.length ? [{ type: 'ins', text: dst }] : [];
  if (b.length === 0) return [{ type: 'del', text: src }];
  if (a.length > maxTokens || b.length > maxTokens || a.length * b.length > maxTokens * maxTokens) {
    return coarseDiff(a, b);
  }

  // 从后往前填 LCS 长度表（`dp[i][j]` = a[i..] 与 b[j..] 的最长公共子序列长度）
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const nextRow = row + w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        a[i] === b[j] ? dp[nextRow + j + 1] + 1 : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }

  // 回溯：相同就保留；否则往"保留更多"的一侧走（相等时先删后插，读起来更接近 Word 的修订习惯）
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(out, 'same', a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push(out, 'del', a[i]);
      i++;
    } else {
      push(out, 'ins', b[j]);
      j++;
    }
  }
  while (i < n) push(out, 'del', a[i++]);
  while (j < m) push(out, 'ins', b[j++]);
  return out;
}
