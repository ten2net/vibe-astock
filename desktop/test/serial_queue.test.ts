// 交易日志写动作排队(审计 3.9):两个表单同时提交、先点的晚回来,不能把后点的结果盖回旧值。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { serialQueue } from "../src/verticals/finance/lib/serialQueue.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("🔴 后点的写动作要等先点的回来才发:最后落到页面上的是后点的那份视图", async () => {
  const q = serialQueue();
  const started: string[] = [];
  const shown: string[] = [];
  const a = deferred<string>();
  const b = deferred<string>();
  const pa = q(async () => { started.push("记一笔"); const v = await a.promise; shown.push(v); return v; });
  const pb = q(async () => { started.push("改费率"); const v = await b.promise; shown.push(v); return v; });
  await flush();
  assert.deepEqual(started, ["记一笔"], "第一笔还没回来,第二笔不该发出去");
  b.resolve("费率新视图");                 // 就算第二笔的服务端先好了也轮不到它
  await flush();
  assert.deepEqual(shown, []);
  a.resolve("记一笔后的视图");
  assert.equal(await pa, "记一笔后的视图");
  assert.equal(await pb, "费率新视图");
  assert.deepEqual(started, ["记一笔", "改费率"]);
  assert.deepEqual(shown, ["记一笔后的视图", "费率新视图"], "最后显示的必须是后点的那份");
});

test("前一件失败不堵后面:失败照样抛给它自己的调用方,下一件照常跑", async () => {
  const q = serialQueue();
  const a = deferred<string>();
  const pa = q(() => a.promise);
  const pb = q(async () => "第二件");
  a.reject(new Error("台账被锁"));
  await assert.rejects(pa, /台账被锁/);
  assert.equal(await pb, "第二件");
  assert.equal(await q(async () => "第三件"), "第三件");
});

test("交易日志页的写动作走这条队列(不是各表单自己直接发)", () => {
  const hook = readFileSync(new URL("../src/verticals/finance/journal/useJournal.ts", import.meta.url), "utf8");
  assert.match(hook, /const act = useCallback\(\(body: JournalAction\) => queue\.current\(async \(\) => \{\s*try \{\s*const r = await backend\.journalAct\(body\)/);
  assert.equal(hook.match(/backend\.journalAct\(/g)?.length, 1, "写动作只能有这一个出口");
});
