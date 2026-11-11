# Layout and visual audit: Valet desktop renderer (round 1)

Auditor: layout/visual pass, 2026-11-11. Scope: every screen of `apps/desktop/src/renderer`, measured
in Chromium against the dev fake API.

**How this was measured.** I adapted the existing render script and saved it as
`/tmp/claude-0/-home-user/1fccf96c-41d8-510b-9eca-c97d63a5ec7f/scratchpad/audit-layout.mjs`.
It renders 24 routes:

- in light mode, at the default size (1180 x 780) and at the minimum window size (880 x 560);
- in dark mode, at 1180 x 780;
- the chromeless windows at their **real** sizes from `main/electron/windows.ts`: confirmation
  460 x 620, tray 400 x 640, hand-off banner 168 px high. The earlier `current-screens`
  renders used 1180 x 780 and 360 x 560 for these windows, which hid some problems and invented
  others.

For each render, `page.evaluate` measures these things:

- page-level horizontal scroll;
- children that escape their parent box;
- `overflow:hidden` boxes whose content is cut off;
- every scroll container and its content size;
- ellipsis truncation;
- short labels that wrap;
- grid rows with unequal card heights, and holes in grids;
- gaps between cards, card-head heights, button heights and font sizes;
- hit targets smaller than 20 px;
- computed `user-select` on every element that holds text;
- computed `cursor` on every control;
- WCAG contrast of each text colour against the background it actually sits on.

The script also checks keyboard focus by tabbing through the page 25 times, checks hover backgrounds,
and takes a select-all screenshot. Screenshots are in `audit/shots/` (29 PNGs, deviceScaleFactor 1).

## Summary

Nick's "weird gaps and glitches" are real and can be measured. Almost all of them come from four
root causes:

1. **No responsive rules at all.** The stylesheets contain no width `@media` or `@container` query.
   The layouts use fixed columns: a 320 px inspector, a 340 or 360 px inspector, `grid-3`, label
   columns of 120 to 150 px, and a 212 px sidebar plus a 250 px setup rail. These are tuned for
   1180 px and break at the 880 px minimum. At 880 px:
   - the **Adapters table collapses to a 3 px line** (L01);
   - tables run 90 to 260 px past their cards (L12, L23, L26, L31);
   - Settings wraps one word per line (L27).
2. **Vertical stacks are CSS grids inside fixed-height scroll boxes.** When content doesn't fit, a
   grid item with `overflow` set shrinks toward 0. This is what hides the Adapters table (L01) and
   cuts the audit record JSON to 55 px (L24).
3. **No layout system above the component level.**
   - Pages pick their own content width (full width, 720 px, 640 px for the lede), their own top
     padding (12, 16 or 24 px) and their own column ratios.
   - About 120 inline `style={{}}` overrides patch spacing screen by screen.
   - 106 of 199 spacing declarations bypass the `--space-*` scale, using 17 different raw values.
   - The result is cards of unequal height and columns that end at different heights, which leaves
     holes (L09, L16, L28, L30).
4. **Web defaults leak through.**
   - 100% of text is selectable on every screen. The only exception is the diff line numbers.
   - Links show a hand cursor and buttons show an arrow.
   - Rows, nav items and cards have no hover state.
   - The UA focus outline paints a black frame around the grant sheet.
   - Controls are 13 to 19 px tall, smaller than a usable target.

There are 50 findings below: 16 high, 23 medium, 11 low.

---

## Findings

### Control panel shell (sidebar, title bar, page frame)

**L01: The Adapters table disappears at the minimum window size.** _Screens:_ adapters,
fr-adapters at 880 x 560 (`shots/adapters-880x560-light.png`).

The card that holds the adapters table measures **618 x 3 px**, against 857 x 179 px of content. On
first run it measures 618 x 0. On screen it is a thin grey line under the review banner, and the
**main list of the app is gone**.

- _Severity:_ high.
- _Root cause:_ the page is `.content.scroll.stack` (`Adapters.tsx:75`, `app.css:435`), a CSS grid
  inside a fixed-height scroll box. The table card has `overflow-x:auto` (`.table-scroll`,
  `screens.css:70`), so its automatic minimum height is 0. The grid shrinks it to make room for the
  three cards below.
- _Fix:_ never use a grid that stretches or shrinks as a page's vertical flow. Page sections take
  their natural height (`max-content` rows or block flow), and only the page scrolls. A component
  that scrolls internally must state its own minimum or fixed height.

**L02: Sidebar nav items get squashed and nothing scrolls.** _Screens:_ activity and activity-call
at 880 x 560.

With the "Recent" run list shown, the 28 px nav items shrink to about 25 px:

- Adapters is at y = 88, Activity at 113 and Clients at 164, against 90, 118 and 174 at 1180.
- The gap between the list and the footer drops to 0 px.
- Run names are cut off ("update_cart_li…", "remove_fro…", measured 109 of 116 px and 82 of
  116 px).

- _Severity:_ med.
- _Root cause:_ `.sidebar` is a flex column with no `overflow` (`app.css:282`). `.nav-item`
  (`app.css:305`) keeps the default `flex-shrink:1`.
- _Fix:_ the sidebar is a fixed header (sections), a scroll region (contextual list) and a fixed
  footer. Nav rows never shrink.

**L03: The sidebar changes its contents depending on the section.** _Screens:_ activity versus every
other page.

The lower group is "Sites" (adapters) everywhere except Activity, where it becomes "Recent" (12
runs). The nav block also moves when the list underneath changes length. A layout that changes with
location makes the sidebar a poor anchor.

