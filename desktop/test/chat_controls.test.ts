import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("聊天实际渲染停止入口，并修复裸链接末尾中文标点而不改显式 URL", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  try {
    const { AiComposer, AiMessages } = await server.ssrLoadModule("/src/core/ai/AiMessages.tsx");
    const stopped = renderToStaticMarkup(createElement(AiComposer, { placeholder: "问问题", disabled: true, onSend: () => {}, onStop: () => {} }));
    assert.match(stopped, />停止</); assert.doesNotMatch(stopped, /<button[^>]*disabled/);
    assert.match(stopped, /可先写下一问/);
    const info = renderToStaticMarkup(createElement(AiMessages, { loading: false, err: null, info: "已停止等待", msgs: [] }));
    assert.match(info, /role="status"/);
    assert.doesNotMatch(info, /text-destructive/);
    const waiting = renderToStaticMarkup(createElement(AiComposer, { placeholder: "未接入", disabled: true, onSend: () => {} }));
    assert.match(waiting, /<button[^>]*disabled/); assert.doesNotMatch(waiting, />停止</);
    const html = renderToStaticMarkup(createElement(AiMessages, { loading: false, err: null, msgs: [{ role: "assistant", content:
      "来源 https://iana.org/domains/example）。\n\n[签名链接](https://example.com/a%EF%BC%89?q=ok)\n\n[https://example.com/字。](https://example.com/字。)\n\n[坏链接](javascript:alert%281%29)" }] }));
    assert.match(html, /href="https:\/\/iana.org\/domains\/example"/);
    assert.match(html, /<\/a>）。/);
    assert.match(html, /href="https:\/\/example.com\/a%EF%BC%89\?q=ok"/);
    assert.match(html, /href="https:\/\/example.com\/%E5%AD%97%E3%80%82"/);
    assert.doesNotMatch(html, /href="javascript:/);
  } finally { await server.close(); }
});
