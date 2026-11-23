import { afterAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cancelled, sleep, withSignal } from "../../src/browse/cdp/cancel.ts";
import { parseCookieFile } from "../../src/browse/commands/storage.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { parse } from "../../src/browse/commands/parse.ts";
import { BrowseError, Usage } from "../../src/browse/daemon-errors.ts";
import { OUTPUT_CAP, render as renderAnswer } from "../../src/browse/daemon/render.ts";
import { begin } from "../../src/browse/metrics.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import { content } from "../../src/browse/outfile.ts";
import * as pages from "../../src/browse/read/pages.ts";
import { extractHtml, postProcess } from "../../src/browse/read/readurl.ts";
import * as scroll from "../../src/browse/read/scroll.ts";
import { goto } from "../../src/browse/read/pages.ts";
import type { Page } from "../../src/browse/state/page.ts";
import { State } from "../../src/browse/state/state.ts";

const folders: [string, number][] = [];

afterAll(() => {
  for (const [root, fd] of folders) {
    closeFd(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function record(index: number, length: number): pages.PageRecord {
  const lines = Array.from({ length: Math.floor(length / 70) }, (_, n) => `line ${index}.${n} ${"x".repeat(60)}`);
  return { url: `http://x.test/${index}`, finalUrl: `http://x.test/${index}`, title: `Page ${index}`, text: lines.join("\n") };
}

describe("PagesCap", () => {
  test("test_cap_grows_with_pages_between_floor_and_ceiling", () => {
    expect(pages.pagesCap(1)).toBe(OUTPUT_CAP);
    expect(pages.pagesCap(2)).toBe(OUTPUT_CAP);
    expect(pages.pagesCap(4)).toBe(24000);
    expect(pages.pagesCap(30)).toBe(pages.PAGES_CAP_CEILING);
  });

  test("test_twelve_pages_fit_whole_under_the_scaled_cap", () => {
    const result = pages.resultFor(Array.from({ length: 12 }, (_, index) => record(index, 1000)), {}, {});
    expect(result.text).not.toContain("pages cut to fit");
    expect((result.text as string).length).toBeGreaterThan(OUTPUT_CAP);
    const [, out, err] = renderAnswer({}, result, null, "read");
    expect(out).toBe(`${result.text}\n`);
    expect(err).toBe("");
  });

  test("test_too_many_pages_are_cut_and_the_footer_reaches_stderr", () => {
    const result = pages.resultFor(Array.from({ length: 10 }, (_, index) => record(index, 5000)), {}, {});
    expect((result.text as string).length).toBeLessThanOrEqual(pages.PAGES_CAP_CEILING);
    expect(result.notice).toContain("pages cut to fit 36,000 characters");
    const [, out, err] = renderAnswer({}, result, null, "read");
    expect(err.startsWith("[pages cut to fit 36,000 characters")).toBe(true);
    expect(out.includes("[pages cut to fit")).toBe(false);
  });

  test("test_max_output_still_wins_over_the_page_budget", () => {
    const result = pages.resultFor(Array.from({ length: 12 }, (_, index) => record(index, 1000)), {}, { max_output: 3000 });
    expect((result.text as string).length).toBeLessThanOrEqual(3000);
  });
});

describe("ScrollRows", () => {
  const row = (text: string, index: number | null, offset: number) => ({ text, index, id: "", offset });

  test("test_virtual_rows_are_kept_once_by_index_and_ordered", () => {
    const collector = new scroll.RowCollector();
    collector.absorb({ rows: [row("b", 2, 40), row("a", 1, 0)] });
    const added = collector.absorb({ rows: [row("b", 2, 40), row("c", 3, 80)] });
    expect(added).toBe(1);
    expect(collector.ordered().map((item) => item.text)).toEqual(["a", "b", "c"]);
  });

  test("test_rows_without_an_index_dedupe_by_offset_and_text", () => {
    const collector = new scroll.RowCollector();
    const same = row("Weekly digest", null, 400);
    collector.absorb({ rows: [same, row("Weekly digest", null, 680), { ...same }] });
    expect(collector.rows.size).toBe(2);
  });

  test("test_match_ignores_case", () => {
    const rows = [row("Receipt from STAPLES", null, 0), row("Weekly digest", null, 1)];
    expect(scroll.matching(rows, "staples")).toEqual(rows.slice(0, 1));
    expect(scroll.matching(rows, null)).toEqual(rows);
  });

  test("test_summary_names_why_it_stopped", () => {
    expect(scroll.scrollSummary(200, 2, "staples", "end", 1000, 3.1)).toBe('[2 of 200 rows match "staples"; scrolled to the end of the list]');
    expect(scroll.scrollSummary(50, 50, null, "limit", 50, 1)).toContain("--limit 50");
    expect(scroll.scrollSummary(900, 900, null, "time", 1000, 30)).toContain("--timeout");
    expect(scroll.scrollSummary(12, 12, null, "end", 1000, 1, "t3").endsWith("ardia browse tab t3 --show, then read again]")).toBe(true);
    expect(scroll.scrollSummary(12, 12, null, "limit", 12, 1, "t3")).not.toContain("hidden");
  });

  test("test_limits", () => {
    expect(scroll.parseRows(null)).toBe(scroll.SCROLL_ROWS_DEFAULT);
    expect(scroll.parseRows(null, true)).toBe(scroll.SCROLL_ROWS_MAX);
    expect(scroll.parseRows("300")).toBe(300);
    for (const bad of ["0", "abc", String(scroll.SCROLL_ROWS_MAX + 1)]) expect(() => scroll.parseRows(bad)).toThrow(Usage);
  });

  test("test_scroll_flags_need_one_list_on_the_tab", async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ scroll: true, selector: "ul" }, ["http://x.test/"]],
      [{ scroll: true, selector: "ul", http: true }, []],
      [{ match: "x", selector: "ul" }, []],
    ];
    for (const [options, positional] of cases) await expect(scroll.runScroll(null as never, options, positional)).rejects.toBeInstanceOf(Usage);
  });

  test("test_flags_parse", () => {
    const [options, args] = parse(["-s", "@e8", "--scroll", "--limit", "50", "--match", "receipt"], pages.flags(), pages.ALIASES);
    expect([options["selector"], options["scroll"], options["limit"], options["match"], args]).toEqual(["@e8", true, "50", "receipt", []]);
    expect(scroll.scrolls(options)).toBe(true);
  });
});

