import { Dialog } from "@/components/ui/dialog";
import type { CurveRenderer } from "@/core/render/canvas2d/basicRenderer/curveRenderer";
import type { ImageRenderer } from "@/core/render/canvas2d/basicRenderer/ImageRenderer";
import type { ShapeRenderer } from "@/core/render/canvas2d/basicRenderer/shapeRenderer";
import type { SvgRenderer } from "@/core/render/canvas2d/basicRenderer/svgRenderer";
import type { TextRenderer } from "@/core/render/canvas2d/basicRenderer/textRenderer";
import type { DrawingControllerRenderer } from "@/core/render/canvas2d/controllerRenderer/drawingRenderer";
import type { CollisionBoxRenderer } from "@/core/render/canvas2d/entityRenderer/CollisionBoxRenderer";
import type { StraightEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/StraightEdgeRenderer";
import type { SymmetryCurveEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/SymmetryCurveEdgeRenderer";
import type { VerticalPolyEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/VerticalPolyEdgeRenderer";
import type { EdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/EdgeRenderer";
import type { EntityDetailsButtonRenderer } from "@/core/render/canvas2d/entityRenderer/EntityDetailsButtonRenderer";
import type { EntityRenderer } from "@/core/render/canvas2d/entityRenderer/EntityRenderer";
import type { LatexNodeRenderer } from "@/core/render/canvas2d/entityRenderer/latexNode/LatexNodeRenderer";
import type { MediaNodeRenderer } from "@/core/render/canvas2d/entityRenderer/mediaNode/MediaNodeRenderer";
import type { MultiTargetUndirectedEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/multiTargetUndirectedEdge/MultiTargetUndirectedEdgeRenderer";
import type { ReferenceBlockRenderer } from "@/core/render/canvas2d/entityRenderer/ReferenceBlockRenderer";
import type { SectionRenderer } from "@/core/render/canvas2d/entityRenderer/section/SectionRenderer";
import type { SvgNodeRenderer } from "@/core/render/canvas2d/entityRenderer/svgNode/SvgNodeRenderer";
import type { TextNodeRenderer } from "@/core/render/canvas2d/entityRenderer/textNode/TextNodeRenderer";
import type { UrlNodeRenderer } from "@/core/render/canvas2d/entityRenderer/urlNode/urlNodeRenderer";
import type { Renderer } from "@/core/render/canvas2d/renderer";
import type { BackgroundRenderer } from "@/core/render/canvas2d/utilsRenderer/backgroundRenderer";
import type { RenderUtils } from "@/core/render/canvas2d/utilsRenderer/RenderUtils";
import type { SearchContentHighlightRenderer } from "@/core/render/canvas2d/utilsRenderer/searchContentHighlightRenderer";
import type { WorldRenderUtils } from "@/core/render/canvas2d/utilsRenderer/WorldRenderUtils";
import type { InputElement } from "@/core/render/domElement/inputElement";
import type { AutoLayoutFastTree } from "@/core/service/controlService/autoLayoutEngine/autoLayoutFastTreeMode";
import type { AutoLayout } from "@/core/service/controlService/autoLayoutEngine/mainTick";
import type { ControllerUtils } from "@/core/service/controlService/controller/concrete/utilsControl";
import type { Controller } from "@/core/service/controlService/controller/Controller";
import type { KeyboardOnlyEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyEngine";
import type { KeyboardOnlyGraphEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyGraphEngine";
import type { KeyboardOnlyTreeEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyTreeEngine";
import type { SelectChangeEngine } from "@/core/service/controlService/keyboardOnlyEngine/selectChangeEngine";
import type { RectangleSelect } from "@/core/service/controlService/rectangleSelectEngine/rectangleSelectEngine";
import type { KeyBindHintEngine } from "@/core/service/controlService/shortcutKeysEngine/KeyBindHintEngine";
import type { MouseInteraction } from "@/core/service/controlService/stageMouseInteractionCore/stageMouseInteractionCore";
import type { AutoComputeUtils } from "@/core/service/dataGenerateService/autoComputeEngine/AutoComputeUtils";
import type { AutoCompute } from "@/core/service/dataGenerateService/autoComputeEngine/mainTick";
import type { GenerateFromFolder } from "@/core/service/dataGenerateService/generateFromFolderEngine/GenerateFromFolderEngine";
import type { StageExport } from "@/core/service/dataGenerateService/stageExportEngine/stageExportEngine";
import type { StageExportPng } from "@/core/service/dataGenerateService/stageExportEngine/StageExportPng";
import type { StageExportSvg } from "@/core/service/dataGenerateService/stageExportEngine/StageExportSvg";
import type { StageImport } from "@/core/service/dataGenerateService/stageImportEngine/stageImportEngine";
import type { AIEngine } from "@/core/service/dataManageService/aiEngine/AIEngine";
import type { ComplexityDetector } from "@/core/service/dataManageService/ComplexityDetector";
import type { ContentSearch } from "@/core/service/dataManageService/contentSearchEngine/contentSearchEngine";
import type { CopyEngine } from "@/core/service/dataManageService/copyEngine/copyEngine";
import type { Effects } from "@/core/service/feedbackService/effectEngine/effectMachine";
import { StageStyleManager } from "@/core/service/feedbackService/stageStyle/StageStyleManager";
import type { Camera } from "@/core/stage/Camera";
import type { Canvas } from "@/core/stage/Canvas";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import type { LayoutManager } from "@/core/stage/stageManager/concreteMethods/LayoutManager";
import type { SectionCollisionSolver } from "@/core/stage/stageManager/concreteMethods/SectionCollisionSolver";
import type { AutoAlign } from "@/core/stage/stageManager/concreteMethods/StageAutoAlignManager";
import type { DeleteManager } from "@/core/stage/stageManager/concreteMethods/StageDeleteManager";
import type { EntityMoveManager } from "@/core/stage/stageManager/concreteMethods/StageEntityMoveManager";
import type { StageUtils } from "@/core/stage/stageManager/concreteMethods/StageManagerUtils";
import type { MultiTargetEdgeMove } from "@/core/stage/stageManager/concreteMethods/StageMultiTargetEdgeMove";
import type { NodeAdder } from "@/core/stage/stageManager/concreteMethods/StageNodeAdder";
import type { NodeConnector } from "@/core/stage/stageManager/concreteMethods/StageNodeConnector";
import type { StageNodeRotate } from "@/core/stage/stageManager/concreteMethods/stageNodeRotate";
import type { StageObjectColorManager } from "@/core/stage/stageManager/concreteMethods/StageObjectColorManager";
import type { StageObjectSelectCounter } from "@/core/stage/stageManager/concreteMethods/StageObjectSelectCounter";
import type { SectionInOutManager } from "@/core/stage/stageManager/concreteMethods/StageSectionInOutManager";
import type { SectionPackManager } from "@/core/stage/stageManager/concreteMethods/StageSectionPackManager";
import type { StageSyncAssociationManager } from "@/core/stage/stageManager/concreteMethods/StageSyncAssociationManager";
import type { TagManager } from "@/core/stage/stageManager/concreteMethods/StageTagManager";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import type { StageManager } from "@/core/stage/stageManager/StageManager";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import type { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { buildAiSidecar } from "@/core/research/AiSidecarBuilder";
import { isResearchShell, SIDECAR_JSON_SUFFIX, SIDECAR_MD_SUFFIX, WORKBENCH_DIR } from "@/core/research/ResearchShell";
import { Settings } from "@/core/service/Settings";
import { nextProjectIdAtom, store, tabsAtom } from "@/state";
import { createDefaultMetadata, PrgMetadata, readWorkbenchMetadata, WorkbenchMetadata } from "@/types/metadata";
import { Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Decoder, Encoder } from "@msgpack/msgpack";
import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import i18next from "i18next";
import { File } from "lucide-react";
import md5 from "md5";
import mime from "mime";
import React from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { URI, Utils } from "vscode-uri";
import { CollaborationService } from "./service/collaboration/CollaborationService";
import { AutoSaveBackupService } from "./service/dataFileService/AutoSaveBackupService";
import { generateThumbnail } from "./service/dataGenerateService/generateThumbnail";
import { ProjectOwnershipLifecycle, ProjectOwnershipLease } from "./ProjectOwnership";
import { compareProjectVersions, parseProjectFile } from "./ProjectFile";
import { ProjectUpgrader } from "./stage/ProjectUpgrader";
import { ReferenceManager } from "./stage/stageManager/concreteMethods/StageReferenceManager";
import { Tab } from "./Tab";

/**
 * 按需导入：ResearchFolder 负责新建和打开工作区，依赖界面层的模块，静态导入容易和 Project 成环
 */
async function loadResearchFolder() {
  return (await import("@/core/research/ResearchFolder")).ResearchFolder;
}

function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:)?[\\/]/.test(path);
}

/** 不同磁盘（Windows 盘符、macOS 的 /Volumes/<名字>）之间不存相对路径 */
function volumeOf(path: string): string {
  const posixPath = path.replaceAll("\\", "/");
  const drive = /^([a-zA-Z]):\//.exec(posixPath);
  if (drive) return `${drive[1].toUpperCase()}:`;
  const mounted = /^\/Volumes\/([^/]+)/.exec(posixPath);
  return mounted ? `/Volumes/${mounted[1]}` : "/";
}

/** 另存为进行中时的目标：getFileContent 据此写工作区信息和文件卡片路径 */
interface SaveAsTarget {
  uri: URI;
  /** 文件卡片 → 相对新 .prg 所在文件夹重新算出的 sourcePath（只列出有变化的） */
  sourcePaths: Map<FileCardNode, string>;
  /** 把已存盘的工作区另存成副本：副本要有自己的 id，AI 对话记录才不会和原文件共用 */
  isCopy: boolean;
}

/** 科研模式拒绝存到研究文件夹外面：抛出前已经弹过提示，调用方不用再提示一遍 */
export class ResearchSaveRefusedError extends Error {}

/** 提示按纯文本显示，路径和报错里的 / & 不能被转成 HTML 实体 */
function researchText(key: string, values: Record<string, string>): string {
  return i18next.t(key, { ns: "research", ...values, interpolation: { escapeValue: false } });
}

export enum ProjectState {
  /**
   * “已保存”
   * 已写入到原始文件中
   * 已上传到云端
   */
  Saved,
  /**
   * "已暂存"
   * 未写入到原始文件中，但是已经暂存到数据目录
   * 未上传到云端，但是已经暂存到本地
   */
  Stashed,
  /**
   * “未保存”
   * 未写入到原始文件中，也未暂存到数据目录（真·未保存）
   * 未上传到云端，也未暂存到本地
   */
  Unsaved,
}

/**
 * “工程”
 * 一个标签页对应一个工程，一个工程只能对应一个URI
 * 一个工程可以加载不同的服务，类似vscode的扩展（Extensions）机制
 */
export class Project extends Tab {
  static readonly latestVersion = 18;

  /**
   * 工程文件的URI
   * key: 服务ID
   * value: 服务实例
   */
  private _uri: URI;
  private _projectState: ProjectState = ProjectState.Unsaved;
  /**
   * 每次标成未保存（编辑、撤销、重做等）都加一，状态本来就是未保存时也加。
   * 保存要等写盘完成才标成已保存，这期间又有编辑的话，刚写下去的是旧内容，不能标成已保存。
   */
  private _editRevision = 0;
  private _isSaving = false;
  private readonly projectOwnership = new ProjectOwnershipLifecycle(this);
  public stage: StageObject[] = [];
  public sectionMoveDepth = 0;
  public tags: string[] = [];
  /**
   * string：UUID
   * value: Blob
   */
  public attachments = new Map<string, Blob>();
  /**
   * 创建Encoder对象比直接用encode()快
   * @see https://github.com/msgpack/msgpack-javascript#reusing-encoder-and-decoder-instances
   */
  private encoder = new Encoder();
  private decoder = new Decoder();

  /**
   * 创建一个项目
   * @param uri 工程文件的URI
   * 之所以从“路径”改为了“URI”，是因为要为后面的云同步功能做铺垫。
   * 普通的“路径”无法表示云盘中的文件，而URI可以。
   * 同时，草稿文件也从硬编码的“Project Graph”特殊文件路径改为了协议为draft、内容为UUID的URI。
   * @see https://code.visualstudio.com/api/references/vscode-api#workspace.workspaceFile
   */
  constructor(uri: URI) {
    super({});
    this._uri = uri;
  }

  attachProjectOwnership(ownership: ProjectOwnershipLease) {
    this.projectOwnership.attach(ownership);
  }

  /** Rename keeps the existing workspace/chat identity, unlike Save As. */
  rebindRenamedFile(target: URI, write: () => Promise<void>) {
    return this.projectOwnership.saveAs(target, write);
  }

  get projectOwnerIdentity() {
    return this.projectOwnership.ownershipId;
  }

  get canonicalProjectPath() {
    return this.projectOwnership.canonicalPath;
  }

  activateOpenRuntimeHost() {
    this.projectOwnership.activate();
  }
  /**
   * 创建一个草稿工程
   * URI为draft:UUID
   */
  static newDraft(): Project {
    // const num = store.get(tabsAtom).filter((p) => p.isDraft).length + 1;
    if (store.get(tabsAtom).length === 0) store.set(nextProjectIdAtom, 1);
    const num = store.get(nextProjectIdAtom);
    const uri = URI.parse("draft:" + num);
    store.set(nextProjectIdAtom, num + 1);
    return new Project(uri);
  }

  /**
   * 检查是否需要升级，如果需要则显示确认对话框
   * @param currentVersion 当前文件版本
   * @param latestVersion 最新版本
   */
  private async checkAndConfirmUpgrade(currentVersion: string, latestVersion: string): Promise<boolean> {
    const versionDiff = compareProjectVersions(currentVersion, latestVersion);

    // 文件版本 > 软件版本：文件来自更新版本的软件，当前软件无法安全解析，拒绝打开
    if (versionDiff > 0) {
      await Dialog.buttons(
        "文件版本过新，无法打开",
        `该文件由更新版本的软件保存（prg文件版本 ${currentVersion}，当前软件支持的prg最高版本 ${latestVersion}）。\n\n请升级软件后再打开此文件，以避免数据损坏。`,
        [{ id: "ok", label: "确定" }],
      );
      return false;
    }

    // 文件版本 == 软件版本：无需升级，直接打开
    if (versionDiff === 0) {
      return true;
    }

    // 文件版本 < 软件版本：需要升级旧文件，弹出确认对话框
    const response = await Dialog.buttons(
      "检测到旧版本项目文件",
      `当前文件版本为 ${currentVersion}，需要升级到 ${latestVersion} (是prg文件版本,非软件版本)。\n\n升级过程不可逆且可能存在风险，特别是对于大型文件，建议提前备份。是否继续升级？`,
      [
        { id: "cancel", label: "取消", variant: "ghost" },
        { id: "upgrade", label: "确认升级" },
      ],
    );

    if (response === "cancel") {
      // 用户取消升级，返回 false 表示取消
      return false;
    }

    // 添加延迟，确保用户看到提示并给系统时间处理
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  }

  /**
   * 服务加载完成后再调用
   */
  async init() {
    if (!(await this.fs.exists(this.uri))) {
      this.ensureWorkbenchId();
      return;
    }
    try {
      // 解析项目文件
      const { serializedStageObjects, tags, references, metadata, readme } = await parseProjectFile(
        await this.fs.read(this.uri),
        this.decoder,
        this.attachments,
      );

      // 检查并确认升级
      const currentVersion = metadata?.version || "2.0.0";
      const latestVersion = ProjectUpgrader.NLatestVersion;
      const confirmed = await this.checkAndConfirmUpgrade(currentVersion, latestVersion);
      if (!confirmed) return; // 用户取消升级，不打开文件，跳过 this.projectState = ProjectState.Saved

      // 升级数据
      const [upgradedStageObjects, upgradedMetadata] = ProjectUpgrader.upgradeNAnyToNLatest(
        serializedStageObjects,
        metadata as any,
      );

      // 应用升级后的数据
      this.stage = deserialize(upgradedStageObjects, this);
      const { convertLatexNodes } = await import("@/core/stage/stageObject/tools/convertLatexNodes");
      convertLatexNodes(this);
      this.tags = tags;
      this.references = references;
      this.metadata = upgradedMetadata;
      this.readme = readme;
      if (isResearchShell()) this.restoreSavedCamera();

      // 更新引用关系，包括双向线的偏移状态
      // 注意：这里需要在服务加载后才能调用，所以需要检查服务是否已加载
      if (this.getService("stageManager")) {
        this.stageManager.updateReferences();
      }

      this.wasUpgraded = currentVersion !== latestVersion;
    } catch (e) {
      console.warn(e);
      const errorMessage = `打开文件时发生错误，文件内容可能已损坏或与当前软件版本不兼容。\n\n错误信息：${e}`;
      const result = await Dialog.buttons("文件解析失败", errorMessage, [
        { id: "ok", label: "确定" },
        { id: "copy", label: "复制错误信息" },
      ]);
      if (result === "copy") {
        navigator.clipboard.writeText(errorMessage);
      }
      return;
    }
    this.projectState = ProjectState.Saved;
    // 旧文件刚补上的 id 要写回去：否则只聊天不改内容就关掉，下次打开又是新 id，这次的 AI 对话记录就找不回来了
    if (this.ensureWorkbenchId()) this.projectState = ProjectState.Unsaved;
  }

  /**
   * 科研模式下，工作区一打开（草稿一创建）就有固定的 id。AI 对话记录按它存，
   * 不能等到第一次保存或备份才生成，否则对话中途换了 key，记录就丢了。
   * 返回这次是否新生成了 id。
   */
  private ensureWorkbenchId(): boolean {
    if (!isResearchShell() || readWorkbenchMetadata(this.metadata)) return false;
    this.metadata = { ...this.metadata, workbench: { id: crypto.randomUUID(), createdAt: Date.now() } };
    return true;
  }

  get isDraft() {
    return this.uri.scheme === "draft";
  }
  get isCollab() {
    return this.uri.scheme === "collab";
  }
  get title(): string {
    return this.uri.scheme === "draft"
      ? `临时草稿 (${this.uri.path})`
      : this.uri.scheme === "collab"
        ? `协作 (${this.uri.path})`
        : this.uri.scheme === "file"
          ? this.uri.path.split("/").pop()!
          : this.uri.toString();
  }
  get icon() {
    return File;
  }
  get uri() {
    return this._uri;
  }
  set uri(uri: URI) {
    this._uri = uri;
    // 换位置不算编辑：另存为写完才改 uri，这一步不能让 editRevision 变化
    this.applyProjectState(ProjectState.Unsaved);
  }

  /**
   * 将文件暂存到数据目录中（通常为~/.local/share）
   * ~/.local/share/liren.project-graph/stash/<normalizedUri>
   * @see https://code.visualstudio.com/blogs/2016/11/30/hot-exit-in-insiders
   *
   * 频繁用msgpack序列化不会卡吗？
   * 虽然JSON.stringify()在V8上面速度和msgpack差不多
   * 但是要考虑跨平台，目前linux和macos用的都是webkit，目前还没有JavaScriptCore相关的benchmark
   * 而且考虑到以后会把图片也放进文件里面，JSON肯定不合适了
   * @see https://github.com/msgpack/msgpack-javascript#benchmark
   */
  async stash() {
    // TODO: stash
  }
  async save(options: { includeThumbnail?: boolean } = {}) {
    if (this.fileMutationInProgress) throw new Error("正在重命名文件，请稍后保存");
    if (this.isDraft || this.isCollab) {
      // 科研模式：草稿默认存进研究文件夹；程序只在研究文件夹里读写，所以存到外面会被拒绝
      const researchRoot = isResearchShell() ? (await loadResearchFolder()).getRoot() : "";
      const path = await saveDialog({
        title: this.isDraft ? "保存草稿" : "保存协作工程",
        filters: [{ name: "Project Graph", extensions: ["prg"] }],
        defaultPath: researchRoot || undefined,
      });
      if (!path) throw new Error("未选择路径");
      await this.saveAs(URI.file(path), options);
      return;
    }
    try {
      this.isSaving = true;
      const revision = this._editRevision;
      const content = await this.getFileContent(options);
      await this.fs.write(this.uri, content);
      this.adoptSavedWorkbench(content);
      this.markSavedIfUnchangedSince(revision);
      await this.writeAiSidecar(this.uri, content);
    } finally {
      this.isSaving = false;
    }
  }

  async saveAs(targetUri: URI, options: { includeThumbnail?: boolean } = {}) {
    if (this.fileMutationInProgress) throw new Error("正在重命名文件，请稍后保存");
    if (targetUri.scheme !== "file") throw new Error("Project Save As requires a file URI");
    const fileSystemProvider = this.fileSystemProviders.get("file");
    if (!fileSystemProvider) throw new Error("File Project provider is not registered");
    const saveAsTarget = isResearchShell() ? await this.prepareResearchSaveAs(targetUri) : null;

    try {
      this.isSaving = true;
      const revision = this._editRevision;
      this.saveAsTarget = saveAsTarget;
      const content = await this.getFileContent(options);
      this.saveAsTarget = null;
      await this.projectOwnership.saveAs(targetUri, () => fileSystemProvider.write(targetUri, content));
      // 写盘成功、uri 已换成新位置后再改内存里的路径：失败时原工程保持原样
      for (const [card, sourcePath] of saveAsTarget?.sourcePaths ?? []) {
        card.sourcePath = sourcePath;
      }
      this.adoptSavedWorkbench(content);
      this.markSavedIfUnchangedSince(revision);
      await this.writeAiSidecar(targetUri, content);
    } finally {
      this.saveAsTarget = null;
      this.isSaving = false;
    }
  }

  /**
   * 科研模式的另存为（草稿保存也走这里）：程序只在研究文件夹里读写，目标在外面就拒绝；
   * 文件卡片存的是相对 .prg 所在文件夹的路径，换了文件夹要重新算。
   */
  private async prepareResearchSaveAs(targetUri: URI): Promise<SaveAsTarget> {
    const ResearchFolder = await loadResearchFolder();
    const researchRoot = ResearchFolder.getRoot();
    if (researchRoot && !ResearchFolder.isInside(targetUri.fsPath)) {
      const message = researchText("workspace.save.outsideFolder", { path: targetUri.fsPath, root: researchRoot });
      // 菜单和快捷键调用另存为时不接异常，用户只能从提示里知道没存
      toast.error(message, { id: "research-save-outside-folder" });
      throw new ResearchSaveRefusedError(message);
    }
    const isCopy = this.uri.scheme === "file" && this.uri.toString() !== targetUri.toString();
    const sourcePaths = new Map<FileCardNode, string>();
    // 草稿里的卡片存的是绝对路径，按接口约定保存时不改写；同一个文件夹里另存，相对路径也不用变
    const sameFolder = Utils.dirname(this.uri).toString() === Utils.dirname(targetUri).toString();
    if (this.uri.scheme !== "file" || sameFolder) return { uri: targetUri, sourcePaths, isCopy };
    const [{ FileCardNode }, { resolveSourcePath }] = await Promise.all([
      import("@/core/stage/stageObject/entity/FileCardNode"),
      import("@/core/research/FileCardFactory"),
    ]);
    const targetFolder = Utils.dirname(targetUri).fsPath;
    for (const stageObject of this.stage) {
      if (!(stageObject instanceof FileCardNode) || isAbsolutePath(stageObject.sourcePath)) continue;
      // this.uri 还是原来的位置，按原文件夹解析
      const absolutePath = resolveSourcePath(this, stageObject.sourcePath);
      const storedPath =
        volumeOf(absolutePath) === volumeOf(targetFolder)
          ? ResearchFolder.toRelative(absolutePath, targetFolder)
          : absolutePath;
      if (storedPath !== stageObject.sourcePath) sourcePaths.set(stageObject, storedPath);
    }
    return { uri: targetUri, sourcePaths, isCopy };
  }

  /** 研究模式下，写盘期间又有新编辑就保持未保存，让自动保存下一轮把它写进去 */
  private markSavedIfUnchangedSince(revision: number) {
    if (isResearchShell() && this._editRevision !== revision) return;
    this.projectState = ProjectState.Saved;
  }

  /** 写盘成功后才把这次存下的工作区信息（id、视野、位置）记到内存里；备份不改元数据 */
  private adoptSavedWorkbench(content: Uint8Array) {
    const workbench = this.workbenchByContent.get(content);
    if (workbench) this.metadata = { ...this.metadata, workbench };
  }

  // 反向引用数据
  public references: { sections: Record<string, string[]>; files: string[] } = { sections: {}, files: [] };
  public fileMutationInProgress = false;
  public metadata: PrgMetadata = createDefaultMetadata(ProjectUpgrader.NLatestVersion);
  public readme?: string;
  public wasUpgraded = false;

  /**
   * getFileContent 生成的字节 → 同一次 serialize 的结果。
   * save / saveAs 写完 .prg 后用它生成 AI 文字版，不必再 serialize 一遍，getFileContent 的返回值也不用改。
   */
  private readonly serializedStageByContent = new WeakMap<Uint8Array, unknown[]>();
  /** getFileContent 生成的字节 → 里面写的工作区信息。只有保存成功才记回内存，备份不动 this.metadata */
  private readonly workbenchByContent = new WeakMap<Uint8Array, WorkbenchMetadata>();
  private saveAsTarget: SaveAsTarget | null = null;

  private restoreSavedCamera() {
    const camera = readWorkbenchMetadata(this.metadata)?.camera;
    if (camera && this.getService("camera")) {
      this.camera.applySavedView(new Vector(camera.x, camera.y), camera.scale);
    }
  }

  /**
   * 要写进文件的工作区信息：当前视野、相对研究文件夹的位置；另存成副本时换一个新 id。
   * id 平时在 init 里就有了，这里补生成只是兜底（比如没走 init 的工程）。
   * 命令行里没有摄像机服务，原来存的视野保持不变。不修改 this.metadata。
   */
  private async workbenchForSave(targetUri: URI, isCopy: boolean): Promise<WorkbenchMetadata> {
    const existing = readWorkbenchMetadata(this.metadata);
    const workbench: WorkbenchMetadata =
      existing && !isCopy ? existing : { ...existing, id: crypto.randomUUID(), createdAt: Date.now() };
    const camera = this.getService("camera");
    if (camera?.isInitialViewSettled) {
      workbench.camera = { x: camera.location.x, y: camera.location.y, scale: camera.currentScale };
    }
    if (targetUri.scheme === "file") {
      const ResearchFolder = await loadResearchFolder();
      if (ResearchFolder.isInside(targetUri.fsPath)) {
        workbench.workspacePath = ResearchFolder.toRelative(targetUri.fsPath);
      } else {
        delete workbench.workspacePath;
      }
    }
    return workbench;
  }

  /**
   * 在 <.prg 所在文件夹>/.workbench/ 下写 AI 读的文字版（.ai.json 和 .ai.md）。
   * 只提示、不抛错：文字版写不出来不能让保存本身失败。
   * file 协议的 FileSystemProvider 写入本身就是「临时文件 + 改名」（命令行版换成 node:fs 实现，也一样）。
   */
  private async writeAiSidecar(targetUri: URI, content: Uint8Array) {
    if (!isResearchShell() || targetUri.scheme !== "file" || !Settings.writeAiSidecarOnSave) return;
    const serializedStage = this.serializedStageByContent.get(content);
    const fileSystemProvider = this.fileSystemProviders.get("file");
    if (!serializedStage || !fileSystemProvider) return;
    try {
      const { json, markdown } = buildAiSidecar({
        serializedStage,
        tags: this.tags,
        metadata: this.metadata,
        workspaceFile: targetUri.fsPath,
        researchRoot: (await loadResearchFolder()).getRoot(),
        readme: this.readme,
      });
      const workbenchDir = Utils.joinPath(Utils.dirname(targetUri), WORKBENCH_DIR);
      const workspaceName = Utils.basename(targetUri).replace(/\.prg$/i, "");
      if (!(await fileSystemProvider.exists(workbenchDir))) await fileSystemProvider.mkdir(workbenchDir);
      const encoder = new TextEncoder();
      await fileSystemProvider.write(
        Utils.joinPath(workbenchDir, workspaceName + SIDECAR_JSON_SUFFIX),
        encoder.encode(JSON.stringify(json, null, 2)),
      );
      await fileSystemProvider.write(
        Utils.joinPath(workbenchDir, workspaceName + SIDECAR_MD_SUFFIX),
        encoder.encode(markdown),
      );
    } catch (error) {
      // 固定 id：自动保存反复失败时只留一条提示
      toast.warning(researchText("workspace.save.sidecarFailed", { error: String(error) }), {
        id: "research-ai-sidecar-failed",
      });
    }
  }

  // 备份也要用到这个
  async getFileContent(options: { includeThumbnail?: boolean } = {}) {
    const includeThumbnail = options.includeThumbnail !== false;
    const saveAsTarget = this.saveAsTarget;
    const workbench = isResearchShell()
      ? await this.workbenchForSave(saveAsTarget?.uri ?? this.uri, saveAsTarget?.isCopy ?? false)
      : undefined;
    const metadata = workbench ? { ...this.metadata, workbench } : this.metadata;
    const serializedStage: unknown[] = serialize(this.stage);
    if (saveAsTarget) {
      this.stage.forEach((stageObject, index) => {
        const sourcePath = saveAsTarget.sourcePaths.get(stageObject as FileCardNode);
        if (sourcePath !== undefined) (serializedStage[index] as { sourcePath: string }).sourcePath = sourcePath;
      });
    }
    const encodedStage = this.encoder.encode(serializedStage);
    const uwriter = new Uint8ArrayWriter();

    // @zip.js/zip.js 从 ^2.7.63 升到了 ^2.8.26，需要显示指定 level: 0，防止保存的时候卡顿
    const writer = new ZipWriter(uwriter, { level: 0 });
    await writer.add("stage.msgpack", new Uint8ArrayReader(encodedStage), { level: 0 });
    await writer.add("tags.msgpack", new Uint8ArrayReader(this.encoder.encode(this.tags)), { level: 0 });
    await writer.add("reference.msgpack", new Uint8ArrayReader(this.encoder.encode(this.references)), { level: 0 });
    await writer.add("metadata.msgpack", new Uint8ArrayReader(this.encoder.encode(metadata)), { level: 0 });
    if (this.readme) {
      await writer.add("README.md", new Uint8ArrayReader(new TextEncoder().encode(this.readme)), { level: 0 });
    }
    // 添加附件
    for (const [uuid, attachment] of this.attachments.entries()) {
      await writer.add(`attachments/${uuid}.${mime.getExtension(attachment.type)}`, new BlobReader(attachment), {
        level: 0,
      });
    }
    // 添加缩略图
    if (includeThumbnail) {
      try {
        const thumbnailBlob = await generateThumbnail(this);
        if (thumbnailBlob) {
          await writer.add("thumbnail.png", new BlobReader(thumbnailBlob), { level: 0 });
        }
      } catch {
        // 缩略图生成失败不阻止保存
      }
    }
    await writer.close();

    const fileContent = await uwriter.getData();
    this.serializedStageByContent.set(fileContent, serializedStage);
    if (workbench) this.workbenchByContent.set(fileContent, workbench);
    return fileContent;
  }

  /**
   * 备份用：生成项目内容的哈希值，用于检测内容是否发生变化
   */
  get stageHash() {
    const serializedStage = serialize(this.stage);
    // 创建临时Encoder来编码数据
    const tempEncoder = new Encoder();
    const encodedStage = tempEncoder.encode(serializedStage);
    return md5(encodedStage);
  }

  /**
   * 注册一个文件管理器
   * @param scheme 目前有 "file" | "draft"， 以后可能有其他的协议
   */

  addAttachment(data: Blob, id: string = crypto.randomUUID()): string {
    const uuid = id;
    this.attachments.set(uuid, data);
    this.emit("attachment-add", { id: uuid, data });
    return uuid;
  }

  set projectState(state: ProjectState) {
    if (state === ProjectState.Unsaved) this._editRevision++;
    this.applyProjectState(state);
  }

  private applyProjectState(state: ProjectState) {
    if (state === this._projectState) return;
    this._projectState = state;
    this.emit("state-change", state);
  }

  get editRevision(): number {
    return this._editRevision;
  }

  get projectState(): ProjectState {
    return this._projectState;
  }

  set isSaving(isSaving: boolean) {
    if (isSaving === this._isSaving) return;
    this._isSaving = isSaving;
    this.emit("state-change", this._projectState);
  }

  get isSaving(): boolean {
    return this._isSaving;
  }

  private containerRef = React.createRef<HTMLDivElement>();

  /**
   * 立刻加载一个新的服务
   */
  loadService(service: { id?: string; new (...args: any[]): any }) {
    super.loadService(service);
    // 如果加载的是 canvas 服务，且容器已经准备好了，就进行挂载
    if (service.id === "canvas" && (this as any)._lastContainer) {
      this.canvas.mount((this as any)._lastContainer);
    }
  }

  componentDidMount(): void {
    // 这里的 this 是 Project 实例，不再作为 React 组件直接使用
  }

  private currentComponent: React.ComponentType | null = null;

  public getComponent(): React.ComponentType {
    if (this.currentComponent) return this.currentComponent;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.currentComponent = class extends React.Component<Record<string, never>> {
      displayName = "ProjectContainer";
      private containerRef = React.createRef<HTMLDivElement>();

      componentDidMount(): void {
        (self as any)._lastContainer = this.containerRef.current;
        if (this.containerRef.current && self.getService("canvas")) {
          self.canvas.mount(this.containerRef.current);
        }
      }

      render() {
        return (
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 overflow-hidden" ref={this.containerRef}></div>
          </div>
        );
      }
    };
    return this.currentComponent as React.ComponentType;
  }

  render(): React.ReactNode {
    return (
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 overflow-hidden" ref={this.containerRef}></div>
      </div>
    );
  }

  override async dispose() {
    await this.projectOwnership.dispose(async () => {
      const cleanupErrors: unknown[] = [];
      try {
        await super.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
      const stageCleanupTasks = this.stage.map((stageObject) => Promise.resolve().then(() => stageObject.dispose?.()));
      const stageCleanupResults = await Promise.allSettled(stageCleanupTasks);
      cleanupErrors.push(
        ...stageCleanupResults
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(({ reason }) => reason),
      );
      this.stage.length = 0;
      this.attachments.clear();
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Project cleanup failed");
    });
  }
}

declare module "./Project" {
  interface Project {
    canvas: Canvas;
    inputElement: InputElement;
    controllerUtils: ControllerUtils;
    autoComputeUtils: AutoComputeUtils;
    renderUtils: RenderUtils;
    worldRenderUtils: WorldRenderUtils;
    historyManager: HistoryManager;
    stageManager: StageManager;
    camera: Camera;
    effects: Effects;
    autoCompute: AutoCompute;
    rectangleSelect: RectangleSelect;
    stageNodeRotate: StageNodeRotate;
    complexityDetector: ComplexityDetector;
    aiEngine: AIEngine;
    copyEngine: CopyEngine;
    autoLayout: AutoLayout;
    autoLayoutFastTree: AutoLayoutFastTree;
    layoutManager: LayoutManager;
    autoAlign: AutoAlign;
    mouseInteraction: MouseInteraction;
    contentSearch: ContentSearch;
    deleteManager: DeleteManager;
    nodeAdder: NodeAdder;
    entityMoveManager: EntityMoveManager;
    stageUtils: StageUtils;
    multiTargetEdgeMove: MultiTargetEdgeMove;
    nodeConnector: NodeConnector;
    stageObjectColorManager: StageObjectColorManager;
    stageObjectSelectCounter: StageObjectSelectCounter;
    sectionInOutManager: SectionInOutManager;
    sectionPackManager: SectionPackManager;
    sectionCollisionSolver: SectionCollisionSolver;
    tagManager: TagManager;
    syncAssociationManager: StageSyncAssociationManager;
    keyboardOnlyEngine: KeyboardOnlyEngine;
    keyboardOnlyGraphEngine: KeyboardOnlyGraphEngine;
    keyboardOnlyTreeEngine: KeyboardOnlyTreeEngine;
    selectChangeEngine: SelectChangeEngine;
    textRenderer: TextRenderer;
    imageRenderer: ImageRenderer;
    referenceBlockRenderer: ReferenceBlockRenderer;
    shapeRenderer: ShapeRenderer;
    entityRenderer: EntityRenderer;
    edgeRenderer: EdgeRenderer;
    multiTargetUndirectedEdgeRenderer: MultiTargetUndirectedEdgeRenderer;
    curveRenderer: CurveRenderer;
    svgRenderer: SvgRenderer;
    drawingControllerRenderer: DrawingControllerRenderer;
    collisionBoxRenderer: CollisionBoxRenderer;
    entityDetailsButtonRenderer: EntityDetailsButtonRenderer;
    straightEdgeRenderer: StraightEdgeRenderer;
    symmetryCurveEdgeRenderer: SymmetryCurveEdgeRenderer;
    verticalPolyEdgeRenderer: VerticalPolyEdgeRenderer;
    sectionRenderer: SectionRenderer;
    svgNodeRenderer: SvgNodeRenderer;
    latexNodeRenderer: LatexNodeRenderer;
    mediaNodeRenderer: MediaNodeRenderer;
    textNodeRenderer: TextNodeRenderer;
    urlNodeRenderer: UrlNodeRenderer;
    backgroundRenderer: BackgroundRenderer;
    searchContentHighlightRenderer: SearchContentHighlightRenderer;
    renderer: Renderer;
    controller: Controller;
    stageExport: StageExport;
    stageExportPng: StageExportPng;
    stageExportSvg: StageExportSvg;
    stageImport: StageImport;
    generateFromFolder: GenerateFromFolder;
    keyBindHintEngine: KeyBindHintEngine;
    sectionMethods: SectionMethods;
    graphMethods: GraphMethods;
    stageStyleManager: StageStyleManager;
    autoSaveBackup: AutoSaveBackupService;
    referenceManager: ReferenceManager;
    collaboration: CollaborationService;
  }
}

/**
 * 装饰器
 */
export const service =
  (id: string) =>
  <
    T extends {
      [x: string | number | symbol]: any;
      id?: string;
      new (...args: any[]): any;
    },
  >(
    target: T,
  ): T & { id: string } => {
    target.id = id;
    return target as T & { id: string };
  };
