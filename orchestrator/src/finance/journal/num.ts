/**
 * 交易日志的数字工具。算法移植自 Vibe AStock v2.0.0(Python),对账时要逐项一致,所以舍入照 Python 的 round。
 */

/**
 * 和 Python `round(x, n)` 同一结果:按 double 的**精确**十进制值舍入,恰好一半时取偶数。
 * ⚠️ `Number(x.toFixed(n))` 恰好一半时往大的进(12.125 → 12.13,Python 是 12.12)。
 *    钱数是分的整数倍除出来的,恰好一半(x.125 / x.375 …)真会出现,对账就差一分。
 * toFixed(100) 给出 double 的精确十进制展开(规范要求),在字符串上进位,不再经过浮点运算。
 */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0;
  const [ip, fp = ""] = Math.abs(x).toFixed(100).split(".");
  const keep = fp.slice(0, n), rest = fp.slice(n);
  let digits = ip! + keep;
  const first = rest[0] ?? "0";
  const tail = rest.slice(1);
  const odd = Number(digits[digits.length - 1]) % 2 === 1;
  const up = first > "5" || (first === "5" && (/[1-9]/.test(tail) || odd));
  if (up) {
    const arr = digits.split("");
    let i = arr.length - 1;
    for (; i >= 0; i--) {
      if (arr[i] === "9") { arr[i] = "0"; continue; }
      arr[i] = String(Number(arr[i]) + 1);
      break;
    }
    digits = (i < 0 ? "1" : "") + arr.join("");
  }
  const intLen = digits.length - n;
  const v = Number(n > 0 ? `${digits.slice(0, intLen)}.${digits.slice(intLen)}` : digits);
  return neg && v !== 0 ? -v : v;
}

/**
 * 求和用 Neumaier 补偿:Python 3.12 起内置 sum() 对浮点就是这么加的,statistics.mean 更是按精确分数求和。
 * 普通累加几十笔之后会差几个末位,碰上舍入边界对账就差一分。
 */
export function sum(vals: readonly number[]): number {
  let s = 0, c = 0;
  for (const v of vals) {
    const t = s + v;
    c += Math.abs(s) >= Math.abs(v) ? (s - t) + v : (v - t) + s;
    s = t;
  }
  return s + c;
}

/** double 的精确值 = 整数 × 2^-1074(所有有限 double 都是 2^-1074 的整数倍) */
function scaled(x: number): bigint {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  const hi = v.getUint32(0), lo = v.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  const m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  const n = exp === 0 ? m : (m | (1n << 52n)) << BigInt(exp - 1);
  return hi >>> 31 ? -n : n;
}
const bitLen = (v: bigint) => v.toString(2).length;
/** 分数 p / q(q > 0)按 IEEE 就近取偶转成 double,和 Python int / int、float(Fraction) 一样 */
function ratio(p: bigint, q: bigint): number {
  if (p === 0n) return 0;
  const neg = p < 0n;
  if (neg) p = -p;
  // 商留 55~56 位,再舍到 53 位;余数只用来判断「恰好一半」还是「过半」
  const shift = 55 - (bitLen(p) - bitLen(q));
  const num = shift >= 0 ? p << BigInt(shift) : p, den = shift >= 0 ? q : q << BigInt(-shift);
  let qt = num / den;
  const sticky = num % den !== 0n;
  const extra = bitLen(qt) - 53;
  const low = qt & ((1n << BigInt(extra)) - 1n), half = 1n << BigInt(extra - 1);
  qt >>= BigInt(extra);
  if (low > half || (low === half && (sticky || (qt & 1n) === 1n))) qt += 1n;
  const e = extra - shift;
  let v: number;
  if (e + 52 >= -1022) v = Number(qt) * 2 ** e;
  else {
    // 非规格化(绝对值 < 2^-1022):精度只到 2^-1074,按它的整数倍重新就近取偶
    const a = p << 1074n;
    let k = a / q;
    const r2 = (a % q) * 2n;
    if (r2 > q || (r2 === q && (k & 1n) === 1n)) k += 1n;
    v = Number(k) * 2 ** -1074;
  }
  return neg ? -v : v;
}

/**
 * 和 Python `statistics.mean` 同一结果:先按精确分数求和、除以个数,最后只舍入一次。
 * ⚠️ 不能写成 sum / n:那是两次舍入,碰上 x.xx5 这种恰好一半的平均数(三笔 1.00 / 1.00 / 1.015)会差一分。
 */
export function mean(vals: readonly number[]): number {
  if (!vals.length) throw new RangeError("mean of empty list");
  if (vals.some((x) => !Number.isFinite(x))) return sum(vals) / vals.length;
  let total = 0n;
  for (const x of vals) total += scaled(x);
  return ratio(total, BigInt(vals.length) << 1074n);
}

export function median(vals: readonly number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 真实存在的日历日。先判 NaN:`2025-13-01` 的 Invalid Date 调 toISOString 会抛错 */
export const realDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/** 两个日历日之间隔几天(b − a) */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
