// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  importImages: vi.fn(),
  pasteImage: vi.fn(),
  previewImage: vi.fn(),
  openDocument: vi.fn(),
  toastError: vi.fn(),
}));
// 面板下面读、改 Markdown 的代码是真的（NodeRecord.ts），只把磁盘换成内存里的一张表：这样能看见文件里到底写成了什么。
// 不去假造 @tauri-apps/plugin-fs：面板一打开就同时读记录、列封存的节点，两处同时 import 它时，
// vitest 会把真的那份给其中一处。
vi.mock("./NodeRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./NodeRecord")>();
  const io: import("./NodeRecord").RecordFiles = {
    read: async (path) => mocks.disk.get(path),
    write: async (path, text) => void mocks.disk.set(path, text),
    names: async (folder) =>
      [...mocks.disk.keys()]
        .filter((path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/"))
        .map((path) => path.slice(folder.length + 1)),
  };
  return {
    ...actual,
    loadNodeRecord: (root: string, name?: string) => actual.loadNodeRecord(root, name, io),
    listSealedRecords: (root: string) => actual.listSealedRecords(root, io),
    ensureNodeRecord: (root: string, name?: string) => actual.ensureNodeRecord(root, name, io),
    appendRecordItem: (...args: Parameters<typeof actual.appendRecordItem>) =>
      actual.appendRecordItem(args[0], args[1], args[2], args[3], args[4], args[5], io),
    updateRecordItem: (...args: Parameters<typeof actual.updateRecordItem>) =>
      actual.updateRecordItem(args[0], args[1], args[2], args[3], io),
    setRecordItemDone: (...args: Parameters<typeof actual.setRecordItemDone>) =>
      actual.setRecordItemDone(args[0], args[1], args[2], args[3], io),
  };
});
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return { store: createStore(), tabsAtom: atom([]) };
});
vi.mock("@/components/overlay-host", () => ({ OverlayHost: { open: vi.fn(() => ({ id: "panel" })), close: vi.fn() } }));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const component =
    (tag: string) =>
    ({ children, className }: { children: React.ReactNode; className?: string }) =>
      createElement(tag, { className }, children);
  return {
    Dialog: component("section"),
    DialogContent: component("div"),
    DialogHeader: component("header"),
    DialogTitle: component("h1"),
    DialogDescription: component("p"),
  };
});
vi.mock("react-i18next", () => {
  const t = (key: string, options?: { text?: string; title?: string; name?: string }) =>
    `${key}${options?.text ? ` ${options.text}` : options?.title ? ` ${options.title}` : options?.name ? ` ${options.name}` : ""}`;
  return { useTranslation: () => ({ t }) };
});
vi.mock("i18next", () => ({ default: { exists: () => true, t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/core/service/Settings", () => ({ Settings: { watch: () => () => undefined } }));
vi.mock("./ResearchFolder", () => ({
  notifyResearchFilesChanged: vi.fn(),
  ResearchFolder: {
    getRoot: () => "/research/课题",
    toAbsolute: (path: string, root: string) => `${root}/${path}`,
    isInside: () => true,
  },
}));
vi.mock("./DocumentTab", () => ({ openDocumentFile: mocks.openDocument }));
vi.mock("./NodeRecordMedia", () => ({
  importRecordImages: mocks.importImages,
  pasteRecordImage: mocks.pasteImage,
  loadRecordImagePreview: mocks.previewImage,
}));

import { NodeRecordPanel } from "./NodeRecordPanel";
import { summarizeRecordItem } from "./NodeRecord";

const PROJECT = "/research/课题";
const currentFile = `${PROJECT}/进展记录/进行中.md`;
const sealedFile = `${PROJECT}/进展记录/2026-11-14 组会.md`;
const CURRENT = `# 进展记录 · 进行中

## 进展

- [x] 跑通了 B 方法

## 待办

- [ ] 换损失函数再跑一遍
- [ ] **对比两种取法** — 取 A 和取 B 各跑一遍 [实验笔记](../笔记/实验.md)

## 问题与决定

- [ ] 边界条件会炸

## 下一步

- [ ] 试试 C 方法
`;
const SEALED = `# 进展记录 · 2026-11-14 组会

## 进展

- [x] 读完那篇综述

## 待办

- [ ] 当时没做完的事

## 问题与决定

## 下一步
`;

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const k = (key: string) => `nodeRecord.${key}`;
const labelled = <T extends Element = HTMLElement>(label: string) =>
  container.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.includes(text))!;
const sectionText = (name: string) => labelled(k(`section.${name}`)).textContent ?? "";
const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((value) => value.textContent);
/** 等读写和跟着来的重画都做完 */
async function settle() {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function save() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}
async function open(props: { initialName?: string; initialItemId?: string } = {}) {
  await act(async () => root.render(<NodeRecordPanel root={PROJECT} onClose={onClose} {...props} />));
  await settle();
}
const title = () => labelled<HTMLInputElement>(k("panel.itemTitle"));
const details = () => labelled<HTMLTextAreaElement>(k("panel.itemDetails"));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.disk.clear();
  mocks.disk.set(currentFile, CURRENT);
  mocks.disk.set(sealedFile, SEALED);
  mocks.previewImage.mockResolvedValue("data:image/png;base64,AA==");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the record panel", () => {
  it("lists the stretch in progress in four sections and offers the sealed nodes", async () => {
    await open();
    expect(sectionText("done")).toContain("跑通了 B 方法");
    expect(sectionText("todo")).toContain("换损失函数再跑一遍");
    expect(sectionText("todo")).toContain("对比两种取法");
    expect(sectionText("todo")).toContain("取 A 和取 B 各跑一遍");
    expect(sectionText("notes")).toContain("边界条件会炸");
    expect(sectionText("next")).toContain("试试 C 方法");
    const picker = labelled<HTMLSelectElement>(k("panel.choose"));
    expect([...picker.options].map((option) => option.textContent)).toEqual([k("panel.current"), "2026-11-14 组会"]);
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("adds an item with a link typed by hand, without writing the title twice", async () => {
    await open();
    await enter(details(), "写一下实验小结");
    // 没碰标题框：标题跟着内容走（提炼时会去掉「一下」这样的虚词）
    expect(title().value).toBe(summarizeRecordItem("写一下实验小结", "todo"));
    expect(title().value).not.toBe("");
    await click(button(k("panel.addLink")));
    await enter(labelled<HTMLInputElement>(k("panel.linkLabel")), "小结");
    await enter(labelled<HTMLInputElement>(k("panel.linkTarget")), "../笔记/小结.md");
    await click(button(k("panel.confirmLink")));
    await save();
    expect(mocks.disk.get(currentFile)).toBe(
      CURRENT.replace(
        "各跑一遍 [实验笔记](../笔记/实验.md)\n",
        "各跑一遍 [实验笔记](../笔记/实验.md)\n- [ ] 写一下实验小结 [小结](<../笔记/小结.md>)\n",
      ),
    );
    expect(sectionText("todo")).toContain("写一下实验小结");
    // 记下以后表单清空，等着记下一条
    expect(details().value).toBe("");
    expect(alerts()).toEqual([]);
  });

  it("writes the title the user typed, into the section the user chose", async () => {
    await open();
    await choose(labelled<HTMLSelectElement>(k("panel.itemSection")), "notes");
    await enter(title(), "先不管三维");
    await enter(details(), "二维的先做扎实，三维的放到下个节点以后");
    await save();
    expect(mocks.disk.get(currentFile)).toContain(
      "- [ ] 边界条件会炸\n- [ ] **先不管三维** — 二维的先做扎实，三维的放到下个节点以后\n",
    );
  });

  it("edits the details of an item whose title was only derived, without writing a title into the file", async () => {
    await open();
    await click(labelled(`${k("panel.editItemNamed")} 换损失函数再跑一遍`));
    expect(title().value).toBe("换损失函数再跑一遍");
    expect(details().value).toBe("换损失函数再跑一遍");
    // 改着的时候不能换节：这一条在哪一节不在这里改
    expect(labelled<HTMLSelectElement>(k("panel.itemSection")).disabled).toBe(true);
    await enter(details(), "换成 Huber 损失再跑一遍\n先看梯度");
    await save();
    expect(mocks.disk.get(currentFile)).toBe(
      CURRENT.replace("- [ ] 换损失函数再跑一遍\n", "- [ ] 换成 Huber 损失再跑一遍\n  先看梯度\n"),
    );
    // 存完回到「加一条」
    expect(button(k("panel.cancelEdit"))).toBeUndefined();
    expect(details().value).toBe("");
  });

  it("edits a title the user wrote and removes one of the item's links, leaving its sentence", async () => {
    await open();
    await click(labelled(`${k("panel.editItemNamed")} 对比两种取法`));
    expect(title().value).toBe("对比两种取法");
    await enter(title(), "对比 A、B 两种取法");
    await click(labelled(`${k("panel.removeNamedLink")} 实验笔记`));
    await save();
    expect(mocks.disk.get(currentFile)).toBe(
      CURRENT.replace(
        "**对比两种取法** — 取 A 和取 B 各跑一遍 [实验笔记](../笔记/实验.md)",
        "**对比 A、B 两种取法** — 取 A 和取 B 各跑一遍 实验笔记",
      ),
    );
  });

  it("puts the new item being typed back after an edit is cancelled", async () => {
    await open();
    await enter(details(), "写到一半的新事项");
    await click(labelled(`${k("panel.editItemNamed")} 换损失函数再跑一遍`));
    expect(details().value).toBe("换损失函数再跑一遍");
    await click(button(k("panel.cancelEdit")));
    expect(details().value).toBe("写到一半的新事项");
    expect(mocks.disk.get(currentFile)).toBe(CURRENT);
  });

  it("attaches pictures chosen from the computer and pasted from the clipboard", async () => {
    mocks.importImages.mockResolvedValue([{ label: "曲线.png", href: "%E9%99%84%E4%BB%B6/aaa.png" }]);
    mocks.pasteImage.mockResolvedValue({ label: "clipboard.png", href: "%E9%99%84%E4%BB%B6/bbb.png" });
    await open();
    await click(button(k("panel.addImage")));
    await click(button(k("panel.pasteImage")));
    expect(mocks.importImages).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ path: "进展记录/进行中.md" }),
      expect.anything(),
    );
    expect(labelled(`${k("panel.removeImage")} 曲线.png`)).not.toBeNull();
    await enter(details(), "看这两张图");
    await save();
    expect(mocks.disk.get(currentFile)).toContain(
      "- [ ] 看这两张图\n  ![曲线.png](<%E9%99%84%E4%BB%B6/aaa.png>)\n  ![clipboard.png](<%E9%99%84%E4%BB%B6/bbb.png>)\n",
    );
    // 记下以后列表里看得到缩略图
    expect(container.querySelectorAll("section img")).toHaveLength(2);
  });

  it("says so when the clipboard holds no picture, and attaches nothing", async () => {
    mocks.pasteImage.mockResolvedValue(undefined);
    await open();
    await click(button(k("panel.pasteImage")));
    expect(alerts()).toEqual([k("panel.noClipboardImage")]);
    expect(container.querySelectorAll("form img")).toHaveLength(0);
  });

  it("ticks a to-do, which then counts as progress", async () => {
    await open();
    await click(labelled(`${k("markDone")} 换损失函数再跑一遍`));
    expect(mocks.disk.get(currentFile)).toBe(CURRENT.replace("- [ ] 换损失函数再跑一遍", "- [x] 换损失函数再跑一遍"));
    expect(sectionText("done")).toContain("换损失函数再跑一遍");
    expect(sectionText("todo")).not.toContain("换损失函数再跑一遍");
  });

  it("shows a sealed node for reading only", async () => {
    await open();
    await choose(labelled<HTMLSelectElement>(k("panel.choose")), "2026-11-14 组会");
    expect(sectionText("done")).toContain("读完那篇综述");
    expect(sectionText("todo")).toContain("当时没做完的事");
    expect(container.textContent).toContain(`${k("panel.sealedHint")} 2026-11-14 组会`);
    // 没有表单、没有勾选框、没有「改」
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelectorAll(`[aria-label^="${k("panel.editItemNamed")}"]`)).toHaveLength(0);
    expect(mocks.disk.get(sealedFile)).toBe(SEALED);
    // 「打开原文件」开的是封存的那一份
    await click(button(k("panel.openFile")));
    expect(mocks.openDocument).toHaveBeenCalledWith(sealedFile);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens on the node and the item it was asked for", async () => {
    await open({ initialName: "2026-11-14 组会" });
    expect(labelled<HTMLSelectElement>(k("panel.choose")).value).toBe("2026-11-14 组会");
    expect(container.querySelector("form")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await open({ initialItemId: "line:8" });
    expect(container.querySelector('[data-record-item="line:8"]')!.className).toContain("ring-1");
  });

  it("does not write over the file when it changed while an item was being edited", async () => {
    await open();
    await click(labelled(`${k("panel.editItemNamed")} 换损失函数再跑一遍`));
    const elsewhere = CURRENT.replace("- [ ] 试试 C 方法\n", "- [ ] 试试 C 方法\n- [ ] 在 Obsidian 里加的一条\n");
    mocks.disk.set(currentFile, elsewhere);
    await enter(details(), "我的修改");
    await save();
    expect(mocks.disk.get(currentFile)).toBe(elsewhere);
    expect(alerts()).toEqual([k("panel.editConflict")]);
    // 填的东西还在，可以复制出来
    expect(details().value).toBe("我的修改");
    // 取消以后看到的是文件现在的样子
    await click(button(k("panel.cancelEdit")));
    expect(sectionText("next")).toContain("在 Obsidian 里加的一条");
  });

  it("re-reads and asks for another click when a tick meets a file changed elsewhere", async () => {
    await open();
    const elsewhere = CURRENT.replace("## 待办\n\n", "## 待办\n\n- [ ] 别处插在前面的一条\n");
    mocks.disk.set(currentFile, elsewhere);
    await click(labelled(`${k("markDone")} 换损失函数再跑一遍`));
    expect(mocks.disk.get(currentFile)).toBe(elsewhere);
    expect(alerts()).toEqual([k("reloaded")]);
    expect(sectionText("todo")).toContain("别处插在前面的一条");
    // 再点一次，勾的是对的那一条
    await click(labelled(`${k("markDone")} 换损失函数再跑一遍`));
    expect(mocks.disk.get(currentFile)).toBe(elsewhere.replace("- [ ] 换损失函数再跑一遍", "- [x] 换损失函数再跑一遍"));
  });

  it("still adds an item when the file changed elsewhere, keeping what was added there", async () => {
    await open();
    const elsewhere = CURRENT.replace("- [x] 跑通了 B 方法\n", "- [x] 跑通了 B 方法\n- [x] 别处记的进展\n");
    mocks.disk.set(currentFile, elsewhere);
    await enter(details(), "面板里新加的");
    await save();
    const saved = mocks.disk.get(currentFile)!;
    expect(saved).toContain("- [x] 别处记的进展\n");
    expect(saved).toContain("- [ ] 面板里新加的\n");
    expect(alerts()).toEqual([]);
  });

  it("starts the record file when the first item is added", async () => {
    mocks.disk.delete(currentFile);
    await open();
    expect(container.textContent).toContain(k("panel.emptyCurrent"));
    await enter(details(), "第一条");
    await save();
    expect(mocks.disk.get(currentFile)).toContain("## 待办\n\n- [ ] 第一条\n");
  });
});
