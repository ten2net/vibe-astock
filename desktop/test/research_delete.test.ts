import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, backend } from "../src/verticals/finance/lib/backend.ts";

test("删除归档:只有后端的 not_found 才当「本来就不在了」;代理/路由的 404 照常抛给界面", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string }[] = [];
  /** 后端真实响应体照抄 api.ts 的 DELETE /runs/:id 分支,不要自己编一个更"规整"的 ——
   *  编出来的契约会让收窄条件在测试里永远绿、到真环境立刻回归 */
  const reply = (status: number, body: unknown) => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    };
  };
  try {
    // 别人删过 / 列表是旧的:结果与删掉一样,不该弹「删除失败:HTTP 404」
    reply(404, { run_id: "run a/b", deleted: false, error: "not_found" });
    assert.deepEqual(await backend.deleteRun("run a/b"), { run_id: "run a/b", deleted: false });
    assert.deepEqual(calls[0], { url: "/api/runs/run%20a%2Fb", method: "DELETE" }, "run id 要转义,方法是 DELETE");
    // 代理/静态服务的 HTML 404:吞掉就等于删除失败却一个字不说
    reply(404, "<html>404 Not Found</html>");
    await assert.rejects(backend.deleteRun("r2"), (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "bad_response");
    // 路径形状不对时后端兜底回的通用 404(没有 not_found 码):同样不能当成删成功
    await assert.rejects(
      (reply(404, { error: "not found" }), backend.deleteRun("r3")),
      (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "not found");
    // 进行中 / 确认不了终态 / 删了一半都是真失败,必须抛出去,否则界面会谎报「已删除」
    for (const code of ["run_in_progress", "control_unreadable", "delete_failed"]) {
      reply(400, { error: code, message: "后端文案" });
      await assert.rejects(backend.deleteRun("r4"), (e: unknown) => e instanceof ApiError && e.code === code && e.message === "后端文案");
    }
    // 正常删除照常透传后端结果
    reply(200, { run_id: "r5", deleted: true });
    assert.deepEqual(await backend.deleteRun("r5"), { run_id: "r5", deleted: true });
  } finally { globalThis.fetch = originalFetch; }
});
