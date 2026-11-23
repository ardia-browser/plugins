# When `ardia browse` doesn't do what you expected

`ardia browse` takes agent-browser's commands, flags and output (text and `--json`), on the user's running Ardia.
These are the places it differs, and what to do when something goes wrong.

- Input that didn't land
- Background tabs
- Refs
- Custom inputs, covered elements, drag
- Refused commands
- Tabs and sessions
- The page's own world, console and errors
- Output cap
- Auth vault
- Exit status

## Input that didn't land

A click, key press, typing or scroll the page never received fails with `input_not_delivered` (`target_replaced` when
the page redrew the element first: find it again); one it only partly
received reports an unknown outcome. Check the page before retrying, and never repeat a submit blindly. Input is
instant; `--humanize` (or `AGENT_BROWSER_HUMANIZE=1`) gives curved mouse paths, human press timing, wheel scrolling
and per-character typing.

## Background tabs

A session starts with no tab and never takes the user's: until `open <url>` (a background tab of its own) or
`tab active` / `tab <id>`, commands that need a page fail with `no_session_tab`. `open` never navigates the user's
tab unless you picked it with `tab <id>`; `tab active` works in it and `open` then moves to a tab of your own. Later
`open`s navigate the session's own tab. A newer Ardia keeps the tab the CLI is attached to
live, so input works without switching the user's view. On one that doesn't, `open` says so, and `click`, `fill`,
`type`, `press`, `hover`, `drag` and `mouse` fail with the fix: `ardia browse tab t2 --show` (or
`open <url> --show`), which switches Ardia's window to the tab. Snapshots, `read`, `get`, `is`, `find … text`,
`eval`, screenshots, `scroll` and `wait` work in the background either way.

## Refs

A ref points only at the element it was issued for. When that element is gone (a navigation, a new document, a
redraw, an Ardia restart), the command fails with `stale_ref`: ``Stale ref @e4: … Run `ardia browse snapshot -i` again and use the new
refs``, or, when the same element came back under a new ref, `… is now @e19 … use that ref`. An element
keeps its number across snapshots of the same page, and a number never moves to another element. Long runs of one role fold into one line in change reports
(`+ 48 options in combobox "Start time" (…; e8…e55)`); the refs in it work.

In a `batch`, a line can carry its own flags (`--no-changes`), and a last line `close` closes your tabs once every
line succeeded. On `stale_ref`, take a new snapshot (or use the ref the error names) and rerun from that line.

## Custom inputs, covered elements, drag

- `covered by <…>`: act on the covering element first (close the dialog or editor), then retry. Click already dismisses cookie banners and scrolls past sticky headers by itself.
- A field that ignores `fill`: `focus @e1`, then `keyboard inserttext "text"` (or `keyboard type` for keystrokes).
- A typeahead or chip input: `select`, not `fill`; it types each value and clicks the match
  (`select @e5 "Priya Raman" alex@example.com`). When it lists two or no suggestions, pick an exact one.
- `find role` with several matches clicks nothing and lists them with refs; use the ref you mean.
- When `select` says no list is linked to the field, click the option: `find role option click --name "…"`.
- Selectors take CSS, `@e3`, `text=Save`, `role=button[name="Save"]` and `li:has-text("Ana")`; `[role=main]` also
  matches `<main>`.
- `drag @src @dst` drops on the target's far half, so the source takes its place; `--before` or `--after` picks the
  side. In a sortable list the answer names the new position (`moved to 5 of 5`). From a `draggable` source it does
  HTML5 drag and drop (the answer says `HTML5 drag and drop`, `the target didn't accept the drop`, or `plain mouse
  drag`). When the answer has no position, check with `read -s <list>`.

## Refused commands

