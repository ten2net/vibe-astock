// 自选订阅 hook 的快照契约。
// 回归点：快照每次返回新数组 ⇒ useSyncExternalStore 判定「每次都变了」⇒ 无限重渲染，
// 整页被路由错误页接住（「这个页面暂时无法显示」）。
import assert from "node:assert/strict";
import test from "node:test";
import { withRenderer } from "./helpers/render.ts";

test("自选快照:连续取值必须是同一引用(否则 useSyncExternalStore 会无限重渲染)", async () => {
  await withRenderer(async (r) => {
    const mod = await r.load("/src/verticals/finance/hooks/useWatchCodes.ts");
    const a = mod.__watchSnapshotForTest();
    const b = mod.__watchSnapshotForTest();
    assert.ok(Array.isArray(a));
    assert.equal(a, b, "没有变化时两次快照必须 === ");
  });
});
