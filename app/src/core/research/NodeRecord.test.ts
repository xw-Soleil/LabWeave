import { describe, expect, it, vi } from "vitest";
import {
  appendRecordItem,
  appendRecordMarkdown,
  CURRENT_RECORD,
  ensureNodeRecord,
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
  updateRecordMarkdownItem,
  type RecordFiles,
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