- _Severity:_ med.
- _Root cause:_ `Sidebar.tsx:132-170`.
- _Fix:_ keep the sidebar's structure stable. Put context-specific lists (recent runs) inside the
  page, as a master list in a split view, not in global navigation.

**L04: Unexplained empty band at the top of the sidebar, and a redundant "Valet" label.** _Screens:_
all control-panel pages.

The sidebar has `padding-top: 44px` to clear the hidden-inset traffic lights. The first thing below
that is a group label that just says "Valet" (top at y = 44, first nav row at y = 76). That spends
about 76 px of chrome before the first destination. The title bar is 52 px high, so the sidebar's
first row doesn't line up with any line in the main pane.

- _Severity:_ low.
- _Root cause:_ `app.css:287` and `Sidebar.tsx:83`.
- _Fix:_ reserve exactly the traffic-light area (about 52 px, matched to the title bar) and fill
  it. A search or filter field or an app mark can sit there. Drop the redundant group label. The
  first nav row should line up with the main pane's content top.

**L05: The page header pattern is inconsistent and too weak.** _Screens:_ all.

- List pages put a 13 px title and an 11 px subtitle in the title bar.
- Detail pages put breadcrumbs in the title bar and a 20 px H1 in the body (adapter), or only
  breadcrumbs (run trace).
- Review has its own title bar with a hard-coded 64 px indent.
- Setup uses a 26 px H1.

The title on list pages is the same size as body text (13 px), so it doesn't read as a page title.

- _Severity:_ med.
- _Root cause:_ each screen builds `.titlebar` by hand (`Adapters.tsx:49`, `AdapterDetail.tsx:43`,
  `Activity.tsx:104/188`, `ReviewUpdate.tsx:144-145`, `Credentials.tsx:19`).
- _Fix:_ use one `PageHeader` pattern: the title bar carries navigation (back, breadcrumb, view
  switch, global actions), and the page carries the title, status and primary actions in a fixed
  type style. Set the page-title size once in the design system.

**L06: The page-top offset changes from page to page.** _Screens:_ all.

The distance from the title bar to the first content is:

| Distance | Pages                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| 24 px    | Adapters, Activity, Credentials                                                   |
| 16 px    | Adapter detail, Clients/Settings, Remote (`paddingTop: var(--space-4)` overrides) |
| 12 px    | Audit log (`margin: var(--space-3) var(--space-5) 0`)                             |

Moving between pages makes the content jump.

- _Severity:_ low.
- _Root cause:_ `AdapterDetail.tsx:57`, `ClientsSettings.tsx:64`, `AuditLog.tsx:186`.
- _Fix:_ a single page-inset token for top, sides and bottom, which pages never override.

**L07: Content width is decided page by page.** _Screens:_ remote, setup, all others.

- Remote caps its column at 720 px (`RemoteConsent.tsx:55`). At 1180 that leaves a **224 px empty
  gutter** on the right, while every other page fills the width.
- Setup caps the lede at 640 px but lets the cards run 842 px wide.
- Activity rows run 920 px wide: the label sits at the far left and the status and time sit 600 to
  900 px to the right, so the eye has a long way to travel.

- _Severity:_ med.
- _Fix:_ define two or three page widths, for example a readable form or document column (about
  680 px) and a full-bleed data page, and pick one per page type. Center or left-align them the same
  way every time.

**L08: Dark windows flash light when they open.** _Screens:_ every window in dark mode.

`BrowserWindow` is created with `backgroundColor: '#f5f5f7'` whatever the theme, so a dark-mode user
sees a light frame before the first paint.

- _Severity:_ med.
- _Root cause:_ `main/electron/windows.ts:276`.
- _Fix:_ window background colours come from the same semantic token for each theme, using
  `nativeTheme`.

### Adapters list

**L09: Holes and dead space under the overview cards.** _Screen:_ adapters at 1180.

The three cards (Circuit breakers, Today, Credentials) stretch to the tallest card's height (264 px).

- Circuit breakers fills about 150 px and leaves **about 115 px of empty card**.
- Credentials leaves about 90 px.
- Below the cards there are **205 px of empty window**.

- _Severity:_ med.
- _Root cause:_ `.grid-3` stretch (`app.css:505`) with fixed three equal columns.
- _Fix:_ summary tiles share a fixed tile height or are content-sized and top-aligned. Give the
  overview a layout that fits the height, for example tiles above and lists below. Don't stretch
  cards whose content differs.

**L10: `grid-3` never reflows, so the tiles squeeze to words-per-line at 880 px.**
_Screen:_ adapters at 880 (`shots/adapters-880x560-light.png`).

Each tile is about 150 px wide:

- "Logins 3 · 0 failed" wraps onto 2 lines;
- the Credentials list wraps "Copy in your Keychain · not set up" onto 4 lines;
- the "1Password and Messages" subtitle stacks three lines high in the head.

- _Severity:_ high.
- _Root cause:_ `app.css:505`. There are no breakpoints anywhere.
- _Fix:_ use auto-fill or minmax grids (minimum tile width of about 240 px), or container queries
  on cards.

**L11: The table's secondary badges wrap into 2 to 3 line blobs.** _Screens:_ adapters,
fr-adapters.

- "SMS code · not granted" is 33 px tall at 1180 and 61 px at 880.
- "login · not granted" is 47 px at 880.

A pill should be one line. Pills that grow into rounded rectangles look broken.

