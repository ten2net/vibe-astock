/**
 * 全站共用的股票名链接：名称 → 雪球个股页（站外，新窗口），旁边挂站内「去研究」图标。
 *
 * 需要「加入 / 移除自选」的地方用 `WatchToggle` 再挂一颗星（见 `StockNameWithWatch`），
 * 三样都是并列节点，不能嵌套 —— 浏览器里 <a> 套 <a>、<button> 套在 <a> 里都是非法结构
 * （后者还会吞掉点击）。
 *
 * 只认 A 股 6 位代码（沪 60/68/9、深 00/30、北 4/8、基金 5 与 15/16）；港美股代码不做链接，
 * 拿不到可点的依据就不伪造成可点。
 */
import { Link } from "react-router-dom";
import { Search, Star } from "lucide-react";
import { useWatchCodes } from "../hooks/useWatchCodes";

const XUEQIU_BASE = "https://xueqiu.com/S/";
const A_SHARE_CODE = /^(?:6[08]\d{4}|0[03]\d{4}|3[01]\d{4}|[48]\d{5}|9\d{5}|5\d{5}|1[56]\d{4})$/;

/** 6 位代码 → 雪球代码（SH600699 / SZ000725 / BJ830799），非 A 股返回 null */
export function xueqiuUrl(code: string | null | undefined): string | null {
  const c = (code || "").trim();
  if (!A_SHARE_CODE.test(c)) return null;
  if (/^[695]/.test(c)) return XUEQIU_BASE + "SH" + c;
  if (/^[48]/.test(c)) return XUEQIU_BASE + "BJ" + c;
  return XUEQIU_BASE + "SZ" + c;
}

/** 名称 → 雪球；名称旁边挂「去研究」站内图标 */
export function StockName({ code, name, className }: { code: string; name?: string | null; className?: string }) {
  const text = name || code;
  const url = xueqiuUrl(code);
  return (
    <>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={`${text} ${code} · 在雪球查看`}
          className={`underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:text-primary hover:decoration-primary ${className ?? ""}`}>
          {text}
        </a>
      ) : (
        <span className={className}>{text}</span>
      )}
      {code && (
        <Link to={`/research?symbol=${encodeURIComponent(code)}`} title={`${text} ${code} · 去研究`} aria-label="去研究"
          className="ml-1 inline-flex align-middle text-muted-foreground hover:text-primary">
          <Search className="h-3 w-3" />
        </Link>
      )}
    </>
  );
}

/**
 * 自选开关：不在自选 → 空心星「加入自选」；已在 → 实心星「移出自选」。
 * 写失败时 hook 会回滚并抛出，这里只把错误交给调用方显示，不自己吞。
 */
export function WatchToggle({ code, inWatch, onToggle, busy }: {
  code: string; inWatch: boolean; onToggle: (code: string) => void; busy?: boolean;
}) {
  return (
    <button type="button" disabled={busy} onClick={() => onToggle(code)}
      title={inWatch ? "移出自选" : "加入自选"} aria-label={inWatch ? "移出自选" : "加入自选"} aria-pressed={inWatch}
      className={`inline-flex align-middle disabled:opacity-50 ${inWatch ? "text-primary" : "text-muted-foreground hover:text-primary"}`}>
      <Star className="h-3 w-3" fill={inWatch ? "currentColor" : "none"} />
    </button>
  );
}

/**
 * 「名称 + 去研究 + 自选开关」三件套：表格里一行一只股票，直接用这个。
 *
 * 自选状态来自 `useWatchCodes`（台账真源 + 乐观更新），所以同一只票在这个页面加入后，
 * 别的页面读到的也是已加入；写失败会把星标回滚并把原因交给调用方显示。
 * 每行各自订阅而不是在外层订阅一次再往下传：列表里几百行时，只有被点的那行会重渲染。
 */
export function StockNameWithWatch({ code, name, className, onError }: {
  code: string; name?: string | null; className?: string; onError?: (msg: string) => void;
}) {
  const { codes, toggle } = useWatchCodes();
  return (
    <>
      <StockName code={code} name={name} className={className} />
      <WatchToggle
        code={code}
        inWatch={codes.includes(code)}
        onToggle={(c) => {
          void toggle(c).catch((e) => {
            onError?.(`${c} 没保存上：${e instanceof Error ? e.message : String(e)}`);
          });
        }}
      />
    </>
  );
}
