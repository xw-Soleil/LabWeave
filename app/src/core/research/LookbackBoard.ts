import type { FileSystemProvider } from "@/core/interfaces/Service";
import { Project, ProjectState } from "@/core/Project";
import { store, tabsAtom } from "@/state";
import { exists } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";
import { listSnapshots, readSnapshotBoard, under, type Snapshot } from "./ProjectRecord";
import { ResearchFolder } from "./ResearchFolder";
import { reportFolderName } from "./ResearchReport";
import {
  boardInSnapshot,
  nodesOf,
  previousOf,
  readSnapshotBoardContent,
  type SnapshotBoardContent,
} from "./SnapshotBoard";
import { compareBoards, showSnapshotDiff } from "./SnapshotDiff";

/*
 * 回看历史：把某个节点定格时的一块白板原样打开成一个只读的标签页，
 * 画布上标出它和再前一个节点相比的变化（新加的描边、改过的打点、删掉的留影，和「自上次小结以来」是同一套）。
 *
 * 它是一块「不对应文件」的白板，走的是草稿那条路（不自动保存、不备份、不进活动记录和快照），
 * 另外不让它变成「未保存」：拖了、改了都不问要不要存，关掉就没了。节点条在 NodeStrip.tsx。
 */

export interface Lookback {
  root: string;
  /** 白板文件，相对项目文件夹 */
  file: string;
  /** 这个项目的节点，最早的在前 */
  nodes: readonly Snapshot[];
  /** 正在看的那个节点 */
  node: Snapshot;
  /** 它当初是和哪份快照比的；前面什么都没有时没有，这时卡片都算新加的 */
  base?: Snapshot;
  counts: { added: number; edited: number; removed: number };
  /** 这个节点出过汇报的话，报告在哪 */
  report?: string;
}

const text = (key: string, options?: Record<string, unknown>) =>
  i18next.t(key, { ns: "research", interpolation: { escapeValue: false }, ...options });
const pathKey = (path: string) => path.replace(/\\/g, "/").normalize("NFC").toLowerCase();
/** 快照文件夹名「2026-11-21 1030」写成「11-21 10:30」 */
const shortTime = (name: string) => name.replace(/^\d{4}-(\d\d-\d\d) (\d\d)(\d\d)(?:-\d+)?$/, "$1 $2:$3");
const boardLabel = (file: string) => (file.replace(/\\/g, "/").split("/").pop() ?? file).replace(/\.prg$/i, "");

/** 节点的名字：2026-11-21 组会。加节点信息之前做阶段小结时拍的没有名字，写成「11-15 10:30 阶段小结」 */
export const nodeLabel = (snapshot: Snapshot) =>
  snapshot.manifest.node?.title ?? `${shortTime(snapshot.name)} ${text("stageSummary.title")}`;

/** 节点条上的短名字：11-21 组会 */
export function nodeChip({ manifest }: Snapshot): string {
  const type = manifest.node ? text(`stageNode.types.${manifest.node.type}`) : text("stageSummary.title");
  return `${manifest.at.slice(5, 10)} ${type}`;
}

class LookbackFiles implements FileSystemProvider {
  constructor(private readonly board: LookbackBoard) {}
  async read() {
    return this.board.content.stripped;
  }
  async readDir() {
    return [];
  }
  async write(): Promise<void> {
    throw new Error("lookback.readOnly");
  }
  async remove() {}
  async exists() {
    return true;
  }
  async mkdir() {}
  async rename() {}
}

export class LookbackBoard extends Project {
  constructor(
    readonly lookback: Lookback,
    readonly content: SnapshotBoardContent,
  ) {
    // 用草稿的地址：程序里凡是「草稿没有路径」的地方都照样成立
    super(URI.parse(`draft:lookback-${crypto.randomUUID()}`));
  }

  override get tabName(): string {
    return text("lookback.tabName", {
      node: nodeChip(this.lookback.node),
      board: boardLabel(this.lookback.file),
    });
  }

  override get title(): string {
    return this.tabName;
  }

  override async init(): Promise<void> {
    // 快照里图片另放着，读白板文件之前先放好，卡片一建出来就找得到
    for (const [id, image] of this.content.images) this.attachments.set(id, image);
    await super.init();
    // 快照里带着真白板的工作区编号，AI 对话记录是按它存的：换一个，免得两个标签写同一份对话
    this.metadata = { ...this.metadata, workbench: { id: crypto.randomUUID(), createdAt: Date.now() } };
  }

  override get projectState(): ProjectState {
    return super.projectState;
  }

  // 回看时拖一下、改一下不算「未保存」：关标签、关程序都不问要不要存
  override set projectState(state: ProjectState) {
    super.projectState = state === ProjectState.Unsaved ? ProjectState.Saved : state;
  }

  override async save(): Promise<void> {
    toast.info(text("lookback.readOnly"));
  }

  override async saveAs(): Promise<void> {
    toast.info(text("lookback.readOnly"));
  }
}