describe("Links", () => {
  test("test_a_plain_pattern_is_a_substring_and_star_matches_anything", () => {
    const links = ["http://s/p/a", "http://s/c/docks?page=2", "http://s/p/b", "http://s/blog/p/x", "http://s/"];
    expect(pages.pickLinks(links, "/p/")).toEqual(["http://s/p/a", "http://s/p/b", "http://s/blog/p/x"]);
    expect(pages.pickLinks(links, "s/p/*")).toEqual(["http://s/p/a", "http://s/p/b"]);
    expect(pages.pickLinks(links, "page=*")).toEqual(["http://s/c/docks?page=2"]);
    expect(pages.pickLinks(links, "")).toEqual(links);
  });

  test("test_the_listing_itself_is_skipped", () => {
    expect(pages.pickLinks(["http://s/p/a", "http://s/p/b"], "/p/", "http://s/p/a#top")).toEqual(["http://s/p/b"]);
  });

  test("test_no_match_names_some_links", () => {
    expect(pages.noLinksMessage("/item/", "http://s/c", ["http://s/p/a?x=1", "http://s/p/b"])).toBe("No link on http://s/c matches '/item/' (2 links, such as /p/a?x=1, /p/b)");
    expect(pages.noLinksMessage("/p/", "http://s/", [])).toBe("The page has no links to read (http://s/)");
  });
});