- _Severity:_ low.
- _Root cause:_ `screens.css:58-67` deliberately sets `white-space: normal` on `.badge.neutral`.
- _Fix:_ pills never wrap. When there isn't room, shorten the label or move the detail into a
  secondary text line or a tooltip.

**L12: Eight columns don't fit the window, and the rows aren't targets.** _Screen:_ adapters.

The table needs 857 px of content and has 618 px at 880, so even after L01 is fixed it scrolls
sideways. Each row is a full-width visual target, but only the name link (76 x 16 px) can be
clicked. The row has `cursor: default`, no hover background (measured `rgba(0,0,0,0)`) and no
keyboard focus. In the focus walk, Tab goes from "Coles" straight to `<body>`: the circuit-breaker,
Today and Credentials cards contain **no focusable element**.

- _Severity:_ high.
- _Root cause:_ `Adapters.tsx:161`, `screens.css:41`.
- _Fix:_ list rows are whole-row targets with a hover state, a selected state and keyboard focus.
  Pick fewer columns and fold the rest into a two-line cell. Summary tiles link to the page they
  summarise.

### Adapter detail

**L13: The pending-review link looks like a status pill and overlaps the meta block at 880.**
_Screens:_ adapter-wow, fr-adapter.

"0.4.0 waiting for review" is the only link from the adapter to its review, which is Nick's
complaint. It is styled as `.pill.info`, so it looks like a status chip, and it has no button
affordance. At 880 it overflows its row by **111 px** and is drawn on top of the "Version / Content
hash" block (`shots/adapter-wow-880x560-light.png`).

- _Severity:_ high.
- _Root cause:_ `AdapterDetail.tsx:113-117`; the hero is a flex row with `.grow` plus a
  non-shrinking `dl` (`screens.css:83`).
- _Fix:_ an action that needs the person must be a real button or banner in the page header, for
  example "Review 0.4.0…". Status pills are never links. Header meta should wrap below the title
  when there is no room.

**L14: The fixed 320 px right column starves the main column, and cards clip it silently.**
_Screen:_ adapter-wow at 880.

The main column gets 282 px. The Tools, Recent runs and Permissions cards clip their content
(437, 457 and 477 px wide inside 282) because `.detail .card { overflow:hidden }`. Columns such as
"Manifest's description" and Calls are simply cut off, with no scroll and no ellipsis.

- _Severity:_ high.
- _Root cause:_ `screens.css:78` and `screens.css:118`.
- _Fix:_ below a breakpoint the side column stacks under the main one, or becomes an inspector
  that can be collapsed. Never hide overflow on a container that holds tables.

**L15: The Permissions grid overflows its card.** _Screens:_ adapter-wow, fr-adapter at 880.

In the three-column permissions body, "Tools may contact" overflows by 116 px and "Request
surface" by 195 px. Request paths overflow `.surface-list` by 12 px, and their read/write badges by
63 px.

- _Severity:_ med.
- _Root cause:_ a fixed `grid-3` in a card body (`AdapterDetail.tsx` permissions card), and
  `.surface-list` `auto 1fr auto` (`screens.css:90`).
- _Fix:_ key and value lists stack below a minimum width. Long monospace values wrap at path
  separators or truncate in the middle, with copy.

**L16: The two columns end at different heights.** _Screen:_ adapter-wow at 1180.

Columns are 867 and 832 px tall. Each column's cards are separate, so the left ends 35 px below the
right (1018 and 983 px). At 880 the gap is 1334 against 832 px: **500 px of empty right column**.

- _Severity:_ low.
- _Fix:_ a sidebar column should be sticky or shorter by design, or the layout should become a
  single flow. Don't line up two independent card stacks.

**L17: Card heads have different heights.** _Screens:_ adapter-wow and others.

Card heads are 40 px, or 45 px when they hold a button (Session: "Show login"). "Recent runs"
places a ghost link where other heads put a real button.

- _Severity:_ low.
- _Root cause:_ `.card > .card-head` padding of 10 px and no fixed height (`app.css:477`).
- _Fix:_ a card header component with a fixed height and one action slot using a small button.

### Run trace (Activity, call)

**L18: The trace column overlaps itself at 880.** _Screen:_ activity-call at 880
(`shots/activity-call-880x560-light.png`).

- The inspector is fixed at 360 px (inline style), which leaves the timeline 308 px.
- Step labels are `nowrap` code. `goto(https://www.woolworths…)` overflows by **236 px** and is
  painted under the duration column ("1.1 s" is drawn over the URL).
- Check rows overflow by 55 px.
- The step titles break into five lines of two words each.

- _Severity:_ high.
- _Root cause:_ `Activity.tsx:290` (`width: 360`) and `.step` grid (`app.css:1333`).
- _Fix:_ the inspector collapses or becomes a bottom drawer under a width threshold. Code in a
  timeline wraps or truncates with a tooltip. The duration column reserves its own space.

**L19: The trace JSON is clipped sideways.** _Screen:_ activity-call at 1180.

The "Output sent to the client" `<pre>` is 325 px wide against 350 px of content. `"qty": 1 }` is
cut at the card edge, and there's no visible scrollbar (macOS overlay scrollbars).

- _Severity:_ med.
- _Root cause:_ `.code` `overflow:hidden` (`app.css:984`); only `.inspector .code` gets
  `overflow-x:auto`.
- _Fix:_ code blocks either wrap or scroll with a visible edge fade. Offer copy and expand
  actions.

**L20: The header KPI strip wraps into two uneven rows.** _Screen:_ activity-call at 880.

