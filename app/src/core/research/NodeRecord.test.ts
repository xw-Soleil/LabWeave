import { describe, expect, it, vi } from "vitest";
import {
  appendRecordItem,
  appendRecordMarkdown,
  CURRENT_RECORD,
  displayRecordLink,
  ensureNodeRecord,
  hasOwnTitle,
  listSealedRecords,
  loadNodeRecord,
  parseNodeRecord,
  recordPath,
  recordTemplate,
  resolveRecordLinkPath,
  saveRecordMarkdown,
  sealMarkdown,
  sealNodeRecord,
  sectionItems,
  setRecordItemDone,
  summarizeRecordItem,
  toggleRecordMarkdown,
  updateRecordItem,
  updateRecordItemSummary,
  updateRecordMarkdownItem,
  updateRecordMarkdownSummary,
  type RecordFiles,
  type RecordItemUpdate,
} from "./NodeRecord";

const root = "/research/课题";
const currentFile = `${root}/进展记录/进行中.md`;
const TEMPLATE = "# 进展记录 · 进行中\n\n## 进展\n\n## 待办\n\n## 问题与决定\n\n## 下一步\n";

/** 假的磁盘：路径 → 内容 */
function memoryFiles(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const io: RecordFiles = {
    read: async (path) => disk.get(path),
    write: async (path, text) => void disk.set(path, text),
    names: async (folder) =>
      [...disk.keys()]
        .filter((path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/"))
        .map((path) => path.slice(folder.length + 1)),
  };
  return { disk, io };
}
const record = (markdown: string, name = CURRENT_RECORD) =>
  parseNodeRecord({ name, path: recordPath(name), markdown, revision: "" });

const WEEK = `# 进展记录 · 进行中

## 进展

- [x] 跑通了 B 方法

## 待办

- [ ] 换损失函数再跑一遍
  要先看梯度
- [x] 读完那篇综述

## 问题与决定

- [ ] 边界条件会炸
- 决定先不管三维的情况

## 下一步

- [ ] 试试 C 方法
- 整理实验记录
`;

describe("a record as Markdown", () => {
  it("starts from four empty sections, in a file named after the node", () => {
    expect(recordTemplate(CURRENT_RECORD)).toBe(TEMPLATE);
    expect(recordPath(CURRENT_RECORD)).toBe("进展记录/进行中.md");
    expect(recordPath('2026/11/21: "组会"? ')).toBe("进展记录/2026-11-21- -组会--.md");
  });

  it("reads items with their state, title, details, links and pictures, and leaves the rest alone", () => {
    const parsed = record(
      [
        "---",
        "tags: [记录]",
        "---",
        "# 进展记录 · 进行中",
        "",
        "## 进展",
        "",
        "- [x] **跑通 B 方法** — 在小数据上跑通了 [结果](../白板.prg#node=c1)",
        "  第二行的细节",
        "  ![曲线](图片/a.png)",
        "- 没带勾选框的也算做完",
        "",
        "## 待办",
        "",
        "- [ ] 换损失函数再跑一遍",
        "- [x] 读完那篇综述",
        "",
        "## 问题与决定",
        "",
        "- [ ] 边界条件会炸",
        "- 决定先不管三维的情况",
        "",
        "## 下一步",
        "",
        "- [ ] 试试 C 方法",
        "",
        "## 随手写的",
        "",
        "- 这一节程序不认，原样留着",
        "",
        "```ts",
        "- [ ] 代码块里的不算事项",
        "```",
        "",
      ].join("\n"),
    );
    expect(parsed.items.map(({ section, done, text }) => ({ section, done, text }))).toEqual([
      { section: "done", done: true, text: "在小数据上跑通了 结果\n第二行的细节" },
      { section: "done", done: true, text: "没带勾选框的也算做完" },
      { section: "todo", done: false, text: "换损失函数再跑一遍" },
      { section: "todo", done: true, text: "读完那篇综述" },
      { section: "notes", done: false, text: "边界条件会炸" },
      { section: "notes", done: false, text: "决定先不管三维的情况" },
      { section: "next", done: false, text: "试试 C 方法" },
    ]);
    expect(parsed.items[0]).toMatchObject({
      summary: "跑通 B 方法",
      links: [{ label: "结果", href: "../白板.prg#node=c1" }],
      images: [{ label: "曲线", href: "图片/a.png" }],
    });
    // 没写标题的，标题是从内容里提炼的；短的就是它自己
    expect(parsed.items[2].summary).toBe("换损失函数再跑一遍");
    expect(summarizeRecordItem("换损失函数再跑一遍", "todo")).toBe("换损失函数再跑一遍");
    // 挂在末尾的关联链接不算进标题；整条只有一个链接的还是用它的名字
    const linked = record(
      "## 进展\n\n- [x] 对比了两种取法 [边界条件怎么取](<../白板.prg#node=c1>) [综述](<../论文/review.pdf>)\n- [x] [综述](<../论文/review.pdf>)\n",
    );
    expect(linked.items.map(({ summary, text }) => [summary, text])).toEqual([
      ["对比了两种取法", "对比了两种取法 边界条件怎么取 综述"],
      ["综述", "综述"],
    ]);
  });

  it("adds an item at the end of its section, with a checkbox to tick later", () => {
    const todo = appendRecordMarkdown(TEMPLATE, "todo", "换损失函数再跑一遍");
    expect(todo).toBe(
      "# 进展记录 · 进行中\n\n## 进展\n\n## 待办\n\n- [ ] 换损失函数再跑一遍\n\n## 问题与决定\n\n## 下一步\n",
    );
    const more = appendRecordMarkdown(todo, "todo", "读综述\n先读第三节", {
      label: "综述",
      href: "../论文/review.pdf#page=3",
    });
    expect(more).toContain(
      "## 待办\n\n- [ ] 换损失函数再跑一遍\n- [ ] 读综述 [综述](<../论文/review.pdf#page=3>)\n  先读第三节\n\n## 问题与决定",
    );
    // 做完的直接是勾上的；问题也带勾选框，解决了再勾
    expect(appendRecordMarkdown(TEMPLATE, "done", "跑通了 B 方法")).toContain(
      "## 进展\n\n- [x] 跑通了 B 方法\n\n## 待办",
    );
    expect(appendRecordMarkdown(TEMPLATE, "notes", "边界条件会炸")).toContain("- [ ] 边界条件会炸\n\n## 下一步");
    expect(appendRecordMarkdown(TEMPLATE, "next", "试试 C 方法")).toBe(`${TEMPLATE}\n- [ ] 试试 C 方法\n`);
    expect(appendRecordMarkdown(TEMPLATE, "todo", "   ")).toBe(TEMPLATE);
  });

  it("keeps everything else byte for byte: front matter, other sections, Windows line endings", () => {
    const mine = "---\r\ntags: [记录]\r\n---\r\n# 我自己起的标题\r\n\r\n## 备忘\r\n\r\n周四和导师对一下\r\n";
    const added = appendRecordMarkdown(mine, "todo", "换损失函数");
    // 文件里还没有「待办」这一节：在文末新开
    expect(added).toBe(`${mine}\r\n## 待办\r\n\r\n- [ ] 换损失函数\r\n`);
    const ticked = toggleRecordMarkdown(record(added), record(added).items[0].id, true);
    expect(ticked).toBe(`${mine}\r\n## 待办\r\n\r\n- [x] 换损失函数\r\n`);
  });

  it("ticks and unticks an item, giving a plain bullet a checkbox", () => {
    const parsed = record(WEEK);
    const byText = (text: string) => parsed.items.find((item) => item.text.startsWith(text))!;
    expect(toggleRecordMarkdown(parsed, byText("换损失函数").id, true)).toContain(
      "- [x] 换损失函数再跑一遍\n  要先看梯度",
    );
    expect(toggleRecordMarkdown(parsed, byText("读完").id, false)).toContain("- [ ] 读完那篇综述");
    expect(toggleRecordMarkdown(parsed, byText("整理").id, true)).toContain("- [x] 整理实验记录");
    expect(() => toggleRecordMarkdown(parsed, "line:999", true)).toThrow("nodeRecord.conflict");
  });

  it("rewrites only the edited item, and refuses when the file is no longer what was being edited", () => {
    const parsed = record(WEEK);
    const item = parsed.items.find((candidate) => candidate.text.startsWith("换损失函数"))!;
    const edited = updateRecordMarkdownItem(parsed, item.id, {
      summary: "",
      text: "换成 Huber 损失再跑一遍",
      links: [],
      images: [],
    });
    expect(edited).toBe(WEEK.replace("- [ ] 换损失函数再跑一遍\n  要先看梯度\n", "- [ ] 换成 Huber 损失再跑一遍\n"));
    // 编辑开始以后这一条在别处被改了：不能照着旧的行号去改
    const moved = { ...parsed, markdown: WEEK.replace("换损失函数再跑一遍", "别人改过的字") };
    expect(() =>
      updateRecordMarkdownItem(moved, item.id, { summary: "", text: "我的修改", links: [], images: [] }),
    ).toThrow("nodeRecord.conflict");
  });

  it("only follows links that stay inside the project", () => {
    const from = "进展记录/进行中.md";
    expect(resolveRecordLinkPath(from, "../白板.prg#node=c1")).toEqual({ path: "白板.prg", fragment: "node=c1" });
    expect(resolveRecordLinkPath(from, "../论文/a%20b.pdf#page=3")).toEqual({
      path: "论文/a b.pdf",
      fragment: "page=3",
    });
    expect(resolveRecordLinkPath(from, "图片/a.png")).toEqual({ path: "进展记录/图片/a.png" });
    for (const outside of ["../../别的项目/x.md", "/etc/passwd", "C:\\x.md", "https://example.com/x.md", ""]) {
      expect(resolveRecordLinkPath(from, outside)).toBeUndefined();
    }
  });
});

describe("reading and saving a record", () => {
  it("creates the file on first use and reads it back", async () => {
    const { disk, io } = memoryFiles();
    expect(await loadNodeRecord(root, CURRENT_RECORD, io)).toBeNull();
    const created = await ensureNodeRecord(root, CURRENT_RECORD, io);
    expect(disk.get(currentFile)).toBe(TEMPLATE);
    expect(created).toMatchObject({ name: "进行中", path: "进展记录/进行中.md", items: [] });
    // 已经有了就不再动它
    disk.set(currentFile, WEEK);
    expect((await ensureNodeRecord(root, CURRENT_RECORD, io)).items).toHaveLength(7);
  });

  it("adds and ticks items through to the file", async () => {
    const { disk, io } = memoryFiles();
    const empty = await ensureNodeRecord(root, CURRENT_RECORD, io);
    const added = await appendRecordItem(root, empty, "todo", "换损失函数再跑一遍", undefined, undefined, io);
    expect(disk.get(currentFile)).toContain("- [ ] 换损失函数再跑一遍");
    const ticked = await setRecordItemDone(root, added, added.items[0].id, true, io);
    expect(disk.get(currentFile)).toContain("- [x] 换损失函数再跑一遍");
    expect(ticked.items[0].done).toBe(true);
    // 关联的东西只能是项目里面的
    await expect(
      appendRecordItem(root, ticked, "done", "看了一篇", { label: "外面的", href: "../../x.pdf" }, undefined, io),
    ).rejects.toThrow("nodeRecord.unsafeLink");
  });

  it("does not overwrite a file that changed since it was read", async () => {
    const { disk, io } = memoryFiles({ [currentFile]: WEEK });
    const mine = (await loadNodeRecord(root, CURRENT_RECORD, io))!;
    // 这期间你在 Obsidian 里加了一行
    const yours = `${WEEK}\n- 在 Obsidian 里加的一行\n`;
    disk.set(currentFile, yours);
    await expect(setRecordItemDone(root, mine, mine.items[1].id, true, io)).rejects.toThrow("nodeRecord.conflict");
    expect(disk.get(currentFile)).toBe(yours);
    // 重新读一遍再改就行
    const fresh = (await loadNodeRecord(root, CURRENT_RECORD, io))!;
    await setRecordItemDone(root, fresh, fresh.items[1].id, true, io);
    expect(disk.get(currentFile)).toContain("- [x] 换损失函数再跑一遍");
    expect(disk.get(currentFile)).toContain("- 在 Obsidian 里加的一行");
    // 两边同时新建：后到的不盖掉先到的
    const racing = memoryFiles();
    const missing = { ...record(""), revision: "" };
    racing.disk.set(currentFile, "先到的那一份\n");
    await expect(saveRecordMarkdown(root, missing, TEMPLATE, racing.io)).rejects.toThrow("nodeRecord.conflict");
    expect(racing.disk.get(currentFile)).toBe("先到的那一份\n");
  });

  it("lets the desktop side wrap the write, so an open editor is not written over", async () => {
    const { disk, io } = memoryFiles({ [currentFile]: TEMPLATE });
    const steps: string[] = [];
    const guarded: RecordFiles = {
      ...io,
      write: async (path, text) => {
        steps.push("写");
        await io.write(path, text);
      },
      guard: vi.fn(async (path: string, write: () => Promise<void>) => {
        steps.push(`占住 ${path}`);
        await write();
        steps.push("放开");
      }),
    };
    const loaded = (await loadNodeRecord(root, CURRENT_RECORD, guarded))!;
    await appendRecordItem(root, loaded, "done", "跑通了", undefined, undefined, guarded);
    expect(steps).toEqual([`占住 ${currentFile}`, "写", "放开"]);
    // 编辑器正忙：不写
    const busy: RecordFiles = {
      ...io,
      guard: async () => {
        throw new Error("nodeRecord.documentBusy");
      },
    };
    const before = disk.get(currentFile);
    const again = (await loadNodeRecord(root, CURRENT_RECORD, busy))!;
    await expect(appendRecordItem(root, again, "done", "又一条", undefined, undefined, busy)).rejects.toThrow(
      "nodeRecord.documentBusy",
    );
    expect(disk.get(currentFile)).toBe(before);
  });

  it("shows finished to-dos and next steps under progress, and leaves the open ones where they are", () => {
    const parsed = record(WEEK.replace("- [ ] 试试 C 方法", "- [x] 试试 C 方法"));
    const texts = (section: "done" | "todo" | "notes" | "next") =>
      sectionItems(parsed, section).map((item) => item.text.split("\n")[0]);
    expect(texts("done")).toEqual(["跑通了 B 方法", "读完那篇综述", "试试 C 方法"]);
    expect(texts("todo")).toEqual(["换损失函数再跑一遍"]);
    expect(texts("notes")).toEqual(["边界条件会炸", "决定先不管三维的情况"]);
    expect(texts("next")).toEqual(["整理实验记录"]);
    expect(sectionItems(null, "todo")).toEqual([]);
  });

  it("lists the sealed records, most recent first", async () => {
    const { io } = memoryFiles({
      [currentFile]: TEMPLATE,
      [`${root}/进展记录/2026-11-14 组会.md`]: "",
      [`${root}/进展记录/2026-11-21 组会.md`]: "",
      [`${root}/进展记录/2026-11-21 周报.md`]: "",
      [`${root}/进展记录/图片/a.png`]: "",
      [`${root}/进展记录/别的.txt`]: "",
    });
    expect(await listSealedRecords(root, io)).toEqual(["2026-11-21 组会", "2026-11-21 周报", "2026-11-14 组会"]);
    expect(await listSealedRecords("/research/空项目", io)).toEqual([]);
  });
});

describe("freezing a node", () => {
  const NEXT = `# 进展记录 · 进行中

## 进展

## 待办

- [ ] 换损失函数再跑一遍
  要先看梯度
- [ ] 试试 C 方法
- [ ] 整理实验记录

## 问题与决定

- [ ] 边界条件会炸

## 下一步
`;

  it("seals everything into the node, and carries what is still open into a fresh record", () => {
    const { sealed, next } = sealMarkdown(WEEK, undefined, "2026-11-21 组会");
    expect(sealed).toBe(WEEK.replace("# 进展记录 · 进行中", "# 进展记录 · 2026-11-21 组会"));
    // 没勾的待办、没勾的问题带过去；「下一步」变成待办；做完的、没带勾选框的决定留在封存里
    expect(next).toBe(NEXT);
  });

  it("freezing the same node again adds what is new and updates what changed, without duplicates", () => {
    const first = sealMarkdown(WEEK, undefined, "2026-11-21 组会");
    // 下午接着干：勾掉一条带过来的待办，新记一条进展，在自己加的一节里写了一句
    const afternoon = first.next
      .replace("## 进展\n", "## 进展\n\n- [x] 下午又跑了一组对照\n")
      .replace("- [ ] 换损失函数再跑一遍", "- [x] 换损失函数再跑一遍")
      .concat("\n## 备忘\n\n周四和导师对一下\n");
    const second = sealMarkdown(afternoon, first.sealed, "2026-11-21 组会");

    const sealed = record(second.sealed, "2026-11-21 组会");
    expect(
      sealed.items.map(({ section, done, text }) => `${section} ${done ? "✓" : "·"} ${text.split("\n")[0]}`),
    ).toEqual([
      "done ✓ 跑通了 B 方法",
      "done ✓ 下午又跑了一组对照",
      "todo ✓ 换损失函数再跑一遍",
      "todo ✓ 读完那篇综述",
      "notes · 边界条件会炸",
      "notes · 决定先不管三维的情况",
      "next · 试试 C 方法",
      "next · 整理实验记录",
    ]);
    expect(second.sealed).toContain("  要先看梯度");
    expect(second.sealed.endsWith("\n\n## 备忘\n周四和导师对一下\n")).toBe(true);
    expect(second.next).toBe(NEXT.replace("- [ ] 换损失函数再跑一遍\n  要先看梯度\n", ""));

    // 什么都没再动就又定格一次：封存的那份不变
    const third = sealMarkdown(second.next, second.sealed, "2026-11-21 组会");
    expect(third.sealed).toBe(second.sealed);
    expect(third.next).toBe(second.next);
  });

  it("carries one copy of something that was noted twice", () => {
    // 「下一步」里同一句写了两遍；同一个问题记了两遍
    const twice = WEEK.replace("- 整理实验记录", "- [ ] 试试 C 方法").replace(
      "- [ ] 边界条件会炸",
      "- [ ] 边界条件会炸\n- [ ] 边界条件会炸",
    );
    const { next } = sealMarkdown(twice, undefined, "2026-11-21 组会");
    const carried = record(next).items.map(({ section, text }) => `${section} ${text.split("\n")[0]}`);
    expect(carried).toEqual(["todo 换损失函数再跑一遍", "todo 试试 C 方法", "notes 边界条件会炸"]);
  });

  it("puts loose lines that have no heading of their own under 其他", () => {
    const first = sealMarkdown(WEEK, undefined, "2026-11-21 组会");
    const loose = `一句没头没尾的话\n\n${first.next}`;
    const { sealed } = sealMarkdown(loose, first.sealed, "2026-11-21 组会");
    expect(sealed.endsWith("\n\n## 其他\n\n一句没头没尾的话\n")).toBe(true);
  });

  it("writes the sealed file first and then the fresh record; does nothing when nothing was noted", async () => {
    const nothing = memoryFiles();
    expect(await sealNodeRecord(root, "2026-11-21 组会", nothing.io)).toBeUndefined();
    const empty = memoryFiles({ [currentFile]: TEMPLATE });
    expect(await sealNodeRecord(root, "2026-11-21 组会", empty.io)).toBeUndefined();
    expect([...empty.disk.keys()]).toEqual([currentFile]);

    const { disk, io } = memoryFiles({ [currentFile]: WEEK });
    const order: string[] = [];
    const watched: RecordFiles = {
      ...io,
      write: async (path, text) => {
        order.push(path.slice(root.length + 1));
        await io.write(path, text);
      },
    };
    const sealed = await sealNodeRecord(root, "2026-11-21 组会", watched);
    expect(order).toEqual(["进展记录/2026-11-21 组会.md", "进展记录/进行中.md"]);
    expect(sealed).toMatchObject({ name: "2026-11-21 组会", path: "进展记录/2026-11-21 组会.md" });
    expect(disk.get(`${root}/进展记录/2026-11-21 组会.md`)).toContain("# 进展记录 · 2026-11-21 组会");
    expect(disk.get(currentFile)).toBe(NEXT);

    // 同一天再定格：补进同一份，不另起文件
    disk.set(currentFile, NEXT.replace("- [ ] 试试 C 方法", "- [x] 试试 C 方法"));
    await sealNodeRecord(root, "2026-11-21 组会", watched);
    expect((await listSealedRecords(root, io)).length).toBe(1);
    expect(disk.get(`${root}/进展记录/2026-11-21 组会.md`)).toContain("- [x] 试试 C 方法");
    expect(disk.get(currentFile)).not.toContain("试试 C 方法");
  });
});

// 记录面板里改一条用到的：标题、详细内容、关联的链接和图片。
// 这一组照着同伴 cleverfool-rnh 给 WeeklyProgress.ts 写的测试搬过来，路径少一层（记录文件在「进展记录/」下面）。
describe("editing one item: title, details, links and pictures", () => {
  const editPayload = (base: ReturnType<typeof record>, index = 0): RecordItemUpdate => {
    const item = base.items[index];
    return { summary: item.summary ?? "", text: item.text, links: [...item.links], images: [...(item.images ?? [])] };
  };

  it("writes multiline details under a title, with the pictures grouped below", () => {
    const detail = "保留第一行原文\n第二行详细解释\n\n  原有缩进与 **强调**";
    const saved = appendRecordMarkdown(TEMPLATE.replace(/\n/g, "\r\n"), "todo", detail, undefined, {
      summary: "复核实验结果",
      images: [{ label: "结果曲线", href: "../图片/结果曲线.png" }],
    });
    expect(saved).toContain(
      "- [ ] **复核实验结果** — 保留第一行原文\r\n  第二行详细解释\r\n  \r\n    原有缩进与 **强调**\r\n  ![结果曲线](<../图片/结果曲线.png>)",
    );
    const parsed = record(saved);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].text).toBe(detail);
    expect(parsed.items[0].summary).toBe("复核实验结果");
    expect(parsed.items[0].images).toEqual([{ label: "结果曲线", href: "../图片/结果曲线.png" }]);
    expect(parsed.items[0].links).toEqual([]);
    expect(parsed.links).toContainEqual({ label: "结果曲线", href: "../图片/结果曲线.png" });
  });

  it("groups inline, indented and standalone pictures under the right item", () => {
    const parsed = record(
      "## 进展\n- [x] **实验观察** — 已获得结果 ![图一](../图片/1.png)\n  - ![图二](../图片/2.png)\n\n![图三](../图片/3.png)\n- [x] **新图记录** — ![图四](../图片/4.png)\n  ![[../图片/5.png|图五]]\n",
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].images?.map((link) => link.label)).toEqual(["图一", "图二", "图三"]);
    expect(parsed.items[0].text).toBe("已获得结果");
    expect(parsed.items[1].summary).toBe("新图记录");
    expect(parsed.items[1].images).toHaveLength(2);
    expect(parsed.links).toHaveLength(5);
    const imageOnly = record(
      appendRecordMarkdown(TEMPLATE, "done", "", undefined, {
        summary: "图片记录",
        images: [{ label: "图", href: "../图.png" }],
      }),
    );
    expect(imageOnly.items[0].text).toBe("");
    expect(imageOnly.items[0].summary).toBe("图片记录");
    expect(imageOnly.items[0].images).toHaveLength(1);
  });

  it("tells a title the user wrote from one that is only derived from the details", () => {
    const parsed = record("## 待办\n- [ ] **自己写的标题** — 详细内容\n- [ ] 只有内容，没有标题\n* 另一种列表符号\n");
    expect(parsed.items.map((item) => hasOwnTitle(parsed, item.id))).toEqual([true, false, false]);
    // 没写标题的也有标题可以显示，是从内容里提炼的（到第一个逗号为止），文件里并没有
    expect(parsed.items[1].summary).toBe("只有内容");
    expect(hasOwnTitle(parsed, "line:999")).toBe(false);
  });

  it("edits only the title, keeping the checkbox, details, links and pictures", async () => {
    const original =
      "## 待办\r\n- [x] **旧标题** — 不能删除的原句 [依据](../证据.md#结果)\r\n  第二行\r\n  ![图](../图.png)\r\n\r\n## 我的补充\r\n原样保留\r\n";
    const parsed = record(original);
    const edited = updateRecordMarkdownSummary(parsed, parsed.items[0].id, "新 *事项* 标题");
    expect(edited).toBe(original.replace("**旧标题**", "**新 \\*事项\\* 标题**"));
    expect(record(edited).items[0].summary).toBe("新 *事项* 标题");
    expect(record(edited).items[0].text).toBe(parsed.items[0].text);
    expect(record(edited).items[0].done).toBe(true);
    const spaced = record(original.replace("**旧标题** — ", "**旧标题**   –  "));
    expect(updateRecordMarkdownSummary(spaced, spaced.items[0].id, "标题")).toBe(
      spaced.markdown.replace("**旧标题**", "**标题**"),
    );
    expect(() => updateRecordMarkdownSummary(parsed, "line:999", "new")).toThrow("nodeRecord.conflict");

    const { disk, io } = memoryFiles({ [currentFile]: original });
    const loaded = (await loadNodeRecord(root, undefined, io))!;
    await updateRecordItemSummary(root, loaded, loaded.items[0].id, "新 *事项* 标题", io);
    expect(disk.get(currentFile)).toBe(edited);
  });

  it("shows a readable path for a link while keeping the exact target", () => {
    const path = recordPath(CURRENT_RECORD);
    const href = "../%E6%96%87%E7%8C%AE/%E9%98%85%E8%AF%BB.pdf#page%3D8";
    expect(displayRecordLink(path, href)).toBe("文献/阅读.pdf · 第 8 页");
    expect(displayRecordLink(path, "../%E7%AC%94%E8%AE%B0/a.md#%E7%BB%93%E8%AE%BA")).toBe("笔记/a.md · #结论");
    expect(displayRecordLink(path, "../画布.prg#node=abc")).toBe("画布.prg · 节点 abc");
    expect(displayRecordLink(path, "../bad%")).toBe("../bad%");
  });

  it("adds links and pictures without rewriting the item's existing lines or its neighbours", () => {
    const original =
      "---\r\nowner: me\r\n---\n## 待办\r\n<!-- 保留前言 -->\n- [x] **原标题**   – 原文 **格式** [原依据](../旧.md#结果)\r\n  第二段 `![内联示例](../code.png)`\n  ```md\r\n  ![围栏示例](../example.png)\r\n  ```\n<!-- 独立注释原位保留 -->\r\n  ![[../旧图.png]]\r\n\r\n- [ ] 其他事项 [同一依据](../旧.md#结果)\n\n## 自定义章节\r\n此段保留。\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.links.push(
      { label: "新依据", href: "../文件夹/新记录.md#结论" },
      { label: "页码", href: "../文献/论文.pdf#page=4" },
    );
    payload.images.push({ label: "新图一", href: "../图片/图 1.png" }, { label: "新图二", href: "../图片/图2.jpg" });
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    const added =
      "  [新依据](<../文件夹/新记录.md#结论>)\r\n  [页码](<../文献/论文.pdf#page=4>)\r\n  ![新图一](<../图片/图 1.png>)\r\n  ![新图二](<../图片/图2.jpg>)\r\n";
    expect(updated).toBe(original.replace("  ![[../旧图.png]]\r\n", `  ![[../旧图.png]]\r\n${added}`));
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
    expect(parsed.links.map((link) => link.href)).not.toContain("../example.png");
    expect(parsed.links.map((link) => link.href)).not.toContain("../code.png");
  });

  it("removes only the chosen link and picture, leaving the sentence and other items' pictures", () => {
    const original =
      "## 待办\r\n- [ ] **事项** — 原句 [依据甲](../a.md) 与 [依据乙](../b.md)。\r\n  ![图甲](../a.png)\r\n  ![图乙](../b.png)\r\n\r\n- [ ] 另一个事项\r\n  ![共享图甲](../a.png)\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.links = [payload.links[1]];
    payload.images = [payload.images[1]];
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toBe(original.replace("[依据甲](../a.md)", "依据甲").replace("![图甲](../a.png)", ""));
    const parsed = record(updated);
    expect(parsed.items[0].done).toBe(false);
    expect(parsed.items[0].links).toEqual([{ label: "依据乙", href: "../b.md" }]);
    expect(parsed.items[0].images).toEqual([{ label: "图乙", href: "../b.png" }]);
    expect(parsed.items[1].images).toEqual([{ label: "共享图甲", href: "../a.png" }]);
  });

  it("leaves same-target aliases, empty labels and wiki pictures alone when only a picture is added", () => {
    const original =
      "## 待办\r\n- [ ] 比较 [方案A](../same.md) 与 [方案B](../same.md)，保留 [](<../empty.md>)\r\n  ![视角A](../same.png) ![视角B](../same.png)\r\n  ![[../wiki.png]]\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.images.push({ label: "新增", href: "../new.png" });
    expect(updateRecordMarkdownItem(base, base.items[0].id, payload)).toBe(original + "  ![新增](<../new.png>)\r\n");
    expect(base.items[0].links.map((link) => link.label)).toEqual(["方案A", "方案B", ""]);
    expect(base.items[0].images?.map((image) => image.label)).toEqual(["视角A", "视角B", "wiki.png"]);
  });

  const ALIASES =
    "## 待办\n- [ ] **事项** — [A](../same.md) 与 [B](../same.md)\n  ![A](../same.png) ![B](../same.png)\n";

  it.each(["links", "images"] as const)("removes only alias B of two same-target %s", (kind) => {
    const base = record(ALIASES);
    const payload = editPayload(base);
    payload[kind] = payload[kind].filter((link) => link.label !== "B");
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    const before = kind === "links" ? "[B](../same.md)" : "![B](../same.png)";
    expect(updated).toBe(ALIASES.replace(before, kind === "links" ? "B" : ""));
    expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A"]);
    expect(record(updated).items[0].done).toBe(false);
  });

  it.each(["links", "images"] as const)("renames only alias B of two same-target %s", (kind) => {
    const base = record(ALIASES);
    const payload = editPayload(base);
    payload[kind] = payload[kind].map((link) => (link.label === "B" ? { ...link, label: "C" } : link));
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    const before = kind === "links" ? "[B](../same.md)" : "![B](../same.png)";
    const after = kind === "links" ? "[C](<../same.md>)" : "![C](<../same.png>)";
    expect(updated).toBe(ALIASES.replace(before, after));
    expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A", "C"]);
  });

  it.each(["links", "images"] as const)("adds a third alias to two same-target %s", (kind) => {
    const base = record(ALIASES);
    const payload = editPayload(base);
    payload[kind].push({ label: "C", href: kind === "links" ? "../same.md" : "../same.png" });
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toBe(ALIASES + (kind === "links" ? "  [C](<../same.md>)\n" : "  ![C](<../same.png>)\n"));
    expect(record(updated).items[0][kind]?.map((link) => link.label)).toEqual(["A", "B", "C"]);
  });

  it("keeps links and pictures written as inline code literal when the details are edited", () => {
    const detail = "执行 `[示例](../code.md)`，保留 `![图](../code.png)` 和 ``包含 ` 的 [第二例](../other.md)`` 后继续";
    const base = record(`## 待办\n- [ ] **标题** — ${detail}\n`);
    expect(base.items[0].text).toBe(detail);
    expect(base.items[0].links).toEqual([]);
    expect(base.items[0].images).toEqual([]);
    const payload = { ...editPayload(base), text: detail + "补充一句" };
    const updated = record(updateRecordMarkdownItem(base, base.items[0].id, payload));
    expect(updated.items[0].text).toBe(payload.text);
    expect(updated.markdown).toContain("`[示例](../code.md)`");
    expect(updated.markdown).toContain("``包含 ` 的 [第二例](../other.md)``");
    expect(updated.links).toEqual([]);
    const shallowIndent = record("## 待办\n- [ ] 任务\n 单空格缩进的原文\n");
    expect(shallowIndent.items[0].text).toBe("任务\n单空格缩进的原文");
    const shallowUpdate = updateRecordMarkdownItem(shallowIndent, shallowIndent.items[0].id, {
      ...editPayload(shallowIndent),
      text: shallowIndent.items[0].text + "补充",
    });
    expect(shallowUpdate).toContain("单空格缩进的原文补充");
  });

  it("rewrites edited details with the kept links and pictures, leaving comments and other items alone", () => {
    const original =
      "## 待办\r\n- [x] **旧标题** — 旧第一行 [来源](../a.md)\r\n  旧第二行\r\n<!-- 不属于事项正文的注释 -->\n  ![旧图](../old.png)\r\n\r\n- [ ] 下一个事项原文\n## 其他章节\r\n不改此段。\r\n";
    const base = record(original);
    const payload = editPayload(base);
    payload.summary = "新标题";
    payload.text = "修改后的第一段\n第二段 **保留格式**\n\n```md\n![示例不是附件](../sample.png)\n```";
    payload.links.push({ label: "新增节点", href: "../画布.prg#node=abc" });
    payload.images.push({ label: "新图", href: "../new.webp" });
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
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
    expect(parsed.links.map((link) => link.href)).not.toContain("../sample.png");
  });

  it("drops no title into the file when the details change and the title was only derived", () => {
    const base = record("## 待办\n- [ ] 换损失函数再跑一遍\n");
    const updated = updateRecordMarkdownItem(base, base.items[0].id, {
      ...editPayload(base),
      summary: "",
      text: "换成 Huber 损失再跑一遍\n先看梯度",
    });
    expect(updated).toBe("## 待办\n- [ ] 换成 Huber 损失再跑一遍\n  先看梯度\n");
  });

  it("adds and removes pictures on an item that is only a picture", () => {
    const base = record("## 待办\n![原图](../old.png)\n");
    const payload = editPayload(base);
    payload.images.push({ label: "第二张", href: "../second.png" });
    const updated = record(updateRecordMarkdownItem(base, base.items[0].id, payload));
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].text).toBe("");
    expect(updated.items[0].done).toBe(false);
    expect(updated.items[0].images).toEqual(payload.images);
    const removed = record(
      updateRecordMarkdownItem(updated, updated.items[0].id, { ...editPayload(updated), images: [] }),
    );
    expect(removed.items).toHaveLength(1);
    expect(removed.items[0].summary).toBe("原图");
    expect(removed.items[0].images).toEqual([]);
    expect(removed.items[0].done).toBe(false);
  });

  it("keeps links and pictures typed into the details, and checks they stay inside the project", () => {
    const base = record("## 待办\n- [ ] **事项** — 原文\n");
    const payload = { ...editPayload(base), text: "新增 [证据](../notes.md#结果)\n![新图](../typed.png)" };
    const updated = record(updateRecordMarkdownItem(base, base.items[0].id, payload));
    expect(updated.markdown).toContain("[证据](../notes.md#结果)");
    expect(updated.markdown).toContain("![新图](../typed.png)");
    expect(updated.items[0].links).toEqual([{ label: "证据", href: "../notes.md#结果" }]);
    expect(updated.items[0].images).toEqual([{ label: "新图", href: "../typed.png" }]);
    const alsoAttached = updateRecordMarkdownItem(base, base.items[0].id, {
      ...payload,
      images: [{ label: "新图", href: "../typed.png" }],
    });
    expect(alsoAttached.match(/!\[新图\]/g)).toHaveLength(1);
    expect(() =>
      updateRecordMarkdownItem(base, base.items[0].id, { ...payload, text: "![越界](../../outside.png)" }),
    ).toThrow("nodeRecord.unsafeLink");
    expect(() =>
      updateRecordMarkdownItem(base, base.items[0].id, { ...payload, text: "[远程](https://example.com)" }),
    ).toThrow("nodeRecord.unsafeLink");
  });

  it("does not touch the file when nothing changed", async () => {
    const markdown = "## 待办\r\n- [ ] 未完成 [原链接](../a.md)\n  ```md\r\n  ![示例](../example.png)\n  ```\r\n";
    const { disk, io } = memoryFiles({ [currentFile]: markdown });
    const write = vi.spyOn(io, "write");
    const base = (await loadNodeRecord(root, undefined, io))!;
    expect(updateRecordMarkdownItem(base, base.items[0].id, editPayload(base))).toBe(base.markdown);
    expect(await updateRecordItem(root, base, base.items[0].id, editPayload(base), io)).toBe(base);
    expect(write).not.toHaveBeenCalled();
    expect(disk.get(currentFile)).toBe(markdown);
  });

  it("puts a new picture where it shows when the details end in an unfinished code block", () => {
    const base = record("## 待办\n- [ ] **事项** — 原始正文\n  ```md\n  尚未写完的示例\n");
    const payload = { ...editPayload(base), images: [{ label: "新增图", href: "../new.png" }] };
    const updated = updateRecordMarkdownItem(base, base.items[0].id, payload);
    expect(updated).toBe(base.markdown.replace("原始正文\n", "原始正文\n  ![新增图](<../new.png>)\n"));
    expect(record(updated).items[0].images).toEqual(payload.images);
  });

  it("refuses an edit when the file is no longer what the edit started from", async () => {
    const markdown = "## 待办\n- [ ] 原任务\n";
    const { disk, io } = memoryFiles({ [currentFile]: markdown });
    const base = (await loadNodeRecord(root, undefined, io))!;
    const payload = { ...editPayload(base), images: [{ label: "新图", href: "../new.png" }] };
    // 手里这份的内容和它的事项对不上（行号挪了）：不照着旧行号改
    expect(() => updateRecordMarkdownItem({ ...base, markdown: "\n" + markdown }, base.items[0].id, payload)).toThrow(
      "nodeRecord.conflict",
    );
    // 开始改以后文件在别处变了：不覆盖
    disk.set(currentFile, markdown + "- [ ] 别处加的一条\n");
    await expect(updateRecordItem(root, base, base.items[0].id, payload, io)).rejects.toThrow("nodeRecord.conflict");
    expect(disk.get(currentFile)).toBe(markdown + "- [ ] 别处加的一条\n");
  });

  it("keeps an old unusual picture but refuses new targets outside the project", () => {
    const base = record("## 待办\n- [ ] **旧标题** — 原文\n  ![旧图片](https://example.com/old.tiff)\n");
    expect(updateRecordMarkdownItem(base, base.items[0].id, { ...editPayload(base), summary: "新标题" })).toBe(
      base.markdown.replace("**旧标题**", "**新标题**"),
    );
    for (const href of ["../../outside.png", "https://example.com/new.png", "../program.exe"]) {
      expect(() =>
        updateRecordMarkdownItem(base, base.items[0].id, { ...editPayload(base), images: [{ label: "new", href }] }),
      ).toThrow("nodeRecord.unsafeLink");
    }
    expect(() =>
      updateRecordMarkdownItem(base, base.items[0].id, {
        ...editPayload(base),
        links: [{ label: "unsafe", href: "file:///outside.md" }],
      }),
    ).toThrow("nodeRecord.unsafeLink");
    expect(() =>
      updateRecordMarkdownItem(base, base.items[0].id, {
        ...editPayload(base),
        summary: "[越界](../../outside.md)",
      }),
    ).toThrow("nodeRecord.unsafeLink");
  });

  it("takes several links for a new item, counting the single one once", () => {
    const first = { label: "来源一", href: "../one.md" };
    const second = { label: "来源二", href: "../two.md" };
    const parsed = record(appendRecordMarkdown(TEMPLATE, "todo", "新事项", first, { links: [first, second] }));
    expect(parsed.items[0].links).toEqual([first, second]);
    expect(parsed.markdown.match(/\[来源一\]/g)).toHaveLength(1);
  });

  it("refuses pictures outside the project, or that are not pictures, before saving", async () => {
    const { disk, io } = memoryFiles({ [currentFile]: TEMPLATE });
    const base = (await loadNodeRecord(root, undefined, io))!;
    for (const href of ["../../private.png", "https://example.com/image.png", "../program.exe"]) {
      await expect(
        appendRecordItem(root, base, "done", "", undefined, { images: [{ label: "image", href }] }, io),
      ).rejects.toThrow("nodeRecord.unsafeLink");
    }
    expect(disk.get(currentFile)).toBe(TEMPLATE);
  });
});
