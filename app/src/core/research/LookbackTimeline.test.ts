import { describe, expect, it } from "vitest";
import { easeInOut, easeOut, easeOutBack, planTimeline, progress, type TimelineBoard } from "./LookbackTimeline";

const item = (id: string, x = 0, y = 0, frame = false) => ({ id, box: { x, y, w: 100, h: 40 }, frame });
const link = (...ends: string[]) => ({ id: ends.join("→"), ends });
const board = (items: TimelineBoard["items"], links: TimelineBoard["links"] = []): TimelineBoard => ({ items, links });
/** 长出来的先后 */
const order = (spans: ReadonlyMap<string, { start: number }>) =>
  [...spans].sort(([, a], [, b]) => a.start - b.start).map(([id]) => id);

describe("the timeline of a lookback transition", () => {
  it("fades the removed cards, slides the kept ones, grows the new ones, and brings up the marks last", () => {
    const { removed, added, leave, move, marks, total } = planTimeline(
      board([item("留", 0), item("删", 300)]),
      board([item("留", 500), item("新", 700)]),
    );
    expect([...removed]).toEqual(["删"]);
    expect([...added.keys()]).toEqual(["新"]);
    expect(leave.start).toBe(0);
    expect(move.start).toBeLessThan(leave.end);
    expect(move.end).toBeGreaterThan(leave.end);
    const grow = added.get("新")!;
    expect(grow.start).toBeGreaterThan(leave.end);
    expect(grow.start).toBeLessThan(move.end);
    expect(marks.end).toBeGreaterThan(Math.max(grow.end, move.end));
    expect(total).toBe(marks.end);
    expect(total).toBeLessThanOrEqual(1100);
  });

  it("spends no time on steps there is nothing to do in", () => {
    const { added, leave } = planTimeline(board([item("留")]), board([item("留"), item("新", 300)]));
    expect(leave).toEqual({ start: 0, end: 0 });
    expect(added.get("新")!.start).toBe(0);
    expect(progress(leave, 0)).toBe(1);
  });

  it("grows outwards from the cards that were already there, group frames first", () => {
    const { added } = planTimeline(
      board([item("原有", 0, 500)]),
      board(
        [
          item("孙", 200, 0),
          item("子", 100, 900),
          item("框", 0, 999, true),
          item("子二", 100, 100),
          item("原有", 0, 500),
        ],
        [link("原有", "子"), link("子", "孙"), link("子二", "原有")],
      ),
    );
    expect(order(added)).toEqual(["框", "子二", "子", "孙"]);
  });

  it("grows a tree that is new as a whole from its root", () => {
    const { added } = planTimeline(
      board([]),
      board(
        [item("叶", 200, 0), item("根", 0, 300), item("枝", 100, 50), item("单独一张", 900, 900)],
        [link("根", "枝"), link("枝", "叶")],
      ),
    );
    expect(order(added)).toEqual(["根", "单独一张", "枝", "叶"]);
  });

  it("does not take longer and longer the more cards are new", () => {
    const many = Array.from({ length: 300 }, (_, index) => item(String(index), index));
    expect(planTimeline(board([]), board(many)).total).toBeLessThanOrEqual(900);
  });

  it("draws a new connection once both its ends have grown, and swaps one that was re-attached", () => {
    const { added, addedLinks, removedLinks } = planTimeline(
      board([item("甲"), item("乙", 200)], [{ id: "线", ends: ["甲", "乙"] }, link("乙", "甲")]),
      board([item("甲"), item("乙", 200), item("丙", 400)], [{ id: "线", ends: ["甲", "丙"] }, link("乙", "甲")]),
    );
    expect([...removedLinks]).toEqual(["线"]);
    expect([...addedLinks.keys()]).toEqual(["线"]);
    const grow = added.get("丙")!;
    expect(addedLinks.get("线")!.start).toBeGreaterThan((grow.start + grow.end) / 2);
  });

  it("starts and ends every easing where it should", () => {
    for (const ease of [easeOut, easeInOut, easeOutBack]) {
      expect(ease(0)).toBeCloseTo(0, 10);
      expect(ease(1)).toBeCloseTo(1, 10);
    }
    expect(progress({ start: 100, end: 200 }, 50)).toBe(0);
    expect(progress({ start: 100, end: 200 }, 150)).toBe(0.5);
    expect(progress({ start: 100, end: 200 }, 900)).toBe(1);
  });
});
