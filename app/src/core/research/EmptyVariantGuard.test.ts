// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Tailwind 的「没有子元素时」变体会生成一条带「空元素」伪类的嵌套规则。Mac 的网页引擎（WebKit）遇到它，
 * 会把页面上每个元素都记成「样式跟有没有子元素有关」；之后任何地方增删一个子元素，那一层下面的样式都要整个重算。
 * 整个程序里只用过一处，就让长笔记处处卡。实测一篇 980 行的笔记（实时预览）：
 * 快速滚动平均每帧 42ms → 18ms，超过 40ms 的帧 24 个 → 5 个；点一下、选中、取消选中每次少 60ms。
 *
 * Tailwind 连注释和文档里的字样也会扫出来生成规则，所以 src 下面的文字都查，这个文件里也不能把那个写法拼全。
 */
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const WORD = ["emp", "ty"].join("");
const VARIANT = new RegExp(`${WORD}:[a-z\\[!-]`);
const PSEUDO = new RegExp(`:${WORD}\\b`);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(tsx?|css|html|ya?ml|md)$/.test(entry.name) ? [path] : [];
  });
}

it("keeps the Tailwind no-children variant and its pseudo-class out of the app (WebKit restyles whole subtrees)", () => {
  const offenders = files(SRC).filter((path) => {
    const text = readFileSync(path, "utf8");
    return VARIANT.test(text) || PSEUDO.test(text);
  });
  expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
});
