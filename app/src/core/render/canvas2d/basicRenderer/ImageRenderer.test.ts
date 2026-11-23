import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import type { Project } from "@/core/Project";
vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
import { ImageRenderer } from "./ImageRenderer";

describe("rounded image nodes", () => {
  it.each([0.25, 1, 2, 4])(
    "keeps the radius in screen pixels at zoom %s and restores clipping after failures",
    (zoom) => {
      const ctx = {
        save: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        clip: vi.fn(),
        restore: vi.fn(),
        drawImage: vi.fn(),
      };
      const renderer = new ImageRenderer({ canvas: { ctx }, camera: { currentScale: zoom } } as unknown as Project);
      const image = { width: 100, height: 50 } as ImageBitmap;
      renderer.renderImageBitmap(image, new Vector(10, 20), 3, 16);
      expect(ctx.moveTo).toHaveBeenCalledWith(10 + 300 * zoom, 20 + 150 * zoom - 16);
      expect(ctx.lineTo).toHaveBeenCalledWith(10 + 300 * zoom - 16, 20 + 150 * zoom);
      expect(ctx.closePath).toHaveBeenCalledOnce();
      expect(ctx.clip).toHaveBeenCalledOnce();
      expect(ctx.restore).toHaveBeenCalledOnce();
      ctx.drawImage.mockImplementationOnce(() => {
        throw new Error("decode failure");
      });
      expect(() => renderer.renderImageElement(image, new Vector(10, 20), 3, 16)).toThrow("decode failure");
      expect(ctx.restore).toHaveBeenCalledTimes(2);
      renderer.renderImageElement(image, new Vector(10, 20), 1);
      expect(ctx.clip).toHaveBeenCalledTimes(2);
    },
  );

  it("draws a turned picture inside the turned box and leaves the context as it found it", () => {
    const ctx = {
      save: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      transform: vi.fn(),
      drawImage: vi.fn(),
    };
    const renderer = new ImageRenderer({ canvas: { ctx }, camera: { currentScale: 2 } } as unknown as Project);
    const image = { width: 100, height: 50 } as ImageBitmap;
    renderer.renderImageElement(image, new Vector(10, 20), 3, 16, 90);
    // 100 × 50 放大到 600 × 300，转过来占 300 × 600：圆角按转过来的框裁
    expect(ctx.moveTo).toHaveBeenCalledWith(10 + 300, 20 + 600 - 16);
    expect(ctx.translate).toHaveBeenCalledWith(10, 20);
    expect(ctx.transform).toHaveBeenCalledWith(0, 1, -1, 0, 300, 0);
    expect(ctx.drawImage).toHaveBeenCalledWith(image, 0, 0, 600, 300);
    expect(ctx.save).toHaveBeenCalledOnce();
    expect(ctx.restore).toHaveBeenCalledOnce();
    // 没有圆角也要还原，不然后面画的东西全歪了
    renderer.renderImageElement(image, new Vector(10, 20), 3, 0, 180);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
  });
});