Seven KPIs wrap into two rows of 5 and 2. The second row starts at x = 236 under the avatar, not
under the first KPI.

- _Severity:_ low.
- _Root cause:_ `.run-head` flex-wrap (`screens.css:351`).
- _Fix:_ a summary strip with a fixed set of fields, or a definition grid that reflows by column.

### Activity list

**L21: A short list floats in a tall empty window.** _Screen:_ activity at 1180.

Seven rows leave **392 px empty** below. There is no grouping by day, no pagination and no detail
pane, so most of the window is empty. "Removed … Thu 6:20 pm" sits among today's rows with no day
header.

- _Severity:_ low.
- _Fix:_ use a list and detail split view, for Activity and the trace (see L03), with day section
  headers. An empty area should be an intentional empty or detail state.

### Audit log

**L22: Filters wrap onto a second line and push the log down.** _Screen:_ audit at 1180.

- Seven chips and three selects don't fit on one line, so "Last 7 days" goes onto its own row.
- The green chain banner takes 60 px (96 px at 880).
- At 880 the table header starts at **y = 232 of 560**, so 41% of the window is chrome before the
  first row.
- At 880 the subtitle "4,813 records · append-only" wraps inside the 52 px title bar.

- _Severity:_ med.
- _Root cause:_ `AuditLog.tsx:186-247`, `.filterbar` flex-wrap (`app.css:1428`).
- _Fix:_ one toolbar row: a search field, one filter menu or token field, and a date range. Move
  the chain status into a compact status item in the title bar or toolbar, not a paragraph banner.

**L23: The Details column is cut off without an ellipsis.** _Screen:_ audit.

The log table needs 890 px and gets 628 px at 1180 (328 px at 880). `POST https://collect.tealiumiq.com/event page · h…`
and the long `www.woolworths.com.au/apis/ui/Trolley/Re…` are hard-cut at the pane edge, and the Call
and Hash columns are off-screen. The only clue is a horizontal scroll inside `.log`.

- _Severity:_ high.
- _Root cause:_ the fixed 340 px `.inspector` (`app.css:1459`) plus a wide table with `nowrap`
  cells.
- _Fix:_ prioritised columns. Low-priority columns (Call, Hash) hide first. Details truncates with
  an ellipsis and the full value is in the inspector. The inspector can be resized or collapsed.

**L24: The record JSON is squashed to 55 px at 880.** _Screen:_ audit at 880
(`shots/audit-880x560-light.png`).

The inspector's `pre.code.raw` measures 305 x **55 px** against 272 px of content. It's the same
grid-shrink cause as L01: the inspector is a `stack` grid with `overflowY:auto`, and `.code` has
`overflow:hidden`.

- _Severity:_ high.
- _Root cause:_ `AuditLog.tsx:625-641`, `app.css:984`.
- _Fix:_ as for L01.

**L25: Rows are selected through a 31 x 19 px "Seq" button.** _Screen:_ audit.

The selected row (4813) is highlighted, but the only way to select a row is the ghost button on
the sequence number. Rows have `cursor:auto` and no hover state.

- _Severity:_ med.
- _Root cause:_ `AuditLog.tsx:286`.
- _Fix:_ a whole-row selection model with arrow-key navigation, as in macOS table views.

### Clients and Settings

**L26: The row actions in the Clients table stack vertically.** _Screens:_ clients, settings.

"Set up / Reset access / Revoke" wrap into a column of three text buttons. That makes each row
**about 81 px tall** for three words of data. At 880, in Settings order, the actions column is
pushed **92 px past the card** (table right = 948 against card 856).

- _Severity:_ high.
- _Root cause:_ `.clients-table .client-actions { flex-wrap: wrap }` (`screens.css:567`). The
  comment there admits it's a workaround for the table being too narrow in a shared column.
- _Fix:_ row actions belong in an overflow menu (`…`) or a detail pane, and only the primary
  action is visible. Tables get a full-width region of their own.

**L27: The Settings column collapses to one word per line at 880.** _Screen:_ settings at 880
(`shots/settings-880x560-light.png`).

The setting rows are `120px | 1fr | auto` inside a card about 260 px wide, which leaves about
100 px for the description. "Open Valet when you log in" takes 4 lines, and the notification help
takes 13 lines.

Five controls overflow their row:

| Control                       | Overflow |
| ----------------------------- | -------- |
| select                        | 5 px     |
| "Check now"                   | 8 px     |
| Stable/Beta segmented control | 25 px    |
| "Reset Valet…"                | 19 px    |
| "Uninstall Valet…"            | 38 px    |

The MCP address overlaps its copy button.

- _Severity:_ high.
- _Root cause:_ `.setting` (`screens.css:547`) and `.cols` (`screens.css:532`).
- _Fix:_ Settings gets its own full-width page, laid out as a form (label above or label left at
  ≥ 600 px), and each group is a section.

**L28: Clients and Settings share one page, reordered with CSS.** _Screens:_ clients, settings.

Both nav items render `ClientsSettingsPage`. "Settings" just flips the column order through
`order: -1` (`screens.css:539-545`). The visible layout jumps between the two nav items, and the
titles and content are the same.

The two columns are **562 px and 1262 px** tall, which leaves a **700 px hole** under Clients at
1180. At 880 it's 691 against 3048 px, a **2357 px** hole. The page scrolls 3088 px.

- _Severity:_ high (layout and IA).
- _Fix:_ one destination per nav item. Settings is grouped and tabbed, or split into sections.
  Clients and MCP endpoint is its own page.

