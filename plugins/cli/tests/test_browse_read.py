import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import browse_driver
from ardia_cli import command_metrics
from ardia_cli.browse import commands, daemon, readpages
from ardia_cli.browse.errors import Usage

CLI = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "browse"
CHROME = os.environ.get("ARDIA_BROWSE_CHROME")


def record(index: int, length: int) -> dict:
    return {"url": f"http://x.test/{index}", "finalUrl": f"http://x.test/{index}", "title": f"Page {index}",
            "text": "\n".join(f"line {index}.{n} " + "x" * 60 for n in range(length // 70))}


class PagesCap(unittest.TestCase):
    def test_cap_grows_with_pages_between_floor_and_ceiling(self):
        self.assertEqual(readpages.pages_cap(1), daemon.OUTPUT_CAP)
        self.assertEqual(readpages.pages_cap(2), daemon.OUTPUT_CAP)
        self.assertEqual(readpages.pages_cap(4), 24000)
        self.assertEqual(readpages.pages_cap(30), readpages.PAGES_CAP_CEILING)

    def test_twelve_pages_fit_whole_under_the_scaled_cap(self):
        records = [record(index, 1000) for index in range(12)]
        result = readpages.result_for(records, {}, {})
        self.assertNotIn("pages cut to fit", result.text)
        self.assertGreater(len(result.text), daemon.OUTPUT_CAP)
        _, out, err = daemon.render({}, result=result, name="read")
        self.assertEqual(out, result.text + "\n")
        self.assertEqual(err, "")

    def test_too_many_pages_are_cut_and_the_footer_reaches_stderr(self):
        records = [record(index, 5000) for index in range(10)]
        result = readpages.result_for(records, {}, {})
        self.assertLessEqual(len(result.text), readpages.PAGES_CAP_CEILING)
        self.assertIn("pages cut to fit 36,000 characters", result.notice)
        _, out, err = daemon.render({}, result=result, name="read")
        self.assertTrue(err.startswith("[pages cut to fit 36,000 characters"))
        self.assertNotIn("[pages cut to fit", out)

    def test_max_output_still_wins_over_the_page_budget(self):
        records = [record(index, 1000) for index in range(12)]
        result = readpages.result_for(records, {}, {"max_output": 3000})
        self.assertLessEqual(len(result.text), 3000)


class CapNotice(unittest.TestCase):
    def test_capped_output_prints_its_notice_once_on_stderr(self):
        text = "\n".join(f"- row {n}" for n in range(2000))
        _, out, err = daemon.render({}, result=commands.Result({}, text), name="snapshot")
        self.assertTrue(err.startswith("[output capped at "))
        self.assertEqual(err.count("\n"), 1)
        self.assertNotIn("[output capped at ", out)
        self.assertTrue(out.rstrip("\n").endswith("- row " + out.rstrip("\n").rpartition("- row ")[2]))

    def test_uncapped_output_has_nothing_on_stderr(self):
        self.assertEqual(daemon.render({}, result=commands.Result({}, "short"), name="snapshot")[2], "")
        self.assertEqual(daemon.render({"full": True}, result=commands.Result({}, "x\n" * 5000), name="snapshot")[2], "")

    def test_script_gets_its_own_narrowing_hint(self):
        text = "\n".join(f"{{\"row\": {n}}}" for n in range(2000))
        _, _, err = daemon.render({}, result=commands.Result({}, text), name="script")
        self.assertIn("Narrow it: return fewer fields or rows from the script;", err)

    def test_read_fields_survive_the_telemetry_filter(self):
        values = {"read_rows": 200, "read_pages": 12, "read_scrolled": True, "read_matched": True, "read_virtualized_grid": True, "read_text": "x"}
        self.assertEqual(command_metrics.clean(values), {key: value for key, value in values.items() if key != "read_text"})

    def test_hidden_navigation_counts_survive_the_telemetry_filter(self):
        values = {"read_nav_hidden": 3, "read_nav_chars_hidden": 2400}
        self.assertEqual(command_metrics.clean(values), values)

    def test_hidden_navigation_adds_up_across_pages(self):
        metrics = command_metrics.Metrics("read", False, True)
        token = command_metrics.current.set(metrics)
        try:
            readpages.note_nav({"navSections": 2, "navChars": 900})
            readpages.note_nav({"navSections": 0, "navChars": 0})
            readpages.note_nav({"navSections": 1, "navChars": 300})
        finally:
            command_metrics.current.reset(token)
        self.assertEqual((metrics.values["read_nav_hidden"], metrics.values["read_nav_chars_hidden"]), (3, 1200))

    def test_output_truncated_counts_read_footers(self):
        self.assertTrue(any(marker in "x\n[pages cut to fit 6,000 characters. Narrow it: …" for marker in command_metrics.OUTPUT_MARKERS))
        self.assertTrue(any(marker in "x\n[+3 pages not shown. Narrow it: …" for marker in command_metrics.OUTPUT_MARKERS))


class ScrollRows(unittest.TestCase):
    def test_virtual_rows_are_kept_once_by_index_and_ordered(self):
        collector = readpages.RowCollector()
        collector.absorb({"rows": [{"text": "b", "index": 2, "id": "", "offset": 40}, {"text": "a", "index": 1, "id": "", "offset": 0}]})
        added = collector.absorb({"rows": [{"text": "b", "index": 2, "id": "", "offset": 40}, {"text": "c", "index": 3, "id": "", "offset": 80}]})
        self.assertEqual(added, 1)
        self.assertEqual([row["text"] for row in collector.ordered()], ["a", "b", "c"])

    def test_rows_without_an_index_dedupe_by_offset_and_text(self):
        collector = readpages.RowCollector()
        same = {"text": "Weekly digest", "index": None, "id": "", "offset": 400}
        twin = {"text": "Weekly digest", "index": None, "id": "", "offset": 680}
        collector.absorb({"rows": [same, twin, dict(same)]})
        self.assertEqual(len(collector.rows), 2)

    def test_match_ignores_case(self):
        rows = [{"text": "Receipt from STAPLES"}, {"text": "Weekly digest"}]
        self.assertEqual(readpages.matching(rows, "staples"), rows[:1])
        self.assertEqual(readpages.matching(rows, None), rows)

    def test_summary_names_why_it_stopped(self):
        self.assertEqual(readpages.scroll_summary(200, 2, "staples", "end", 1000, 3.1),
                         '[2 of 200 rows match "staples"; scrolled to the end of the list]')
        self.assertIn("--limit 50", readpages.scroll_summary(50, 50, None, "limit", 50, 1))
        self.assertIn("--timeout", readpages.scroll_summary(900, 900, None, "time", 1000, 30))
        self.assertTrue(readpages.scroll_summary(12, 12, None, "end", 1000, 1, "t3").endswith("ardia browse tab t3 --show, then read again]"))
        self.assertNotIn("hidden", readpages.scroll_summary(12, 12, None, "limit", 12, 1, "t3"))

    def test_limits(self):
        self.assertEqual(readpages.parse_rows(None), readpages.SCROLL_ROWS_DEFAULT)
        self.assertEqual(readpages.parse_rows(None, True), readpages.SCROLL_ROWS_MAX)
        self.assertEqual(readpages.parse_rows("300"), 300)
        for bad in ("0", "abc", str(readpages.SCROLL_ROWS_MAX + 1)):
            with self.assertRaises(Usage):
                readpages.parse_rows(bad)

    def test_scroll_flags_need_one_list_on_the_tab(self):
        cases = [({"scroll": True, "selector": "ul"}, ["http://x.test/"]),
                 ({"scroll": True, "selector": "ul", "http": True}, []), ({"match": "x", "selector": "ul"}, [])]
        for options, positional in cases:
            with self.subTest(options=options), self.assertRaises(Usage):
                asyncio.run(readpages.run_scroll(None, options, positional))

    def test_flags_parse(self):
        options, args = commands.parse(["-s", "@e8", "--scroll", "--limit", "50", "--match", "receipt"], readpages.flags(), readpages.ALIASES)
        self.assertEqual((options["selector"], options["scroll"], options["limit"], options["match"], args), ("@e8", True, "50", "receipt", []))
        self.assertTrue(readpages.scrolls(options))


def wait_for(check, seconds: float, what: str):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def answers(url: str) -> bool:
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status == 200


@unittest.skipUnless(CHROME and Path(CHROME).exists(), "set ARDIA_BROWSE_CHROME to a Chrome binary to read real lists")
class ReadListsInChrome(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = Path(tempfile.mkdtemp(prefix="ardia-read-"))
        cls.data = cls.scratch / "cli-data"
        cls.data.mkdir()
        cls.http_port, cls.port = browse_driver.free_port(), browse_driver.free_port()
        browse_driver.begin_class(f"http://127.0.0.1:{cls.http_port}")
        cls.server = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(cls.http_port), "--bind", "127.0.0.1"], cwd=FIXTURES,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={cls.port}", f"--user-data-dir={cls.scratch / 'profile'}",
                                       "--no-first-run", "--window-size=1200,800", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(lambda: answers(f"http://127.0.0.1:{cls.port}/json/version"), 30, "Chrome's DevTools port")
            wait_for(lambda: answers(f"http://127.0.0.1:{cls.http_port}/virtual-lists.html"), 10, "the fixture server")
            cls.browse("open", f"http://127.0.0.1:{cls.http_port}/virtual-lists.html", "--show")
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browse("close", check=False)
        finally:
            for process in (cls.chrome, cls.server):
                process.terminate()
                process.wait(10)
            shutil.rmtree(cls.scratch, ignore_errors=True)

    @classmethod
    def browse(cls, *args, check=True):
        return browse_driver.browse(args, endpoint=["--port", str(cls.port)], data_dir=cls.data, session="read", check=check)

    def setUp(self):
        browse_driver.begin(self.id())

    def tearDown(self):
        browse_driver.end()

    def test_grid_reads_as_rows_with_the_virtualized_note(self):
        lines = self.browse("read", "-s", "[role=grid]").stdout.splitlines()
        self.assertEqual(lines[0], "Row | SKU | Item | Qty")
        self.assertEqual(lines[1], "1 | SKU-1000 | Washer | 0")
        self.assertRegex(lines[-1], r"^\(\d+ of 501 rows rendered; the grid is virtualized")

    def test_scroll_reads_a_lazy_virtual_list_once_in_order(self):
        out = self.browse("read", "-s", "[role=listbox]", "--scroll", "--max-output", "0").stdout.splitlines()
        self.assertEqual(out[-1], "[120 rows; scrolled to the end of the list]")
        rows = out[:-1]
        self.assertEqual(len(rows), 120)
        self.assertEqual(rows[0], "Sender 0 · Message 1")
        self.assertEqual(rows[119], "Sender 0 · Message 120")
        self.assertEqual(rows.count("Sender 0 · Weekly digest"), 2)
        self.assertEqual(self.browse("eval", "document.getElementById('mail').scrollTop").stdout.strip(), "0")

    def test_scroll_match_and_limit(self):
        out = self.browse("read", "-s", "[role=listbox]", "--scroll", "--match", "STAPLES").stdout.splitlines()
        self.assertEqual(out, ["Sender 1 · Receipt from Staples #37", "Sender 3 · Receipt from Staples #74",
                               "Sender 5 · Receipt from Staples #111", '[3 of 120 rows match "STAPLES"; scrolled to the end of the list]'])
        grid = self.browse("read", "-s", "[role=grid]", "--scroll", "--match", "hex bolt").stdout.splitlines()
        self.assertEqual(grid, ["322 | SKU-1321 | Hex bolt | 963", '[1 of 501 rows match "hex bolt"; scrolled to the end of the list]'])
        limited = self.browse("read", "-s", "[role=grid]", "--scroll", "--limit", "40").stdout.splitlines()
        self.assertEqual(len(limited), 41)
        self.assertIn("stopped at --limit 40", limited[-1])


@unittest.skipUnless(CHROME and Path(CHROME).exists(), "set ARDIA_BROWSE_CHROME to a Chrome binary to read real menus")
class ReadNavigationInChrome(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = Path(tempfile.mkdtemp(prefix="ardia-read-nav-"))
        cls.data = cls.scratch / "cli-data"
        cls.data.mkdir()
        cls.http_port, cls.port = browse_driver.free_port(), browse_driver.free_port()
        browse_driver.begin_class(f"http://127.0.0.1:{cls.http_port}")
        cls.server = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(cls.http_port), "--bind", "127.0.0.1"], cwd=FIXTURES,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={cls.port}", f"--user-data-dir={cls.scratch / 'profile'}",
                                       "--no-first-run", "--window-size=1200,800", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(lambda: answers(f"http://127.0.0.1:{cls.port}/json/version"), 30, "Chrome's DevTools port")
            wait_for(lambda: answers(f"http://127.0.0.1:{cls.http_port}/nav-megamenu.html"), 10, "the fixture server")
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browse("close", check=False)
        finally:
            for process in (cls.chrome, cls.server):
                process.terminate()
                process.wait(10)
            shutil.rmtree(cls.scratch, ignore_errors=True)

    @classmethod
    def browse(cls, *args, check=True):
        return browse_driver.browse(args, endpoint=["--port", str(cls.port)], data_dir=cls.data, session="nav", check=check)

    def setUp(self):
        browse_driver.begin(self.id())

    def tearDown(self):
        browse_driver.end()

    def url(self, name):
        return f"http://127.0.0.1:{self.http_port}/{name}"

    def test_a_mega_menu_and_a_link_footer_read_as_one_line_each(self):
        out = self.browse("open", self.url("nav-megamenu.html"), "--read").stdout
        self.assertIn("[navigation hidden, 15 links, a search box: Search · Dinners · Meals · Ingredients · Occasions …; read --nav shows it]", out)
        self.assertNotIn("Kitchen Tips", out)
        self.assertNotIn("idea", out)
        self.assertIn("[navigation: not the main content]\nLog in Join\n[end of navigation]", out)
        self.assertIn("[footer hidden, 24 links: Company link 0 · Company link 1 · Company link 2 …]", out)
        self.assertNotIn("Legal link 7", out)
        self.assertNotIn("© 2026", out)
        for kept in ("- Home\n- Desserts\n- Cookies", "# Best Chocolate Chip Cookies", "Rated 4.6 from 19,342 ratings.", "Ingredients Directions Nutrition Reviews",
                     "- 2 cups semisweet chocolate chips", "1 2 3 Next"):
            self.assertIn(kept, out)

    def test_nav_prints_every_menu(self):
        self.browse("open", self.url("nav-megamenu.html"))
        out = self.browse("read", "--nav").stdout
        self.assertNotIn("hidden,", out)
        for shown in ("- Kitchen Tips", "- Sweepstakes", "Legal link 7", "© 2026 Mega Recipes", "# Best Chocolate Chip Cookies"):
            self.assertIn(shown, out)
        self.assertNotIn("idea", out)

    def test_read_of_a_url_reads_main_unless_nav_asks_for_the_whole_page(self):
        main = self.browse("read", self.url("nav-megamenu.html")).stdout
        self.assertIn("# Best Chocolate Chip Cookies", main)
        self.assertNotIn("Dinners", main)
        self.assertNotIn("hidden,", main)
        whole = self.browse("read", self.url("nav-megamenu.html"), "--nav").stdout
        self.assertIn("- Dinners", whole)
        self.assertIn("Legal link 7", whole)

    def test_a_scoped_read_keeps_the_menu_it_was_pointed_at(self):
        self.browse("open", self.url("nav-megamenu.html"))
        out = self.browse("read", "-s", "header").stdout
        self.assertIn("- Kitchen Tips", out)
        self.assertNotIn("hidden,", out)

    def test_docs_keep_their_page_contents_and_hide_the_site_tree(self):
        out = self.browse("open", self.url("nav-docs.html"), "--read").stdout
        self.assertIn("[navigation: not the main content]\nHome Docs\n[end of navigation]", out)
        self.assertIn("[navigation hidden, 30 links: Guide page 0 · Guide page 1 · Guide page 2 · Guide page 3 …; read --nav shows it]", out)
        self.assertNotIn("Guide page 29", out)
        self.assertIn("Install Configure Upgrade FAQ", out)
        self.assertIn("Open widget.toml and set the port to 8080 before the first start.", out)

    def test_filters_and_numbered_pages_stay(self):
        out = self.browse("open", self.url("nav-facets.html"), "--read").stdout
        self.assertIn("[navigation hidden, 14 links: Models · Datasets · Spaces · Docs · Pricing · Log In …; read --nav shows it]", out)
        self.assertIn("Clear all\napache-2.0\nmit\ncc-by-sa-4.0\ngpl-3.0\nbsd-3-clause", out)
        self.assertIn("replit/replit-code-v1-3b 748 likes", out)
        self.assertIn("Previous 1 2 3 Next", out)

    def test_a_page_that_is_mostly_navigation_prints_it(self):
        out = self.browse("open", self.url("nav-sitemap.html"), "--read").stdout
        self.assertIn("- Section number 19", out)
        self.assertNotIn("hidden,", out)

    def test_menus_that_hold_content_or_controls_stay(self):
        out = self.browse("open", self.url("nav-tricky.html"), "--read").stdout
        for kept in ("# Wrapped article", "must stay.", "Shadow item 9", "Framed item 9", "Framed copy.", "TVs", "Screen size", "Shop item 11",
                     "Site item 11", "Go to next page of results", "[Related products: not the main content]\nKettle Toaster"):
            self.assertIn(kept, out)
        self.assertIn("[navigation hidden, 12 links: Brand item 0", out)
        self.assertNotIn("Brand item 11", out)
