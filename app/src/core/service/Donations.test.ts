import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch } from "@tauri-apps/plugin-http";
import { fetchDonations } from "./Donations";

beforeEach(() => vi.mocked(fetch).mockReset());

describe("supporter list loading", () => {
  it("returns an empty list without any network request", async () => {
    expect(await fetchDonations()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
