# The agents' browser

A real browser on the Mac (Electron's Chromium, so the Mac's own GPU and internet address) that any
agent the person connected can use to read the web. Built-in tools under **Browser**:
`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_query` and
`browser_close` (src/main/core/agent-browser.ts).

- **Signed out, in memory.** It is the drafts' scratch browser (`ScratchBrowser`) in a new
  in-memory partition each time it opens. It holds nothing of the person's, and cookie values never
  reach the agent.
- **Any https page**, through the public-only dial (no private addresses), except the sites the
  person is signed in to through Valet: those are never reached, pages or requests, so a signed-out
  visit from the same address can't count against the person's session there.
- **Pages only by GET.** A form that posts doesn't go anywhere; a page's own scripts may still
  send requests, as in any browser.
- **One per agent, three in all**, closed after ten minutes unused, by `browser_close`, and on
  lockdown, pause or quit. Page loads on a site are at least three seconds apart and at most 60 an
  hour, all agents together. A site that refuses the browser (a 429 or an HTML 403) closes it, and
  the person is told.
- **Never types** a login secret or session value Valet knows.
- **Every call is audited** like any built-in tool's. Agents on the Mac get the tools at once;
  remote agents (claude.ai and others) only once the person turns them on on the agent's page, as
  for Mail or Calendar.

The browser grant (docs/browser-grants.md) is the signed-in, per-site version, for building an
adapter. Not built yet: screenshots, the network log for this browser, signing in, and a setting
to turn it off (lockdown, pause and the per-agent switches do that for now).

## The new engine (being built)

The browser tools are being rebuilt on Playwright MCP's shape, on Valet's own Electron browser
(the design: "Valet browser tools: what the giants do"). The first part is in `ScratchBrowser`,
not yet behind any tool:

- **`ariaSnapshot`** gives the page as Playwright MCP does: its accessibility tree in YAML, with a
  `[ref=eN]` on everything an agent can act on. It is made by Playwright's own in-page script,
  vendored from `playwright-core` into `packages/browser-electron/src/generated` by
  `node packages/browser-electron/scripts/vendor-playwright.mjs` (a unit test fails if the copy
  drifts from the installed version). It runs in the runtime's isolated world, so a page can't see
  it or tamper with it. Two hooks patched into it keep Valet's rule that a snapshot shows only what
  a person can see: hidden elements are left out, and controls are named by their visible words, not
  an aria-label or title no one sees. Link targets are made absolute. A snapshot can be of one
  element (`target`) or a few levels (`depth`), and carries the page's previous snapshot for a delta.
- **`find`** gives the snapshot's lines that match some text or a pattern, each under its path.
- **Input is trusted** (sent as a mouse and keyboard would, never as script events):
  `clickElement` (button, double click, modifiers), `hover`, `drag`, `fill` (replaces a field's
  text at once; `slowly` types a key at a time; `submit` presses Enter), `press` (Playwright's key
  names, such as `Enter`, `ArrowDown` or `Shift+Tab`) and `select` (by value or label).
  A target is a ref from the last snapshot or a CSS selector. Something covered by an overlay is
  refused rather than clicked through.
- **`waitFor`** waits for text to show or go, or for a time, up to 20 seconds.
- Agents never type into password or one-time code fields: Valet signs in to sites itself.

Not yet: frames inside the page (an iframe's content isn't in the snapshot), sessions and the
tools themselves, screenshots, uploads and downloads.