These need Ardia 0.2.49 or later: cookies, `state save` (and `state load` of a file with cookies),
`set device|geo|offline|headers|credentials|media|permission`, `network route`, `upload`, `download` and
`wait --download`, `highlight`, `clipboard`, `trace`, `profiler`, `record` and `stream enable`. From 0.2.49 the
ardia command is a full DevTools client of Ardia, so they work, and so does any method through `cdp`. An older
Ardia keeps the command to a short list of methods: there they fail with exit 1 and `code: "policy_refused"`, name
the method, say to update Ardia and what to do until then (ask the user to attach the file or download it,
`screenshot` instead of `record`, `storage local|session` or `eval` instead of cookies and `state`). Ask the user to
update Ardia rather than retrying. `set viewport <w> <h>` works on a tab this session
opened and never showed: it goes off-screen, and `--show` or `set viewport reset` reloads it at its own size. A refusal that says
"which this Ardia allows for the ardia command, but not …" comes from an older Ardia and is about the tab or address,
not the command: it gives the reason (`data.reason`) and, for a tab, what Ardia has there; 0.2.49 or later has no
such limit. Pick another tab or `open` a web page. Not here at all: `connect`, `install`, `upgrade`, `doctor`, `dashboard`, `chat`, `mcp`, `profiles`,
`confirm`/`deny`, iOS, cloud providers and launch flags (`--headed`, `--profile`, `--proxy`, …).

A site Ardia's built-in ad blocker blocks opens as uBlock Origin's "Page blocked" page, which `ardia browse` can't
attach to, and `open` fails with `net::ERR_BLOCKED_BY_CLIENT` or `net::ERR_ABORTED`. When the user wants that site,
`ardia call sites.allowAds -p site=<host>` trusts it (a site, not a public suffix like `co.uk`; it covers its
subdomains in every profile), then `open` it again; `sites.adBlocker` lists the trusted sites and `sites.blockAds`
takes one out. An Ardia without these methods answers `unknown_method`, and one that lists them but can't make the
change yet (Linux before its engine update) answers `refused`: either way, ask the user to turn off Block Ads & Trackers
in Site Controls for that site.

## Tabs and sessions

- A session never takes the user's tab on its own: until it opens one (`open`, `tab new`) or picks one (`tab active`,
  `tab <id>`), page commands fail with `no_session_tab`. `tab list` shows the user's tabs too; `tab close` refuses
  theirs, and `close` leaves open a tab another live session uses.
- `tN` ids are the same in every session and never move to another tab. `tab tab-…` takes the ids `ardia windows`
  prints.
- `tab_detached`: Ardia took the tab away mid-command (it closed, crashed or went to sleep). Run the command again;
  a multi-page `read` already retries that page in a new tab.
- `frame_gone`: the frame chosen with `ardia browse frame` is gone. Run `ardia browse frame main` or pick another frame.
- `attaches_unanswered`: Ardia hasn't answered DevTools attaches yet. Retry, or `ardia browse close` the session.
- `setup_lost`: the tab was attached again after Ardia detached it, but the init scripts, `set` overrides or routes the
  error names couldn't be put back, so they are off. Set them again, then rerun the command.
- `--session name` (or `AGENT_BROWSER_SESSION`) gives its own tabs, refs and captures; cookies and logins are the
  user's in every session. Use one session per task.

## The page's own world, console and errors

Snapshots, `read` and locating run in an isolated world or through the browser; the page sees only what a person's
input would cause. `eval`, `wait --fn`, `page.evaluate` in scripts, init scripts and `open --enable react-devtools` run
in the page's own world, where its globals are; `eval --isolated` (and `wait --fn … --isolated`) run in an isolated
world instead, which shares the DOM but leaves nothing the page can see. `console` and `errors` start capturing on first use (or with `open --capture-console`).

## Output cap

Text output stops at about 12,000 characters (20,000 for `script`) with one line, on stderr, saying how to narrow it
(for a snapshot, the `-s` of its biggest region). Narrow rather than reading the saved full output. Narrow with `-s <sel>`, `snapshot -i`, `read --links <pattern>`, or a script that
returns only the fields you need. `--json` and output redirected to a file (`> out.json`) are never cut.

## Auth vault

```sh
ardia browse auth save github --url https://github.com/login --username me --password-stdin < secret.txt
ardia browse auth login github
```

