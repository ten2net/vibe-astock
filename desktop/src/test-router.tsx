// 只给 SSR 界面测试用：让 MemoryRouter 与组件共用同一份 react-router-dom 实例。
// 测试文件直接从 react-router-dom 导入会拿到另一份模块（各自一份 Context），包不起来 <Link>。
export { MemoryRouter } from "react-router-dom";
