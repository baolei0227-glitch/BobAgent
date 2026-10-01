/**
 * 金额定点化工具：所有货币比较、勾稽一律改用「最小货币单位（分/円/セント等）整数」，
 * 避免 JS IEEE 754 浮点累积误差（10.12 - 10.11 !== 0.01）。
 *
 * 用法：
 *   const cent = toMinorUnit('1,204.80');  // 120480
 *   const diff = reconcile(prevCent, incomeCent, expenseCent, actualCent); // 0 = 平
 */

/** 千分位 / 货币符号 / 中英文逗号 / 空白 清洗后的原始数字串；无法识别返回 null */
export function cleanMoneyRaw(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).replace(/[,，¥￥$\s]/g, '').trim();
  if (!t || t === '-' || /[识别不清？？]/.test(t)) return null;
  return t;
}

/**
 * 把可读金额字符串转换为「分」的整数（2 位小数）。
 * 无法解析返回 null；超过 2 位小数按银行四舍六入五成双（此处用 Math.round 就近舍入）。
 */
export function toMinorUnit(raw: string | null | undefined, decimals = 2): number | null {
  const t = cleanMoneyRaw(raw);
  if (t == null) return null;
  const signed = t.startsWith('-') ? -1 : 1;
  const body = t.startsWith('-') ? t.slice(1) : t;
  // 仅允许 数字 + 1 个小数点
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const scale = Math.pow(10, decimals);
  const n = Math.round(parseFloat(body) * scale);
  if (!Number.isFinite(n)) return null;
  return n * signed;
}

/** 用勾稽方程校验一行：prevBalance + income - expense ≡ actualBalance（均为最小货币单位整数） */
export function reconcile(
  prevBalance: number | null,
  incomeCent: number,
  expenseCent: number,
  actualCent: number,
): number | null {
  if (prevBalance == null) return null;
  const expected = prevBalance + incomeCent - expenseCent;
  return expected - actualCent;
}

/** 还原为 2 位小数展示（仅 UI 输出，不得参与计算） */
export function formatMinorUnit(cent: number, decimals = 2): string {
  const scale = Math.pow(10, decimals);
  const sign = cent < 0 ? '-' : '';
  const abs = Math.abs(cent);
  const intPart = Math.floor(abs / scale);
  const fracPart = String(abs - intPart * scale).padStart(decimals, '0');
  return `${sign}${intPart.toLocaleString('en-US')}.${fracPart}`;
}