Passwords go to the macOS login Keychain (so `auth` doesn't work on Linux); `--password` is refused. `login` types only on the saved https origins and
stops if the page navigates, the frame changes or focus leaves the field. Never echo secrets yourself.

## Exit status

0 done; 1 the command failed (a stale ref, a refused command, an action whose outcome is unknown); 2 Ardia isn't
reachable or closed the connection (Stop was pressed or control was turned off: the session ends, and an interrupted
action is reported as unknown, never retried); 130 interrupted.

## Error codes

A failure's last word is its code in brackets, `(stale_ref)`; `--json` puts it in `code`. When one command fixes it, the
next line is `remedy: <command>` (`--json`: `remedy`): run it. Other codes are the page's or the site's: read the message.

| code | means | remedy |
| --- | --- | --- |
| `ambiguous` | several elements match; the message lists them with refs | `ardia browse snapshot -i` |
| `ardia_too_old` | this Ardia's engine lacks a DevTools method the command needs; update Ardia | `ardia methods` |
| `borrowed_tab` | the session works in your tab (`tab active`) and won't do this there without naming it | `ardia browse tab list` |
| `covered` | another element sits on top of the target | `ardia browse screenshot --annotate` |
| `daemon_timeout` | the session's daemon didn't answer in time | `ardia browse session list` |
| `daemon_unreachable` | Ardia or the session's daemon can't be reached (exit 2) | `ardia browse session list` |
| `dialog_blocked` | a JavaScript dialog froze the page; answer it first | `ardia browse dialog status` |
| `disabled` | the target stayed disabled | `ardia browse snapshot -i` |
| `document_changed` | the page changed document while the command ran | `ardia browse snapshot -i` |
| `element_replaced` | the page redrew the element | `ardia browse snapshot -i` |
| `focus_moved` | focus left the field mid-typing, so the rest wasn't sent | `ardia browse snapshot -i` |
| `frame_gone` | the frame the session acts in went away | `ardia browse frame main` |
| `keychain_refused` | the macOS Keychain refused the change; the profile was kept |  |
| `navigation_failed` | the page didn't load; the message says why |  |
| `no_match` | nothing matches the selector or name | `ardia browse snapshot -i` |
| `no_session_tab` | the session has no tab yet: open one or pick the user's | `ardia browse tab active` |
| `no_tab` | that tab isn't there | `ardia browse tab list` |
| `not_found` | the element, flow or item isn't there | `ardia browse snapshot -i` |
| `not_own_tab` | the command works only on tabs this session opened | `ardia browse tab list` |
| `not_visible` | the element has no box on screen | `ardia browse screenshot --annotate` |
| `outcome_unknown` | the connection dropped mid-action; check the page before retrying | `ardia browse snapshot -i` |
| `outside_viewport` | the element is outside the visible page | `ardia browse screenshot --annotate` |
| `page_busy` | the page's script kept the tab busy | `ardia browse screenshot` |
| `policy_refused` | this Ardia keeps the ardia command away from a DevTools method; Ardia 0.2.49 or later allows it |  |
| `profile_busy` | another command is saving or deleting that profile; try again when it's done |  |
| `ref_drifted` | the ref now points at an element with another role or name, so nothing was done | `ardia browse snapshot -i` |
| `session_busy` | another command holds the session | `ardia browse session list` |
| `session_limit` | every automatic session is open and busy; close one or name a session | `ardia browse session list` |
| `stale_ref` | the ref belongs to an older snapshot or page | `ardia browse snapshot -i` |
| `tab_crashed` | the tab's page crashed | `ardia browse reload` |
| `tab_detached` | Ardia detached the tab | `ardia browse tab list` |
| `tab_gone` | the session's tab closed | `ardia browse tab list` |
| `tab_in_use` | another session uses that tab | `ardia browse tab list` |
| `tab_not_found` | no tab has that id or label | `ardia browse tab list` |
| `timeout` | the page or site didn't answer in time |  |
| `unknown_command` | ardia browse has no such command; the message names the closest | `ardia browse --help` |
| `unknown_ref` | no element has that ref | `ardia browse snapshot -i` |
| `unsupported` | ardia browse doesn't do this; the message says what to use instead |  |
| `usage` | the command's words or flags are wrong; the message names the closest flag | `ardia browse <command> --help` |
| `usage_error` | an option before the command is wrong | `ardia browse --help` |
| `vocab_superseded` | the ref comes from a snapshot a newer one replaced | `ardia browse snapshot -i` |
