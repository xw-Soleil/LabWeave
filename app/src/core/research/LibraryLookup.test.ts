// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  head: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("./PdfTools", () => ({ readPdfHead: mocks.head }));

import { findPaperId, lookupPaper, recognizePdf } from "./LibraryLookup";

const reply = (body: string, status = 200) => ({ ok: status < 400, status, text: async () => body });
const crossref = JSON.stringify({
  status: "ok",
  message: {
    DOI: "10.1000/Example.1",
    type: "journal-article",
    title: ["Learning <i>fast</i> solvers &amp; more"],
    author: [{ given: "Ada", family: "Lovelace" }, { name: "The Solver Collaboration" }],
    issued: { "date-parts": [[2023, 5, 1]] },
    "container-title": ["Journal of Examples"],
    volume: "12",
    issue: "3",
    page: "45-67",
    URL: "https://doi.org/10.1000/example.1",
    abstract: "<jats:title>Abstract</jats:title><jats:p>We study  solvers.</jats:p>",
  },
});
const arxivFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2406.17763v2</id>
    <published>2024-06-25T17:59:59Z</published>
    <title>DiffusionPDE: Generative PDE-Solving
  under Partial Observation</title>
    <summary>  We introduce a general framework.
</summary>
    <author><name>Jiahe Huang</name></author>
    <author><name>Guandao Yang</name></author>
    <arxiv:doi>10.52202/079017-4140</arxiv:doi>
    <arxiv:journal_ref>NeurIPS 2024</arxiv:journal_ref>
  </entry>