**L29: Inside Settings, help text, inputs and buttons don't share an alignment.** _Screen:_ clients.

- The 1Password row: the input sits at the top, the help text below it, and "Save" is centred on
  the whole 120 px row.
- "Found automatically" is set in monospace.
- Toggle switches are vertically centred against multi-line descriptions, while the labels in the
  left column are centred too. The label floats in the middle of a 90 px row instead of lining up
  with the first line.

- _Severity:_ low.
- _Fix:_ form rows align to the first baseline, the control sits next to the line it controls, and
  help text is a separate muted line under the control.

### Credentials

**L30: Four cards in a three-column grid leave two empty slots and uneven button positions.**
_Screen:_ credentials.

The four provider cards (`grid-3`) leave 2 empty slots on row 2. The card heights are 145, 145,
145 and 162 px, and the action buttons ("Turn on in Settings", "Set up in Settings") sit at
different heights. The cards on row 1 have up to 40 px of blank space. Below them are **254 px** of
empty window.

- _Severity:_ med.
- _Root cause:_ `Credentials.tsx` uses `grid-3` for a set of 4.
- _Fix:_ a provider list (rows) or a grid sized to its count with actions pinned to the card foot.
  Better still, give each provider its own action, with hover and focus states (L45).

**L31: The grants table runs past its card, and the page scrolls sideways at 880.** _Screen:_
credentials at 880 (`shots/credentials-880x560-light.png`).

The table overflows its card by **129 px**, so the whole content pane scrolls sideways (773 px
inside 668), and "Revoke" is off-screen. "1Password service account 'Woolworths'" wraps onto 3
lines. Card titles ("1Password service account", "Copy in your Keychain") wrap onto 2 lines next to
"1 grant".

- _Severity:_ high.
- _Fix:_ as for L12 and L23, and no page-level horizontal scroll, ever.

### Remote sign-in

**L32: The disabled primary button and the in-card footer look off.** _Screen:_ remote.

- "Turn on" is a disabled primary button: pale blue in light mode, 3.65:1 even when enabled. It
  sits in the card head, so it reads like a status.
- The in-card `.dialog-foot` uses dialog padding (24 px) inside a card body (16 px), so "Approve"
  sits 8 px out of line with the content edge, on a grey band that looks like a second card.
- The code field runs the full card width (686 px) for an 8-character code.

- _Severity:_ low.
- _Root cause:_ `RemoteConsent.tsx:219`, `app.css:1310`.
- _Fix:_ a card footer component that uses card padding. Size fields to their content. When a
  primary action can't be used yet, say why next to it.

### Review update (chromeless review in the control window)

**L33: The title is indented 80 px while the body starts at 24 px.** _Screens:_ review,
setup-approve-review.

The title text sits at x = 80 (`marginLeft: 64` plus 16 px padding) to clear the traffic lights,
but the avatar and summary sit at x = 24. The window has two left edges.

The review also **replaces the whole control panel**, sidebar included, with no back navigation
except "Close". That's why Nick found it from the tray but couldn't navigate to it.

- _Severity:_ med.
- _Root cause:_ `ReviewUpdate.tsx:144-145`.
- _Fix:_ traffic-light clearance is a title-bar inset that applies to the title-bar row only, and
  the body aligns to the page inset. Review is a page or a sheet inside the shell, not a takeover.

**L34: Two columns scroll independently with no scroll affordance, and the diff is clipped.**
_Screen:_ review.

The left column scrolls (543 px visible of 616 at 1180, 323 of 667 at 880), and the "Request
surface" section is cut off mid-header. At 880 the manifest diff is clipped sideways (406 against
487 px), and `{"method":"GET","path":"/api/v1/rewa…` runs out of the box by 81 px.

The decision row puts the "I've read…" checkbox **about 930 px away** from the Approve button.

- _Severity:_ med.
- _Root cause:_ `.review > .stack` (`screens.css:145`), `.diff` overflow hidden (`app.css:1039`).
- _Fix:_ a single scroll for the review document, with a sticky decision footer. Put the
  acknowledgement next to the button it unlocks. Diffs scroll sideways or wrap.

### Grant sheet

**L35: A black UA focus outline frames the whole sheet.** _Screen:_ grant (both sizes).

The sheet takes focus programmatically (`tabIndex=-1`, `sheet.current.focus()`), and its computed
outline is `rgb(16,16,16) auto 1px`. That's the thick black frame around the sheet in every
screenshot.

- _Severity:_ med.
- _Root cause:_ `GrantSheet.tsx:93,148`. `controls.css:15-21` only resets `outline` for
  `button, a, input, select`.
- _Fix:_ focus styles are part of the system. A container that takes focus programmatically has
  no ring, and `:focus-visible` gets the token ring.

**L36: The scrim misses the top of the sidebar, and the sheet hides its own content.** _Screen:_
grant.

`.sheet-scrim { inset: 52px 0 0 }` dims below the main title bar, but the sidebar runs to y = 0, so
a 52 px undimmed strip is left at the top left. At 880 x 560 the sheet body shows 354 of 599 px.
The "Item in Valet" list, the field-usage note and the end of "It can't" are all below the fold,
and nothing hints that the sheet scrolls.

- _Severity:_ med.
- _Root cause:_ `app.css:1274-1298`.
- _Fix:_ the scrim covers the whole content below the window chrome, including the sidebar. Sheets
  with long content use a single column at narrow widths, and scroll edges get a fade or divider.

### Confirmation window (460 x 620, frameless)

**L37: The window can't be moved, and two buttons compete for "default".** _Screen:_ confirm.

