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
