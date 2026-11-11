import { describe, expect, it } from "vitest";
import { highlightSource } from "./CodeHighlight";

const classOf = (tokens: { text: string; className: string }[], text: string) =>
  tokens.find((token) => token.text === text)?.className;

describe("highlightSource", () => {
  it("colors Python, shell and MATLAB code and keeps every character", async () => {
    const python = 'def area(r):\n    # circle\n    return 3.14 * r ** 2  # "pi"\n';
    const tokens = (await highlightSource(python, "python"))!;
    expect(tokens.map((token) => token.text).join("")).toBe(python);
    expect(classOf(tokens, "def")).toBe("cm-code-keyword");
    expect(classOf(tokens, "3.14")).toBe("cm-code-number");
    expect(classOf(tokens, "# circle")).toBe("cm-code-comment");

    const shell = (await highlightSource('echo "hi" # done\n', "bash"))!;
    expect(classOf(shell, '"hi"')).toBe("cm-code-string");

    const matlab = (await highlightSource("x = [1 2 3]; % row\n", "matlab"))!;
    expect(matlab.some((token) => token.className === "cm-code-comment")).toBe(true);
  });

  it("leaves unknown languages alone", async () => {
    expect(await highlightSource("whatever", "no-such-language")).toBeNull();
  });
});
