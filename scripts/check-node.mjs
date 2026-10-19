#!/usr/bin/env node
// 运行前预检：本仓库不做构建，直接让 Node 原生执行 .ts（类型剥离）。
// 需要 Node ≥ 22.18（该版本起类型剥离默认开启），且构建时启用了 TypeScript 支持 ——
// 部分 Linux 发行版仓库打包的 Node 关闭了这一项，表现为 ERR_UNKNOWN_FILE_EXTENSION ".ts" /
// ERR_NO_TYPESCRIPT，版本号够也跑不起来（#38）。这里把两种情况都翻成一句能照做的话。
const [major, minor] = process.versions.node.split(".").map(Number);
const versionOk = major > 22 || (major === 22 && minor >= 18);
const feature = process.features && process.features.typescript;
const problems = [];
if (!versionOk) problems.push(`当前 Node ${process.version}，本仓库需要 ≥ 22.18（推荐 24 LTS）。`);
if (!feature) problems.push(`当前 Node 构建未启用 TypeScript 支持（process.features.typescript = ${JSON.stringify(feature ?? null)}）。`);
if (problems.length) {
  console.error([
    "[vibe-astock] 无法直接运行 .ts 入口：",
    ...problems.map((p) => `  - ${p}`),
    "  请改用 nodejs.org 官方安装包，或用 nvm / fnm / Volta 安装 Node 22.18+ / 24 LTS；",
    "  发行版 apt / yum 仓库里的 Node 可能是关闭了 TypeScript 支持的构建。",
    "  自查命令：node -p process.features.typescript   （应输出 strip 或 transform）",
  ].join("\n"));
  process.exit(1);
}
