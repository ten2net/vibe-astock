/**
 * 新版 VA 沿用旧版规矩:用户自己的成交、持仓和交易日志**不交给模型**(旧版 server.py「不接入任何 AI prompt」)。
 * 聊天助手读台账只走 read_ledger,MCP 桥给本机 CLI 的也是同一组工具 ⇒ 这里守住 read_ledger 的返回。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assistantTools, ledgerUpsert, serviceContext } from "../src/service.ts";
import { FINANCE_LEDGER_KINDS } from "../src/finance/ledger_kinds.ts";
import "../src/finance/register.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HIDDEN = ["closed_position", "trade", "position", "journal_tag", "journal_settings", "mode_card"];

test("read_ledger 不返回成交、持仓和交易日志,只说明哪些没给", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "va-ledger-ai-"));
  try {
    const ctx = { ...serviceContext({ repoRoot: repo }), dataRoot };
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "600519", name: "贵州茅台", note: "自选备注WATCH" } });
    ledgerUpsert(ctx, { kind: "note", record: { title: "研究笔记NOTE" } });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300308", type: "buy", date: "2026-10-09", shares: 1234, price: 98.76, note: "成交备注TRADE" } });
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 4321, cost: 11.11, note: "持有备注POS" } });
    ledgerUpsert(ctx, { kind: "closed_position", record: { symbol: "000002", closed_at: "2026-10-08", price: 7.77, shares: 500, cost: 8.88, note: "清仓备注CLOSED" } });

    const tool = assistantTools(ctx, { provider: "cli-claude", model: "", apiKey: "" }).find((t) => t.name === "read_ledger")!;
    const out = await tool.run(tool.schema.parse({}) as never, new AbortController().signal) as { records: Record<string, unknown[]>; withheld: string[] };
    const text = JSON.stringify(out);
    assert.equal(out.records.watch?.length, 1);
    assert.equal(out.records.note?.length, 1);
    for (const k of HIDDEN) assert.equal(k in out.records, false, `${k} 不该给模型`);
    for (const secret of ["300308", "1234", "98.76", "TRADE", "000001", "4321", "11.11", "POS", "000002", "CLOSED", "8.88"]) {
      assert.equal(text.includes(secret), false, `返回里不该出现 ${secret}`);
    }
    assert.deepEqual([...out.withheld].sort(), HIDDEN.map((k) => FINANCE_LEDGER_KINDS[k]!.label).sort());
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("带金额、数量或成本字段的台账种类必须标 hiddenFromAssistant(新增种类别漏)", () => {
  const money = /^(price|shares|cost|amount|fee|capital|ratio)$/;
  for (const [k, def] of Object.entries(FINANCE_LEDGER_KINDS)) {
    if (Object.keys(def.properties).some((f) => money.test(f))) assert.equal(def.hiddenFromAssistant, true, `${k} 有金额类字段,要标不交给模型`);
  }
  for (const k of HIDDEN) assert.equal(FINANCE_LEDGER_KINDS[k]!.hiddenFromAssistant, true, k);
});

test("聊天助手的工具里只有 read_ledger 读台账", () => {
  const tools = assistantTools(serviceContext({ repoRoot: repo }), { provider: "cli-claude", model: "", apiKey: "" });
  assert.deepEqual(tools.filter((t) => /ledger|holding|position|trade|journal/i.test(t.name)).map((t) => t.name), ["read_ledger"]);
});
