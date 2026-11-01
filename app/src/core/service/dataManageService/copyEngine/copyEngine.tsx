import { Project, service } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { isLinux, isMac, isWindows } from "@/utils/platform";
import { ConnectableAssociation } from "@/core/stage/stageObject/abstract/Association";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { resolveSourcePath, rewriteSerializedFileCardPaths, toStoredSourcePath } from "@/core/research/FileCardFactory";
import { nudgeEntitiesOutOfOverlap } from "@/core/research/OverlapResolver";
import { isResearchShell } from "@/core/research/ResearchShell";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { Serialized } from "@/types/node";
import { Color, ProgressNumber, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import { Image as TauriImage } from "@tauri-apps/api/image";
import { readText, writeImage, writeText } from "@tauri-apps/plugin-clipboard-manager";
import _ from "lodash";
import { toast } from "sonner";
import { v4 } from "uuid";
import { MouseLocation } from "../../controlService/MouseLocation";
import { EntityShrinkEffect } from "../../feedbackService/effectEngine/concrete/EntityShrinkEffect";
import { PenStrokeDeletedEffect } from "../../feedbackService/effectEngine/concrete/PenStrokeDeletedEffect";
import { RectangleNoteEffect } from "../../feedbackService/effectEngine/concrete/RectangleNoteEffect";
import { RectangleNoteReversedEffect } from "../../feedbackService/effectEngine/concrete/RectangleNoteReversedEffect";
import { RectanglePushInEffect } from "../../feedbackService/effectEngine/concrete/RectanglePushInEffect";
import { VirtualClipboard } from "./VirtualClipboard";
import { CopyEngineImage } from "./copyEngineImage";
import { CopyEngineText } from "./copyEngineText";
import { CopyEngineUtils } from "./copyEngineUtils";

/**
 * 专门用来管理节点复制的引擎
 */
@service("copyEngine")
export class CopyEngine {
  private copyEngineImage: CopyEngineImage;
  private copyEngineText: CopyEngineText;

  constructor(private readonly project: Project) {
    this.copyEngineImage = new CopyEngineImage(project);
    this.copyEngineText = new CopyEngineText(project);
  }

  /**
   * 用户按下了ctrl+c，
   * 将当前选中的节点复制到虚拟粘贴板
   * 也要将选中的部分复制到系统粘贴板
   */
  async copy() {
    if (await this.copySelectedEntities()) {
      // 最后清空所有选择
      this.project.stageManager.clearSelectAll();
    }
  }

  /**
   * 剪切：复制，然后删掉复制的实体。
   * 不能先调 copy()，它最后会清空选择，后面就不知道该删什么了。
   */
  async cut() {
    const copiedEntities = await this.copySelectedEntities();
    if (!copiedEntities) return;
    // 和 Delete 键一样跳过锁定分组框里的东西和背景图；复制要等附件读完，这期间可能已经被别的操作删掉了
    const stageObjects = new Set<StageObject>(this.project.stage);
    const deletableEntities = copiedEntities.filter(
      (entity) =>
        stageObjects.has(entity) &&
        !this.project.sectionMethods.isObjectBeLockedBySection(entity) &&
        !(entity instanceof ImageNode && entity.isBackground),
    );
    for (const entity of deletableEntities) {
      this.project.effects.addEffect(
        entity instanceof PenStroke
          ? PenStrokeDeletedEffect.fromPenStroke(entity)
          : EntityShrinkEffect.fromEntity(entity),
      );
    }
    // 复制不记历史，deleteEntities 记一步，所以撤销一次就能恢复
    this.project.stageManager.deleteEntities(deletableEntities);
  }

  /**
   * 把选中的实体复制到虚拟剪贴板和系统剪贴板，不改选择。
   * 返回复制了的实体；没选中实体时清空虚拟剪贴板并返回 null。
   */
  private async copySelectedEntities(): Promise<Entity[] | null> {
    // 获取所有选中的实体，不能包含关系
    const selectedEntities = this.project.stageManager.getSelectedEntities();
    if (selectedEntities.length === 0) {
      // 如果没有选中东西，就是清空虚拟粘贴板
      VirtualClipboard.clear();
      toast.info("当前没有选中任何实体，已清空了虚拟剪贴板");
      return null;
    }
    const copiedStageObjects = CopyEngineUtils.getAllStageObjectFromEntities(this.project, selectedEntities);

    // 收集所有需要复制的附件（ImageNode 和 SvgNode 的附件）
    const attachmentMap = await CopyEngineUtils.collectAttachmentFromStageObjects(this.project, copiedStageObjects);

    // 深拷贝一下数据，只有在粘贴的时候才刷新uuid
    const serializedCopiedStageObjects = serialize(copiedStageObjects);
    // 文件卡片存的是相对本工程的路径，可能粘贴到别的文件夹里的工程，先换成绝对路径，粘贴时再换回来。
    // 选中 Section 时，里面的卡片内联在 Section 的 children 里，顶层只剩一个引用，所以要整棵树找
    rewriteSerializedFileCardPaths(serializedCopiedStageObjects, (sourcePath) =>
      resolveSourcePath(this.project, sourcePath),
    );

    // 将舞台对象和附件一起存储到虚拟粘贴板
    const copyGeneration = VirtualClipboard.copy({
      stageObjects: serialize(serializedCopiedStageObjects),
      attachments: Object.fromEntries(attachmentMap),
    });

    const rect = Rectangle.getBoundingRectangle(selectedEntities.map((it) => it.collisionBox.getRectangle()));
    this.project.effects.addEffect(new RectangleNoteReversedEffect(new ProgressNumber(0, 100), rect, Color.Green));

    const systemClipboardWritten = this.writeSystemClipboard(selectedEntities);
    if (isResearchShell()) {
      // 记下复制完成时系统剪贴板里是什么，粘贴时对比，就知道用户之后有没有在别处复制新东西
      await systemClipboardWritten;
      VirtualClipboard.rememberSystemClipboardText(copyGeneration, await readSystemClipboardText());
    }
    return selectedEntities;
  }

  private async writeSystemClipboard(selectedEntities: Entity[]) {
    // 更新系统剪贴板
    // 如果只有一张图片就直接复制图片
    if (selectedEntities.length === 1 && selectedEntities[0] instanceof ImageNode) {
      const imageNode = selectedEntities[0] as ImageNode;
      const blob = this.project.attachments.get(imageNode.attachmentId);
      if (blob) {
        toast.success("已将选中的图片复制到系统剪贴板");
        await writeImage(await TauriImage.fromBytes(await blob.arrayBuffer()));
      }
    } else {
      // 否则复制全部文本节点，用两个换行分割
      const textNodes = selectedEntities.filter((it) => it instanceof TextNode) as TextNode[];
      if (textNodes.length > 0) {
        const text = textNodes.map((it) => it.text).join("\n\n");
        toast.success("已将选中的文本复制到系统剪贴板");
        await writeText(text);
      }
    }
  }

  /**
   * 用户按下了ctrl+v，将粘贴板数据粘贴到画布上
   */
  async paste() {
    if (isResearchShell()) {
      if (await this.hasFreshVirtualClipboardData()) {
        this.virtualClipboardPaste("pointer");
      } else {
        await this.readSystemClipboardAndPaste();
      }
      return;
    }
    // 如果有虚拟粘贴板数据，则优先粘贴虚拟粘贴板上的东西
    if (VirtualClipboard.hasData()) {
      this.virtualClipboardPaste();
    } else {
      void this.readSystemClipboardAndPaste();
    }
  }

  /**
   * 原位粘贴：坐标和复制时一模一样，用来剪切后贴回原处、或贴到另一块白板的同一位置。
   * 从别处复制来的文字和图片没有原位置，照常贴到鼠标处。
   */
  async pasteWithOriginLocation() {
    const hasVirtualData = isResearchShell() ? await this.hasFreshVirtualClipboardData() : VirtualClipboard.hasData();
    if (hasVirtualData) {
      this.virtualClipboardPaste("origin");
    } else {
      await this.readSystemClipboardAndPaste();
    }
  }

  /** 科研模式下虚拟剪贴板可以反复粘贴；但用户在别处复制了新东西以后，就该贴新的了 */
  private async hasFreshVirtualClipboardData(): Promise<boolean> {
    if (!VirtualClipboard.hasData()) return false;
    if (VirtualClipboard.isOutdatedBy(await readSystemClipboardText())) {
      VirtualClipboard.clear();
    }
    return VirtualClipboard.hasData();
  }

  /**
   * below：原版行为，贴在原内容正下方，粘贴一次就清空虚拟剪贴板；
   * pointer：贴到鼠标处（科研模式的 Cmd+V）；origin：贴在原坐标。
   */
  virtualClipboardPaste(placement: "below" | "pointer" | "origin" = "below") {
    const pasteData = this.instantiateVirtualClipboard();
    if (placement === "below") {
      this.pasteBelowOriginal(pasteData);
    } else {
      this.pasteAt(pasteData, placement);
    }
    // 原版粘贴一次就清空；科研模式留着，可以连续粘贴多份
    if (!isResearchShell()) {
      VirtualClipboard.clear();
    }
  }

  /** 把虚拟剪贴板里的数据变成一份新的舞台对象：新的 uuid、新的附件，文件卡片路径换成相对本工程 */
  private instantiateVirtualClipboard(): StageObject[] {
    const clipboardData = VirtualClipboard.paste();

    // 兼容旧格式：如果直接是序列化数据，则没有附件
    let pastDataSerialized: any;
    let attachmentsData: Record<string, { data: ArrayBuffer; type: string }> | undefined;

    if (clipboardData && typeof clipboardData === "object" && "stageObjects" in clipboardData) {
      // 新格式：包含附件数据
      pastDataSerialized = clipboardData.stageObjects;
      attachmentsData = clipboardData.attachments;
    } else {
      // 旧格式：只有序列化数据
      pastDataSerialized = clipboardData;
    }

    // deserialize 会就地把传进去的数据换成实例，不先拷贝的话，下一次粘贴会和这次共用碰撞箱等对象
    const pasteData: StageObject[] = deserialize(_.cloneDeep(pastDataSerialized), this.project);

    // 处理附件：将附件添加到新项目中，并建立 oldAttachmentId -> newAttachmentId 的映射
    const attachmentIdMap = new Map<string, string>();
    if (attachmentsData) {
      for (const [oldAttachmentId, attachmentInfo] of Object.entries(attachmentsData)) {
        // 将 ArrayBuffer 转换回 Blob
        const blob = new Blob([attachmentInfo.data], { type: attachmentInfo.type });
        // 添加到新项目并生成新的 UUID
        const newAttachmentId = this.project.addAttachment(blob);
        attachmentIdMap.set(oldAttachmentId, newAttachmentId);
      }
    }

    // 粘贴的时候刷新UUID
    for (const stageObject of pasteData) {
      if (stageObject instanceof Entity) {
        // @ts-expect-error 没办法，只能这么做了，否则会出现移动速度2倍甚至n倍的bug
        stageObject.project = this.project;
        const newUUID = v4();
        const oldUUID = stageObject.uuid;
        stageObject.uuid = newUUID;

        // 更新附件ID（如果是 ImageNode 或 SvgNode）
        if (stageObject instanceof ImageNode) {
          const oldAttachmentId = stageObject.attachmentId;
          if (oldAttachmentId && attachmentIdMap.has(oldAttachmentId)) {
            const newAttachmentId = attachmentIdMap.get(oldAttachmentId)!;
            stageObject.attachmentId = newAttachmentId;
            // 重新加载图片附件
            const blob = this.project.attachments.get(newAttachmentId);
            if (blob) {
              createImageBitmap(blob).then((bitmap) => {
                stageObject.bitmap = bitmap;
                stageObject.state = "success";
                // 设置碰撞箱
                stageObject.scaleUpdate(0);
              });
            }
          }
        } else if (stageObject instanceof SvgNode) {
          const oldAttachmentId = stageObject.attachmentId;
          if (oldAttachmentId && attachmentIdMap.has(oldAttachmentId)) {
            const newAttachmentId = attachmentIdMap.get(oldAttachmentId)!;
            stageObject.attachmentId = newAttachmentId;
            // 重新加载 SVG 附件
            const blob = this.project.attachments.get(newAttachmentId);
            if (blob) {
              const url = URL.createObjectURL(blob);
              stageObject.image = new Image();
              stageObject.image.src = url;
              stageObject.image.onload = () => {
                stageObject.originalSize = new Vector(stageObject.image.naturalWidth, stageObject.image.naturalHeight);
                stageObject.collisionBox = new CollisionBox([
                  new Rectangle(
                    stageObject.collisionBox.getRectangle().location,
                    stageObject.originalSize.multiply(stageObject.scale),
                  ),
                ]);
              };
            }
          }
        } else if (stageObject instanceof MediaNode) {
          const oldAttachmentId = stageObject.attachmentId;
          if (oldAttachmentId && attachmentIdMap.has(oldAttachmentId)) {
            const newAttachmentId = attachmentIdMap.get(oldAttachmentId)!;
            stageObject.attachmentId = newAttachmentId;
            stageObject.reload();
          }
        } else if (stageObject instanceof FileCardNode) {
          // 缩略图在渲染时按新的 attachmentId 重新解码
          const oldAttachmentId = stageObject.attachmentId;
          if (oldAttachmentId && attachmentIdMap.has(oldAttachmentId)) {
            stageObject.attachmentId = attachmentIdMap.get(oldAttachmentId)!;
          }
          stageObject.sourcePath = toStoredSourcePath(
            this.project,
            resolveSourcePath(this.project, stageObject.sourcePath),
          );
        }

        // 开始遍历所有关联，更新uuid
        for (const stageObject2 of pasteData) {
          if (stageObject2 instanceof ConnectableAssociation) {
            // 更新这个关系对象本身的uuid,因为目前还没有关系的关系，所以可以直接更新。
            stageObject2.uuid = v4();

            if (stageObject2 instanceof Edge) {
              if (stageObject2.source.uuid === oldUUID) {
                stageObject2.source.uuid = newUUID;
              }
              if (stageObject2.target.uuid === oldUUID) {
                stageObject2.target.uuid = newUUID;
              }
            } else if (stageObject2 instanceof MultiTargetUndirectedEdge) {
              for (const associationListItem of stageObject2.associationList) {
                if (associationListItem.uuid === oldUUID) {
                  associationListItem.uuid = newUUID;
                }
              }
            }
          }
        }
      }
    }
    return pasteData;
  }

  private pasteBelowOriginal(pasteData: StageObject[]) {
    // 将pasteData设为选中状态
    const shouldSelectedEntities = this.project.sectionMethods.shallowerNotSectionEntities(
      pasteData.filter((it) => it instanceof Entity) as Entity[],
    );
    shouldSelectedEntities.forEach((it) => (it.isSelected = true));
    // 粘贴到舞台上（必须先粘贴到舞台上，再运行选择标准化、移动函数）
    this.project.stage.push(...pasteData);
    // 粘贴出的 Section / Edge 需要先重建运行时引用和层级树，否则后续点选与拖拽会失效。
    this.project.stageManager.updateReferences();
    // 选中标准化
    this.project.controllerUtils.selectedEntityNormalizing();

    // 将所有选中的实体，往右下角移动一点
    const rect = Rectangle.getBoundingRectangle(pasteData.map((it: StageObject) => it.collisionBox.getRectangle()));
    this.project.entityMoveManager.moveSelectedEntities(new Vector(0, rect.height));
    // 加特效
    const effectRect = Rectangle.getBoundingRectangle(
      shouldSelectedEntities.map((it) => it.collisionBox.getRectangle()),
    );
    this.project.effects.addEffect(new RectangleNoteEffect(new ProgressNumber(0, 50), effectRect, Color.Green));
    toast.success(
      <div>
        <h2 className="text-lg">粘贴成功</h2>
        <p className="text-xs">粘贴位置在{effectRect.leftTop.toString()}，如果您是跨文档粘贴，请注意调整位置</p>
        <p className="text-xs">已帮您自动选中该内容，按下默认快捷键 `F` 即可快速聚焦到该内容</p>
      </div>,
    );
  }

  /**
   * 把粘贴内容的外接矩形中心对到鼠标处（pointer），或者原样留在原坐标（origin）。
   * 落点在分组框里就放进那个框；pointer 时最后把它整体挪到最近的空位，不推开别的卡片。整个粘贴记一步历史。
   */
  private pasteAt(pasteData: StageObject[], placement: "pointer" | "origin") {
    const pastedEntities = pasteData.filter((it) => it instanceof Entity) as Entity[];
    if (pastedEntities.length === 0) return;
    const bounds = Rectangle.getBoundingRectangle(pastedEntities.map((it) => it.collisionBox.getRectangle()));
    const dropLocation = placement === "pointer" ? this.pointerPasteLocation() : bounds.center;
    const offset =
      placement === "pointer" ? CopyEngineUtils.computePasteOffset(bounds, dropLocation) : Vector.getZero();
    // 要在放上舞台之前找，否则粘贴出来的分组框自己也会被找到
    const dropSection = this.findDropSection(dropLocation, bounds.translate(offset));
    // 放上舞台之前直接改坐标：放上去以后再 move()，会把原有的卡片一路推开
    if (!offset.isZero()) {
      for (const entity of pastedEntities) {
        CopyEngineUtils.rawShiftEntity(entity, offset);
      }
    }

    this.project.stageManager.clearSelectAll();
    this.project.stage.push(...pasteData);
    // 粘贴出的 Section / Edge 需要先重建运行时引用和层级树，分组框也在这一步按挪过的孩子重算大小
    this.project.stageManager.updateReferences();
    const pastedEntitySet = new Set<Entity>(pastedEntities);
    const topLevelEntities = pastedEntities.filter(
      (it) => it.parentSection === null || !pastedEntitySet.has(it.parentSection),
    );
    topLevelEntities.forEach((it) => (it.isSelected = true));
    if (dropSection) {
      this.project.sectionInOutManager.goInSection(topLevelEntities, dropSection);
    }
    if (placement === "pointer") {
      nudgeEntitiesOutOfOverlap(this.project, topLevelEntities);
      // 挪动锁定的分组框时它自己的碰撞箱不会跟着走，重建一次让所有分组框按孩子重新贴合
      this.project.stageManager.updateReferences();
    }

    const effectRect = Rectangle.getBoundingRectangle(topLevelEntities.map((it) => it.collisionBox.getRectangle()));
    this.project.effects.addEffect(new RectangleNoteEffect(new ProgressNumber(0, 50), effectRect, Color.Green));
    if (dropSection) {
      this.project.effects.addEffect(
        RectanglePushInEffect.sectionGoInGoOut(effectRect, dropSection.collisionBox.getRectangle()),
      );
    }
    this.project.historyManager.recordStep();
    if (!isResearchShell()) {
      toast.success(
        <div>
          <h2 className="text-lg">粘贴成功</h2>
          <p className="text-xs">已粘贴到原位置{effectRect.leftTop.toString()}</p>
          <p className="text-xs">已帮您自动选中该内容，按下默认快捷键 `F` 即可快速聚焦到该内容</p>
        </div>,
      );
    }
  }

  /**
   * 鼠标在这块白板的画布上就贴到鼠标处，否则贴到视野中心。
   * MouseLocation.x/y 只在鼠标落在画布上时更新，移到文件面板上以后还是旧值，所以用 clientX/clientY 判断鼠标现在在哪；
   * 从右键菜单点粘贴时菜单盖在画布上，x/y 停在右键的位置，正好贴到那里。
   */
  private pointerPasteLocation(): Vector {
    const rect = this.project.canvas.element.getBoundingClientRect();
    const { clientX, clientY } = MouseLocation;
    const isPointerOverCanvas =
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    return isPointerOverCanvas
      ? this.project.renderer.transformView2World(MouseLocation.vector())
      : this.project.camera.location.clone();
  }

  private findDropSection(location: Vector, pastedBounds: Rectangle): Section | null {
    let section = this.project.sectionMethods.getInnermostSectionByLocation(location);
    // 会被粘贴内容整个盖住的框不当容器：比如原位粘贴一个分组框，落点正好在原来那个框里，应该放进它的父框
    while (section && section.collisionBox.getRectangle().isAbsoluteIn(pastedBounds)) {
      section = section.parentSection;
    }
    // 锁定的分组框不能往里放东西
    if (!section || this.project.sectionMethods.isObjectBeLockedBySection(section)) return null;
    return section;
  }

  async readSystemClipboardAndPaste() {
    const mode = Settings.clipboardPasteMode;
    if (mode === "webview") {
      await this.pasteFromWebClipboard();
    } else if (mode === "tauri") {
      await this.pasteFromTauriClipboard();
    } else {
      // AUTO模式
      if (isMac) {
        // mac优先用web模式，比较安全不容易崩溃
        await this.pasteFromWebClipboard();
      } else if (isWindows) {
        // windows优先用tauri，因为不需要申请权限
        await this.pasteFromTauriClipboard();
      } else if (isLinux) {
        // 待排查
        await this.pasteFromTauriClipboard();
      } else {
        // 未知系统，先随便了
        await this.pasteFromTauriClipboard();
      }
    }
  }

  private async pasteFromWebClipboard() {
    try {
      await this.copyEngineImage.pasteImageFromWebClipboard();

      try {
        const text = await navigator.clipboard.readText();
        if (text && text.length > 0) {
          this.copyEngineText.copyEnginePastePlainText(text);
        }
      } catch {
        toast.error("无法读取系统剪贴板");
      }
    } finally {
      setTimeout(() => {
        this.project.controller.pressingKeySet.clear();
      });
    }
  }

  private async pasteFromTauriClipboard() {
    // 处理粘贴文字
    let text = "";
    try {
      text = await readText();
    } catch (err) {
      if (err instanceof Error) toast.error(`Tauri文字粘贴板出错 ${err}`);
    }

    if (text && text.length > 0) {
      this.copyEngineText.copyEnginePastePlainText(text);
    } else {
      // 没有文字，应该是有图片，处理粘贴图片
      try {
        await this.copyEngineImage.pasteImageFromTauriClipboard();
      } catch (err) {
        if (err instanceof Error) {
          toast.error(`Tauri模式粘贴图片失败，可尝试在设置中换用webview粘贴模式。报错信息：${err.message}`);
        } else if (typeof err === "string") {
          // tauri 给的报错信息是个string
          toast.error(`Tauri模式粘贴图片失败，可尝试在设置中换用webview粘贴模式。报错信息：${err}`);
        } else {
          toast.error(`Tauri模式粘贴图片失败，可尝试在设置中换用webview粘贴模式。报错信息：${err}, ${typeof err}`);
        }
      }
    }
  }
}

/**
 * 只用来判断系统剪贴板有没有变。剪贴板里没有文字（比如是图片）时 arboard 会报错，这里当作空文字：
 * 复制时记下的若是文字，换成图片也能看出变了。
 */
async function readSystemClipboardText(): Promise<string> {
  try {
    return await readText();
  } catch {
    return "";
  }
}

export function getRectangleFromSerializedEntities(serializedEntities: Serialized.Entity[]): Rectangle {
  const rectangles = [];
  for (const node of serializedEntities) {
    if (
      Serialized.isTextNode(node) ||
      Serialized.isSection(node) ||
      Serialized.isImageNode(node) ||
      Serialized.isUrlNode(node) ||
      Serialized.isPortalNode(node) ||
      Serialized.isSvgNode(node)
    ) {
      // 比较常规的矩形
      rectangles.push(new Rectangle(new Vector(...node.location), new Vector(...node.size)));
    }
    if (node.type === "core:connect_point") {
      rectangles.push(new Rectangle(new Vector(...node.location), new Vector(1, 1)));
    } else if (node.type === "core:pen_stroke") {
      // rectangles.push(new Rectangle(new Vector(...node.location), new Vector(1, 1)));
      // TODO: 画笔粘贴板矩形暂时不考虑
    }
  }
  return Rectangle.getBoundingRectangle(rectangles);
}
