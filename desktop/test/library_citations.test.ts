import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { libraryCitations } from "../src/verticals/finance/lib/libraryCitations.ts";

test("本地资料引用显示真实文件名；已知页码链接、未知页码不编造，代码块不改写", () => {
  const id = "a".repeat(32);
  const missing = "b".repeat(32);
  const content = `证据 [资料:${id} p.2] 未注明 [资料:${id} p.-] 越界 [资料:${id} p.9] 丢失 [资料:${missing} p.1]\n\n\`[资料:${id} p.2]\``;
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [libraryCitations([{ id, name: "中报 <核对>.pdf", pages: 3 }])], children: content,
  }));
  assert.match(html, /中报 &lt;核对&gt;.pdf/);
  assert.match(html, new RegExp(`href="/my-reports\\?report=${id}&amp;page=2"`));
  assert.doesNotMatch(html, /page=9/);
  assert.match(html, /页码未提供或未核实/);
  assert.ok(html.includes(`[资料:${missing} p.1]`));
  assert.ok(html.includes(`<code>[资料:${id} p.2]</code>`));
  assert.equal((html.match(/<a /g) ?? []).length, 3);
});
