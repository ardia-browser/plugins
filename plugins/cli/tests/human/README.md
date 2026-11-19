# Human test pages (ardia-browser/ardia#2812)

One page per row of #2812. Each page prints PASS/FAIL and sets one machine-readable result:
`window.__humanResult` and `<html data-human-result>`, `{row, pass, measured}`. A page decides its own verdict when
the driver sets `data-finish` on `<html>`; anything only the driver can observe (a file on disk, a read inside a closed
shadow root) is handed to the page as JSON in `data-read`.

`drive.ts` drives every page over a full DevTools connection, the stand-in for the owner's CLI session after #2808.

```sh
bun drive.ts --app "<Chromium>.app" [--headed] [--rows 1,2] [--modes full,naive] [--flags=--enable-automation] [--out results.json]
```

- **full**: what the issue's verdict says the engine gives. Trusted input (`Input.dispatch*`, `imeSetComposition`,
  `insertText`, `dispatchDragEvent`), reads and writes in an isolated world (`Page.createIsolatedWorld`), no
  `Runtime.enable` or `Debugger.enable` on the page, `DOM.getDocument({pierce: true})`, flattened auto-attach for
  iframes, `Browser.grantPermissions`, `Browser.setDownloadBehavior`, `setInterceptFileChooserDialog` and
  `DOM.setFileInputFiles`, `WebAuthn` virtual authenticators.
- **naive**: `Runtime.enable` and `Log.enable`, then main-world `Runtime.evaluate`, `element.click()` and synthetic events.
- **naive-debugger**: naive plus `Debugger.enable`.
- **gesture-eval**: isolated-world `Runtime.evaluate` with `userGesture: true`.

The browser is started with a fixed `--remote-debugging-port`, never `0`: Chromium turns `navigator.webdriver` on for
an ephemeral port, for `--remote-debugging-pipe`, `--headless` (old mode) and `--enable-automation`
(`content/child/runtime_features.cc`). Ardia strips all of these switches (`kSwitchesThatOpenTheProfile` in
`engine/ardiacore/src/ardia/core/ac_main_delegate.cc`) and uses its token socket.

`server.ts` serves the pages on `127.0.0.1` and `[::1]` on one port, so `127.0.0.1`, `localhost` and `[::1]` are three
sites for the iframe row.

## Confirmed verdicts

Measured on Chrome for Testing 158.0.8127.36 (mac-arm64), headless (`--headless=new`) and headed.

