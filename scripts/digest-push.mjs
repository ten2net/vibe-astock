#!/usr/bin/env node
/**
 * 每日「分时资金榜」digest 推送到企业微信群机器人(可选集成,默认完全不运行)。
 *
 * 商业化推广第 2 步(内容寄生)的最小管道:把产品每天已有的客观读数
 * (shortline_fflow 视图:当日分钟资金「横盘→拉升」榜)摘要推到群里,
 * 末尾带产品链接。只发**已发生的客观资金形态**,不荐股、不预测(口径同产品)。
 *
 * 🔴 纯增量、零副作用:不改任何现有代码路径;不配置环境变量就一行都不跑。
 *    只读本机 API 的一个只读 GET,不写任何状态。
 *
 * 用法(cron / 手动均可,建议每个交易日 15:35 之后):
 *   VRA_PUSH_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx \
 *     node scripts/digest-push.mjs
 *   VRA_PUSH_DRYRUN=1 node scripts/digest-push.mjs        # 只打印不发送(联调)
 *
 * 环境变量:
 *   VRA_PUSH_WEBHOOK  企业微信群机器人 webhook(必填,除非 dry-run)
 *   VRA_PUSH_API      本机 API 地址,默认 http://127.0.0.1:8770
 *   VRA_PUSH_TOKEN    API token;不给则读 <仓库>/.local/api.token(与页面同一份)
 *   VRA_PUSH_LINK     digest 末尾的产品链接(可选)
 *   VRA_PUSH_DRYRUN=1 只打印 webhook 负载,不发送
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 纯函数:视图 → 企业微信 markdown。上限 3800 字节,超出只保留前 5 行榜单。 */
export function buildDigest(view, opts = {}) {
  const day = view?.day ?? "今日";
  const link = opts.link ?? "";
  const wan = (yuan) => (typeof yuan === "number" && Number.isFinite(yuan) ? `${(yuan / 1e4).toFixed(0)}万` : "—");
  const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%` : "—");
  const lines = [
    `**分时资金 · 横盘后拉升榜(${day})**`,
    `扫描 ${view?.total_scanned ?? "—"} 只,命中 ${view?.matched ?? 0} 只 · 通道:${view?.source_label ?? "—"}`,
  ];
  const stocks = Array.isArray(view?.stocks) ? view.stocks : [];
  if (!stocks.length) {
    lines.push("今日无命中形态(横盘→稳步拉升)的票。", `说明:${(view?.notes ?? []).join(" · ") || "—"}`);
  } else {
    for (const [i, s] of stocks.slice(0, 5).entries()) {
      lines.push(`${i + 1}. **${s.name ?? s.code}**(${s.code}) ${pct(s.pct)} 主力${wan(s.main_net)} 横盘${s.flat_minutes ?? "—"}分→拉升${s.rise_minutes ?? "—"}分 +${s.rise_bp ?? "—"}bp`);
    }
    if (stocks.length > 5) lines.push(`…共 ${stocks.length} 只,其余见产品内榜单`);
  }
  lines.push("客观资金形态,非推荐、非预测。");
  if (link) lines.push(`[打开榜单](${link})`);
  let content = lines.join("\n");
  // 企业微信 markdown 上限 4096 字节;留余量,超出时只截榜单行
  while (Buffer.byteLength(content, "utf8") > 3800 && lines.length > 4) {
    lines.splice(3, 1);
    content = lines.join("\n");
  }
  return content;
}

async function main() {
  const dry = process.env.VRA_PUSH_DRYRUN === "1" || process.argv.includes("--dry-run");
  const webhook = process.env.VRA_PUSH_WEBHOOK ?? "";
  if (!webhook && !dry) {
    console.error("未配置 VRA_PUSH_WEBHOOK(企业微信群机器人地址)。本脚本默认不运行;设 VRA_PUSH_DRYRUN=1 可只看输出。");
    process.exit(1);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const api = process.env.VRA_PUSH_API ?? "http://127.0.0.1:8770";
  const token = process.env.VRA_PUSH_TOKEN
    ?? fs.readFileSync(path.join(repoRoot, ".local", "api.token"), "utf8").trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  let view;
  try {
    const res = await fetch(`${api}/view/shortline_fflow`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    view = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const payload = {
    msgtype: "markdown",
    markdown: { content: buildDigest(view, { link: process.env.VRA_PUSH_LINK ?? "" }) },
  };
  if (dry) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }
  const sent = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (sent?.errcode !== 0) {
    console.error(`企业微信返回错误:${sent?.errmsg ?? JSON.stringify(sent)}`);
    process.exit(1);
  }
  console.log(`已推送(${view?.day ?? "?"} 榜单 ${view?.stocks?.length ?? 0} 条)`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => {
    console.error(`推送失败:${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