describe("HashRoutes", () => {
  test("test_route_fragments_are_kept_and_in_page_anchors_dropped", () => {
    expect(pages.canonicalLink("http://s/a#top")).toBe("http://s/a");
    expect(pages.canonicalLink("http://s/#/people/42")).toBe("http://s/#/people/42");
    expect(pages.canonicalLink("http://s/#!/legacy/7")).toBe("http://s/#!/legacy/7");
    expect(pages.canonicalLink("http://s/a#")).toBe("http://s/a");
  });

  test("test_links_dedupe_on_the_full_url_and_patterns_see_the_route", () => {
    const links = pages.distinctLinks(["http://s/#/people/1", "http://s/#top", "http://s/#/people/2", "http://s/#/people/1", "http://s/", "http://s/#!/legacy/7"]);
    expect(links).toEqual(["http://s/#/people/1", "http://s/", "http://s/#/people/2", "http://s/#!/legacy/7"]);
    expect(pages.pickLinks(links, "/people/", "http://s/#/")).toEqual(["http://s/#/people/1", "http://s/#/people/2"]);
    expect(pages.pickLinks(links, "#!/", "http://s/")).toEqual(["http://s/#!/legacy/7"]);
    expect(pages.pickLinks(links, "s/", "http://s/#notes")).toEqual(["http://s/#/people/1", "http://s/#/people/2", "http://s/#!/legacy/7"]);
  });
});

describe("SameDocumentRead", () => {
  test("test_a_hash_route_read_waits_for_the_route_to_render", async () => {
    const page = {
      text: "Person 1 Engineer 11",
      url: "http://s/#/people/1",
      mainFrame: "F",
      session: "S",
      state: { reattach: async (same: unknown) => same },
      loader: () => null,
      lifecycle: new Map(),
      networkOn: false,
      network: { fetchesStarted: new Map(), fetchesBusyUntil: 0, fetchLoaders: new Map() },
      frames: new Map(),
      async send(_method: string, params: Record<string, unknown>) {
        page.url = String(params["url"]);
        page.text = "Loading…";
        setTimeout(() => {
          page.text = "Person 2 Engineer 22";
        }, 500);
        return { frameId: "F" };
      },
      async call() {
        return ["complete", page.text, page.text.toLowerCase().includes("loading")];
      },
      async refreshFrames() {
        return new Map();
      },
    };
    await goto(page as unknown as Page, "http://s/#/people/2", 5);
    expect(page.text).toBe("Person 2 Engineer 22");
  });
});

describe("Urls", () => {
  test("test_arguments_and_stdin_lines_dedupe_in_order", () => {
    expect(pages.wantedUrls({ stdin: true }, ["example.com/a", "-"], "# picked\nhttp://x/1 http://x/2\n\nexample.com/a\n")).toEqual([
      "https://example.com/a",
      "http://x/1",
      "http://x/2",
    ]);
  });

  test("test_paths_resolve_against_the_tab", () => {
    expect(pages.wantedUrls({}, ["/p/a", "?page=2", "../b"], null, "http://s/c/docks?page=1")).toEqual(["http://s/p/a", "http://s/c/docks?page=2", "http://s/b"]);
    expect(() => pages.wantedUrls({}, ["/p/a"], null, null)).toThrow(Usage);
  });

  test("test_limits", () => {
    expect(pages.parseLimit(null)).toBe(pages.DEFAULT_LIMIT);
    for (const bad of ["0", "101", "ten"]) expect(() => pages.parseLimit(bad)).toThrow(Usage);
    expect(pages.pageTimeout({ timeout: "1500" })).toBe(1.5);
  });
});

