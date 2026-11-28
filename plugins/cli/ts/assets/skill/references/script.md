# `ardia repl` & `ardia browse script` Reference

`ardia repl` runs JavaScript in a persistent, sandboxed QuickJS runner attached to the running Ardia browser. Top-level variables, helper functions, and tab handles persist across calls in the same session, and large return values or logs spill to `$out1`, `$out2`, ... so you can filter them in the next call without re-fetching.

## Invocation

```sh
ardia repl <<'EOF'
const p = await openTab('https://example.com');
return { url: p.url(), title: await p.title() };
EOF
```

- Inline: `ardia repl 'return await page.title()'` or `ardia repl -e 'return await page.title()'`
- File: `ardia repl -f task.js` or `ardia repl task.js`
- Auto-cleanup: `ardia repl --close <<'EOF' ... EOF` closes every tab opened during that call when it finishes (even on error).
- Reset scope: `ardia repl --reset` clears persistent REPL variables (keeps `state`).
- Save large output: `ardia repl --out rows.json <<'EOF' ... EOF` (`.csv` writes a table).
- Timeout: `ardia repl --timeout 3m` (default 90s, max 10m).
- Non-persistent one-shot: `ardia browse script <<'EOF' ... EOF` runs in a fresh scope without persisting variables.

## Tabs & Parallel Execution

Every tab handle returned by `openTab`, `openTabs`, `withTab`, `withTabs`, `attachTab`, `attachActiveTab`, or `getTabByTargetId` is **target-bound**: calling methods on `p1` and `p2` under `Promise.all` runs them concurrently without switching active tabs or clobbering refs.

```sh
ardia repl --close <<'EOF'
return await withTabs([
  'https://example.com/a',
  'https://example.com/b',
  'https://example.com/c',
], async (pages) => Promise.all(pages.map(async (p) => ({
  url: p.url(),
  title: await p.title(),
  heading: await p.locator('h1').first().text(),
}))));
EOF
```

- `openTab(url?, { label?, background? })` -> target-bound `Page` handle (`owned: true`).
- `openTabs(urls, opts?)` -> opens all URLs in parallel background tabs and returns `Page[]`.
- `withTab(url, async (p) => ..., opts?)` -> opens one tab, runs callback, closes tab in `finally`.
- `withTabs(urls, async (pages) => ..., opts?)` -> opens tabs in parallel, runs callback, closes all in `finally`.
- `closeTab(p?)` -> closes an owned tab or cleanly detaches a borrowed user tab (never throws if already closed).
- `closeTabs(list?)` / `closeAllTabs()` -> closes listed tabs or all session-managed tabs in parallel.
- `attachActiveTab()` -> returns a target-bound `Page` for the user's currently active tab (`owned: false`).
- `attachTab(idOrUrlOrTitle)` -> attaches to an existing browser tab by `tabId`, `targetId`, `label`, URL, or title.
- `getTabByTargetId(targetId)` -> returns the target-bound `Page` for that target ID.
- `listTabs()` / `listBrowserTabs()` -> lists all open browser tabs.
- `tabs` -> array of active `Page` handles opened or attached in this REPL session.
- `page` -> default session tab (auto-adopts active tab on first REPL use if no tab is open yet).

## Snapshots & Screenshots

`snapshot(pageOrOpts?, opts?)` captures an accessibility tree with `@eN` refs and automatically computes a compact line diff against the previous snapshot of that same tab and options:

```js
const s1 = await snapshot(p, { interactive: true });
console.log(s1.text);
await p.getByRole('button', { name: 'Load more' }).click();
const s2 = await snapshot(p, { interactive: true });
console.log(s2.text);
```

- Returns `{ tree, diff, text }` (`text` is `diff` when shorter than the full tree, otherwise `tree`; printing or returning the object emits only `text`).
- Pass `{ diff: false }` to always return the full tree.
- Options: `interactive` (`-i`), `compact` (`-c`), `depth` (`-d`), `selector` (`-s`), `urls` (`-u`), `all` (`--all`).
- `annotatedScreenshot(p?, opts?)` takes an annotated screenshot with numbered ref overlays and returns `{ path, ... }`.
- `display(shot)` attaches a screenshot result inline when supported.

## Locators (Playwright-Compatible)

Every `Page` (`p` or `page`) provides lazy, chainable locators scoped to that tab:

- `p.locator(selector, { hasText?, hasNotText?, has?, nth? })`
- `p.getByRole(role, { name?, exact?, within?, nth? })`
- `p.getByLabel(textOrRegex, { exact? })`
- `p.getByText(textOrRegex, { exact? })`
- `p.getByPlaceholder(textOrRegex, { exact? })`
- `p.getByTestId(id)`
- `p.getByAltText(textOrRegex, { exact? })`
- `p.getByTitle(textOrRegex, { exact? })`

Locator chaining & actions:
- Chaining: `.locator(sub)`, `.filter({ hasText, hasNotText, has })`, `.first()`, `.last()`, `.nth(i)` (supports `-1`), `.getByRole(...)`, `.getByText(...)`, `.getByLabel(...)`.
- Actions: `.click(opts?)`, `.dblclick(opts?)`, `.fill(val)`, `.clear()`, `.type(val)`, `.pressSequentially(val)`, `.press(key)`, `.selectOption(...vals)`, `.check()`, `.uncheck()`, `.setChecked(bool)`, `.hover()`, `.focus()`, `.dragTo(target)`, `.editCell(val)`, `.setInputFiles(files)`, `.scrollIntoViewIfNeeded()`.
- Reads: `.text()` / `.innerText()` / `.textContent()`, `.allTexts()` / `.allInnerTexts()` (single CDP round-trip), `.innerHTML()`, `.inputValue()`, `.getAttribute(name)`, `.boundingBox()`, `.count()`, `.isVisible()`, `.isHidden()`, `.isChecked()`, `.isEnabled()`, `.isDisabled()`, `.isEditable()`, `.evaluate(fn, ...args)`, `.evaluateAll(fn, ...args)`, `.screenshot(opts?)`, `.waitFor({ state?, timeout? })`, `.all()`.

## High-Level Structured Extractors

Prefer these over manual DOM scraping when they fit:

- `p.read(opts?)`: clean main content with nav chrome folded (`{ selector, nav, raw, outline, filter, limit, scroll, full, data }`).
- `p.form(opts?)`: returns `{ text, fields, submits, count, url }` for all fields and submit buttons.
- `p.query(sel, { fields?, limit?, all? })`: extracts matching cards/rows or HTML tables directly into JS objects.
- `p.fetch(url, { method?, headers?, body? })`: runs `fetch()` inside the page with browser cookies and parses `.json` automatically.
- `readUrls(urls, { selector?, concurrency?, maxChars? })`: fetches multiple same-site URLs in parallel using the tab's cookies without opening tabs.
- `read(urls | { links, selector, limit, http })`: reads multiple pages in parallel background tabs.

## Page Methods & DOM Evaluation

- Navigation: `p.goto(url)`, `p.back()` / `p.goBack()`, `p.forward()` / `p.goForward()`, `p.reload()`, `p.url()` (synchronous on tab handles), `p.title()`, `p.content()`.
- Waiting: `p.wait(ms | sel | { text, url, load, fn, state, timeout })`, `p.waitForSelector(sel, opts?)`, `p.waitForURL(glob, opts?)`, `p.waitForLoadState(state?, opts?)`, `p.waitForFunction(fn, arg?, opts?)`, `p.waitForTimeout(ms)`, `sleep(ms)`.
- Input: `p.click(sel)`, `p.fill(sel, val)`, `p.fillForm({ sel: val })`, `p.select(sel, val)`, `p.press(key)`, `p.keyboard.type(text)`, `p.keyboard.press(key)`, `p.keyboard.down(key)`, `p.keyboard.up(key)`, `p.mouse.click(x, y)`, `p.mouse.wheel(dx, dy)`, `p.scroll(dir, px)`, `p.setInputFiles(sel, files)`.
- DOM evaluation (runs in the page's main world; pass script variables as trailing JSON arguments):

```js
const min = 100;
const matches = await p.$$eval('tr', (rows, min) =>
  rows.map((r) => ({ name: r.cells[0]?.textContent?.trim(), val: Number(r.cells[1]?.textContent) }))
      .filter((r) => r.val > min), min);
```

- Frames: `const frame = (await p.frames()).find((f) => f.url.includes('/embed/')); await frame.$$eval('li', ...);`
- Receipts & assertions: pass `{ receipt: true }` to an action (or use `p.act.click(sel)`) to inspect URL/title/DOM changes, and `await p.assertText('Saved', { timeout: 3000 })`.
- Persistence: top-level `const`/`let`/`var`/`function` bindings survive across `ardia repl` calls; `state` survives even timeouts and `--reset`.
- Raw fallback: `browse('network', 'requests')` runs any `ardia browse` command and returns `{ text, data }`.