- The window is `frame:false` and has no `-webkit-app-region: drag` area (drag applies only to
  `.titlebar` and `.sidebar`, `controls.css:24`). It floats on top at the top right and can't be
  moved off what it covers.
- "Decline" carries `default-ring`, a permanent 3 px focus-style ring, while "Allow" is the filled
  primary. People see two emphasised buttons, and the ring reads as keyboard focus.
- The content fits only just: the footer ends at 610 of 620 px. One more line of adapter text
  pushes it off-screen, because `.confirm-window` has `min-height:100vh` and no scroll region.

- _Severity:_ med.
- _Root cause:_ `Confirmation.tsx:256`, `screens.css:608-621`.
- _Fix:_ every frameless window has a drag area. The safe default is marked with one convention
  only (the default button style). The body scrolls and the decision footer is fixed.

### Login hand-off banner (168 px high, frameless)

**L38: The banner's text wraps badly and nothing marks the window's edges.** _Screen:_ needs-user at
1000 px (`shots/needs-user-1000x168-light.png`).

- The trailing hint "· nothing is marked inside the page, where the site could fake it" wraps onto
  its own line and **starts with an orphaned "·"**.
- The adapter note is a fourth muted line. The banner is 4 text lines plus a status bar in 168 px,
  with no space left.
- The status bar under it is 30 px of 11 px text that repeats the window's purpose.
- There's no drag area or close control other than "Give up".

- _Severity:_ med.
- _Root cause:_ `NeedsUserBanner.tsx`, `.handoff-banner` (`app.css:1492`), `BANNER_HEIGHT = 168`
  (`windows.ts:27`).
- _Fix:_ a banner pattern with a fixed layout: icon, one headline, one detail line, and actions.
  Secondary facts go behind a disclosure. Don't build sentences from separators that can start a
  line.

### Menu bar popover (tray, 400 x 640)

**L39: The "Needs you" list is cut mid-item with no affordance.** _Screen:_ tray
(`shots/tray-400x640-light.png`).

The needs list is a scroll region 173 px tall over 275 px of content. Item 1 shows, item 2
("Confirm Remove from cart · Woolworths") is cut through its second line, and **item 3 is entirely
hidden**. There's no fade, no "+1 more" and no visible scrollbar. The "Needs you 3" header is
inside the scroll region, so it scrolls away.

At the old 360 x 560 render, even item 1 was cut in half.

