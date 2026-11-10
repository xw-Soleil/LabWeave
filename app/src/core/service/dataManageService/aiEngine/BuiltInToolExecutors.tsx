import type { Project } from "@/core/Project";
import type { AIObjectReferenceRegistry } from "@/core/service/dataManageService/aiEngine/AIObjectReferenceRegistry";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import type { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { Color, Vector } from "@graphif/data-structures";
import { serialize } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import type { BuiltInToolExecutor } from "./BuiltInToolRegistry";
import { findFirstImageInChildren } from "./imageNodeFinder";
import type { ImageOrientation, OpenverseImageCandidate } from "./OpenverseImageSearch";
import { resolveHttpRequestBody } from "./AIHttpBody";

const builtInToolExecutorLoaders: Record<string, () => BuiltInToolExecutor> = {};

function addExecutor(name: string, loadExecutor: () => BuiltInToolExecutor) {
  if (name in builtInToolExecutorLoaders) throw new Error(`Duplicate built-in tool executor: ${name}`);
  builtInToolExecutorLoaders[name] = loadExecutor;
}

export function loadBuiltInToolExecutor(name: string): BuiltInToolExecutor {
  const loadExecutor = builtInToolExecutorLoaders[name];
  if (!loadExecutor) throw new Error(`Missing built-in tool executor: ${name}`);
  return loadExecutor();
}

for (const name of ["read_pdf_text", "search_pdf"] as const) {
  addExecutor(name, () => async (_project, input, _references, context) => {
    try {
      const { readPdfText, searchPdf } = await import("@/core/research/PdfTools");
      return await (name === "read_pdf_text" ? readPdfText : searchPdf)(input, { signal: context.abortSignal });
    } catch (error) {
      if (context.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      const code = error instanceof Error && error.message.startsWith("pdf.") ? error.message : "pdf.readFailed";
      return { success: false, error: { code, message: code } };
    }
  });
}

// 工具结果里只放摘要开头
const FILE_CARD_EXCERPT_HEAD_LENGTH = 500;

function isAbsoluteFsPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 给模型看的文件卡片路径：相对 .prg 所在文件夹（和 dump_workspace 的 file.path、create_file_card 的输入同一基准）。
 * 草稿里存的是绝对路径，只给文件名，不把用户的目录结构交给 AI。
 */
function toModelFacingSourcePath(project: Pick<Project, "uri">, sourcePath: string): string {
  if (!isAbsoluteFsPath(sourcePath)) return sourcePath;
  const posix = sourcePath.replaceAll("\\", "/").normalize("NFC");
  if (project.uri.scheme === "file") {
    const projectPath = project.uri.fsPath.replaceAll("\\", "/").normalize("NFC");
    const projectDir = projectPath.slice(0, projectPath.lastIndexOf("/"));
    if (projectDir && posix.startsWith(`${projectDir}/`)) return posix.slice(projectDir.length + 1);
  }
  return posix.slice(posix.lastIndexOf("/") + 1);
}

function toAgentObjectInfo(object: StageObject, references: AIObjectReferenceRegistry, project: Pick<Project, "uri">) {
  const rect = object.collisionBox.getRectangle();
  const info: Record<string, unknown> = {
    ref: references.getOrCreateRef(object),
    type: object.constructor.name,
    position: { x: rect.location.x, y: rect.location.y },
    size: { width: rect.size.x, height: rect.size.y },
  };
  if (object instanceof TextNode) info.text = object.text;
  if (object instanceof ImageNode) {
    info.isBackground = object.isBackground;
    info.imageState = object.state;
  }
  const color = "color" in object ? object.color : undefined;
  if (color instanceof Color) info.color = (color as { toArray(): unknown }).toArray();
  if (object instanceof FileCardNode) {
    info.title = object.title;
    info.fileKind = object.fileKind;
    info.path = toModelFacingSourcePath(project, object.sourcePath);
    info.pageCount = object.pageCount;
    info.excerpt = object.excerpt.slice(0, FILE_CARD_EXCERPT_HEAD_LENGTH);
  }
  if (object instanceof Section) {
    info.childRefs = object.children.map((child) => references.getOrCreateRef(child));
  }
  if (object instanceof Edge) {
    info.sourceRef = references.getOrCreateRef(object.source);
    info.targetRef = references.getOrCreateRef(object.target);
    info.text = object.text;
  }
  return info;
}

function sanitizeImageSourceText(value: string | null | undefined): string | undefined {
  const sanitized = value
    ?.replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500)
    .replace(/([\\`*_[\]{}()#+\-.!|>])/g, "\\$1");
  return sanitized || undefined;
}

function sanitizeImageSourceUrl(value: string | null | undefined): string | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
}

function createOpenverseImageDetails(candidate: OpenverseImageCandidate, markdownToDetails: (markdown: string) => any) {
  const lines = ["## 网络图片来源"];
  const title = sanitizeImageSourceText(candidate.title);
  const creator = sanitizeImageSourceText(candidate.creator);
  const license = sanitizeImageSourceText(candidate.license);
  const sourceUrl = sanitizeImageSourceUrl(candidate.foreign_landing_url);
  const licenseUrl = sanitizeImageSourceUrl(candidate.license_url);
  if (title) lines.push(`标题：${title}`);
  if (creator) lines.push(`作者：${creator}`);
  if (license) lines.push(`许可证：${license}`);
  if (sourceUrl) lines.push(`来源页面：<${sourceUrl}>`);
  if (licenseUrl) lines.push(`许可证页面：<${licenseUrl}>`);
  lines.push("搜索服务：Openverse");
  return markdownToDetails(lines.join("\n\n"));
}

function getViewportCenteredLocation(project: Project, size: Vector): Vector {
  return project.renderer.getCoverWorldRectangle().center.subtract(size.clone().multiply(0.5));
}

function resolveEntityRefs(refs: string[], references: AIObjectReferenceRegistry): Entity[] {
  const entitiesByUuid = new Map<string, Entity>();
  for (const ref of refs) {
    const object = references.resolve(ref, "node");
    if (!(object instanceof Entity)) {
      throw new Error(`节点引用 ${ref} 未指向可删除的实体`);
    }
    entitiesByUuid.set(object.uuid, object);
  }
  return [...entitiesByUuid.values()];
}

function deleteEntities(project: Project, entities: Entity[]) {
  const entityCountBefore = project.stageManager.getEntities().length;
  const associationCountBefore = project.stageManager.getAssociations().length;
  project.stageManager.deleteEntities(entities);
  return {
    deletedNodeCount: entityCountBefore - project.stageManager.getEntities().length,
    deletedAssociationCount: associationCountBefore - project.stageManager.getAssociations().length,
  };
}

addExecutor("get_all_nodes", () => (project, _data, references) => ({
  objects: project.stage.map((object) => toAgentObjectInfo(object, references, project)),
}));
addExecutor("delete_node", () => (project, { ref }, references) => {
  return deleteEntities(project, resolveEntityRefs([ref], references));
});
addExecutor("delete_nodes", () => (project, { refs }, references) => {
  return deleteEntities(project, resolveEntityRefs(refs, references));
});
addExecutor("delete_selected_nodes", () => (project) => {
  return deleteEntities(project, [...project.stageManager.getSelectedEntities()]);
});
addExecutor("delete_all_nodes", () => (project) => {
  const entities = [...project.stageManager.getEntities()];
  const associations = [...project.stageManager.getAssociations()];
  for (const assoc of associations) {
    project.stageManager.delete(assoc);
  }
  for (const entity of entities) {
    project.stageManager.delete(entity);
  }
  const total = entities.length + associations.length;
  if (total > 0) {
    project.historyManager.recordStep();
  }
  return { deletedEntities: entities.length, deletedAssociations: associations.length };
});
addExecutor("edit_text_node", () => (project, { ref, data }, references) => {
  const node = references.resolve(ref, "node");
  if (!(node instanceof TextNode)) {
    return {
      success: false,
      error: { code: "wrong_node_type", ref, expected: "TextNode", actual: node.constructor.name },
    };
  }
  if (
    data.text === undefined &&
    data.color === undefined &&
    data.width === undefined &&
    data.sizeAdjust === undefined
  ) {
    return { success: false, error: { code: "no_changes", ref, message: "没有提供要修改的字段" } };
  }

  if (data.width !== undefined && data.sizeAdjust === "auto") {
    return {
      success: false,
      error: { code: "invalid_size_mode", ref, message: "width 只能在 manual 宽度模式下使用" },
    };
  }

  const previous = {
    text: node.text,
    color: node.color,
    sizeAdjust: node.sizeAdjust,
    rectangle: node.collisionBox.getRectangle().clone(),
  };
  try {
    node.text = data.text ?? node.text;
    node.color = data.color ? new Color(...(data.color as [number, number, number, number])) : node.color;
    node.sizeAdjust = data.sizeAdjust ?? (data.width !== undefined ? "manual" : node.sizeAdjust);
    if (data.width !== undefined) {
      const rect = node.collisionBox.getRectangle();
      node.collisionBox.updateShapeList([new Rectangle(rect.location.clone(), new Vector(data.width, rect.size.y))]);
    }
    if (node.sizeAdjust === "manual") {
      node.forceAdjustHeightByText();
    } else {
      node.forceAdjustSizeByText();
    }

    project.historyManager.recordStep();
    const finalRect = node.collisionBox.getRectangle();
    return {
      success: true,
      ref,
      text: node.text,
      size: { width: finalRect.size.x, height: finalRect.size.y },
      sizeAdjust: node.sizeAdjust,
    };
  } catch (error) {
    node.text = previous.text;
    node.color = previous.color;
    node.sizeAdjust = previous.sizeAdjust;
    node.collisionBox.updateShapeList([previous.rectangle]);
    throw error;
  }
});
addExecutor("edit_image_node", () => (project, { ref, data }, references) => {
  const node = references.resolve(ref, "node");
  if (!(node instanceof ImageNode)) {
    return {
      success: false,
      error: { code: "wrong_node_type", ref, expected: "ImageNode", actual: node.constructor.name },
    };
  }
  if (data.displaySize === undefined && data.isBackground === undefined) {
    return { success: false, error: { code: "no_changes", ref, message: "没有提供要修改的字段" } };
  }

  const previous = {
    scale: node.scale,
    isBackground: node.isBackground,
    rectangle: node.collisionBox.getRectangle().clone(),
  };
  try {
    const currentRect = node.collisionBox.getRectangle();
    if (data.displaySize) {
      const intrinsicWidth = node.bitmap?.width ?? currentRect.width / node.scale;
      const intrinsicHeight = node.bitmap?.height ?? currentRect.height / node.scale;
      if (
        !Number.isFinite(intrinsicWidth) ||
        !Number.isFinite(intrinsicHeight) ||
        intrinsicWidth <= 0 ||
        intrinsicHeight <= 0
      ) {
        return {
          success: false,
          error: { code: "invalid_image_size", ref, message: "无法确定图片的原始尺寸" },
        };
      }

      const basisSize =
        data.displaySize.basis === "width"
          ? intrinsicWidth
          : data.displaySize.basis === "height"
            ? intrinsicHeight
            : Math.max(intrinsicWidth, intrinsicHeight);
      const nextScale = data.displaySize.value / basisSize;
      if (nextScale < 0.1 || nextScale > 10) {
        return {
          success: false,
          error: {
            code: "scale_out_of_range",
            ref,
            message: "目标尺寸超出 ImageNode 支持的 0.1 到 10 倍缩放范围",
          },
        };
      }
      node.scaleUpdate(nextScale - node.scale);
      if (!node.bitmap) {
        node.collisionBox.updateShapeList([
          new Rectangle(
            currentRect.location.clone(),
            new Vector(intrinsicWidth * nextScale, intrinsicHeight * nextScale),
          ),
        ]);
      }
    }

    node.isBackground = data.isBackground ?? node.isBackground;
    project.historyManager.recordStep();
    const finalRect = node.collisionBox.getRectangle();
    return {
      success: true,
      ref,
      displaySize: { width: finalRect.width, height: finalRect.height },
      isBackground: node.isBackground,
    };
  } catch (error) {
    node.scale = previous.scale;
    node.isBackground = previous.isBackground;
    node.collisionBox.updateShapeList([previous.rectangle]);
    throw error;
  }
});
addExecutor("auto_layout_dag", () => (project, { refs }, references) => {
  const uniqueRefs = [...new Set<string>(refs)];
  if (uniqueRefs.length !== refs.length) {
    return { success: false, error: { code: "duplicate_refs", message: "refs 不能包含重复节点引用" } };
  }

  const nodes = uniqueRefs.map((ref) => ({ ref, node: references.resolve(ref, "node") }));
  const invalidNode = nodes.find(({ node }) => !(node instanceof ConnectableEntity) || node instanceof Section);
  if (invalidNode) {
    return {
      success: false,
      error: {
        code: "unsupported_node_type",
        ref: invalidNode.ref,
        message: "DAG 布局目前只支持非 Section 的可连接节点",
      },
    };
  }

  const entities = nodes.map(({ node }) => node as ConnectableEntity);
  const parentSection = entities[0].parentSection;
  if (!entities.every((entity) => entity.parentSection === parentSection)) {
    return {
      success: false,
      error: { code: "mixed_containers", message: "DAG 布局的节点必须位于同一直属 Section 层级" },
    };
  }

  const nodeIds = new Set(entities.map((entity) => entity.uuid));
  const internalEdgeCount = project.stageManager
    .getEdges()
    .filter((edge) => nodeIds.has(edge.source.uuid) && nodeIds.has(edge.target.uuid)).length;
  if (internalEdgeCount === 0) {
    return {
      success: false,
      error: { code: "no_internal_edges", message: "DAG 布局至少需要一条位于 refs 范围内的有向连线" },
    };
  }
  if (!project.graphMethods.isDAGByNodes(entities)) {
    return { success: false, error: { code: "not_dag", message: "指定节点不构成有向无环图" } };
  }

  const result = project.autoLayout.autoLayoutDAG(entities);
  return { success: true, ...result };
});
type TextNodeInput = { text: string; color?: number[]; width?: number; sizeAdjust?: "auto" | "manual" };

/** create_text_node 放在视野中心，create_text_node_at 放在给定坐标，其余完全一样 */
function addTextNode(
  project: Project,
  references: AIObjectReferenceRegistry,
  { text, color, width, sizeAdjust }: TextNodeInput,
  locate: (size: Vector) => Vector,
) {
  if (width !== undefined && sizeAdjust === "auto") {
    return {
      success: false,
      error: { code: "invalid_size_mode", message: "width 只能在 manual 宽度模式下使用" },
    };
  }
  if (sizeAdjust === "manual" && width === undefined) {
    return {
      success: false,
      error: { code: "missing_width", message: "manual 宽度模式必须提供 width" },
    };
  }

  const resolvedSizeAdjust = sizeAdjust ?? (width === undefined ? "auto" : "manual");
  const node = new TextNode(project, {
    text,
    color: color ? new Color(...(color as [number, number, number, number])) : Color.Transparent,
    collisionBox: new CollisionBox([new Rectangle(Vector.getZero(), new Vector(width ?? 100, 50))]),
    sizeAdjust: resolvedSizeAdjust,
  });
  node.moveTo(locate(node.collisionBox.getRectangle().size));
  project.stageManager.add(node);
  project.historyManager.recordStep();
  const rect = node.collisionBox.getRectangle();
  return {
    success: true,
    ref: references.getOrCreateRef(node),
    size: { width: rect.width, height: rect.height },
    sizeAdjust: node.sizeAdjust,
  };
}
addExecutor(
  "create_text_node",
  () => (project, input, references) =>
    addTextNode(project, references, input, (size) => getViewportCenteredLocation(project, size)),
);
addExecutor(
  "create_text_node_at",
  () =>
    (project, { x, y, ...input }, references) =>
      addTextNode(project, references, input, () => new Vector(x, y)),
);
addExecutor("generate_node_tree_by_text", () => (project, { text }) => {
  project.stageManager.generateNodeTreeByText(text, 2);
});
addExecutor("expand_node_tree_from_node", () => (project, { ref, text }, references) => {
  const root = references.resolve(ref, "node");
  const result = project.stageImport.addNodeTreeByTextFromNode(root.uuid, text, 2);
  if (result.success && result.nodeCount && result.nodeCount > 0) {
    project.historyManager.recordStep();
  }
  return result;
});
addExecutor("search_text_nodes_by_regex", () => (project, { regex }, references) => {
  const results: { text: string; ref: string }[] = [];
  const regexObj = new RegExp(regex);
  for (const entity of project.stageManager.getEntities()) {
    if (entity instanceof TextNode && regexObj.test(entity.text)) {
      results.push({ text: entity.text, ref: references.getOrCreateRef(entity) });
    }
  }
  return results;
});
addExecutor("get_children", () => (project, { ref }, references) => {
  const object = references.resolve(ref, "node");
  const node = project.stageManager.getConnectableEntityByUUID(object.uuid);
  if (!node) return [];
  const children = project.graphMethods.nodeChildrenArray(node);
  const results: { text: string; ref: string }[] = [];
  for (const child of children) {
    if (child instanceof TextNode) {
      results.push({ text: child.text, ref: references.getOrCreateRef(child) });
    }
  }
  return results;
});
addExecutor("get_parents", () => (project, { ref }, references) => {
  const object = references.resolve(ref, "node");
  const node = project.stageManager.getConnectableEntityByUUID(object.uuid);
  if (!node) return [];
  const parents = project.graphMethods.nodeParentArray(node);
  const results: { text: string; ref: string }[] = [];
  for (const parent of parents) {
    if (parent instanceof TextNode) {
      results.push({ text: parent.text, ref: references.getOrCreateRef(parent) });
    }
  }
  return results;
});
addExecutor("batch_change_color", () => (project, { refs, color }, references) => {
  const colorObj = new Color(...(color as [number, number, number, number]));
  let changedCount = 0;
  for (const ref of refs) {
    const obj = references.resolve(ref);
    if ("color" in obj && obj.color instanceof Color) {
      obj.color = colorObj;
      changedCount++;
    }
  }
  if (changedCount > 0) {
    project.historyManager.recordStep();
  }
  return { changedCount };
});
addExecutor(
  "get_object_details",
  () =>
    (project, { refs }, references) =>
      refs.map((ref: string) => toAgentObjectInfo(references.resolve(ref), references, project)),
);
addExecutor("check_connections", () => (project, { pairs }, references) => {
  const results: { fromRef: string; toRef: string; connected: boolean }[] = [];
  for (const [fromRef, toRef] of pairs) {
    const fromObject = references.resolve(fromRef, "node");
    const toObject = references.resolve(toRef, "node");
    const fromNode = project.stageManager.getConnectableEntityByUUID(fromObject.uuid);
    const toNode = project.stageManager.getConnectableEntityByUUID(toObject.uuid);
    if (fromNode && toNode) {
      const connected = project.graphMethods.isConnected(fromNode, toNode);
      results.push({ fromRef, toRef, connected });
    } else {
      results.push({ fromRef, toRef, connected: false });
    }
  }
  return results;
});
addExecutor("create_edges", () => (project, { edges }, references) => {
  const results: Array<{
    sourceRef: string;
    targetRef: string;
    success: boolean;
    edgeRef?: string;
    error?: string;
  }> = [];
  for (const edgeData of edges) {
    const sourceObject = references.resolve(edgeData.sourceRef, "node");
    const targetObject = references.resolve(edgeData.targetRef, "node");
    const sourceNode = project.stageManager.getConnectableEntityByUUID(sourceObject.uuid);
    const targetNode = project.stageManager.getConnectableEntityByUUID(targetObject.uuid);
    if (!sourceNode) {
      results.push({
        sourceRef: edgeData.sourceRef,
        targetRef: edgeData.targetRef,
        success: false,
        error: `源节点不存在或不是可连接对象`,
      });
      continue;
    }
    if (!targetNode) {
      results.push({
        sourceRef: edgeData.sourceRef,
        targetRef: edgeData.targetRef,
        success: false,
        error: `目标节点不存在或不是可连接对象`,
      });
      continue;
    }
    try {
      project.nodeConnector.connectConnectableEntity(sourceNode, targetNode, edgeData.text || "");
      // 获取新创建的边的UUID（可能需要通过查找最新的边）
      const newEdge = project.stageManager
        .getAssociations()
        .find((edge) => edge instanceof Edge && edge.source === sourceNode && edge.target === targetNode);
      if (newEdge) {
        results.push({
          sourceRef: edgeData.sourceRef,
          targetRef: edgeData.targetRef,
          success: true,
          edgeRef: references.getOrCreateRef(newEdge),
        });
      } else {
        results.push({
          sourceRef: edgeData.sourceRef,
          targetRef: edgeData.targetRef,
          success: false,
          error: `连线创建失败，未知原因`,
        });
      }
    } catch (error) {
      results.push({
        sourceRef: edgeData.sourceRef,
        targetRef: edgeData.targetRef,
        success: false,
        error: error instanceof Error ? error.message : "连线创建失败",
      });
    }
  }
  if (results.some((r) => r.success)) {
    project.historyManager.recordStep();
  }
  return results;
});
addExecutor("change_edge_text", () => (project, { edgeRef, text }, references) => {
  const edge = references.resolve(edgeRef, "edge");
  if (!(edge instanceof Edge)) {
    return { success: false, error: "连线不存在或不是Edge类型" };
  }
  edge.rename(text);
  project.historyManager.recordStep();
  return { success: true };
});
addExecutor("select_objects", () => (project, { refs, clearOthers }, references) => {
  if (clearOthers) {
    // 清除所有对象的选中状态
    for (const obj of project.stageManager.getEntities()) {
      obj.isSelected = false;
    }
    for (const assoc of project.stageManager.getAssociations()) {
      assoc.isSelected = false;
    }
  }
  let selectedCount = 0;
  for (const ref of refs) {
    const obj = references.resolve(ref);
    obj.isSelected = true;
    selectedCount++;
  }
  if (selectedCount > 0) {
    project.historyManager.recordStep();
  }
  return { selectedCount };
});
addExecutor("get_selected_nodes", () => (project, _data, references) => ({
  objects: [...project.stageManager.getSelectedEntities(), ...project.stageManager.getSelectedAssociations()].map(
    (object) => toAgentObjectInfo(object, references, project),
  ),
}));

addExecutor("get_nodes_in_viewport", () => (project, _data, references) => {
  const viewRect = project.renderer.getCoverWorldRectangle();
  const results: Array<Record<string, unknown>> = [];

  for (const entity of project.stageManager.getEntities()) {
    const rect = entity.collisionBox.getRectangle();
    if (rect.isAbsoluteIn(viewRect)) {
      results.push(toAgentObjectInfo(entity, references, project));
    }
  }

  return { nodes: results };
});
addExecutor("get_selected_refs", () => (project, _data, references) => {
  const selectedEntities = project.stageManager.getSelectedEntities();
  const selectedAssociations = project.stageManager.getSelectedAssociations();
  const refs = [...selectedEntities, ...selectedAssociations].map((object) => references.getOrCreateRef(object));
  return { refs };
});

addExecutor("breadth_expand_node", () => (project, { ref, texts }, references) => {
  const sourceObject = references.resolve(ref, "node");
  const sourceNode = project.stageManager.getConnectableEntityByUUID(sourceObject.uuid);
  if (!sourceNode) {
    return { success: false, error: "源节点不存在或不是可连接对象" };
  }

  const sourceRect = sourceNode.collisionBox.getRectangle();
  const startX = sourceRect.location.x + sourceRect.size.x + 100; // 右侧100像素
  const startY = sourceRect.location.y;
  const verticalSpacing = 60;

  const results: Array<{ text: string; ref?: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    try {
      const node = new TextNode(project, {
        text,
        color: new Color(0, 0, 0, 0), // 透明
        collisionBox: new CollisionBox([
          new Rectangle(new Vector(startX, startY + i * verticalSpacing), new Vector(100, 50)),
        ]),
        sizeAdjust: "auto" as "auto" | "manual",
      });
      project.stageManager.add(node);

      // 创建连线
      project.nodeConnector.connectConnectableEntity(sourceNode, node, "");

      results.push({ text, ref: references.getOrCreateRef(node), success: true });
    } catch (error) {
      results.push({
        text,
        success: false,
        error: error instanceof Error ? error.message : "创建节点失败",
      });
    }
  }

  if (results.some((r) => r.success)) {
    project.historyManager.recordStep();
  }

  return { results };
});

addExecutor("depth_expand_node", () => (project, { ref, texts }, references) => {
  const rootObject = references.resolve(ref, "node");
  const rootNode = project.stageManager.getConnectableEntityByUUID(rootObject.uuid);
  if (!rootNode) {
    return { success: false, error: "根节点不存在或不是可连接对象" };
  }

  const results: Array<{ text: string; ref?: string; success: boolean; error?: string }> = [];
  let currentNode = rootNode;
  const horizontalSpacing = 150;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    try {
      const currentRect = currentNode.collisionBox.getRectangle();
      const node = new TextNode(project, {
        text,
        color: new Color(0, 0, 0, 0), // 透明
        collisionBox: new CollisionBox([
          new Rectangle(
            new Vector(currentRect.location.x + horizontalSpacing, currentRect.location.y),
            new Vector(100, 50),
          ),
        ]),
        sizeAdjust: "auto" as "auto" | "manual",
      });
      project.stageManager.add(node);

      // 创建连线：从前一个节点连接到新节点
      project.nodeConnector.connectConnectableEntity(currentNode, node, "");

      results.push({ text, ref: references.getOrCreateRef(node), success: true });
      currentNode = node; // 更新当前节点为新建的节点，继续链式扩展
    } catch (error) {
      results.push({
        text,
        success: false,
        error: error instanceof Error ? error.message : "创建节点失败",
      });
      break; // 链式结构中一旦失败就停止
    }
  }

  if (results.some((r) => r.success)) {
    project.historyManager.recordStep();
  }

  return { results };
});

addExecutor("sort_selected_nodes_by_y", () => (project, { current_order, desired_order }) => {
  // 获取所有选中的TextNode
  const selectedTextNodes = project.stageManager
    .getSelectedEntities()
    .filter((e): e is TextNode => e instanceof TextNode);

  // 检查重复名称
  const textCounts = new Map<string, number>();
  for (const node of selectedTextNodes) {
    textCounts.set(node.text, (textCounts.get(node.text) ?? 0) + 1);
  }
  const duplicates = [...textCounts.entries()].filter(([, count]) => count > 1).map(([text]) => text);
  if (duplicates.length > 0) {
    return {
      success: false,
      error: `排序功能不能有重复名称的文本节点，重复的内容：${duplicates.join(", ")}`,
    };
  }

  // 校验 current_order 与 desired_order 元素一致
  const currentSet = new Set(current_order);
  const desiredSet = new Set(desired_order);
  if (current_order.length !== desired_order.length || [...currentSet].some((t) => !desiredSet.has(t))) {
    return { success: false, error: "current_order 与 desired_order 包含的元素不一致" };
  }

  // 构建 text -> node 映射
  const textToNode = new Map<string, TextNode>();
  for (const node of selectedTextNodes) {
    textToNode.set(node.text, node);
  }

  // 校验 current_order 是否覆盖了所有选中节点
  for (const text of current_order) {
    if (!textToNode.has(text)) {
      return { success: false, error: `current_order 中的 "${text}" 在选中节点中未找到` };
    }
  }

  // 以 current_order 第一个节点（最顶部）的 y 坐标作为起始 y
  const startNode = textToNode.get(current_order[0])!;
  let currentY = startNode.collisionBox.getRectangle().location.y;

  // 按 desired_order 顺序从上到下重新排列，保持原 x 坐标
  for (const text of desired_order) {
    const node = textToNode.get(text)!;
    const rect = node.collisionBox.getRectangle();
    node.collisionBox.updateShapeList([new Rectangle(new Vector(rect.location.x, currentY), rect.size)]);
    node.forceAdjustSizeByText();
    // 下一个节点从当前节点底部开始
    currentY += node.collisionBox.getRectangle().size.y;
  }

  project.historyManager.recordStep();
  return { success: true, movedCount: desired_order.length };
});

addExecutor("sort_selected_nodes_by_x", () => (project, { current_order, desired_order }) => {
  // 获取所有选中的TextNode
  const selectedTextNodes = project.stageManager
    .getSelectedEntities()
    .filter((e): e is TextNode => e instanceof TextNode);

  // 检查重复名称
  const textCounts = new Map<string, number>();
  for (const node of selectedTextNodes) {
    textCounts.set(node.text, (textCounts.get(node.text) ?? 0) + 1);
  }
  const duplicates = [...textCounts.entries()].filter(([, count]) => count > 1).map(([text]) => text);
  if (duplicates.length > 0) {
    return {
      success: false,
      error: `排序功能不能有重复名称的文本节点，重复的内容：${duplicates.join(", ")}`,
    };
  }

  // 校验 current_order 与 desired_order 元素一致
  const currentSet = new Set(current_order);
  const desiredSet = new Set(desired_order);
  if (current_order.length !== desired_order.length || [...currentSet].some((t) => !desiredSet.has(t))) {
    return { success: false, error: "current_order 与 desired_order 包含的元素不一致" };
  }

  // 构建 text -> node 映射
  const textToNode = new Map<string, TextNode>();
  for (const node of selectedTextNodes) {
    textToNode.set(node.text, node);
  }

  // 校验 current_order 是否覆盖了所有选中节点
  for (const text of current_order) {
    if (!textToNode.has(text)) {
      return { success: false, error: `current_order 中的 "${text}" 在选中节点中未找到` };
    }
  }

  // 以 current_order 第一个节点（最左侧）的 x 坐标作为起始 x
  const startNode = textToNode.get(current_order[0])!;
  let currentX = startNode.collisionBox.getRectangle().location.x;

  // 按 desired_order 顺序从左到右重新排列，保持原 y 坐标
  for (const text of desired_order) {
    const node = textToNode.get(text)!;
    const rect = node.collisionBox.getRectangle();
    node.collisionBox.updateShapeList([new Rectangle(new Vector(currentX, rect.location.y), rect.size)]);
    node.forceAdjustSizeByText();
    // 下一个节点从当前节点右侧开始
    currentX += node.collisionBox.getRectangle().size.x;
  }

  project.historyManager.recordStep();
  return { success: true, movedCount: desired_order.length };
});
addExecutor(
  "search_and_add_image_node",
  () =>
    async (project, { query, preferredOrientation, maxDisplaySize }, references, { abortSignal }) => {
      const [imageUtils, imageNodeFactory, entityDetailsManager, openverseImageSearch] = await Promise.all([
        import("@/core/service/dataManageService/imageUtils"),
        import("@/core/service/dataManageService/imageNodeFactory"),
        import("@/core/stage/stageObject/tools/entityDetailsManager"),
        import("./OpenverseImageSearch"),
      ]);
      const { prepareImageBlobForImport } = imageUtils;
      const { calculateImageDisplaySize, createImageNodeFromBlob } = imageNodeFactory;
      const { DetailsManager } = entityDetailsManager;
      const { findDownloadableOpenverseImage } = openverseImageSearch;
      const { candidate, image: prepared } = await findDownloadableOpenverseImage(query, {
        orientation: preferredOrientation as ImageOrientation | undefined,
        abortSignal,
        transform: prepareImageBlobForImport,
      });
      const targetDisplaySize = calculateImageDisplaySize(prepared.width, prepared.height, maxDisplaySize ?? 480);
      const { node, width, height } = await createImageNodeFromBlob(project, prepared.blob, {
        location: getViewportCenteredLocation(project, new Vector(targetDisplaySize.width, targetDisplaySize.height)),
        intrinsicSize: prepared,
        maxDisplaySize: maxDisplaySize ?? 480,
        details: createOpenverseImageDetails(candidate, DetailsManager.markdownToDetails),
      });
      project.historyManager.recordStep();
      const license = candidate.license?.match(/^[a-z0-9-]{1,32}$/i) ? candidate.license.toLowerCase() : undefined;
      return {
        ref: references.getOrCreateRef(node),
        intrinsicSize: { width, height },
        displaySize: { width: targetDisplaySize.width, height: targetDisplaySize.height },
        source: "openverse",
        license,
      };
    },
);
addExecutor("recognize_image", () => async (project, { ref, prompt }, references) => {
  const [{ encodeModelImageDataUrl }, { Settings }] = await Promise.all([
    import("@/core/service/dataManageService/aiEngine/ModelImageEncoder"),
    import("@/core/service/Settings"),
  ]);
  const obj = references.resolve(ref, "node");
  const imageNode = (
    obj instanceof ImageNode
      ? obj
      : findFirstImageInChildren(
          obj instanceof Section ? obj.children : [],
          (n) => n instanceof ImageNode,
          (n) => (n instanceof Section ? n.children : undefined),
        )
  ) as ImageNode | undefined;
  if (!imageNode) {
    return { success: false, error: "该节点不是 ImageNode，且其内部未找到图片" };
  }
  const blob = project.attachments.get(imageNode.attachmentId);
  if (!blob) {
    return { success: false, error: "图片数据未找到（附件可能已丢失）" };
  }
  try {
    const dataUrl = await encodeModelImageDataUrl(blob, Settings.maxPastedImageSize);
    const description = await recognizeImage(dataUrl, prompt);
    return { success: true, description };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "图片识别失败" };
  }
});

addExecutor("dump_workspace", () => async (project) => {
  const [{ buildAiSidecar }, { capWorkspaceDump }] = await Promise.all([
    import("@/core/research/AiSidecarBuilder"),
    import("./ResearchContext"),
  ]);
  const sidecar = buildAiSidecar({
    serializedStage: serialize(project.stage),
    tags: project.tags,
    metadata: project.metadata,
    workspaceFile: project.uri.scheme === "file" ? (project.uri.path.split("/").pop() ?? "") : "",
  }).json;
  return capWorkspaceDump(sidecar);
});
addExecutor("create_file_card", () => async (project, { path, x, y }, references) => {
  const [{ createFileCards, resolveSourcePath }, { ResearchFolder }, { fileKindOf }] = await Promise.all([
    import("@/core/research/FileCardFactory"),
    import("@/core/research/ResearchFolder"),
    import("@/core/research/ResearchShell"),
  ]);
  if (!fileKindOf(path)) {
    return { success: false, error: "只支持 PDF、图片（png/jpg/jpeg/webp/gif）和 Markdown 文件" };
  }
  if (!ResearchFolder.getRoot()) {
    return { success: false, error: "还没有选择研究文件夹" };
  }
  // 相对路径按 .prg 所在文件夹解析（草稿按研究文件夹），和 dump_workspace / 卡片信息里的 path 同一个基准
  const absPath = resolveSourcePath(project, path);
  if (!ResearchFolder.isInside(absPath)) {
    return { success: false, error: "文件不在研究文件夹里" };
  }
  const location =
    x !== undefined && y !== undefined
      ? new Vector(x, y)
      : getViewportCenteredLocation(project, new Vector(FileCardNode.width, FileCardNode.height));
  const [card] = await createFileCards(project, [absPath], location);
  if (!card) {
    return { success: false, error: "没有创建出卡片" };
  }
  return {
    success: true,
    ref: references.getOrCreateRef(card),
    title: card.title,
    fileKind: card.fileKind,
    path: toModelFacingSourcePath(project, card.sourcePath),
  };
});

addExecutor("create_section", () => (project, { refs, title }, references) => {
  const picked: Entity[] = [];
  for (const ref of refs as string[]) {
    const object = references.resolve(ref, "node");
    if (!(object instanceof Entity)) throw new Error(`节点引用 ${ref} 未指向卡片`);
    if (!picked.includes(object)) picked.push(object);
  }
  // 分组和它里面的卡片同时传进来时只保留分组
  const entities = project.sectionMethods.shallowerNotSectionEntities(picked);
  const parent = entities[0].parentSection;
  if (entities.some((entity) => entity.parentSection !== parent)) {
    return {
      success: false,
      error: { code: "mixed_levels", message: "这些卡片不在同一层级：有的在分组里、有的不在，或者在不同的分组里" },
    };
  }
  // 和右键「打包为分组」一样：先从原来的分组里拿出来，建好新分组再放回去
  if (parent) project.sectionInOutManager.goOutSection(entities, parent);
  const section = Section.fromEntities(project, entities);
  section.rename(title);
  project.stageManager.add(section);
  if (parent) project.sectionInOutManager.goInSection([section], parent);
  project.historyManager.recordStep();
  return {
    success: true,
    ref: references.getOrCreateRef(section),
    title: section.text,
    childCount: section.children.length,
  };
});

addExecutor("move_nodes", () => (project, { moves }, references) => {
  const targets = (moves as { ref: string; x: number; y: number }[]).map(({ ref, x, y }) => {
    const object = references.resolve(ref, "node");
    if (!(object instanceof Entity)) throw new Error(`节点引用 ${ref} 未指向卡片`);
    return { ref, entity: object, location: new Vector(x, y) };
  });
  if (new Set(targets.map(({ entity }) => entity)).size !== targets.length) {
    return { success: false, error: { code: "duplicate_refs", message: "同一张卡片只能出现一次" } };
  }
  // 分组一挪，里面的卡片跟着走；先挪外层，里面的卡片才能落在给定的位置上
  const depth = (entity: Entity) => {
    let count = 0;
    for (let section = entity.parentSection; section; section = section.parentSection) count++;
    return count;
  };
  for (const { entity, location } of targets.toSorted((a, b) => depth(a.entity) - depth(b.entity))) {
    entity.moveTo(location);
  }
  project.historyManager.recordStep();
  return {
    success: true,
    moved: targets.map(({ ref, entity }) => {
      const rect = entity.collisionBox.getRectangle();
      return {
        ref,
        position: { x: rect.location.x, y: rect.location.y },
        size: { width: rect.size.x, height: rect.size.y },
      };
    }),
  };
});

Object.freeze(builtInToolExecutorLoaders);

async function recognizeImage(dataUrl: string, prompt: string): Promise<string> {
  const { getCliDesktopAcceptanceRecognition } = await import("./CliDesktopAcceptanceAdapter");
  const acceptanceRecognition = getCliDesktopAcceptanceRecognition();
  if (acceptanceRecognition) return acceptanceRecognition;
  const [{ Settings }, { createChatModel, mergeAIRequestHeaders }, { fetch }, { generateText }] = await Promise.all([
    import("@/core/service/Settings"),
    import("./AIProvider"),
    import("@tauri-apps/plugin-http"),
    import("ai"),
  ]);
  const model = createChatModel(
    {
      aiApiFormat: Settings.aiApiFormat,
      aiApiBaseUrl: Settings.aiApiBaseUrl,
      aiApiKey: Settings.aiApiKey,
      aiModel: Settings.aiModel,
    },
    async (url: any, init: any) => {
      const response = await fetch(url.toString(), {
        ...init,
        body: await resolveHttpRequestBody(init?.body),
        headers: mergeAIRequestHeaders(init?.headers, Settings.aiCustomHeaders),
        mode: "cors",
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`图像识别请求失败 (${response.status}): ${errorText}`);
      }
      return response;
    },
  );
  const result = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", image: dataUrl },
        ],
      },
    ],
  });
  return result.text;
}
