// @vitest-environment jsdom
import { Vector } from "@graphif/data-structures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageRotationOf, rotatedImageBlob, rotateRate90, rotationMatrix, turned } from "./ImageRotation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** canvas 的 transform(a,b,c,d,e,f) 把一个点搬到哪里 */
const apply = ([a, b, c, d, e, f]: number[], x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];

describe("ImageRotation", () => {
  it("turns a quarter at a time and comes back after four", () => {
    expect(turned(0, "cw")).toBe(90);
    expect(turned(270, "cw")).toBe(0);
    expect(turned(0, "ccw")).toBe(270);
    let rotation = imageRotationOf(0);
    for (let turn = 0; turn < 4; turn++) rotation = turned(rotation, "ccw");
    expect(rotation).toBe(0);
  });

  it("reads anything it does not know as not turned", () => {
    for (const value of [undefined, null, 45, 360, -90, "90", NaN]) expect(imageRotationOf(value)).toBe(0);
    expect(imageRotationOf(180)).toBe(180);
  });

  it("lands a turned picture back on the origin, with its top left corner where a clockwise turn puts it", () => {
    // 宽 40 高 30 的图，左上角依次转到：左上、右上、右下、左下
    expect(apply(rotationMatrix(0, 40, 30), 0, 0)).toEqual([0, 0]);
    expect(apply(rotationMatrix(90, 40, 30), 0, 0)).toEqual([30, 0]);
    expect(apply(rotationMatrix(180, 40, 30), 0, 0)).toEqual([40, 30]);
    expect(apply(rotationMatrix(270, 40, 30), 0, 0)).toEqual([0, 40]);
    for (const [rotation, width, height] of [
      [90, 30, 40],
      [180, 40, 30],
      [270, 30, 40],
    ] as const) {
      const corners = [
        [0, 0],
        [40, 0],
        [0, 30],
        [40, 30],
      ].map(([x, y]) => apply(rotationMatrix(rotation, 40, 30), x, y));
      expect([Math.min(...corners.map(([x]) => x)), Math.max(...corners.map(([x]) => x))]).toEqual([0, width]);
      expect([Math.min(...corners.map(([, y]) => y)), Math.max(...corners.map(([, y]) => y))]).toEqual([0, height]);
    }
  });

  it("moves the end of a connection along with the picture", () => {
    expect(rotateRate90(new Vector(0.5, 0.5), "cw")).toEqual(new Vector(0.5, 0.5));
    expect(rotateRate90(new Vector(0.6, 0.3), "cw")).toEqual(new Vector(0.7, 0.6));
    expect(rotateRate90(new Vector(0.7, 0.6), "ccw")).toEqual(new Vector(0.6, 0.3));
    expect(rotateRate90(new Vector(0.5, 0.01), "cw")).toEqual(new Vector(0.99, 0.5));
  });

  describe("as a picture for use outside the board", () => {
    const stubCanvas = (encode: (type: string) => Blob | null) => {
      const transforms: number[][] = [];
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          setTransform: (...matrix: number[]) => transforms.push(matrix),
          drawImage: vi.fn(),
        }),
        toBlob: (done: (blob: Blob | null) => void, type: string) => done(encode(type)),
      };
      vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);
      const close = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width: 40, height: 30, close })),
      );
      return { canvas, transforms, close };
    };

    it("is the stored file itself while it has not been turned", async () => {
      const decode = vi.fn();
      vi.stubGlobal("createImageBitmap", decode);
      const blob = new Blob(["x"], { type: "image/png" });
      expect(await rotatedImageBlob(blob, 0)).toBe(blob);
      expect(decode).not.toHaveBeenCalled();
    });

    it("is drawn turned, keeping a JPEG a JPEG and making everything else a PNG", async () => {
      const { canvas, transforms, close } = stubCanvas((type) => new Blob(["turned"], { type }));
      const jpeg = await rotatedImageBlob(new Blob(["x"], { type: "image/jpeg" }), 90);
      expect(jpeg.type).toBe("image/jpeg");
      expect([canvas.width, canvas.height]).toEqual([30, 40]);
      expect(transforms).toEqual([rotationMatrix(90, 40, 30)]);
      expect(close).toHaveBeenCalledOnce();
      expect((await rotatedImageBlob(new Blob(["x"], { type: "image/bmp" }), 180)).type).toBe("image/png");
      expect([canvas.width, canvas.height]).toEqual([40, 30]);
    });

    it("says so when it cannot be encoded, and still lets go of the decoded picture", async () => {
      const { close } = stubCanvas(() => null);
      await expect(rotatedImageBlob(new Blob(["x"], { type: "image/png" }), 90)).rejects.toThrow("image.rotateFailed");
      expect(close).toHaveBeenCalledOnce();
    });

    it("is the stored file where there is no canvas, as on the command line", async () => {
      vi.stubGlobal("createImageBitmap", undefined);
      const blob = new Blob(["x"], { type: "image/png" });
      expect(await rotatedImageBlob(blob, 90)).toBe(blob);
    });
  });
});