- _Severity:_ high (this is the person's main to-do surface).
- _Root cause:_ `TrayPopover.tsx:92`, `screens.css:758-762`.
- _Fix:_ the popover sizes to its content up to a cap. "Needs you" is shown first and in full for
  up to N items, then "Show all (n)" opens the control panel's inbox. Section headers stay fixed.

**L40: Adapter rows: the secondary line truncates and runs into the status column.** _Screens:_
fr-tray, tray.

In `20px 1fr auto`, the `auto` status ("Working · 1 waiting their turn") takes priority and squeezes
the name column. At 360 px, "0.3.0 waiting for review" was cut to "…for revie" and touched the
status dot. At 400 px it fits with about 40 px to spare, so any longer status cuts it off.

- _Severity:_ low.
- _Root cause:_ `.adapter-row` (`screens.css:794`).
- _Fix:_ in the tray, status goes on the second line under the name, or the status column has a
  maximum width with an ellipsis.

**L41: The popover is exactly as wide as its window, and the stat tiles look clickable.**
_Screen:_ tray.

The `.popover` is 400 px in a 400 px transparent window, so its shadow and the rounded corners'
antialiasing are clipped at the window edge. The three stat tiles look like buttons (surface,
border, radius) but they're inert.

- _Severity:_ low.
- _Root cause:_ `app.css:1146`, `windows.ts:26`.
- _Fix:_ window = popover + shadow margin. A tile is either a link (with hover) or styled flat.

### First-run setup

**L42: Blocked steps are almost entirely empty.** _Screens:_ setup-grant, setup-store.

When an earlier step isn't done, the page shows a heading, a lede and one 44 px callout, then
**about 480 px of nothing** above the footer. The rail and the footer dots both show progress, so
there are two progress indicators. "Skip setup" (x = 28) is out of line with the rail text above it
(x = 16).

- _Severity:_ med.
- _Root cause:_ `Setup.tsx`, `screens.css:942-948`.
- _Fix:_ a blocked step shows the blocking step's content inline, or a preview of what it will ask
  for, with a primary action that resolves it. Pick one progress indicator.

**L43: The Welcome step at 880: the H1 wraps and the diagram boxes go uneven.** _Screen:_
setup-welcome at 880 (`shots/setup-welcome-880x560-light.png`).

The 26 px H1 wraps onto 2 lines. The flow diagram's boxes become 160 px tall columns of 6-word
lines. The three "never" cards wrap their titles onto 2 or 3 lines ("Nothing irreversible without
you" is 57 px), and the main point is below the fold.

The 250 px rail takes 28% of the window at 880, while the control panel's sidebar is 212 px, so the
window chrome jumps by 38 px when setup ends.

- _Severity:_ med.
- _Root cause:_ `screens.css:853,986,1026`.
- _Fix:_ the setup rail and the sidebar share one width token. The diagram stacks vertically below
  a width threshold.

### Cross-screen: interaction affordances, text, tokens

**L44: All text is selectable.** _Screens:_ all. _Measured:_ every text-bearing element on every
screen computes to `user-select` other than `none`:

| Screen         | Selectable / text elements                        |
| -------------- | ------------------------------------------------- |
| Adapters       | 93 / 93                                           |
| Adapter detail | 174 / 174                                         |
| Audit log      | 194 / 194                                         |
| Tray           | 40 / 40                                           |
| Setup welcome  | 39 / 39                                           |
| Review         | 102 / 112 (only the diff line numbers are `none`) |

Select-all highlights nav labels, badge counts, button labels and headings
(`shots/select-all-adapters.png`). A drag across a card selects its title.

- _Severity:_ high (named by Nick).
- _Root cause:_ there is no global rule. The only `user-select: none` is `app.css:1052`.
- _Fix:_ chrome is not selectable by default (`body`, nav, buttons, labels, pills, headings).
  Text opts in when it's a value the person may copy: hashes, URLs, hosts, IDs, code, JSON, log
  details, error messages. Those values also get a copy affordance.

**L45: The cursor and hover language follow web conventions, not the Mac.** _Screens:_ all.

- `<a>` elements show the pointing hand. That covers sidebar nav, adapter names, run links,
  breadcrumbs and "Run setup again" (`a:pointer` × 12 on Adapters, × 17 on detail).
- `<button>` shows the arrow (`.btn { cursor: default }`, `tokens.css:139`).
- Table rows show `auto`.

So the same kind of control shows different cursors depending on its HTML tag. Only five `:hover`
rules exist in the whole app (menu rows, setup steps, activity rows). Sidebar nav, table rows,
cards, tiles, chips and pills have no hover state (sidebar hover measured `rgba(0,0,0,0)`).

- _Severity:_ high (feeds "presentational UI").
- _Fix:_ one interaction policy:
  - the arrow cursor for all native-style controls and rows, and the hand only for inline text
    links that leave the app;
  - every interactive surface has hover, pressed, selected and focus-visible states from tokens;
  - anything without those states must not look like a control.

**L46: Hit targets are too small.** _Screens:_ all. _Measured examples:_

| Target                            | Size (px)                                         |
| --------------------------------- | ------------------------------------------------- |
| Switches                          | 32 x 19                                           |
| Checkboxes                        | 13 to 14 square                                   |
| Audit Seq buttons                 | 31 x 19                                           |
| "Details" disclosures             | 47 x 16                                           |
| Breadcrumb "Adapters"             | 56 x 19                                           |
| Run-tool links on the detail page | 58 to 116 x 14                                    |
| Adapter-name links                | 36 to 76 x 16                                     |
| "Go to approval"                  | 83 x 15                                           |
| "Run setup again"                 | 16 high                                           |
| Default buttons                   | 24 high (heights of 20, 24, 26 and 30 px coexist) |

- _Severity:_ med.
- _Fix:_ a minimum target of 24 x 24 px, padded to 28 px for row actions. Controls come in
  explicit sizes (small, regular, large), and each size has one height.

**L47: Contrast falls short in both themes.** _Screens:_ all. _Measured_ against the real
background:

| Text                                                                                             | Background         | Ratio      |
| ------------------------------------------------------------------------------------------------ | ------------------ | ---------- |
| `--text-tertiary` #a1a1a6 (light): setup step subtitles, tray versions, "The adapter wrote this" | #ececef to #f5f5f7 | 2.2 to 2.4 |
| `--text-tertiary` #6e6e73 (dark): sidebar group labels, kbd hints, "FROM THE MANIFEST"           |                    | 2.8 to 3.3 |
| `.badge.write` orange text #ff9f0a: "write", "+1 host", "new host"                               | white              | **2.06**   |
| White on orange: sidebar alert counts "3" and "1", permission marks                              |                    | **2.06**   |
| `.badge.read` green #34c759                                                                      | white              | ~2.2       |
| White on accent #0a84ff: every primary button, 13 px                                             |                    | 3.65       |

On Review the checker found 58 low-contrast text nodes in light mode and 27 in dark (this count
includes a few false positives on gradient avatars).

- _Severity:_ high.
- _Root cause:_ `tokens.css:39,45-50`. Risk colours are used both as fills and as text.
- _Fix:_ separate tokens for the semantic _fill_ and the semantic _text_ (on-surface and on-fill),
  checked to ≥ 4.5:1 for text under 14 px. Tertiary text is for disabled or placeholder only.

**L48: The spacing scale exists but isn't used.** _Code:_ `styles/*.css`, screens.

- 93 margin, padding and gap declarations use `--space-*`. **106 use raw px**, with 17 distinct
  values (6 px × 24, 2, 4, 8 and 10 px × 15 each, 5 px × 10, and 3, 7, 9, 11, 14, 26, 40 and
  44 px).
- About 120 inline `style={{}}` overrides in screen code: ReviewUpdate 17, ClientsSettings 18,
  GrantSheet 13, RemoteConsent 12, Setup 12, AuditLog 11.
- Gaps between stacked cards are 16 px on pages and 12 px on Review, Setup and Grant.
- Card-body padding is overridden to `2px 16px` in 5 places.
- The key/value label column has four widths: 132, 92, 120 and 150 px (`app.css:514`,
  `screens.css:114,549,1039`).

- _Severity:_ med (it's why gaps look random).
- _Fix:_ adopt the tokens strictly, with a lint rule (no raw px for spacing, no inline layout
  styles). Semantic spacing tokens: inset-page, inset-card, gap-section, gap-stack, gap-inline. One
  key/value component with one label width per density.

**L49: Too many type sizes and radii.** _Code:_ `styles/*.css`.

- Rendered font sizes: 10, 10.5, 11, 11.5, 12, 13, 15, 20, 22 and 26 px. Raw sizes outside the
  token scale appear at `app.css:887,903`, `screens.css:301,381,419,506,513,578,592,839`.
- Border radii: 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 50% and 999 px. Only 8 of 57 radius
  declarations use a token.
- 10 to 11 px text carries a lot of meaning: KPIs, provenance labels, help.

- _Severity:_ med.
- _Fix:_ a type ramp of about 6 steps (caption 11, footnote 12, body 13, emphasised body 13
  semibold, title3 15, title2 20, title1 26), with mono variants. No text smaller than 11 px. A
  radius scale of 3 or 4 steps tied to component size.

**L50: Long values are truncated by hand, in different ways.** _Screens:_ adapters, detail,
review, audit, credentials, confirm, tray.

- Hashes are cut in the middle in code (`9f3c1a7e…e0f1` and `sha256:9f3c1a7e52d4…c8d9e0f1`), with
  two lengths and only a `title` tooltip.
- URLs and hosts are hard-clipped (audit), end-truncated (sidebar runs, blocked requests:
  `collect.tealiumiq.com/…`), or overflow (trace, permissions).
- The endpoint URL ends in an ellipsis at 360 px in the tray.

- _Severity:_ med.
- _Fix:_ a single `Value` primitive for hash, URL, host, path and ID:
  - mono;
  - middle truncation for hashes and IDs, end truncation for paths;
  - the full value on hover;
  - copy on click or from a context menu;
  - selectable, which is the only selectable text (see L44).

---

## Cross-cutting layout principles for the redesign

1. **One spacing scale, with semantic tokens.**
   - Primitives: 2, 4, 8, 12, 16, 24 and 32 px.
   - Semantics: `space-page-inset`, `space-section`, `space-card-inset`, `space-stack`,
     `space-inline` and `space-control-gap`.
   - Raw px for spacing and inline layout styles are banned by lint.
2. **A fixed window frame.**
   - The title bar is one height across the window. The sidebar's top area is reserved for traffic
     lights and filled.
   - The sidebar is a fixed nav, an optional scroll list and a fixed footer, with the same
     structure in every section.
   - The page body always starts at the same inset.
3. **One page header pattern.**
   - The title bar holds navigation and view controls: back, breadcrumb, segmented view switch,
     search.
   - The page header holds the title (a real title size), status and the primary action.
   - A pending action is a button or banner in the header, never a status pill.
4. **Page archetypes with defined widths.**
   - _List and detail split_ (Activity, Audit, Adapters, Clients): the list pane and an inspector
     pane that can be resized or collapsed.
   - _Document_ (detail, review, settings, remote): one readable column of about 680 to 760 px,
     with an optional sticky side column at ≥ 1100 px.
   - _Dashboard_ (overview): a tile grid that reflows.
   - Each page uses exactly one archetype.
5. **Designed for 880 x 560 first.**
   - Every layout has a defined collapse at the minimum size: side columns stack, inspectors
     collapse, grids reflow (`minmax` or auto-fill, container queries), tables drop low-priority
     columns.
   - There is never horizontal scroll at page level, and nothing is ever clipped silently.
6. **Scroll regions are explicit.**
   - Exactly one primary scroll region per pane. Headers, toolbars and decision footers are sticky
     outside it.
   - Vertical page flow never uses shrinkable grid rows.
   - Every nested scroller declares its size and shows an edge fade or count when content
     continues ("+2 more").
7. **Cards don't stretch to their neighbours.**
   - Equal height only for summary tiles of the same kind, with actions pinned to the foot.
   - Content cards are content-sized and top-aligned.
   - Don't line up two independent card stacks side by side.
8. **Text selection policy.**
   - The app's chrome is not selectable: `user-select: none` on `body`.
   - Values, code, IDs, hashes, URLs, JSON, log details and error text opt in with a `selectable`
     or `Value` primitive, and also get copy.
9. **Interaction states are mandatory, and anything without them looks inert.**
   - Arrow cursor for controls and rows, hand only for external text links.
   - Every interactive element has hover, pressed, selected, focus-visible and disabled tokens.
   - Whole rows are targets with keyboard navigation.
   - Tiles and summaries either link somewhere or are styled flat.
10. **Control sizing.**
    - Three control sizes with fixed heights (for example 22, 28 and 34 px).
    - A 24 px minimum hit target.
    - Row actions go in an overflow menu, with one visible primary action.
11. **Colour roles for contrast.**
    - Separate _fill_, _on-fill_ and _text-on-surface_ tokens for each semantic (read, write,
      irreversible, secret, info), each ≥ 4.5:1 for small text in both themes.
    - Tertiary text is reserved for placeholder or disabled.
    - Native window background colours come from the theme.
12. **Focus.**
    - The token ring applies on `:focus-visible` only.
    - Programmatically focused containers show no ring.
    - "Default button" is shown by style, never by a permanent focus ring.
13. **Chromeless windows.**
    - Each has a drag area, a fixed footer for its decision and a scrolling body.
    - Title-bar insets for traffic lights apply to the title row only.
    - The window size includes room for the shadow (tray).
14. **Value presentation.** One `Value` component (mono, truncation rule by kind, tooltip, copy)
    and one `KeyValue` component (one label width per density) replace the hand-made variants.
15. **Type ramp and radii.**
    - About 6 text styles, nothing under 11 px.
    - A radius scale of 3 or 4 steps (control, card, sheet, pill).
    - Each of them is defined once in tokens and used through components.
