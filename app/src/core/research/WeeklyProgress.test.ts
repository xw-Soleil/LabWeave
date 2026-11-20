import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getTabs, notify, changed, loadMarkdown } = vi.hoisted(() => ({
  invoke: vi.fn(),
  getTabs: vi.fn((): unknown[] => []),
  notify: vi.fn(),
  changed: vi.fn(),
  loadMarkdown: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/state", () => ({ store: { get: getTabs }, tabsAtom: {} }));
vi.mock("./DocumentFile", () => ({ documentKey: (path: string) => path.replace(/\\/g, "/").toLowerCase() }));
vi.mock("./ResearchFolder", () => ({
  notifyResearchFilesChanged: notify,
  ResearchFolder: { toAbsolute: (path: string, root: string) => `${root}/${path}` },
}));
vi.mock("./DocumentTab", () => ({
  DocumentTab: class {
    path = "D:/project/进展记录/周进展/2026-11-16.md";
    hasUnsavedChanges = false;
    saving = false;
    loadingMarkdown = false;
    closing = false;
    changed = changed;
    loadMarkdown = loadMarkdown;
  },
}));
import { DocumentTab } from "./DocumentTab";
import {
  appendWeeklyMarkdown,
  appendWeeklyItem,
  displayWeeklyLink,
  ensureWeeklyRecord,
  listWeeklyRecords,
  parseWeeklyRecord,
  resolveWeeklyLinkPath,
  saveWeeklyMarkdown,
  summarizeWeeklyItem,
  toggleWeeklyMarkdown,
  updateWeeklyItemSummary,
  updateWeeklyMarkdownSummary,
  updateWeeklyItem,
  updateWeeklyMarkdownItem,
  weekStartDate,
  weeklyRecordTemplate,
  type WeeklyItemUpdate,
} from "./WeeklyProgress";

const record = (markdown = weeklyRecordTemplate("2026-11-16"), revision = "revision-1") =>
  parseWeeklyRecord({
    weekStart: "2026-11-16",
    path: "进展记录/周进展/2026-11-16.md",
    markdown,
    revision,
  });

const editPayload = (base: ReturnType<typeof record>, index = 0): WeeklyItemUpdate => {
  const item = base.items[index];
  return { summary: item.summary ?? "", text: item.text, links: [...item.links], images: [...(item.images ?? [])] };
};

describe("weekly Markdown records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTabs.mockReturnValue([]);
    invoke.mockReset();
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal(
      "CustomEvent",
      class {
        constructor(
          public type: string,
          public options?: unknown,
        ) {}
      },
    );
  });

  it("uses local Monday boundaries including Sunday and the year boundary", () => {
    expect(weekStartDate(new Date(2026, 10, 22, 23, 59))).toBe("2026-11-16");
    expect(weekStartDate(new Date(2026, 10, 23))).toBe("2026-11-23");
    expect(weekStartDate(new Date(2027, 0, 1))).toBe("2026-12-28");
    expect(() => weeklyRecordTemplate("2026-11-22")).toThrow("weekly.invalidWeek");
    expect(() => weeklyRecordTemplate("2026-02-30")).toThrow("weekly.invalidWeek");
  });

  it("displays actual accomplishments, checklists and decisions with precise source links", () => {
    const parsed = record(
      "## 本周进展\n- [x] 完成实验 [结果](../../实验/结果.md#消融)\n\n## 待办事项\n- [ ] 看论文 [第5页](../../论文/a.pdf#page=5)\n- [x] 已读论文\n\n## 问题与决定\n采用方案 B\n\n## 下周方向\n- [ ] 复现实验\n\n## 详细记录\n[组会记录](../../组会/本周.md)",
    );
    expect(parsed.items.map((item) => [item.section, item.text, item.done])).toEqual([
      ["done", "完成实验 结果", true],
      ["todo", "看论文 第5页", false],
      ["todo", "已读论文", true],
      ["notes", "采用方案 B", false],
      ["next", "复现实验", false],
    ]);
    expect(parsed.links).toHaveLength(3);
    expect(parsed.items[1].links[0].href).toBe("../../论文/a.pdf#page=5");
  });

  it("preserves custom sections, front matter, code examples and CRLF on append and completion", () => {
    const original =
      "---\r\nowner: me\r\n---\r\n# 周进展\r\n\r\n```md\r\n## 待办事项\r\n- [ ] 示例\r\n```\r\n\r\n## 待办事项\r\n- [ ] 验证模型\r\n\r\n## 其他补充\r\n自由正文 **保留**\r\n";
    const appended = appendWeeklyMarkdown(original, "todo", "阅读新论文", {
      label: "第 3 页",
      href: "../../论文/a.pdf#page=3",
    });
    expect(appended).toContain("```md\r\n## 待办事项\r\n- [ ] 示例\r\n```");
    expect(appended).toContain(
      "- [ ] 验证模型\r\n- [ ] 阅读新论文 [第 3 页](<../../论文/a.pdf#page=3>)\r\n\r\n## 其他补充",
    );
    const parsed = record(appended);
    expect(parsed.items).toHaveLength(2);
    const toggled = toggleWeeklyMarkdown(parsed, parsed.items[0].id, true);
    expect(toggled).toBe(appended.replace("- [ ] 验证模型", "- [x] 验证模型"));
    expect(() => toggleWeeklyMarkdown(parsed, "line:999", true)).toThrow("weekly.conflict");
  });

  it("resolves exact relative links, encoded names, headings, PDF pages and canvas nodes", () => {
    const path = record().path;
    expect(resolveWeeklyLinkPath(path, "../../文献/paper.pdf#page=7")).toEqual({
      path: "文献/paper.pdf",
      fragment: "page=7",
    });
    expect(resolveWeeklyLinkPath(path, "../../画布/思路.prg#node=abc")).toEqual({
      path: "画布/思路.prg",
      fragment: "node=abc",
    });
    expect(resolveWeeklyLinkPath(path, "../../笔记/含%23号.md#问题%3A%20结论")).toEqual({
      path: "笔记/含#号.md",
      fragment: "问题: 结论",
    });
    expect(resolveWeeklyLinkPath(path, "#本周进展")).toEqual({ path, fragment: "本周进展" });
    for (const href of [
      "../../../outside.md",
      "../../%2e%2e/private.md",
      "C:/secret.md",
      "\\\\server\\a.md",
      "https://example.com/a",
      "file:///a",
      "/etc/passwd",
      "../../CON.md",
      "../../a.md%00",
      "../../bad%",
      "../../a\\b.md",
    ]) {
      expect(resolveWeeklyLinkPath(path, href), href).toBeUndefined();
    }
  });

  it("does not create a week or scan materials when listing", async () => {
    invoke.mockResolvedValue([]);
    expect(await listWeeklyRecords("D:/project")).toEqual([]);
    expect(invoke.mock.calls).toEqual([["list_weekly_progress", { root: "D:/project" }]]);
  });

  it("suggests concise topics without turning negation or open choices into completed work", () => {
    expect(summarizeWeeklyItem("这周我们主要是完成了数据导入的相关实现工作", "done")).toBe("数据导入实现");
    expect(summarizeWeeklyItem("目前我们尚未完成参数验证，原因是测试数据不足。", "todo")).toBe("尚未完成参数验证");
    const decision = summarizeWeeklyItem(
      "未来需要确定好检索方案，是针对书名检索部分的界面设计还是偏分类导航的设计，多做一些目录导航设计呢？",
      "notes",
    );
    expect(decision).toContain("检索方案");
    expect(decision).toContain("还是");
    expect(decision).toContain("分类导航");
    expect([...decision].length).toBeLessThanOrEqual(24);
    const question = summarizeWeeklyItem("未来借阅页面上线以后呈现形式如何？", "notes");
    expect(question).toContain("呈现形式");
    expect(question).toMatch(/如何|？/);
    expect(summarizeWeeklyItem("模型可以稳定运行，但多轮测试仍未通过。", "done")).toContain("仍未通过");
    expect(summarizeWeeklyItem("This week we completed interface validation", "done")).toBe("interface validation");
    expect(summarizeWeeklyItem("We have not completed interface validation", "todo")).toContain("not completed");
    const long = summarizeWeeklyItem(
      "需要对不同输入形式和调用时机组合执行完整的验证，目前仍未确认能否恢复全部异常状态。",
      "todo",
    );
    expect(long).toMatch(/仍未|能否/);
    expect([...long].length).toBeLessThanOrEqual(24);
  });

  it("derives existing titles without rewriting records, and keeps explicit titles separate from full details", () => {
    const source =
      "## 本周进展\n- [x] 完成了校内预约系统的需求调研\n- [x] **结果复核** — 完成了全部预约记录的复核，尚有一项疑问。\n  原文第二行\n  \n    缩进细节\n";
    const parsed = record(source);
    expect(parsed.markdown).toBe(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].summary).toBe("校内预约系统需求调研");
    expect(parsed.items[0].text).toBe("完成了校内预约系统的需求调研");
    expect(parsed.items[1].summary).toBe("结果复核");
    expect(parsed.items[1].text).toBe("完成了全部预约记录的复核，尚有一项疑问。\n原文第二行\n\n  缩进细节");
  });

  it("retains partial completion and questions while excluding code examples from title suggestions", () => {
    expect(summarizeWeeklyItem("完成了部分的任务", "done")).toContain("部分");
    expect(summarizeWeeklyItem("还不支持一些格式", "notes")).toBe("还不支持一些格式");
    expect(summarizeWeeklyItem("完成率不足一半", "notes")).toBe("完成率不足一半");
    expect(summarizeWeeklyItem("完成了吗？", "notes")).toBe("完成了吗？");
    expect(summarizeWeeklyItem("完成不了全部验证", "todo")).toBe("完成不了全部验证");
    expect(summarizeWeeklyItem("完成了", "done")).toBe("完成了");
    expect(summarizeWeeklyItem("复核输入格式\n```text\nnot completed: example status\n```", "todo")).toBe(
      "复核输入格式",
    );
    expect(summarizeWeeklyItem("还未决定方案，是保留部分的旧模块还是全部替换？", "notes")).toMatch(
      /未决定.*部分.*还是/,
    );
    const directChoice = summarizeWeeklyItem(
      "未来需要确定是面向多校区图书目录的全文检索设计还是分面导航设计？",
      "next",
    );
    expect(directChoice).toContain("全文检索");
    expect(directChoice).toContain("分面导航");
    expect(directChoice).toContain("还是");
    expect([...directChoice].length).toBeLessThanOrEqual(24);
  });

  it("preserves fenced code, nested lists and image-only items when editing a summary", () => {
    const original =
      "## 待办事项\r\n- [ ] 原始任务\r\n  - [ ] 子任务尚未完成\r\n    - [x] 已完成的子步骤\r\n    ```markdown\r\n    ![代码示例](../../example.png)\r\n    - [x] 示例任务\r\n    ```not-a-closing-fence\r\n    ![仍是代码](../../example2.png)\r\n    ```\r\n\r\n## 本周进展\r\n![独立图片](../../real.png)\r\n";
    const parsed = record(original);
    expect(parsed.markdown).toBe(original);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].done).toBe(false);
    expect(parsed.items[0].text).toContain("- [ ] 子任务尚未完成\n  - [x] 已完成的子步骤");
    expect(parsed.items[0].text).toContain("```not-a-closing-fence");
    expect(parsed.items[0].images).toHaveLength(0);
    expect(parsed.links).toEqual([{ label: "独立图片", href: "../../real.png" }]);
    const updated = updateWeeklyMarkdownSummary(parsed, parsed.items[0].id, "原任务短标题");
    expect(updated).toBe(original.replace("- [ ] 原始任务", "- [ ] **原任务短标题** — 原始任务"));
    expect(record(updated).items[0].done).toBe(false);
    const imageOnly = parsed.items[1];
    expect(imageOnly.text).toBe("");
    expect(imageOnly.summary).toBe("独立图片");
    const renamedImage = updateWeeklyMarkdownSummary(parsed, imageOnly.id, "图片标题");
    expect(renamedImage).toBe(
      original.replace("![独立图片](../../real.png)", "**图片标题** — ![独立图片](../../real.png)"),
    );
    expect(record(renamedImage).items[1].images).toEqual(imageOnly.images);
  });

  it("produces inspectable local suggestions for synthetic library and booking examples", () => {
    expect(summarizeWeeklyItem("完成了图书检索工具应用的初步调研", "done")).toBe("图书检索工具应用初步调研");
    expect(summarizeWeeklyItem("完成校内预约系统的需求调研", "done")).toBe("校内预约系统需求调研");
    expect(
      summarizeWeeklyItem(
        "未来需要确定好检索方案，是针对书名检索部分的界面设计还是偏分类导航的设计，多做一些目录导航设计呢？",
        "next",
      ),
    ).toBe("检索方案：书名检索部分界面设计还是分类导航设计");
    expect(summarizeWeeklyItem("未来借阅页面上线以后呈现形式如何？", "notes")).toBe("借阅页面上线后呈现形式如何？");
  });

  it("writes multiline details with ordinary Markdown titles and grouped image references", () => {
    const detail = "保留第一行原文\n第二行详细解释\n\n  原有缩进与 **强调**";
    const original = weeklyRecordTemplate("2026-11-16").replace(/\n/g, "\r\n");
    const saved = appendWeeklyMarkdown(original, "todo", detail, undefined, {
      summary: "复核实验结果",
      images: [{ label: "结果曲线", href: "../../图片/结果曲线.png" }],
    });
    expect(saved).toContain(
      "- [ ] **复核实验结果** — 保留第一行原文\r\n  第二行详细解释\r\n  \r\n    原有缩进与 **强调**\r\n  ![结果曲线](<../../图片/结果曲线.png>)",
    );
    const parsed = record(saved);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].text).toBe(detail);
    expect(parsed.items[0].summary).toBe("复核实验结果");
    expect(parsed.items[0].images).toEqual([{ label: "结果曲线", href: "../../图片/结果曲线.png" }]);
    expect(parsed.items[0].links).toEqual([]);
    expect(parsed.links).toContainEqual({ label: "结果曲线", href: "../../图片/结果曲线.png" });
  });

  it("groups inline, indented and standalone image embeds under the right item without extra rows", () => {
    const parsed = record(
      "## 本周进展\n- [x] **实验观察** — 已获得结果 ![图一](../../图片/1.png)\n  - ![图二](../../图片/2.png)\n\n![图三](../../图片/3.png)\n- [x] **新图记录** — ![图四](../../图片/4.png)\n  ![[../../图片/5.png|图五]]\n",
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].images?.map((link) => link.label)).toEqual(["图一", "图二", "图三"]);
    expect(parsed.items[0].text).toBe("已获得结果");
    expect(parsed.items[1].summary).toBe("新图记录");
    expect(parsed.items[1].images).toHaveLength(2);
    expect(parsed.links).toHaveLength(5);
    const imageOnly = record(
      appendWeeklyMarkdown(weeklyRecordTemplate("2026-11-16"), "done", "", undefined, {
        summary: "图片记录",
        images: [{ label: "图", href: "../../图.png" }],
      }),
    );
    expect(imageOnly.items[0].text).toBe("");
    expect(imageOnly.items[0].summary).toBe("图片记录");
    expect(imageOnly.items[0].images).toHaveLength(1);
  });

  it("edits only the explicit title, preserving the checkbox, original detail, links and images", async () => {
    const original =
      "## 待办事项\r\n- [x] **旧标题** — 不能删除的原句 [依据](../../证据.md#结果)\r\n  第二行\r\n  ![图](../../图.png)\r\n\r\n## 我的补充\r\n原样保留\r\n";
    const parsed = record(original);
    const edited = updateWeeklyMarkdownSummary(parsed, parsed.items[0].id, "新 *事项* 标题");
    expect(edited).toBe(original.replace("**旧标题**", "**新 \\*事项\\* 标题**"));
    expect(record(edited).items[0].summary).toBe("新 *事项* 标题");
    expect(record(edited).items[0].text).toBe(parsed.items[0].text);
    expect(record(edited).items[0].done).toBe(true);
    const spaced = record(original.replace("**旧标题** — ", "**旧标题**   –  "));
    expect(updateWeeklyMarkdownSummary(spaced, spaced.items[0].id, "标题")).toBe(
      spaced.markdown.replace("**旧标题**", "**标题**"),
    );
    invoke.mockResolvedValue(record(edited, "revision-2"));
    await updateWeeklyItemSummary("D:/project", parsed, parsed.items[0].id, "新 *事项* 标题");
    expect(invoke).toHaveBeenCalledWith(
      "save_weekly_progress",
      expect.objectContaining({ markdown: edited, expectedRevision: "revision-1" }),
    );
    expect(() => updateWeeklyMarkdownSummary(parsed, "line:999", "new")).toThrow("weekly.conflict");
  });

  it("shows readable project-relative paths while retaining the original precise href", () => {
    const path = record().path;
    const href = "../../%E6%96%87%E7%8C%AE/%E9%98%85%E8%AF%BB.pdf#page%3D8";
    expect(displayWeeklyLink(path, href)).toBe("文献/阅读.pdf · 第 8 页");
    expect(href).toContain("%E6");
    expect(displayWeeklyLink(path, "../../%E7%AC%94%E8%AE%B0/a.md#%E7%BB%93%E8%AE%BA")).toBe("笔记/a.md · #结论");
    expect(displayWeeklyLink(path, "../../画布.prg#node=abc")).toBe("画布.prg · 节点 abc");
    expect(displayWeeklyLink(path, "../../bad%")).toBe("../../bad%");
  });

  it("adds several links and images without rewriting existing multiline Markdown or neighboring content", () => {
    const original =
      "---\r\nowner: me\r\n---\n## 待办事项\r\n<!-- 保留前言 -->\n- [x] **原标题**   – 原文 **格式** [原依据](../../旧.md#结果)\r\n  第二段 `![内联示例](../../code.png)`\n  ```md\r\n  ![围栏示例](../../example.png)\r\n  ```\n<!-- 独立注释原位保留 -->\r\n  ![[../../旧图.png]]\r\n\r\n- [ ] 其他事项 [同一依据](../../旧.md#结果)\n\n## 自定义章节\r\n此段保留。\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.links.push(
      { label: "新依据", href: "../../文件夹/新记录.md#结论" },
      { label: "页码", href: "../../文献/论文.pdf#page=4" },
    );
    payload.images.push(
      { label: "新图一", href: "../../图片/图 1.png" },
      { label: "新图二", href: "../../图片/图2.jpg" },
    );
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    const added =
      "  [新依据](<../../文件夹/新记录.md#结论>)\r\n  [页码](<../../文献/论文.pdf#page=4>)\r\n  ![新图一](<../../图片/图 1.png>)\r\n  ![新图二](<../../图片/图2.jpg>)\r\n";
    expect(updated).toBe(original.replace("  ![[../../旧图.png]]\r\n", `  ![[../../旧图.png]]\r\n${added}`));
    const parsed = record(updated);
    expect(parsed.items[0].done).toBe(true);
    expect(parsed.items[0].section).toBe("todo");
    expect(parsed.items[0].images).toHaveLength(3);
    expect(parsed.items[0].links).toHaveLength(3);
    expect(parsed.items[1]).toMatchObject({
      text: base.items[1].text,
      done: false,
      section: "todo",
      links: base.items[1].links,
    });
    expect(parsed.links.map((link) => link.href)).not.toContain("../../example.png");
    expect(parsed.links.map((link) => link.href)).not.toContain("../../code.png");
  });

  it("removes only selected reference tokens from the target item while retaining sentence text and shared attachments", () => {
    const original =
      "## 待办事项\r\n- [ ] **事项** — 原句 [依据甲](../../a.md) 与 [依据乙](../../b.md)。\r\n  ![图甲](../../a.png)\r\n  ![图乙](../../b.png)\r\n\r\n- [ ] 另一个事项\r\n  ![共享图甲](../../a.png)\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.links = [payload.links[1]];
    payload.images = [payload.images[1]];
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toBe(original.replace("[依据甲](../../a.md)", "依据甲").replace("![图甲](../../a.png)", ""));
    const parsed = record(updated);
    expect(parsed.items[0].done).toBe(false);
    expect(parsed.items[0].links).toEqual([{ label: "依据乙", href: "../../b.md" }]);
    expect(parsed.items[0].images).toEqual([{ label: "图乙", href: "../../b.png" }]);
    expect(parsed.items[1].images).toEqual([{ label: "共享图甲", href: "../../a.png" }]);
  });

  it("keeps duplicate-href aliases, empty labels and wiki image notation unchanged when only adding an attachment", () => {
    const original =
      "## 待办事项\r\n- [ ] 比较 [方案A](../../same.md) 与 [方案B](../../same.md)，保留 [](<../../empty.md>)\r\n  ![视角A](../../same.png) ![视角B](../../same.png)\r\n  ![[../../wiki.png]]\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.images.push({ label: "新增", href: "../../new.png" });
    expect(updateWeeklyMarkdownItem(base, base.items[0].id, payload)).toBe(original + "  ![新增](<../../new.png>)\r\n");
    expect(base.items[0].links.map((link) => link.label)).toEqual(["方案A", "方案B", ""]);
    expect(base.items[0].images?.map((image) => image.label)).toEqual(["视角A", "视角B", "wiki.png"]);
  });

  it.each(["links", "images"] as const)("removes only alias B from same-href %s while keeping alias A", (kind) => {
    const original =
      "## 待办事项\n- [ ] **事项** — [A](../../same.md) 与 [B](../../same.md)\n  ![A](../../same.png) ![B](../../same.png)\n";
    const base = record(original);
    const payload = editPayload(base);
    payload[kind] = payload[kind].filter((link) => link.label !== "B");
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    const before = kind === "links" ? "[B](../../same.md)" : "![B](../../same.png)";
    expect(updated).toBe(original.replace(before, kind === "links" ? "B" : ""));
    expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A"]);
    expect(record(updated).items[0].done).toBe(false);
  });

  it.each(["links", "images"] as const)("renames only alias B to C for same-href %s", (kind) => {
    const original =
      "## 待办事项\n- [ ] **事项** — [A](../../same.md) 与 [B](../../same.md)\n  ![A](../../same.png) ![B](../../same.png)\n";
    const base = record(original);
    const payload = editPayload(base);
    payload[kind] = payload[kind].map((link) => (link.label === "B" ? { ...link, label: "C" } : link));
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    const before = kind === "links" ? "[B](../../same.md)" : "![B](../../same.png)";
    const after = kind === "links" ? "[C](<../../same.md>)" : "![C](<../../same.png>)";
    expect(updated).toBe(original.replace(before, after));
    expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A", "C"]);
  });

  it.each(["links", "images"] as const)(
    "adds new alias C without suppressing it or altering A/B in same-href %s",
    (kind) => {
      const original =
        "## 待办事项\n- [ ] **事项** — [A](../../same.md) 与 [B](../../same.md)\n  ![A](../../same.png) ![B](../../same.png)\n";
      const base = record(original);
      const payload = editPayload(base);
      payload[kind].push({ label: "C", href: kind === "links" ? "../../same.md" : "../../same.png" });
      const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
      expect(updated).toBe(original + (kind === "links" ? "  [C](<../../same.md>)\n" : "  ![C](<../../same.png>)\n"));
      expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A", "B", "C"]);
    },
  );

  it("preserves literal inline-code links and images when editing another part of the detail", () => {
    const detail =
      "执行 `[示例](../../code.md)`，保留 `![图](../../code.png)` 和 ``包含 ` 的 [第二例](../../other.md)`` 后继续";
    const base = record(`## 待办事项\n- [ ] **标题** — ${detail}\n`);
    expect(base.items[0].text).toBe(detail);
    expect(base.items[0].links).toEqual([]);
    expect(base.items[0].images).toEqual([]);
    const payload = { ...editPayload(base), text: detail + "补充一句" };
    const updated = record(updateWeeklyMarkdownItem(base, base.items[0].id, payload));
    expect(updated.items[0].text).toBe(payload.text);
    expect(updated.markdown).toContain("`[示例](../../code.md)`");
    expect(updated.markdown).toContain("``包含 ` 的 [第二例](../../other.md)``");
    expect(updated.links).toEqual([]);
    const shallowIndent = record("## 待办事项\n- [ ] 任务\n 单空格缩进的原文\n");
    expect(shallowIndent.items[0].text).toBe("任务\n单空格缩进的原文");
    const shallowUpdate = updateWeeklyMarkdownItem(shallowIndent, shallowIndent.items[0].id, {
      ...editPayload(shallowIndent),
      text: shallowIndent.items[0].text + "补充",
    });
    expect(shallowUpdate).toContain("单空格缩进的原文补充");
  });

  it("rewrites a deliberately edited detail with all retained payload links and images, preserving other records and comments", () => {
    const original =
      "## 待办事项\r\n- [x] **旧标题** — 旧第一行 [来源](../../a.md)\r\n  旧第二行\r\n<!-- 不属于事项正文的注释 -->\n  ![旧图](../../old.png)\r\n\r\n- [ ] 下一个事项原文\n## 其他章节\r\n不改此段。\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.summary = "新标题";
    payload.text = "修改后的第一段\n第二段 **保留格式**\n\n```md\n![示例不是附件](../../sample.png)\n```";
    payload.links.push({ label: "新增节点", href: "../../画布.prg#node=abc" });
    payload.images.push({ label: "新图", href: "../../new.webp" });
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toContain("<!-- 不属于事项正文的注释 -->\n");
    expect(updated.endsWith("\r\n- [ ] 下一个事项原文\n## 其他章节\r\n不改此段。\r\n")).toBe(true);
    expect(updated).not.toContain("旧第二行");
    const parsed = record(updated);
    expect(parsed.items[0].summary).toBe("新标题");
    expect(parsed.items[0].done).toBe(true);
    expect(parsed.items[0].section).toBe("todo");
    expect(parsed.items[0].text).toContain(payload.text);
    expect(parsed.items[0].links).toEqual(payload.links);
    expect(parsed.items[0].images).toEqual(payload.images);
    expect(parsed.links.map((link) => link.href)).not.toContain("../../sample.png");
  });

  it("supports adding and removing references on an existing image-only item without losing its state", () => {
    const base = record("## 待办事项\n![原图](../../old.png)\n");
    const payload = editPayload(base);
    payload.images.push({ label: "第二张", href: "../../second.png" });
    const updated = record(updateWeeklyMarkdownItem(base, base.items[0].id, payload));
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].text).toBe("");
    expect(updated.items[0].done).toBe(false);
    expect(updated.items[0].images).toEqual(payload.images);
    const removed = record(
      updateWeeklyMarkdownItem(updated, updated.items[0].id, { ...editPayload(updated), images: [] }),
    );
    expect(removed.items).toHaveLength(1);
    expect(removed.items[0].summary).toBe("原图");
    expect(removed.items[0].images).toEqual([]);
    expect(removed.items[0].done).toBe(false);
  });

  it("preserves newly typed Markdown references in detail edits and validates their scope", () => {
    const base = record("## 待办事项\n- [ ] **事项** — 原文\n");
    const payload = { ...editPayload(base), text: "新增 [证据](../../notes.md#结果)\n![新图](../../typed.png)" };
    const updated = record(updateWeeklyMarkdownItem(base, base.items[0].id, payload));
    expect(updated.markdown).toContain("[证据](../../notes.md#结果)");
    expect(updated.markdown).toContain("![新图](../../typed.png)");
    expect(updated.items[0].links).toEqual([{ label: "证据", href: "../../notes.md#结果" }]);
    expect(updated.items[0].images).toEqual([{ label: "新图", href: "../../typed.png" }]);
    const alsoAttached = updateWeeklyMarkdownItem(base, base.items[0].id, {
      ...payload,
      images: [{ label: "新图", href: "../../typed.png" }],
    });
    expect(alsoAttached.match(/!\[新图\]/g)).toHaveLength(1);
    expect(() =>
      updateWeeklyMarkdownItem(base, base.items[0].id, { ...payload, text: "![越界](../../../outside.png)" }),
    ).toThrow("weekly.unsafeLink");
    expect(() =>
      updateWeeklyMarkdownItem(base, base.items[0].id, { ...payload, text: "[远程](https://example.com)" }),
    ).toThrow("weekly.unsafeLink");
  });

  it("does not rewrite or invoke storage when nothing has changed", async () => {
    const base = record(
      "## 待办事项\r\n- [ ] 未完成 [原链接](../../a.md)\n  ```md\r\n  ![示例](../../example.png)\n  ```\r\n",
    );
    expect(updateWeeklyMarkdownItem(base, base.items[0].id, editPayload(base))).toBe(base.markdown);
    expect(await updateWeeklyItem("D:/project", base, base.items[0].id, editPayload(base))).toBe(base);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps newly added references visible when an existing detail has an unfinished code fence", () => {
    const base = record("## 待办事项\n- [ ] **事项** — 原始正文\n  ```md\n  尚未写完的示例\n");
    const payload = { ...editPayload(base), images: [{ label: "新增图", href: "../../new.png" }] };
    const updated = updateWeeklyMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toBe(base.markdown.replace("原始正文\n", "原始正文\n  ![新增图](<../../new.png>)\n"));
    expect(record(updated).items[0].images).toEqual(payload.images);
  });

  it("rejects mismatched source rows and uses the editing base revision for an external-edit conflict", async () => {
    const base = record("## 待办事项\n- [ ] 原任务\n", "editing-revision");
    const payload = { ...editPayload(base), images: [{ label: "新图", href: "../../new.png" }] };
    const mismatched = { ...base, markdown: "\n" + base.markdown };
    expect(() => updateWeeklyMarkdownItem(mismatched, base.items[0].id, payload)).toThrow("weekly.conflict");
    invoke.mockRejectedValue("weekly.conflict");
    await expect(updateWeeklyItem("D:/project", base, base.items[0].id, payload)).rejects.toThrow("weekly.conflict");
    expect(invoke).toHaveBeenCalledWith(
      "save_weekly_progress",
      expect.objectContaining({ expectedRevision: "editing-revision" }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(base.markdown).toBe("## 待办事项\n- [ ] 原任务\n");
  });

  it("retains old unsupported references but rejects newly introduced unsafe targets", () => {
    const base = record("## 待办事项\n- [ ] **旧标题** — 原文\n  ![旧图片](https://example.com/old.tiff)\n");
    expect(updateWeeklyMarkdownItem(base, base.items[0].id, { ...editPayload(base), summary: "新标题" })).toBe(
      base.markdown.replace("**旧标题**", "**新标题**"),
    );
    for (const href of ["../../../outside.png", "https://example.com/new.png", "../../program.exe"]) {
      expect(() =>
        updateWeeklyMarkdownItem(base, base.items[0].id, { ...editPayload(base), images: [{ label: "new", href }] }),
      ).toThrow("weekly.unsafeLink");
    }
    expect(() =>
      updateWeeklyMarkdownItem(base, base.items[0].id, {
        ...editPayload(base),
        links: [{ label: "unsafe", href: "file:///outside.md" }],
      }),
    ).toThrow("weekly.unsafeLink");
    expect(() =>
      updateWeeklyMarkdownItem(base, base.items[0].id, {
        ...editPayload(base),
        summary: "[越界](../../../outside.md)",
      }),
    ).toThrow("weekly.unsafeLink");
  });

  it("accepts several links when creating a new item and deduplicates the legacy single link", () => {
    const first = { label: "来源一", href: "../../one.md" };
    const second = { label: "来源二", href: "../../two.md" };
    const parsed = record(
      appendWeeklyMarkdown(weeklyRecordTemplate("2026-11-16"), "todo", "新事项", first, { links: [first, second] }),
    );
    expect(parsed.items[0].links).toEqual([first, second]);
    expect(parsed.markdown.match(/\[来源一\]/g)).toHaveLength(1);
  });

  it("rejects external or non-image attachments before saving the record", async () => {
    for (const href of ["../../../private.png", "https://example.com/image.png", "../../program.exe"]) {
      await expect(
        appendWeeklyItem("D:/project", record(), "done", "", undefined, { images: [{ label: "image", href }] }),
      ).rejects.toThrow("weekly.unsafeLink");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses writes over unsaved or busy document tabs before invoking storage", async () => {
    const tab = new DocumentTab("", "markdown");
    Object.assign(tab, { hasUnsavedChanges: true });
    getTabs.mockReturnValue([tab]);
    await expect(saveWeeklyMarkdown("D:/project", record(), "next")).rejects.toThrow("weekly.documentBusy");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reserves then refreshes clean open editors and sends expected revision", async () => {
    const tab = new DocumentTab("", "markdown");
    getTabs.mockReturnValue([tab]);
    invoke.mockImplementation(async () => {
      expect(tab.loadingMarkdown).toBe(true);
      return record("updated", "revision-2");
    });
    const saved = await saveWeeklyMarkdown("D:/project", record(), "updated");
    expect(saved.revision).toBe("revision-2");
    expect(tab.loadingMarkdown).toBe(false);
    expect(loadMarkdown).toHaveBeenCalledWith(true);
    expect(invoke).toHaveBeenCalledWith("save_weekly_progress", {
      root: "D:/project",
      weekStart: "2026-11-16",
      markdown: "updated",
      expectedRevision: "revision-1",
    });
  });

  it("propagates external edit conflicts, releases the editor and does not refresh away drafts", async () => {
    const tab = new DocumentTab("", "markdown");
    getTabs.mockReturnValue([tab]);
    invoke.mockRejectedValue("weekly.conflict");
    await expect(saveWeeklyMarkdown("D:/project", record(), "updated")).rejects.toThrow("weekly.conflict");
    expect(tab.loadingMarkdown).toBe(false);
    expect(loadMarkdown).not.toHaveBeenCalled();
  });

  it("handles concurrent creation without overwriting the winning weekly Markdown", async () => {
    const existing = record("user content");
    invoke.mockResolvedValueOnce(null).mockRejectedValueOnce("weekly.conflict").mockResolvedValueOnce(existing);
    expect((await ensureWeeklyRecord("D:/project", "2026-11-16")).markdown).toBe("user content");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "load_weekly_progress",
      "save_weekly_progress",
      "load_weekly_progress",
    ]);
  });
});