describe("Rendering", () => {
  test("test_pages_are_headed_by_title_and_url", () => {
    const records = [
      { url: "http://s/p/a", finalUrl: "http://s/p/a", title: "Dock A", text: "Two displays: Yes" },
      { url: "http://s/p/b", error: "couldn't load it: net::ERR_CONNECTION_REFUSED" },
    ];
    expect(pages.render(records, {})).toBe(
      "=== [1/2] Dock A\nhttp://s/p/a\nTwo displays: Yes\n\n=== [2/2] ✗ http://s/p/b\ncouldn't load it: net::ERR_CONNECTION_REFUSED",
    );
    expect(pages.render(records.slice(0, 1), {})).toBe("=== Dock A\nhttp://s/p/a\nTwo displays: Yes");
  });

  test("test_the_cap_is_shared_so_every_page_shows", () => {
    const records: pages.PageRecord[] = Array.from({ length: 10 }, (_, n) => ({
      url: `http://s/p/${n}`,
      title: `P${n}`,
      text: Array.from({ length: 400 }, (_, k) => `spec ${n}.${k}: value`).join("\n"),
    }));
    (records[3] as pages.PageRecord)["text"] = "short page";
    const text = pages.render(records, {});
    expect(text.length).toBeLessThanOrEqual(pages.pagesCap(10));
    for (let n = 0; n < 10; n += 1) expect(text).toContain(`=== [${n + 1}/10] P${n}\nhttp://s/p/${n}\n`);
    expect(text).toContain("short page");
    expect(text).toContain("Narrow it: -s <css> (one region per page)");
    expect(text).not.toContain("--full");
    expect(text).toContain(" characters]\n\n=== [");
    const [, out] = renderAnswer({}, pages.resultFor(records, {}, {}), null, "");
    expect(out).not.toContain("output capped");
    const full = pages.render(records, { full: true });
    expect(full).not.toContain("pages cut");
    expect(text.length).toBeGreaterThan(pages.pagesCap(10) - 400);
    expect(pages.render(records, { max_output: 0 })).toBe(full);
  });

  test("test_shares_give_short_pages_their_length_and_split_the_rest", () => {
    expect(pages.shares([100, 5000, 5000], 3100)).toEqual([100, 1500, 1500]);
    expect(pages.shares([10, 20], 1000)).toEqual([10, 20]);
  });
});

describe("ReadTest", () => {
  test("test_html_extract_and_filters", () => {
    const { content } = extractHtml(
      "<html><head><title>T</title><style>x{}</style></head><body><nav>menu</nav><h1>Guide</h1><p>Intro text</p>" +
        "<h2>Auth</h2><ul><li>one</li><li>two</li></ul><h2>Other</h2><p>more</p></body></html>",
    );
    expect(content).toBe("# Guide\n\nIntro text\n\n## Auth\n\n- one\n- two\n\n## Other\n\nmore");
    expect(postProcess(content, { filter: "auth" })).toBe("## Auth\n\n- one\n- two");
    expect(postProcess(content, { outline: true })).toBe("Guide\n  Auth\n  Other");
  });
});

