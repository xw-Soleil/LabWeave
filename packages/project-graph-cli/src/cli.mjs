#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "tsx/esm";

// 开发时从仓库直接跑：没指定归属助手就用 Rust 编译出来的那个（安装包版本由入口自己设）
if (!process.env.PROJECT_GRAPH_OWNERSHIP_HELPER_PATH) {
  const helper = fileURLToPath(
    new URL(
      `../../../app/src-tauri/target/debug/project-graph-ownership-helper${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  if (existsSync(helper)) process.env.PROJECT_GRAPH_OWNERSHIP_HELPER_PATH = helper;
}

await import("../../../app/src/cli/project-graph.ts");
