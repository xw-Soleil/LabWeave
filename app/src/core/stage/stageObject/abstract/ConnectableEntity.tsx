import { Vector } from "@graphif/data-structures";
import type { Rectangle } from "@graphif/shapes";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";

/**
 * 一切可被Edge连接的东西，且会算入图分析算法的东西
 */
export abstract class ConnectableEntity extends Entity {
  /**
   * 几何中心点
   * 用于联动旋转等算法
   */
  abstract geometryCenter: Vector;

  public unknown = false;

  public get clipConnectionToBoundary(): boolean {
    return false;
  }

  /** 连线的端点落在哪个矩形上。一般就是整个外框；图片卡片带说明时只算图片本身（见 FileCardNode） */
  get connectionRectangle(): Rectangle {
    return this.collisionBox.getRectangle();
  }
}