/** 真的那块白板，开着的话 */
function liveBoardOf(root: string, file: string): Project | undefined {
  const key = pathKey(under(root, file));
  return store
    .get(tabsAtom)
    .find(
      (tab): tab is Project =>
        tab instanceof Project && !tab.closing && tab.uri.scheme === "file" && pathKey(tab.uri.fsPath) === key,
    );
}

/**
 * 打开回看。from 是眼前的白板（项目里的一块白板，或者已经在回看的那一块）；
 * nodeName 是要看的节点，不给就是最近的那个——也就是「上上次到上次」。
 * 从一个回看切到另一个时，镜头留在原处，旧的那个标签关掉。
 * 抛的错误代码：stageSummary.noProject、stageReview.outside、lookback.noNode、lookback.noBoard、snapshot.xxx。
 */
export async function openLookback(from: Project, nodeName?: string): Promise<LookbackBoard | undefined> {
  const previous = from instanceof LookbackBoard ? from : undefined;
  const root = previous?.lookback.root ?? ResearchFolder.getRoot();
  if (!root) throw new Error("stageSummary.noProject");
  if (!previous && (from.uri.scheme !== "file" || !ResearchFolder.isInside(from.uri.fsPath, root))) {
    throw new Error("stageReview.outside");
  }
  const file = previous?.lookback.file ?? ResearchFolder.toRelative(from.uri.fsPath, root);
  await ResearchFolder.ensureRootRegistered();
  const [{ snapshotFiles }, { loadAllServicesAfterInit, loadAllServicesBeforeInit }, { TabWorkspace }] =
    await Promise.all([import("./Snapshot"), import("@/core/loadAllServices"), import("@/core/TabWorkspace")]);

  const snapshots = await listSnapshots(snapshotFiles, root);
  const nodes = nodesOf(snapshots);
  const node = nodeName ? nodes.find((candidate) => candidate.name === nodeName) : nodes.at(-1);
  if (!node) throw new Error("lookback.noNode");
  const nodeFile = boardInSnapshot(node, file)?.file;
  // 那个节点定格的时候还没有这块白板（或者它那时叫别的名字）
  if (!nodeFile) throw new Error("lookback.noBoard");
  const base = previousOf(snapshots, node);
  const baseFile = base && boardInSnapshot(base, file)?.file;
  const report = under(root, "汇报", reportFolderName(nodeLabel(node)), "报告.md");
  const live = liveBoardOf(root, file);
  const [content, after, before, hasReport] = await Promise.all([
    readSnapshotBoardContent(
      snapshotFiles,
      root,
      node,
      file,
      (id) => from.attachments.get(id) ?? live?.attachments.get(id),
    ),
    readSnapshotBoard(snapshotFiles, root, node.name, nodeFile),
    base && baseFile ? readSnapshotBoard(snapshotFiles, root, base.name, baseFile) : undefined,
    exists(report),
  ]);
  if (!content || !after) throw new Error("snapshot.boardMissing");
  const diff = compareBoards(before, after);

  const board = new LookbackBoard(
    {
      root,
      file,
      nodes,
      node,
      ...(base && { base }),
      counts: { added: diff.added.size, edited: diff.edited.size, removed: diff.removed.length },
      ...(hasReport && { report }),
    },
    content,
  );
  loadAllServicesBeforeInit(board);
  board.registerFileSystemProvider("draft", LookbackFiles);
  await board.init();
  // 读不出来、或者用户没同意升级旧格式：init 自己已经弹窗说过了，这里不再开标签
  if (board.projectState !== ProjectState.Saved) {
    await board.dispose();
    return undefined;
  }
  loadAllServicesAfterInit(board);
  // 镜头接着刚才看的地方，切节点时画面不跳，看得出哪里长出来了
  board.camera.applySavedView(from.camera.location.clone(), from.camera.currentScale);
  showSnapshotDiff(board, base?.name ?? "", before, after);

  // 直接放进原白板所在的标签组并紧挨在它前面：分屏时不会落到另一边的 PDF 组里，切换节点和关闭时也不会先跳到旁边的 PDF 标签
  TabWorkspace.open(board, { beforeTabId: from.id });
  board.loop();
  if (previous) await TabWorkspace.close(previous.id);
  return board;
}

/** 回到现在：先把真的那块白板切到前面（没开着就打开），再关掉回看，免得关标签那半秒先落到同组的别的标签上 */
export async function leaveLookback(board: LookbackBoard): Promise<void> {
  const { root, file } = board.lookback;
  const path = under(root, file);
  const [{ TabWorkspace }, { onOpenFile }] = await Promise.all([
    import("@/core/TabWorkspace"),
    import("@/core/service/GlobalMenu"),
  ]);
  const live = liveBoardOf(root, file);
  if (live) {
    TabWorkspace.focus(live.id);
    live.loop();
  } else if (await exists(path)) {
    const opened = await onOpenFile(URI.file(path), "Lookback");
    if (opened) TabWorkspace.focus(opened.id);
  }
  await TabWorkspace.close(board.id);
}