</feed>`;

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.head.mockReset();
});

describe("finding a paper's identifier", () => {
  it.each([
    ["https://doi.org/10.1038/s41586-021-03819-2.", { doi: "10.1038/s41586-021-03819-2" }],
    ["see DOI: 10.1016/J.JCP.2018.10.045), and", { doi: "10.1016/j.jcp.2018.10.045" }],
    ["arXiv:2406.17763v2 [cs.LG] 20 Nov 2024", { arxiv: "2406.17763" }],
    ["https://arxiv.org/abs/2406.17763", { arxiv: "2406.17763" }],
    ["https://arxiv.org/pdf/hep-th/9901001v3", { arxiv: "hep-th/9901001" }],
    [" 2406.17763 ", { arxiv: "2406.17763" }],
    ["https://doi.org/10.48550/arXiv.2406.17763", { arxiv: "2406.17763" }],
    ["version 2406.17763 of the software", {}],
    ["no identifier here", {}],
  ])("%s", (text, expected) => {
    const found = findPaperId(text);
    expect({ ...(found.doi && { doi: found.doi }), ...(found.arxiv && { arxiv: found.arxiv }) }).toEqual(expected);
  });
});

describe("looking a paper up online", () => {
  it("asks Crossref for a DOI and sends nothing but the identifier", async () => {
    mocks.fetch.mockResolvedValue(reply(crossref));
    expect(await lookupPaper({ doi: "10.1000/example.1" })).toEqual({
      title: "Learning fast solvers & more",
      authors: ["Ada Lovelace", "The Solver Collaboration"],
      year: "2023",
      venue: "Journal of Examples",
      itemType: "期刊文章",
      volume: "12",
      issue: "3",
      pages: "45-67",
      doi: "10.1000/example.1",
      url: "https://doi.org/10.1000/example.1",
      abstract: "We study solvers.",
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://api.crossref.org/works/10.1000%2Fexample.1");
    expect(options.body).toBeUndefined();
  });

  it("asks arXiv for an arXiv number", async () => {
    mocks.fetch.mockResolvedValue(reply(arxivFeed));
    expect(await lookupPaper({ arxiv: "2406.17763" })).toEqual({
      title: "DiffusionPDE: Generative PDE-Solving under Partial Observation",
      authors: ["Jiahe Huang", "Guandao Yang"],
      year: "2024",
      venue: "NeurIPS 2024",
      itemType: "预印本",
      doi: "10.52202/079017-4140",
      arxiv: "2406.17763",
      url: "https://arxiv.org/abs/2406.17763",
      abstract: "We introduce a general framework.",
    });
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://export.arxiv.org/api/query?id_list=2406.17763");
  });

  it("tells unknown identifiers, network failures and missing identifiers apart", async () => {
    mocks.fetch.mockResolvedValue(reply("Resource not found.", 404));
    await expect(lookupPaper({ doi: "10.1000/none" })).rejects.toThrow("library.lookupNotFound");
    mocks.fetch.mockResolvedValue(reply('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'));
    await expect(lookupPaper({ arxiv: "0000.00000" })).rejects.toThrow("library.lookupNotFound");
    mocks.fetch.mockRejectedValue(new Error("offline"));
    await expect(lookupPaper({ doi: "10.1000/example.1" })).rejects.toThrow("library.lookupNetwork");
    mocks.fetch.mockResolvedValue(reply("busy", 503));
    await expect(lookupPaper({ doi: "10.1000/example.1" })).rejects.toThrow("library.lookupNetwork");
    await expect(lookupPaper({})).rejects.toThrow("library.lookupNoId");
  });
});

describe("recognising an imported PDF", () => {
  it("uses the arXiv stamp on the first page", async () => {
    mocks.head.mockResolvedValue({ text: "DiffusionPDE\narXiv:2406.17763v2 [cs.LG]", title: "", author: "" });
    mocks.fetch.mockResolvedValue(reply(arxivFeed));
    const found = await recognizePdf("/downloads/2406.17763v2.pdf");
    expect(found.source).toBe("online");
    expect(found.fields).toMatchObject({ title: expect.stringMatching(/^DiffusionPDE/), arxiv: "2406.17763" });
    expect(mocks.head).toHaveBeenCalledWith("/downloads/2406.17763v2.pdf");
  });

  it("accepts a DOI only when its title really is on the first pages", async () => {
    mocks.fetch.mockResolvedValue(reply(crossref));
    mocks.head.mockResolvedValue({
      text: "Learning fast sol-\nvers & more\nAda Lovelace\nhttps://doi.org/10.1000/example.1",
      title: "",
      author: "",
    });
    expect((await recognizePdf("/a.pdf")).source).toBe("online");
    mocks.head.mockResolvedValue({
      text: "A different paper\nwhich cites https://doi.org/10.1000/example.1",
      title: "A Different Paper",
      author: "Grace Hopper and Alan Turing; Kurt Goedel",
    });
    const other = await recognizePdf("/b.pdf");
    expect(other.source).toBe("pdf");
    expect(other.fields).toEqual({
      title: "A Different Paper",
      authors: ["Grace Hopper", "Alan Turing", "Kurt Goedel"],
    });
    expect(other.problem).toEqual(new Error("library.lookupMismatch"));
  });

  it("falls back to the PDF's own title, then to nothing, and reports what went wrong", async () => {
    mocks.head.mockResolvedValue({ text: "doi:10.1000/example.1", title: "Offline Paper", author: "" });
    mocks.fetch.mockRejectedValue(new Error("offline"));
    const offline = await recognizePdf("/a.pdf");
    expect(offline).toMatchObject({ source: "pdf", fields: { title: "Offline Paper", doi: "10.1000/example.1" } });
    expect(offline.problem).toEqual(new Error("library.lookupNetwork"));

    mocks.head.mockResolvedValue({ text: "plain text", title: "Microsoft Word - draft.docx", author: "me" });
    expect(await recognizePdf("/a.pdf")).toEqual({ fields: { title: "", authors: [] }, source: "none" });
    expect(mocks.fetch).toHaveBeenCalledOnce();

    mocks.head.mockRejectedValue(new Error("pdf.locked"));
    expect(await recognizePdf("/a.pdf")).toMatchObject({ source: "none", problem: new Error("pdf.locked") });
  });
});
