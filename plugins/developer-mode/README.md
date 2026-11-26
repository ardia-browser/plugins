# Developer Mode

Arc's striped developer bar for the sites you're building. Built into Ardia and off until you turn it on in
**Settings › Plugins**.

## When the bar shows
The bar shows on sites you turned on in Site Controls; with **Turn On for Local Addresses You Type** on, a local
address you type in turns itself on.

- **Site Controls › Developer Mode** turns it on or off for one site. A site is its scheme, host and port, so
  `localhost:5173` and `localhost:8318` are separate.
- **Local addresses** (`localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`) turn on only when you type or pick
  one in the address bar. A sign-in that sends you back to a local address, a link, a restored tab or another app
  opening one never turns anything on. Turning a site off in Site Controls keeps it off.
- Only the tab you're looking at gets the bar, never one behind it.

## What the bar has
Site Controls, the address (click to edit), Copy Link, then the Console, Network and Inspect, then your extensions and
a menu to add a split.

## What it never sees
The plugin is just a manifest: no program, no page, no code in web pages. Ardia draws the bar and runs its buttons,
and keeps which sites you turned on to itself. The plugin never sees an address.

## Thanks
Developer Mode was first built into Ardia by [@narasaka](https://github.com/narasaka) (ardia-browser/ardia#2648 and
#2656). This plugin carries their design.
