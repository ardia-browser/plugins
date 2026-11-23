# `ardia browse script` recipes

A script is one call that does what would otherwise be a command per item. It runs in a sandbox of its own,
outside the page it drives: there's no `document`, `window`, files, modules or network. Every `page.*` call is an
`ardia browse` command on this session, with the same tab, refs and rules. `ardia browse script --help` lists every
call. Selectors are CSS, `@eN`, `text=…` or `xpath=…`.

DOM code goes in `page.evaluate(fn, ...args)` (or `page.eval`), which runs `fn` in the page like `ardia browse eval`.
`fn` can't see the script's variables; pass what it needs as arguments (JSON values):

```js
const min = 100, column = 2;
return await page.evaluate((min, column) => [...document.querySelectorAll('tr')]
  .filter((row) => Number(row.cells[column]?.textContent) > min).map((row) => row.cells[0].textContent), min, column);
```

`page.$$eval(sel, fn, ...args)` hands `fn` every match, `page.$eval(sel, fn, ...args)` the first one. Reads (`page.text`,
`page.attr`, `page.evaluate`, `page.$eval`, `page.$$eval`, `read`) run together under `Promise.all`; actions run one at a
time, in order. `page.click/fill/select/press/…` wait for the page to settle but print no change report; add
`{ receipt: true }` as the last argument when you need it.

## Every row of a list in one call

```sh
ardia browse script <<'EOF'
return await page.$$eval('article', (cards) => cards.map((c) => ({
  name: c.querySelector('h4')?.textContent.trim(),
  link: c.querySelector('a')?.href,
})));
EOF
```

## One filter after another

```sh
ardia browse script <<'EOF'
const out = {};
for (const tag of ['Text Generation', 'Text-to-Image', 'Translation']) {
  await page.click(`button[data-filter="${tag}"]`);
  out[tag] = await page.$$eval('article:not(.hidden) h4', (hs) => hs.map((h) => h.textContent.trim()));
}
return out;
EOF
```

## Many small reads at once

```sh
ardia browse script <<'EOF'
const n = await page.count('tr.result');
return await Promise.all(Array.from({ length: n }, (_, i) =>
  page.text(`tr.result >> nth=${i}`)));
EOF
```

## Inside an iframe

`page.frames()` lists frames (`url`, `name`, `main`, `crossProcess`); each has `evaluate`, `$eval` and `$$eval`:

```js
const frame = (await page.frames()).find((f) => f.url.includes('/embed/'));
return await frame.$$eval('li', (items) => items.map((li) => li.textContent));
```

Return only the fields you need: the return value prints as JSON and counts toward the output cap. It stops at
`--timeout` (default 90s, at most 10m) and after any command whose outcome is unknown. A failed command throws
(`err.code`, `err.message`); uncaught, the script stops and names the line.

## Read every linked page

`read` alone is enough when you only need text:

```sh
ardia browse read --links /docs/ -s main
```

In a script, `read` returns `[{url, title, text, error}]` to filter before printing:

```sh
ardia browse script <<'EOF'
const pages = await read({ links: '/p/', selector: 'table.specs' });
return pages.filter(p => /100 W/.test(p.text)).map(p => ({ url: p.url, title: p.title }));
EOF
```

## Open each item in a list and read it

```sh
ardia browse script <<'EOF'
const out = [];
const count = await page.count('[role=listitem]');
for (let i = 0; i < count; i++) {
  await page.click(`[role=listitem] >> nth=${i}`);
  out.push(await page.text('main'));
}
return out;
EOF
```

## Scroll a list until it stops growing

```sh
ardia browse script <<'EOF'
let seen = -1;
while (seen !== await page.count('[role=option]')) {
  seen = await page.count('[role=option]');
  await page.scroll('down', 800);
  await sleep(300);
}
return await page.text('[role=listbox]');
EOF
```

## Act on every card, keep going past failures

```sh
ardia browse script <<'EOF'
const done = [], failed = [];
for (const name of ['Login bug', 'Offline queue', 'Dark mode']) {
  try {
    await page.click(`[aria-label="Actions for ${name}"]`);
    await page.click('text=Archive');
    done.push(name);
  } catch (err) {
    failed.push({ name, why: err.message });
  }
}
return { done, failed };
EOF
```

## Long jobs: keep what you gathered in `state`

`state` is one object per session that every script starts with and keeps after it ends, even when it times out.
Push rows there as you go, and pick up where you stopped in the next script:

```sh
ardia browse script --timeout 5m --out rows.json <<'EOF'
state.rows ??= [];
state.next ??= 1;
for (; state.next <= 119; state.next++) {
  await page.goto(`https://example.com/results?page=${state.next}`);
  state.rows.push(...await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.innerText)));
}
return state.rows;
EOF
```

## Many records: the site's public API

Before editing dozens of records, look for the site's documented public API and `curl` it with a key the site
shows you; internal `/api` calls don't count (script the UI). Creating a key changes the account: ask first.

## Anything else

`browse('tab', 'list')` runs any other command and returns `{text, data}`. `page.snapshot('-i -s main')` returns a
snapshot to search for refs. `page.wait({ text: 'Saved' })` waits for text, a URL, a load state or a function.
`page.dblclick(sel)`, `page.focus(sel)` and `page.keyboard(text)` (`.press(key)`) cover cells and fields that only
take typing. There are no element handles or locators: read with `$$eval`, act with a selector.