| # | Item | Full CDP | Naive | Verdict |
|---|---|---|---|---|
| 1 | Trusted events | PASS: click, pointer, mouse, key, wheel and touch all `isTrusted` | FAIL: all untrusted | **engine gives it**. Touch arrives trusted while `maxTouchPoints` is 0 and `ontouchstart` is absent, which is a tell; the CLI sends touch only on a touch device or with touch emulation |
| 2 | User activation | PASS: key gives `isActive` from `hasBeenActive: false`; a click after the 5 s expiry gives it again | FAIL | **engine gives it**. Isolated-world `Runtime.evaluate({userGesture: true})` also grants activation, but its events are untrusted |
| 3 | Gesture-gated APIs | PASS: popup (blocked without a gesture), fullscreen, autoplay with sound, `<input type=file>` chooser, clipboard write; clipboard read after `grantPermissions` (before: `NotAllowedError`); `PaymentRequest.show` accepts the activation; `credentials.create` with a virtual authenticator | gesture-eval passes too, untrusted | **engine gives activation**; clipboard read: **CLI** grants it. **Needs engine code**: `showOpenFilePicker` is aborted by interception (`AbortError: Intercepted by Page.setInterceptFileChooserDialog()`, `global_file_system_access.cc`) and `Page.fileChooserOpened` carries no node, so nothing can answer it. **Needs app code**: the payment sheet and the owner's real passkey/password sheets are native (a virtual authenticator is not the owner's keys) |
| 4 | Pointer movement | PASS: 65 trusted `pointermove`s, 63 with `movementX/Y`, up to 6 coalesced events when moves are sent without awaiting, `:hover` style applied | FAIL | **engine gives events**; curved paths and timing are **CLI only** |
| 5 | Focus and IME | PASS: `focus/focusin/blur/focusout` order, trusted `compositionstart/update`, `beforeinput` `insertCompositionText`, `deleteContentBackward`, `insertText`, `document.hasFocus()` true | FAIL | **engine gives it**. `compositionend` is `isTrusted: false`, but Blink fires every `compositionend` through `ScopedEventQueue` without the trusted flag, so a real IME does the same. Background-window focus was not settled: CfT came to the front during the headed run, so the background case needs a check in Ardia; `Emulation.setFocusEmulationEnabled` is the fallback |
| 6 | Drag and drop | PASS: `setInterceptDrags` plus `dispatchDragEvent` give trusted `dragstart`/`drop` with data; real files from disk arrive in `DataTransfer.files` with names, sizes and contents; a mouse-driven sortable list reorders | FAIL | **engine gives it**, **CLI** wires the intercept |
| 7 | `navigator.webdriver` | PASS: `false`, getter native, no `cdc_`/`__webdriver`/`__playwright` names | control with `--enable-automation` (or port 0): `true` | **engine gives it**, because Ardia strips those switches. `HeadlessChrome` in the user agent is a headless-only tell |
| 8 | Session side effects | PASS: no probe fires; `console.debug(bigObject)` costs the same as `console.debug('x')` (ratio 1.07) | FAIL: the old `Error.stack`/Proxy/getter probes no longer fire on 158, but the console cost ratio rises to 1.88 with `Runtime.enable`; with `Debugger.enable`, `debugger;` pauses 10–21 ms | **CLI only**: no `Runtime.enable`/`Debugger.enable` on page sessions, isolated worlds for reads and scripts |
| 9 | Globals and stacks | PASS: no new globals on `window` or `document`, handler stacks contain only page frames | FAIL: `__driverState` leaks, `__puppeteer_evaluation_script__` frame in the stack | **CLI only** |
| 10 | Timing | PASS: rAF max 16.8 ms before attach, attached, while acting and after; one run dropped one frame while typing (33 ms) | `Debugger.enable` adds no rAF hitch | **CLI only**. One headless run saw a 117 ms frame during the first `Page.captureScreenshot`, so the daemon avoids screenshots in the middle of timing-sensitive steps |
| 11 | Banners | PASS: browser-UI height unchanged through attach, headed and headless | control with `--enable-automation`: +57 px infobar | **engine gives it**: no infobar comes from a DevTools client attaching. CfT's own "for testing" infobar shows before attach and is unrelated |
| 12 | Closed shadow roots | PASS: `DOM.getDocument({pierce: true})` reaches nested closed roots, `DOM.resolveNode` into the isolated world reads the text, box-model click is trusted | FAIL: `shadowRoot` is null | **engine gives it**, **CLI** wires selectors through |
| 13 | Cross-origin iframes | PASS: flattened auto-attach gives `localhost`, nested `[::1]` and a sandboxed (opaque-origin) frame their own sessions; isolated-world reads in each; clicks on the top session at summed offsets arrive trusted inside nested OOPIFs | FAIL: `contentDocument` null | **engine gives it**, **CLI** wires it |
| 14 | Pickers and permissions | geolocation, notifications and camera PASS after `grantPermissions` (+ `Emulation.setGeolocationOverride` with no location provider); `<select>` changes by keyboard type-ahead and `<input type=date>` by typed digits, both trusted, with no popup; color FAIL | — | permissions granted ahead: **engine gives it**. **Needs app/engine code**: a prompt already showing isn't answered by a later grant (headed: the camera prompt stayed open and the page waited), so the control socket needs a method that answers the visible prompt (`ResolvePermission` in `engine/ardiacore/src/ardia/core/ac_permissions.mm`); clicking a `<select>` opens a native `NSMenu` (`content/browser/renderer_host/popup_menu_helper_mac.mm`); the color picker is `NSColorPanel` (`components/remote_cocoa/app_shim/color_panel_bridge.mm` via `WebContentsImpl::OpenColorChooser`) with no keyboard path |
| 15 | Downloads and uploads | PASS: served attachment and blob download land in the folder asked, 2 `downloadProgress: completed`; upload of 2 files via interception | — | **engine gives it** after #2808 |
| 16 | Print and save | PASS: `Page.printToPDF` (41 KB, 1 page), `Page.captureSnapshot` MHTML has the page; FAIL: the print dialog | — | **engine gives** PDF and save. Correction: headed `window.print()` opens print preview as a `chrome://print/` page target that `Target.getTargets` lists, and the page stays blocked until it closes. Ardia uses Chrome's `PrintPreviewDialogController` (`ardiacore_tab_commands.mm`), so once #2808 opens `chrome://` targets this is **CLI only**: attach to `chrome://print` and press Print or Cancel. Headless `print()` returns at once |
| 17 | Browser UI | `Browser.setWindowBounds` and `Browser.executeBrowserCommand` work; ⌘T and ⌘L sent with `Input.dispatchKeyEvent` reach only the page, headed and headless | — | **control socket** (#2811) for state and actions; native menus need **app code** |
| 18 | Canvas and WebGL | PASS: screenshot, find the target by its pixels, trusted click hits the 2D circle and the WebGL square; 2D readback via isolated `toDataURL` matches the page's own | — | **engine gives** screenshots and input; locating by pixels is **CLI only**. Colors must be matched with tolerance: on a Retina display, colour management shifted pure red past a strict threshold |
| 19 | Virtualised list | PASS: wheel-driven scroll-until-found reaches row 5,000 of 10,000 in 4 wheel steps (330–360 ms), trusted click | FAIL: the row isn't in the DOM | **CLI only** |
| 20 | Rich editors | PASS: per-key typing, double-click word selection, `insertText` replacement, the editor's own undo stack | FAIL | **engine gives** input; **CLI only**: on macOS ⌘Z/⌘A/⌘C/⌘V do nothing in a native `contenteditable` without `commands: ["undo"]` etc. on `dispatchKeyEvent` |
| 21 | Custom elements | PASS: typing in an open shadow, clicking in a closed shadow, form-associated values in `FormData`, valid, trusted submit | FAIL | **CLI only** on top of #12 |
| 22 | Waits | PASS: network idle plus layout-shift, mutation, long-frame and long-task quiet for 500 ms, then click 520–630 ms after the app is ready | FAIL: a fixed 500 ms sleep clicks before the app is ready | **CLI only** |
