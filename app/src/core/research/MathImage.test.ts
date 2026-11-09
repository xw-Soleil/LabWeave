import { describe, expect, it, vi } from "vitest";
import { MathImageCache, renderMathImage, type MathImage, type MathImageRequest } from "./MathImage";

const request: MathImageRequest = { source: "x", mode: "inline", color: "#000000" };
const value: MathImage = {
  image: {} as HTMLImageElement,
  width: 40,
  height: 30,
  fontSize: 32,
  layout: { width: 24, height: 14, descent: 2 },
  layoutOffset: { x: 8, y: 8 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("MathImageCache", () => {
  it("reads ready metrics from any color without populating another color or mode's image entry", async () => {
    const render = vi.fn(async (input: MathImageRequest) => ({
      ...value,
      image: { color: input.color } as unknown as HTMLImageElement,
    }));
    const cache = new MathImageCache(render);
    const red = { ...request, color: "red" };
    await cache.load(red);
    const fallback = cache.peekAnyColor(request)!;
    expect(fallback.image).toEqual({ color: "red" });
    expect(cache.peek(request)).toBeUndefined();
    expect(cache.peekAnyColor({ ...request, mode: "display" })).toBeUndefined();
    expect(cache.peekAnyColor({ ...request, source: "y" })).toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
    await cache.load(request);
    expect(cache.peek(request)).toEqual({ status: "ready", value: { ...value, image: { color: request.color } } });
    expect(cache.peek(red)).toEqual({ status: "ready", value: { ...value, image: { color: "red" } } });
  });
  it("reports unavailable without document, Image or loading browser assets", async () => {
    expect(typeof document).toBe("undefined");
    expect(typeof Image).toBe("undefined");
    expect(await renderMathImage(request)).toBeNull();
    const cache = new MathImageCache();
    expect(await cache.load(request)).toEqual({ status: "unavailable" });
    expect(cache.get(request)).toBeNull();
  });

  it("also skips the CLI's partial DOM shim when no image loader exists", async () => {
    vi.stubGlobal("document", { body: {} });
    try {
      expect(await renderMathImage(request)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates pending work, caches by source/mode/color and notifies once", async () => {
    const job = deferred<MathImage>();
    const render = vi.fn(() => job.promise);
    const cache = new MathImageCache(render);
    const listener = vi.fn();
    cache.subscribe(listener);
    expect(cache.get(request)).toBeNull();
    expect(cache.request(request).status).toBe("pending");
    const loaded = cache.load({ ...request });
    job.resolve(value);
    expect(await loaded).toEqual({ status: "ready", value });
    expect(render).toHaveBeenCalledExactlyOnceWith(request);
    expect(listener).toHaveBeenCalledExactlyOnceWith(request, { status: "ready", value });
    expect(cache.get(request)).toBe(value);
    await cache.load({ ...request, source: "y" });
    await cache.load({ ...request, mode: "display" });
    await cache.load({ ...request, color: "red" });
    expect(render).toHaveBeenCalledTimes(4);
  });

  it("records failure, returns no metrics and does not retry on subsequent frames", async () => {
    const error = new Error("parse failed");
    const render = vi.fn().mockRejectedValue(error);
    const cache = new MathImageCache(render);
    const listener = vi.fn();
    cache.subscribe(listener);
    expect(await cache.load(request)).toEqual({ status: "failed", error });
    for (let frame = 0; frame < 10; frame++) expect(cache.get(request)).toBeNull();
    expect(await cache.load(request)).toEqual({ status: "failed", error });
    expect(render).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledExactlyOnceWith(request, { status: "failed", error });
  });

  it("also records synchronous renderer failures in the same place", async () => {
    const error = new Error("sync failure");
    const cache = new MathImageCache(() => {
      throw error;
    });
    expect(await cache.load(request)).toEqual({ status: "failed", error });
  });

  it("allows unsubscribing while work is pending", async () => {
    const job = deferred<MathImage>();
    const cache = new MathImageCache(() => job.promise);
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = cache.subscribe(removed);
    cache.subscribe(retained);
    const loaded = cache.load(request);
    unsubscribe();
    unsubscribe();
    job.resolve(value);
    await loaded;
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it("bounds ready, failed and unavailable entries with least-recently-used eviction", async () => {
    const render = vi.fn(async ({ source }: MathImageRequest) => {
      if (source === "bad") throw new Error("bad");
      return source === "missing" ? null : value;
    });
    const cache = new MathImageCache(render, 2);
    const bad = { ...request, source: "bad" };
    const missing = { ...request, source: "missing" };
    await cache.load(request);
    await cache.load(bad);
    expect(cache.get(request)).toBe(value);
    await cache.load(missing);
    expect(cache.get(request)).toBe(value);
    expect(cache.request(missing).status).toBe("unavailable");
    await cache.load(bad);
    expect(render).toHaveBeenCalledTimes(4);
    expect(cache.request(request).status).toBe("pending");
    await cache.load(request);
  });

  it("does not let evicted pending work overwrite a newer result or grow the cache", async () => {
    const first = deferred<MathImage>();
    const render = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(value);
    const cache = new MathImageCache(render, 1);
    const old = cache.load(request);
    await Promise.resolve();
    await cache.load({ ...request, source: "y" });
    await cache.load(request);
    first.resolve({ ...value, width: 999 });
    await old;
    expect(cache.get(request)).toBe(value);
    expect(cache.request({ ...request, source: "y" }).status).toBe("pending");
    await cache.load({ ...request, source: "y" });
  });

  it("takes a stable copy of the request before asynchronous rendering", async () => {
    const render = vi.fn(async () => value);
    const cache = new MathImageCache(render);
    const input = { ...request };
    const loaded = cache.load(input);
    input.source = "changed";
    await loaded;
    expect(render).toHaveBeenCalledWith(request);
  });
});
