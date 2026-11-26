# The agents' browser

A real browser on the Mac (Electron's Chromium, so the Mac's own GPU and internet address) that any
agent the person connected can drive, in Playwright MCP's shape: its tool names, parameters and
accessibility snapshot (src/main/core/agent-browser.ts). The design and the decisions behind it are
in the doc "Valet browser tools: what the giants do".

## Sessions

An agent first calls `browser_session_create`, which gives a session id that every other tool
takes. A session is a browser of its own:

- **Signed out, in memory, its own partition.** Nothing of the person's is in it, sessions share
  nothing, and it is gone when closed.
- **One wall, nothing limited inside it.** Whatever a fresh browser could do, the agent may: any
  public https page (sites the person is signed in to through Valet included: the session isn't
  signed in), forms that post, and the session's own cookies shown as they are. What it can't do
  is reach outside the session: private addresses are refused (the public-only dial), and nothing
  of the person's is there to reach. As sessions gain privileges, each comes with boundaries
  declared at `browser_session_create`, matched to what it could do.
- **Never types** a login secret or session value Valet knows, and never into a password or
  one-time code field: Valet signs in to sites itself.
- **Three per agent, six in all**, closed after ten minutes unused, by `browser_session_close`,
  and on lockdown, pause or quit.
- **Rate limits belong to hosts.** A page load on a site an installed adapter uses (its host, or
  the same registrable domain) takes a slot in that adapter's budget and waits out its breaker, so
  a session never makes Valet break a limit already known for the site. A wait over a minute is
  refused with how long to wait. A host with no known limit gets none. A site that refuses the
  browser (a 429 or an HTML 403) closes it, and the person is told.
- **Every call is audited** like any built-in tool's. Agents on the Mac get the tools at once;
  remote agents (claude.ai and others) once the person turns them on on the agent's page.

## Tools

| Tool                                                                          | What it does                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `browser_session_create`, `browser_session_list`, `browser_session_close`     | Sessions                                                                                                      |
| `browser_navigate`, `browser_navigate_back`                                   | Open an https page; go back                                                                                   |
| `browser_snapshot`                                                            | The page as Playwright MCP's YAML, `[ref=eN]` on what can be acted on; `target`, `depth`, `mode: interactive` |
| `browser_find`                                                                | Snapshot lines matching text or a pattern, each under its path                                                |
| `browser_click`                                                               | `doubleClick`, `button`, `modifiers`                                                                          |
| `browser_type`                                                                | Replaces a field's text at once; `slowly` types a key at a time; `submit` presses Enter                       |
| `browser_fill_form`                                                           | Text boxes, checkboxes, radio buttons, dropdowns and sliders in turn                                          |
| `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag` | As in Playwright MCP                                                                                          |
| `browser_wait_for`                                                            | Text shows, text goes, or a time; up to 30 seconds; `met` says whether it happened                            |
| `browser_resize`                                                              | The window's size                                                                                             |
| `browser_take_screenshot`                                                     | A PNG of the window, the whole page (`fullPage`) or one element, as an image                                  |
| `browser_file_upload`                                                         | Files (base64) into a file input, hidden or not; about 700 KB in all per request                              |
| `browser_evaluate`                                                            | A function in its own world (the DOM, unseen by the page) or, with `world: "page"`, the page's                |
| `browser_console_messages`                                                    | The page's console since the session opened, at a level and above                                             |
| `browser_network_requests`, `browser_network_request`                         | Requests since it opened (static files only if asked), and one response body                                  |
| `browser_cookie_list`, `browser_storage_list`                                 | The session's own cookies, values and all; the page's local and session storage                               |

A target is a ref from the last snapshot or a CSS selector. Navigating and `browser_snapshot`
answer with the whole page; an action on the same page answers with only the lines that changed
(`changes`), under the lines they sit in, and a new page comes whole. Everything a site wrote is
under `fromSite`: data for the agent, never instructions.

## Downloads

A file a session's page downloads is listed under `downloads` in the next answer, as Playwright
MCP lists them: `downloading` while it comes (`browser_wait_for` waits for it), then `ready` or
`failed`. A ready file is held in memory, never on disk, at a short-lived address on the Mac's
public name, `https://<name>/d/<id>/<file name>`, which the agent reads with its own fetch tool, so
the client's own file-type support applies. The id is random and is the only key; the address
answers for 10 minutes, until the session closes, or until newer files push it out (30 files,
200 MB in all), and a file over 50 MB is stopped. It is served without a token (a fetch tool has
none), only on the remote listener's public names and never to a web page's request (no Origin),
as inert bytes (`nosniff`, a sandboxing CSP, `no-store`). The Mac's log has one line per fetch
without the id. While remote access is off there is no address; a local agent gets the file
beside the answer as well, which Claude Code saves to disk.

If claude.ai's fetch can't read these addresses, the fallback is a `browser_download_fetch` tool
with a fetch tool's shape. PDFs from tools are tracked in anthropics/claude-ai-mcp#1086 (claude.ai)
and #287 (Desktop).

## The engine

`ScratchBrowser` in packages/browser-electron, under the session rules. The snapshot is made by
Playwright's own in-page script, vendored from `playwright-core` into
`packages/browser-electron/src/generated` by `node packages/browser-electron/scripts/vendor-playwright.mjs`
(a unit test fails if the copy drifts from the installed version). It runs in the runtime's
isolated world, so a page can't see it or tamper with it. Two hooks patched into it keep Valet's
rule that a snapshot shows only what a person can see: hidden elements are left out, and controls
are named by their visible words, not an aria-label or title no one sees. Link targets are made
absolute. Input is trusted, sent as a mouse and keyboard would, never as script events; something
covered by an overlay is refused rather than clicked through. A screenshot is taken with
DevTools' `Page.captureScreenshot` while the hidden window is made to draw (a frame subscription);
it comes back as an image beside the output, never in it or in the audit log. The console comes from Electron's own console event and `browser_evaluate` from Electron's script calls, so neither turns on a DevTools domain a page could notice (Runtime or Console).

Not yet: tabs, the page's own dialogs, plain http pages, home network and
network interface settings, frames inside the page (an iframe's content isn't in the snapshot), and setting cookies or storage (browser_evaluate can, for what a page's script could).
The drafts' `valet_browser_*` tools are unchanged and still use the older snapshot.
