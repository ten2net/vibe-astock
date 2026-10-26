// 界面行为测试的公共件：用 vite 的 SSR 把 .tsx 组件真正渲染成 HTML，再断言用户看得到什么。
// 只渲染首屏：useEffect 不会跑。要测「拿到数据以后」的样子，就把数据当 props 传给展示组件。
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// react-router 要和组件用同一份实例，否则 MemoryRouter 里的 Link 会报「不在路由里」
const SSR = { ssr: { noExternal: ["react-router-dom", "react-router"], resolve: { conditions: ["module-sync", "node", "import", "development"] } } };

export interface Renderer {
  /** 按 desktop 根目录下的路径加载模块，如 "/src/verticals/finance/components/BacktestCharts.tsx" */
  load(path: string): Promise<Record<string, any>>;
  /** 把组件渲染成静态 HTML */
  html<P extends object>(component: ComponentType<P>, props: P): string;
}

export async function withRenderer<T>(fn: (r: Renderer) => Promise<T>): Promise<T> {
  const server = await createServer({ root: ROOT, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false }, ...SSR });
  try {
    return await fn({
      load: (path) => server.ssrLoadModule(path),
      html: (component, props) => renderToStaticMarkup(createElement(component, props)),
    });
  } finally {
    await server.close();
  }
}

/**
 * 组件里有 <Link>（react-router-dom）时，SSR 必须包一层 MemoryRouter，
 * 否则 Link 里取不到路由上下文，报「basename of useContext(...) is null」。
 * 用法：`const html = routed(r)(Component, props)`。
 *
 * ⚠️ MemoryRouter 必须从 **vite SSR 那边** 取：测试文件里的 react-router-dom 和组件里的
 *    是两份模块实例，各有一份 Context —— 用测试文件里的包一层，组件仍看不到路由。
 */
export function routed(r: Renderer) {
  return async function render<P extends object>(component: ComponentType<P>, props: P, entry = "/"): Promise<string> {
    const { MemoryRouter } = (await r.load("/src/test-router.tsx")) as { MemoryRouter: ComponentType<{ initialEntries: string[] }> };
    return renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: [entry] }, createElement(component, props)),
    );
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'", "&nbsp;": " " };

/** HTML 里用户看得到的文字：去掉标签、还原转义、合并空白。断言文案用它，不受标签拆分和换行影响 */
export function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|#x27|nbsp);/g, (m) => ENTITIES[m] ?? m).replace(/\s+/g, " ").trim();
}
