import { Vector } from "@graphif/data-structures";

/*
 * 图片转 90°：只在图片卡片上记一个角度，图片文件从头到尾不动——转多少次都不掉画质、不多占地方。
 * 画到画布上、导出 SVG 时按角度画；要把图片拿到程序外面用（复制、导出文件、放进汇报、给 AI 看）时才现画一张转好的。
 */

/** 顺时针转了多少度 */
export type ImageRotation = 0 | 90 | 180 | 270;
export type Rotate90Direction = "cw" | "ccw";

/** 文件里读出来的角度；没有（以前的文件）或者认不得的都当没转 */
export function imageRotationOf(value: unknown): ImageRotation {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

export function turned(rotation: ImageRotation, direction: Rotate90Direction): ImageRotation {
  return imageRotationOf((rotation + (direction === "cw" ? 90 : 270)) % 360);
}

/** 转了以后宽高是不是对调了 */
export const isSideways = (rotation: ImageRotation) => rotation === 90 || rotation === 270;

/**
 * 把一张 width × height 的图转好、左上角仍落在原点的变换（canvas 和 SVG 的 matrix 写法）。
 * 不用三角函数：90° 的正弦余弦在浮点里不是整的，边上会糊掉一条。
 */
export function rotationMatrix(
  rotation: ImageRotation,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  if (rotation === 90) return [0, 1, -1, 0, height, 0];
  if (rotation === 180) return [-1, 0, 0, -1, width, height];
  if (rotation === 270) return [0, -1, 1, 0, 0, width];
  return [1, 0, 0, 1, 0, 0];
}

const invert = (value: number) => Number((1 - value).toPrecision(12));

/** 连线端点在图片上的位置（占宽、高的比例）跟着图片一起转 */
export function rotateRate90(rate: Vector, direction: Rotate90Direction): Vector {
  if (rate.x === 0.5 && rate.y === 0.5) return new Vector(0.5, 0.5);
  return direction === "cw" ? new Vector(invert(rate.y), rate.x) : new Vector(rate.y, invert(rate.x));
}

/** 图片现在看上去的样子：没转过就是原图，转过的现画一张。命令行里没有画布，给原图 */
export async function rotatedImageBlob(blob: Blob, rotation: ImageRotation): Promise<Blob> {
  if (rotation === 0 || typeof createImageBitmap === "undefined") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = isSideways(rotation) ? bitmap.height : bitmap.width;
    canvas.height = isSideways(rotation) ? bitmap.width : bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image.rotateFailed");
    context.setTransform(...rotationMatrix(rotation, bitmap.width, bitmap.height));
    context.drawImage(bitmap, 0, 0);
    const type = blob.type === "image/jpeg" || blob.type === "image/webp" ? blob.type : "image/png";
    const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!result) throw new Error("image.rotateFailed");
    return result;
  } finally {
    bitmap.close();
  }
}
