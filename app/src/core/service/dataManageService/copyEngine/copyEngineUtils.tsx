import { SetFunctions } from "@/core/algorithm/setFunctions";
import { Project } from "@/core/Project";
import { ConnectableAssociation } from "@/core/stage/stageObject/abstract/Association";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { FileCardNode } from "@/core/stage/stageObject/entity/FileCardNode";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";

/**
 *
 */
export namespace CopyEngineUtils {
  /**
   * 根据一部分物体，获取所有相关的实体
   * 可以用于选中复制的时候
   * （导出mermaid也会用到这个工具函数）
   */
  export function getAllStageObjectFromEntities(project: Project, entities: Entity[]): StageObject[] {
    //
    if (entities.length === 0) {
      return [];
    }
    const selectedUUIDs = new Set(entities.map((it) => it.uuid));
    const result: StageObject[] = [...entities];
    const isHaveSection = entities.some((it) => it instanceof Section);
    if (isHaveSection) {
      // 如果有框，则获取框内的实体
      const innerEntities = project.sectionMethods.getAllEntitiesInSelectedSectionsOrEntities(entities);
      // 根据 selectedUUIDs 过滤
      const filteredInnerEntities = innerEntities.filter((it) => !selectedUUIDs.has(it.uuid));
      result.push(...filteredInnerEntities);
      // 补充 selectedUUIDs
      for (const entity of filteredInnerEntities) {
        selectedUUIDs.add(entity.uuid);
      }
    }

    // O(N), N 为当前舞台对象数量
    for (const association of project.stageManager.getAssociations()) {
      if (association instanceof ConnectableAssociation) {
        if (association instanceof Edge) {
          if (selectedUUIDs.has(association.source.uuid) && selectedUUIDs.has(association.target.uuid)) {
            result.push(association);
          }
        } else if (association instanceof MultiTargetUndirectedEdge) {
          // 无向边
          const associationUUIDs = new Set(association.associationList.map((it) => it.uuid));
          if (SetFunctions.isSubset(associationUUIDs, selectedUUIDs)) {
            result.push(association);
          }
        }
      }
    }
    return result;
  }

  /**
   * 收集所有需要复制的附件（ImageNode、SvgNode、MediaNode 的附件和 FileCardNode 的缩略图）
   * @param project
   * @param stageObjects
   * @returns
   */
  export async function collectAttachmentFromStageObjects(
    project: Project,
    stageObjects: StageObject[],
  ): Promise<Map<string, { data: ArrayBuffer; type: string }>> {
    const attachmentMap = new Map<string, { data: ArrayBuffer; type: string }>();
    const attachmentIds = new Set<string>();

    // 从所有复制的舞台对象中收集 attachmentId
    for (const stageObject of stageObjects) {
      if (
        stageObject instanceof ImageNode ||
        stageObject instanceof SvgNode ||
        stageObject instanceof MediaNode ||
        stageObject instanceof FileCardNode
      ) {
        const attachmentId = stageObject.attachmentId;
        if (attachmentId && !attachmentIds.has(attachmentId)) {
          attachmentIds.add(attachmentId);
          const blob = project.attachments.get(attachmentId);
          if (blob) {
            // 将 Blob 转换为 ArrayBuffer 以便序列化
            const arrayBuffer = await blob.arrayBuffer();
            attachmentMap.set(attachmentId, {
              data: arrayBuffer,
              type: blob.type,
            });
          }
        }
      }
    }
    return attachmentMap;
  }

  /** 把粘贴内容外接矩形的中心对到目标点要平移多少；取整，免得坐标带上小数 */
  export function computePasteOffset(bounds: Rectangle, target: Vector): Vector {
    const center = bounds.center;
    return new Vector(Math.round(target.x - center.x), Math.round(target.y - center.y));
  }

  /**
   * 给还没放上舞台的粘贴内容改坐标。不能用 move()：它会推开碰到的实体、调整父框。
   * 每个实体只平移它自己（分组框不带孩子），所以要对粘贴出来的每个实体各调一次；
   * 有孩子的分组框放上舞台后 updateReferences 会按孩子重算大小。
   */
  export function rawShiftEntity(entity: Entity, delta: Vector) {
    if (entity instanceof PenStroke) {
      // 涂鸦的位置存在 segments 里，它的 move() 只重建自己的碰撞箱，不碰别人
      entity.move(delta);
      return;
    }
    if (entity instanceof Section) {
      // 锁定时 collisionBox 是现算的临时对象，折叠时拿到的是折叠后那份；展开、折叠两份都要平移，空分组框就靠它们定位
      const { locked, isCollapsed } = entity;
      entity.locked = false;
      entity.isCollapsed = false;
      shiftShapes(entity.collisionBox, delta);
      entity.isCollapsed = true;
      shiftShapes(entity.collisionBox, delta);
      entity.locked = locked;
      entity.isCollapsed = isCollapsed;
      return;
    }
    shiftShapes(entity.collisionBox, delta);
  }

  function shiftShapes(collisionBox: CollisionBox, delta: Vector) {
    for (const shape of collisionBox.shapes) {
      if (shape instanceof Line) {
        shape.start = shape.start.add(delta);
        shape.end = shape.end.add(delta);
      } else if (shape instanceof Rectangle) {
        shape.location = shape.location.add(delta);
      }
    }
  }
}
