import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * pdf.js 运行时按需读取的数据：预定义 CMap（没嵌字体的中日韩 PDF 抽字要用）、标准字体、
 * wasm 解码器（JPX / JBIG2 图片）、ICC 配置。它们不是模块，Vite 不会自动打包，
 * 这里开发时直接从 pdfjs-dist 包里提供，构建时原样拷到产物的 pdfjs/ 下。
 * 前端用 import.meta.env.BASE_URL + "pdfjs/<目录>/" 访问（见 FileCardContent.ts）。
 */
const ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const URL_PREFIX = "pdfjs/";

function contentTypeOf(file: string) {
  return file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
}

export function pdfjsAssets(): Plugin {
  const packageDir = path.resolve(__dirname, "../node_modules/pdfjs-dist");

  return {
    name: "vite-plugin-pdfjs-assets",
    configureServer(server) {
      const prefix = server.config.base + URL_PREFIX;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(prefix)) return next();
        const relative = decodeURIComponent(url.slice(prefix.length));
        if (!ASSET_DIRS.includes(relative.split("/")[0])) return next();
        const file = path.resolve(packageDir, relative);
        if (!file.startsWith(packageDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next();
        }
        res.setHeader("Content-Type", contentTypeOf(file));
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of ASSET_DIRS) {
        const sourceDir = path.join(packageDir, dir);
        if (!fs.existsSync(sourceDir)) continue;
        for (const name of fs.readdirSync(sourceDir)) {
          const file = path.join(sourceDir, name);
          if (!fs.statSync(file).isFile()) continue;
          this.emitFile({ type: "asset", fileName: `${URL_PREFIX}${dir}/${name}`, source: fs.readFileSync(file) });
        }
      }
    },
  };
}
