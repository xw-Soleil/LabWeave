// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./ReactDevTracks";

// 和真的 WebView 一样有 console.timeStamp；赶在上面那条 import 之前（vitest 换掉的 console 里没有它）
vi.hoisted(() => {
  console.timeStamp = () => {};
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => vi.restoreAllMocks());

describe("React's development performance tracks", () => {
  it("are off, so handing a component another board never copies both boards into a log", async () => {
    const measure = vi.spyOn(performance, "measure");
    const [{ act, useState }, { createRoot }] = await Promise.all([import("react"), import("react-dom/client")]);
    let show: (board: { name: string }) => void = () => {};
    const Strip = ({ board }: { board: { name: string } }) => {
      // 太快的组件 React 本来就不记，得慢到它会记的程度
      for (const start = performance.now(); performance.now() - start < 5; );
      return <b>{board.name}</b>;
    };
    const Host = () => {
      const [board, setBoard] = useState({ name: "旧" });
      show = setBoard;
      return <Strip board={board} />;
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Host />));
    await act(async () => show({ name: "新" }));
    expect(container.textContent).toBe("新");
    expect(measure).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("are turned off before anything that could load React", () => {
    const main = readFileSync(resolve(__dirname, "../../main.tsx"), "utf8");
    expect(main.split(/\r?\n/).find((line) => line.startsWith("import"))).toBe(
      'import "./core/research/ReactDevTracks";',
    );
  });
});
