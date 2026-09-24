/**
 * 股票名 / 代码 → 雪球个股页链接。
 *
 * 两个用途：
 *  1. 结构化表格：`<StockNameLink code={...} name={...} />`，把股票名做成链接。
 *  2. AI 生成的 Markdown 正文：`remarkStockLinks` 插件在 mdast 层把文本里
 *     的股票引用替换成链接节点 —— 走 AST 而不是字符串拼 HTML，不会引入
 *     dangerouslySetInnerHTML，也就没有 XSS 面。
 *
 * 没有代码的地方一律不加链接：链接需要代码，拿不到就不伪造成可点。
 */
import { ExternalLink } from "lucide-react";
import { cn } from "./utils";

const XUEQIU_BASE = "https://xueqiu.com/S/";

// A 股有效代码段：沪主板/科创板 60/68、深主板/创业板 00/30、北交所 4/8、
// B 股 9、基金 5 与 15/16。
// 用具体段而不是「任意 6 位数字」，是为了少误伤正文里的金额、股数、点位。
const CODE = "(?:6[08]\\d{4}|0[03]\\d{4}|3[01]\\d{4}|[48]\\d{5}|9\\d{5}|5\\d{5}|1[56]\\d{4})";

/** 6 位代码 → 雪球代码（SH600699 / SZ000725 / BJ830799），非 A 股代码返回 null */
export function stockSymbol(code: string | null | undefined): string | null {
  const c = (code || "").trim();
  if (!new RegExp(`^${CODE}$`).test(c)) return null;
  if (/^[695]/.test(c)) return "SH" + c;
  if (/^[48]/.test(c)) return "BJ" + c;
  return "SZ" + c;
}

export function stockUrl(code: string | null | undefined): string | null {
  const symbol = stockSymbol(code);
  return symbol ? XUEQIU_BASE + symbol : null;
}

const LINK_CLASS =
  "underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:decoration-primary hover:text-primary";

/** 股票名链接。缺代码或代码不是 A 股（美股 AAPL、港股 700.HK 等）时退化为纯文本。 */
export function StockNameLink({
  code,
  name,
  className,
}: {
  code?: string | null;
  name: string;
  className?: string;
}) {
  const url = stockUrl(code);
  if (!url) return <>{name}</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${name} ${code} · 在雪球查看`}
      className={cn(LINK_CLASS, className)}
    >
      {name}
    </a>
  );
}

/** 旁挂的小图标外链 —— 用在名称本身已经是站内链接的场合，不抢走原跳转。 */
export function StockExternalBadge({
  code,
  name,
  className,
}: {
  code?: string | null;
  name?: string;
  className?: string;
}) {
  const url = stockUrl(code);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${name ? name + " " : ""}${code} · 在雪球查看`}
      aria-label="在雪球查看"
      className={className ?? "ml-1 inline-flex align-middle text-muted-foreground hover:text-primary"}
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Markdown 正文
// ---------------------------------------------------------------------------

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// 「中际旭创(300308)」这类写法整体变链接（括号支持中英文）。
// 名称部分排除空白与中英文标点：否则「…成交额居前，亨通光电（600487）」会把前面
// 半句话一起吞进链接文本。中文没有词边界，「领涨股中际旭创」这类前缀仍会带上，
// 但链接指向的代码始终正确。
const NAME_WITH_CODE = new RegExp(
  `([^\\s（(,，。；;：:、！？!?\"“”‘’]{1,10})[（(](${CODE})[)）]`,
  "g",
);
// 裸露的 6 位代码。前后用断言排除更长数字串的一部分（如 1234567 或 12.345678）。
const BARE_CODE = new RegExp(`(?<![0-9.])(${CODE})(?![0-9])`, "g");

function bareCodeNodes(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  BARE_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_CODE.exec(value))) {
    const code = m[1];
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "link",
      url: XUEQIU_BASE + stockSymbol(code),
      children: [{ type: "text", value: code }],
    });
    last = m.index + code.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** 把一个文本节点拆成 [文本, 链接, 文本, ...] */
function linkifyText(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  NAME_WITH_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_WITH_CODE.exec(value))) {
    const [full, _name, code] = m;
    if (m.index > last) out.push(...bareCodeNodes(value.slice(last, m.index)));
    out.push({
      type: "link",
      url: XUEQIU_BASE + stockSymbol(code)!,
      children: [{ type: "text", value: full }],
    });
    last = m.index + full.length;
  }
  if (last < value.length) out.push(...bareCodeNodes(value.slice(last)));
  return out;
}

function walk(node: MdNode): void {
  if (!Array.isArray(node.children)) return;
  // 链接内部、行内代码与代码块不处理：避免嵌套链接，也不该改动代码原文。
  if (node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...linkifyText(child.value));
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

/** remark 插件：把正文里的股票引用变成雪球链接。 */
export function remarkStockLinks() {
  return (tree: MdNode) => {
    walk(tree);
    return tree;
  };
}