describe("CookieFileTest", () => {
  test("test_formats", () => {
    expect(parseCookieFile('[{"name":"a","value":"1"}]')).toEqual([["a", "1"]]);
    expect(parseCookieFile("curl 'https://x' -H 'cookie: a=1; b=2'")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(parseCookieFile("Cookie: s=xyz")).toEqual([["s", "xyz"]]);
  });
});

type Reader = { targetId: string; sessionId: string | null; attach(): Promise<void>; keepAwake(): Promise<void>; enableNetwork(): Promise<void>; detach(): void };

function readerState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d4-read-"));
  fs.chmodSync(root, 0o700);
  const dir = browseDir(root);
  folders.push([root, dir]);
  const state = new State({ session: "reader", key: "b".repeat(24), browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  const created: string[] = [];
  const closed: string[] = [];
  const refuseAttach = new Set<string>();
  let live: string[] = [];
  const browser = {
    alive: true,
    closedByUs: false,
    send(method: string, params: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const targetId = `R${created.length + 1}`;
        created.push(targetId);
        live.push(targetId);
        return Promise.resolve({ targetId });
      }
      if (method === "Target.closeTarget") {
        closed.push(String(params["targetId"]));
        live = live.filter((id) => id !== params["targetId"]);
        return Promise.resolve({ success: true });
      }
      if (method === "Target.getTargets") return Promise.resolve({ targetInfos: live.map((targetId) => ({ targetId, type: "page", url: "about:blank" })) });
      return Promise.resolve({});
    },
  };
  Object.assign(state, { browser, instance: "I", connect: async () => {} });
  return { state, created, closed, refuseAttach };
}

describe("ReadingTabs", () => {
  function scene(delay = 0.02) {
    const found = readerState();
    const visits: [string, string][] = [];
    const detaches = new Set<string>();
    let liveReads = 0;
    let peak = 0;
    const previous = { ...pages.readers };
    pages.readers.makePage = (_state, targetId) => {
      const page: Reader = {
        targetId,
        sessionId: `S${targetId}`,
        async attach() {
          if (found.refuseAttach.has(targetId)) throw new BrowseError("Target.attachToTarget: No target with given id found");
        },
        async keepAwake() {},
        async enableNetwork() {},
        detach() {
          page.sessionId = null;
        },
      };
      return page as unknown as Page;
    };
    pages.readers.readIn = async (page, url) => {
      liveReads += 1;
      peak = Math.max(peak, liveReads);
      visits.push([page.targetId, url]);
      try {
        await sleep(delay);
      } finally {
        liveReads -= 1;
      }
      if (detaches.has(page.targetId)) {
        page.sessionId = null;
        return { url, source: "browser", error: "detached" };
      }
      if (url.endsWith("/boom")) return { url, source: "browser", error: "couldn't load it: net::ERR_FAILED" };
      return { url, finalUrl: url, title: url.slice(url.lastIndexOf("/") + 1), text: `text of ${url}`, source: "browser" };
    };
    const restore = () => Object.assign(pages.readers, previous);
    const ctx = new Ctx(found.state, {}, "/", {}, null, "read");
    return { ...found, visits, detaches, ctx, restore, peak: () => peak };
  }

  test("test_at_most_four_tabs_reused_and_all_closed", async () => {
    const run = scene();
    try {
      const urls = [...Array.from({ length: 10 }, (_, n) => `http://s/p/${n}`), "http://s/boom"];
      const records = await pages.readTabs(run.ctx, urls, null, 5, {});
      expect(records.map((item) => item["url"])).toEqual(urls);
      expect(run.created.length).toBe(4);
      expect(run.peak()).toBeLessThanOrEqual(4);
      expect([...run.closed].sort()).toEqual([...run.created].sort());
      expect(records.at(-1)?.["error"]).toBe("couldn't load it: net::ERR_FAILED");
    } finally {
      run.restore();
    }
  });

  test("test_links_with_a_url_list_that_page_not_the_session_tab (plugins#74)", async () => {
    const run = scene();
    const listed: string[] = [];
    const previous = pages.readers.linksIn;
    pages.readers.linksIn = async (_page, listing) => {
      listed.push(listing);
      return listing.endsWith("/a") ? ["http://s/p/1", "http://s/about", "http://s/p/2"] : ["http://s/p/2", "http://s/p/3", "http://s/a"];
    };
    try {
      await expect(run.state.page()).rejects.toBeInstanceOf(BrowseError);
      const listing = await pages.run(run.ctx, { links: "/p/", list: true }, ["http://s/a", "http://s/b"]);
      expect(listed).toEqual(["http://s/a", "http://s/b"]);
      expect((listing.data as Record<string, unknown>)["links"]).toEqual(["http://s/p/1", "http://s/p/2", "http://s/p/3"]);
      expect(listing.text).toBe("http://s/p/1\nhttp://s/p/2\nhttp://s/p/3");
      expect([...run.closed].sort()).toEqual([...run.created].sort());
      run.visits.length = 0;
      const read = await pages.run(run.ctx, { links: "/p/" }, ["http://s/a"]);
      expect(run.visits.map(([, url]) => url)).toEqual(["http://s/p/1", "http://s/p/2"]);
      expect((read.data as Record<string, unknown>)["matched"]).toBe(2);
      pages.readers.linksIn = async () => ["http://s/about"];
      await expect(pages.run(run.ctx, { links: "/p/", list: true }, ["http://s/a"])).rejects.toMatchObject({ code: "no_links" });
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_links_from_urls_keep_other_listings_when_one_fails_and_skip_named_listings (plugins#74)", async () => {
    const run = scene();
    const previous = pages.readers.linksIn;
    const asked: boolean[] = [];
    pages.readers.linksIn = async (_page, listing, _pattern, _timeout, wanted) => {
      if (listing.endsWith("/down")) throw new BrowseError("couldn't load it: net::ERR_CONNECTION_REFUSED", null, "navigation_failed");
      const found = listing.endsWith("/catalog/a") ? ["http://s/catalog/b", "http://s/catalog/p1"] : ["http://s/catalog/a", "http://s/catalog/p2"];
      asked.push(wanted(["http://s/catalog/b"], listing));
      return found;
    };
    try {
      const listing = await pages.run(run.ctx, { links: "/catalog/", list: true }, ["http://s/catalog/a", "http://s/down", "http://s/catalog/b"]);
      expect((listing.data as Record<string, unknown>)["links"]).toEqual(["http://s/catalog/p1", "http://s/catalog/p2"]);
      expect(listing.failed).toBe(true);
      expect(listing.text).toContain("couldn't list the links on http://s/down: couldn't load it: net::ERR_CONNECTION_REFUSED");
      expect(asked).toEqual([false, false]);
      expect([...run.closed].sort()).toEqual([...run.created].sort());
      pages.readers.linksIn = async () => {
        throw new BrowseError("couldn't load it: net::ERR_NAME_NOT_RESOLVED", null, "navigation_failed");
      };
      await expect(pages.run(run.ctx, { links: "/p/", list: true }, ["http://s/x"])).rejects.toMatchObject({ code: "navigation_failed" });
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_links_from_urls_survive_a_reader_that_cannot_be_reopened_and_compare_serialized_urls (plugins#74)", async () => {
    const run = scene();
    const previous = pages.readers.linksIn;
    pages.readers.linksIn = async (page, listing) => {
      if (listing.endsWith("/b")) {
        page.sessionId = null;
        run.refuseAttach.add("R2");
        throw new BrowseError("Ardia detached the tab", null, "tab_detached");
      }
      return ["http://s/p/1", "http://s:80/a", "http://S/p/2#top"];
    };
    try {
      const listing = await pages.run(run.ctx, { links: "*", list: true }, ["http://S:80/a", "http://s/b", "http://s/c"]);
      expect((listing.data as Record<string, unknown>)["links"]).toEqual(["http://s/p/1", "http://S/p/2#top"]);
      expect(String(listing.text)).toContain("couldn't list the links on http://s/b");
      expect(String(listing.text)).toContain("couldn't list the links on http://s/c");
      expect([...run.closed].sort()).toEqual([...run.created].sort());
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_links_from_urls_keep_polling_past_links_already_picked_and_cap_list_at_twenty (plugins#74)", async () => {
    const run = scene();
    const previous = pages.readers.linksIn;
    const answers: boolean[] = [];
    pages.readers.linksIn = async (_page, listing, _pattern, _timeout, wanted) => {
      if (listing.endsWith("/b")) answers.push(wanted(["http://s/p/1"], "http://S:80/b"), wanted(["http://s/b", "http://s/p/2"], "http://S:80/b"));
      return listing.endsWith("/a") ? ["http://s/p/1"] : Array.from({ length: 26 }, (_, n) => `http://s/p/${n}`);
    };
    try {
      const listing = await pages.run(run.ctx, { links: "*", list: true }, ["http://s/a", "http://s/b"]);
      expect(answers).toEqual([false, true]);
      expect(((listing.data as Record<string, unknown>)["links"] as string[]).length).toBe(20);
      expect(((listing.data as Record<string, unknown>)["matched"])).toBe(26);
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_links_from_urls_retire_a_reader_whose_listing_failed (plugins#74)", async () => {
    const run = scene();
    const previous = pages.readers.linksIn;
    const readers: string[] = [];
    pages.readers.linksIn = async (page, listing) => {
      readers.push(page.targetId);
      if (listing.endsWith("/b")) throw new BrowseError("The site didn't answer Page.navigate", null, "timeout");
      return [`${listing}/item`];
    };
    try {
      const listing = await pages.run(run.ctx, { links: "/item", list: true }, ["http://s/a", "http://s/b", "http://s/c"]);
      expect((listing.data as Record<string, unknown>)["links"]).toEqual(["http://s/a/item", "http://s/c/item"]);
      expect(readers[0]).toBe(readers[1]);
      expect(readers[2]).not.toBe(readers[1]);
      expect([...run.closed].sort()).toEqual([...run.created].sort());
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_links_from_urls_name_failed_listings_in_the_saved_output (plugins#74 review)", async () => {
    const data = new Map<string, unknown>([
      ["pages", [new Map<string, unknown>([["url", "http://s/p/1"], ["title", "One"], ["text", "body"]])]],
      ["failedListings", [new Map<string, unknown>([["url", "http://s/down"], ["error", "couldn't load it: net::ERR_CONNECTION_REFUSED"]])]],
    ]);
    for (const path of ["out.txt", "out.json"]) {
      const [text, summary] = content("read", data as never, path);
      expect(summary).toContain("[couldn't list the links on http://s/down: couldn't load it: net::ERR_CONNECTION_REFUSED]");
      if (path.endsWith(".txt")) expect(text).toContain("couldn't list the links on http://s/down");
    }
  });

  test("test_links_from_urls_read_twenty_by_default_whatever_the_listing_count (plugins#74)", async () => {
    const run = scene();
    const previous = pages.readers.linksIn;
    pages.readers.linksIn = async () => Array.from({ length: 26 }, (_, n) => `http://s/p/${n}`);
    try {
      const listings = Array.from({ length: 25 }, (_, n) => `http://s/list/${n}`);
      run.visits.length = 0;
      await pages.run(run.ctx, { links: "/p/" }, listings);
      expect(run.visits.length).toBe(20);
      run.visits.length = 0;
      await pages.run(run.ctx, { links: "/p/", limit: "26" }, listings.slice(0, 1));
      expect(run.visits.length).toBe(26);
    } finally {
      pages.readers.linksIn = previous;
      run.restore();
    }
  });

  test("test_a_cancelled_read_still_closes_its_tabs", async () => {
    const run = scene(5);
    try {
      const stop = new AbortController();
      const reading = withSignal(stop.signal, () => pages.readTabs(run.ctx, Array.from({ length: 6 }, (_, n) => `http://s/p/${n}`), null, 5, {}));
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop.abort();
      await expect(reading).rejects.toBeInstanceOf(Cancelled);
      expect(run.created.length).toBe(4);
      expect([...run.closed].sort()).toEqual([...run.created].sort());
    } finally {
      run.restore();
    }
  });

  test("test_a_tab_that_fails_to_attach_is_still_closed", async () => {
    const run = scene();
    run.refuseAttach.add("R1");
    try {
      await expect(pages.readTabs(run.ctx, ["http://s/p/1"], null, 5, {})).rejects.toBeInstanceOf(BrowseError);
      expect(run.closed).toEqual(["R1"]);
    } finally {
      run.restore();
    }
  });

  test("test_a_page_whose_tab_ardia_detached_is_read_again_in_a_new_tab", async () => {
    const run = scene();
    run.detaches.add("R1");
    try {
      await begin({ argv: ["read"] }, async (metrics) => {
        const records = await pages.readTabs(run.ctx, ["http://s/p/1", "http://s/p/2"], null, 5, {});
        expect(records.map((item) => item["text"])).toEqual(["text of http://s/p/1", "text of http://s/p/2"]);
        expect(run.visits.filter(([target, url]) => target === "R1" && url === "http://s/p/1").length).toBe(1);
        expect([...run.closed].sort()).toEqual([...run.created].sort());
        expect(metrics.values.get("read_tabs_reopened")).toBe(1);
      });
    } finally {
      run.restore();
    }
  });

  test("test_a_tab_detached_twice_fails_that_page_only", async () => {
    const run = scene();
    run.detaches.add("R1");
    run.detaches.add("R2");
    try {
      const records = await pages.readTabs(run.ctx, ["http://s/p/1"], null, 5, {});
      expect(records[0]?.["error"]).toBe("detached");
      expect(run.created).toEqual(["R1", "R2"]);
      expect([...run.closed].sort()).toEqual(["R1", "R2"]);
    } finally {
      run.restore();
    }
  });

  test("test_one_url_uses_one_tab", async () => {
    const run = scene();
    try {
      await pages.readTabs(run.ctx, ["http://s/p/1"], null, 5, {});
      expect(run.created).toEqual(["R1"]);
    } finally {
      run.restore();
    }
  });

  test("test_a_failed_page_makes_the_command_fail_but_keeps_the_others", async () => {
    const run = scene();
    try {
      const records = await pages.readTabs(run.ctx, ["http://s/p/1", "http://s/boom"], null, 5, {});
      const result = pages.resultFor(records, {}, {});
      expect(result.failed).toBe(true);
      expect(result.text).toContain("text of http://s/p/1");
      expect(renderAnswer({}, result)[0]).toBe(1);
    } finally {
      run.restore();
    }
  });
});
