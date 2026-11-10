/// <reference types="vitest/config" />

import ViteYaml from "@modyfi/vite-plugin-yaml";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-oxc";
import path from "node:path";
import operatorOverload from "unplugin-operator-overload/vite";
import originalClassName from "unplugin-original-class-name/vite";
import { createLogger, defineConfig } from "vite";
import svgr from "vite-plugin-svgr";
import { i18nAutoTW } from "./vite-plugins/i18n-auto-tw";
import { pdfjsAssets } from "./vite-plugins/pdfjs-assets";

const host = process.env.TAURI_DEV_HOST ?? "localhost";

export const viteLogger = createLogger("info", { prefix: "[project-graph]" });

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    originalClassName({
      staticMethodName: "className",
    }),
    operatorOverload(),
    // 将svg文件作为react组件导入
    // import Icon from "./icon.svg?react"
    svgr(),
    // 解析yaml文件，作为js对象导入
    // import config from "./config.yaml"
    ViteYaml(),
    // zh_CN 自动转 zh_TW
    i18nAutoTW(),
    // pdf.js 的 CMap / 标准字体 / wasm 数据文件（科研工作台的文件卡片用）
    pdfjsAssets(),
    // react插件
    react(),
    // 分析组件性能
    // reactScan(),
  ],

  // 不清屏，方便看rust报错
  clearScreen: false,
  // tauri需要固定的端口
  server: {
    host,
    port: 1420,
    // 端口冲突时直接报错，不尝试下一个可用端口
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  // 2024年10月3日发现 pnpm build 会报错，
  // Top-level await is not available in the configured target environment
  // 添加下面的配置解决了
  // 2024/10/05 main.tsx去掉了顶层await，所以不需要这个配置
  // build: {
  //   target: "esnext",
  // },

  // 环境变量前缀
  // 只有名字以LR_开头的环境变量才会被注入到前端
  // import.meta.env.LR_xxx
  envPrefix: "LR_",

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // PDF 阅读器是打开 PDF 时才动态加载的。开发版第一次碰到这些包会现场打包并整页刷新，
  // 打开的标签全没了，看起来像闪退（2026-11-10），所以启动时就先打包好。
  optimizeDeps: {
    include: [
      "@embedpdf/core",
      "@embedpdf/core/react",
      "@embedpdf/engines",
      "@embedpdf/engines/pdfium",
      "@embedpdf/engines/pdfium-direct-engine",
      "@embedpdf/engines/worker",
      "@embedpdf/models",
      "@embedpdf/pdfium",
      "@embedpdf/plugin-bookmark/react",
      "@embedpdf/plugin-document-manager/react",
      "@embedpdf/plugin-interaction-manager/react",
      "@embedpdf/plugin-render/react",
      "@embedpdf/plugin-scroll/react",
      "@embedpdf/plugin-search/react",
      "@embedpdf/plugin-selection",
      "@embedpdf/plugin-selection/react",
      "@embedpdf/plugin-thumbnail/react",
      "@embedpdf/plugin-tiling/react",
      "@embedpdf/plugin-viewport/react",
      "@embedpdf/plugin-zoom/react",
    ],
  },

  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        proxy: path.resolve(__dirname, "proxy.html"),
      },
    },
  },
});
