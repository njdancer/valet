# Valet design system

`packages/ui` (`@valet/ui`) is the one source of Valet's look, layout and motion: tokens, ~50 React
components on Radix primitives in the shadcn style, Tailwind v4 utilities that read only the tokens,
platform materials (Liquid Glass on macOS), and a gallery that shows all of it.

- Gallery: `pnpm --filter @valet/ui gallery` (dev server), `gallery:build` (static, to `dist/gallery`).
  Routes: Foundations, Motion and delight, Actions and inputs, Overlays, Data and status, Layout and
  patterns, and the Motion showcase (`#/showcase?autoplay=1`). Theme, platform material and reduced
  motion switch in its sidebar or with `?theme=dark&platform=windows&motion=reduce`.
- Tokens: edit `src/tokens/*.ts`, then `pnpm --filter @valet/ui tokens` to regenerate
  `src/styles/tokens.css` and `theme.css`. A test fails if they're stale.
- Tests: `pnpm exec vitest run --project ui` (unit and axe for every component, WCAG contrast for every
  semantic text pair in both themes) and `pnpm --filter @valet/ui test:gallery` (axe, keyboard and
  reduced-motion checks on the built gallery in Chromium).

## Direction

Nick asked (2026-11-11) for a look that is good on every OS rather than an imitation of macOS, with
Liquid Glass on Apple platforms for floating elements. The result is "quiet concierge":

- **Type** is bundled (Inter Variable, JetBrains Mono Variable), so Valet reads the same on macOS,
  Windows and Linux. 13 px body, a dense desktop scale (10 to 36).
- **Colour**: graphite neutrals with a faint ink cast, one ink-blue accent for action, focus and
  selection; green, amber, red and violet carry status and risk; **brass** is reserved for delight
  (the mark, the approval seal, setup's sparks). OKLCH, so every hue steps at the same lightness.
- **Shape**: 6 px controls, 12 px cards, 16 px dialogs; hairline (0.5 px) rings rather than borders;
  four elevation levels, with an inner highlight doing the work in dark mode.
- **Materials**: floating layers (popovers, menus, tooltips, toasts, the command palette, the tray)
  are glass on macOS, frost on Windows and Linux, solid with reduced transparency or high contrast.

## Tokens

Two layers. **Primitives** (`src/tokens/primitives.ts`): the palette scales (gray, blue, green, amber,
red, violet, brass; steps 25 to 950), type sizes and weights, the 4 px space scale, radii, durations,
easings, z-index layers, breakpoints. **Semantic** (`src/tokens/semantic.ts`): what each value is for,
per theme. Components use only semantic tokens.

| Group     | Tokens (Tailwind name)                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------- |
| Surfaces  | `canvas`, `sidebar`, `surface`, `raised`, `sunken`, `inset`, `hover`, `pressed`, `selected`, `backdrop` |
| Text      | `fg`, `fg-muted`, `fg-subtle`, `fg-disabled`, `fg-on-accent`, `fg-on-selected`, `fg-link`               |
| Lines     | `line-subtle`, `line`, `line-strong`, `line-control`, `line-focus`                                      |
| Accent    | `accent-solid`, `accent-solid-hover`, `accent-soft`, `accent-fg`                                        |
| Status    | `{success,warning,danger,info}-{solid,soft,fg,border}`                                                  |
| Risk      | `risk-{read,write,irreversible,secret}-{fg,soft}`                                                       |
| Other     | `diff-{add,del}-{bg,fg}`, `brass-{solid,soft,fg}`, `code-bg`, `code-fg`                                 |
| Elevation | `shadow-1` … `shadow-4`                                                                                 |
| Materials | `material-floating` (glass / frost / solid by platform), `material-sidebar`                             |
| Motion    | `--v-duration-{instant,fast,base,slow,slower,glacial}`, `ease-{standard,enter,exit,emphasized,spring}`  |

Every text pair in `contrastPairs` is tested at 4.5:1 (7:1 for body text on surfaces) in both themes;
focus rings, solid fills and control edges at 3:1 (WCAG 1.4.11). High contrast (`prefers-contrast:
more`) strengthens every line.

## Layout

1. **One scroll region per pane.** `Page` = `PageHeader` (breadcrumb, title, description, actions,
   tabs) + `PageBody` (the only thing that scrolls) + optional `ActionBar`. A primary button can never
   fall below the window edge.
2. **Design at 880 × 560 first** (the minimum window); 1180 × 780 is the default. Extra width goes
   to content. `SplitView` answers to its own width with container queries: the inspector folds under
   the detail below 760 px; below 880 px only the detail shows when something is selected.
3. **Gaps, not margins.** `Stack` and `Inline` own spacing: 24 between sections, 12 inside a section,
   8 inside a group, 6 from a label to its control. A missing item leaves no stray gap.
4. **Reading width**: forms and settings 760 px (`PageBody width="form"`), prose 640, tables full.
5. **Sheets over context**: a task that belongs to the page (grant a login, choose a store) is a
   `SheetContent` dropping from the top edge; detail for a list item is a `DrawerContent` from the
   right; a short self-contained question is a `DialogContent`; a destructive confirmation is a
   `ConfirmDialog` that starts on Cancel and names the consequence.

## Interaction rules

- **Chrome is not text.** `body` is `user-select: none` with the arrow cursor. Values a person may
  copy opt back in: `Value` (with `copy`), `Code`, `CodeBlock`, `HashChip`, `DescriptionList` values,
  `Diff` lines, inputs. Use the `selectable` class for anything else that should be.
- **Every object is a link.** A site, call, app, login, version or audit record named anywhere is an
  `ObjectLink` (with a hover card) or a row link. `Badge`, `RiskBadge` and `StatusDot` only label; the
  action sits next to them as a `Button` whose name includes the object ("Review Woolworths update").
- **The fix sits with the problem.** A `Banner` about something actionable carries the action. An
  update waiting is shown on the site's page with its Review button, not only in the tray.
- **One primary per view.** Secondary to its left. Danger only for what can't be undone;
  `ConfirmDialog` (focus on Cancel, the consequences named) for Reset, Uninstall and erase.
  `HoldToConfirm` is optional emphasis for an in-flow commit such as placing an order; a screen
  reader click on it opens the same confirm dialog, so it never gates anyone on a gesture.
- **Disabled explains itself.** `Button disabledReason="…"` stays focusable, shows the reason as a
  tooltip and reads it as its description.
- **Keyboard first.** `⌘K`/`Ctrl+K` (`CommandPalette`) reaches every page, site, call and action.
  Arrow keys within composite widgets (menus, tabs, segmented, radio, table rows, timeline steps, tray
  rows), Tab between them, Escape closes the top layer and returns focus.
- **Shortcuts are written once.** Pass `"mod+K"`, `"mod+shift+P"`, `"alt+T"` to `shortcut` props and
  `<Shortcut keys>`; they show as ⌘K on macOS and Ctrl+K on Windows and Linux (`formatShortcut`), and
  `IconButton` sets `aria-keyshortcuts`. Never hard-code ⌘.
- **Cursor.** The arrow for every control (buttons, switches, tabs, menu items, rows that are
  buttons), as native apps do. The pointing hand only for links: `TextLink`, `ObjectLink`, row links,
  breadcrumbs.
- **Actions in a row are visible buttons.** A row's action is a small secondary `Button` with a
  verb and an object ("Change store"), never quiet grey text that reads as a label. Icon-only actions
  in rows are `IconButton`s with a tooltip.
- **Context menus are shortcuts, not the only path.** A `ContextMenuTrigger` wraps a focusable row
  link or button (so Shift+F10 and the Menu key work), and every item in it is also in a visible
  "More actions" `DropdownMenu`.
- **Risk is not status.** `RiskBadge` (Reads, Changes, Can't be undone) is square-cornered and
  outlined with an icon (eye, pencil, stop sign). Status (`Badge` tones, `StatusDot`) is a round soft
  pill. The two never share a shape, so "Can't be undone" never reads as "Error".
- **Announce arrivals, not furniture.** `Banner live` and `InboxItem appear` are for things that
  arrived while the page was open; they are announced and animate in. What is there on load is
  neither. `DeadlineChip subject="Woolworths code"` names what an announcement is about.
- **Selection is more than colour.** Selected rows, nav items and timeline steps get
  `aria-current` and a 2 px accent bar as well as the selected fill.
- **Accessibility floors** (tested): text 4.5:1 including `fg-subtle`; control edges 3:1
  (`border-control`, 1 px); targets 24 px (hit areas extend past small checkboxes and switches);
  Windows High Contrast (`forced-colors`) gives every control a system-colour border and every
  selection an outline; `prefers-contrast: more` firms borders; reduced motion stops travel
  (`data-travel`) and slides but keeps fades.

## Motion

Principles: motion explains where things come from and go; fast in, faster out; **distance is a
token** (`--v-motion-distance`, set to 0 by `prefers-reduced-motion`, so entrances still fade but
nothing travels or zooms); delight is rare and earned.

| Animation (`animate-*`)            | Use                                                        |
| ---------------------------------- | ---------------------------------------------------------- |
| `pop-in` / `pop-out`               | Popovers, menus, tooltips, from their trigger              |
| `dialog-in` / `dialog-out`         | Dialogs, the command palette                               |
| `sheet-in` / `sheet-out`           | Sheets, from the window's top edge                         |
| `drawer-in` / `drawer-out`         | Drawers, from the right                                    |
| `rise-in`                          | New content in a page: banners, list items, errors         |
| `collapse-open` / `collapse-close` | Disclosure and accordion height                            |
| `shimmer`, `pulse-ring`, `spin`    | Loading, waiting on the person (stopped by reduced motion) |
| `seal`, `draw`, `bump`, sparkle    | Delight: approval sealed, test call worked, setup done     |

Switch thumbs, the segmented pill and the tab underline travel on the spring curve. Buttons dip
slightly when pressed (`press`). Page changes can crossfade with the View Transitions API
(`::view-transition-*` rules are in `motion.css`; call `document.startViewTransition` on navigation).

## Materials and Liquid Glass

`material-floating` reads `data-platform` on `<html>` (`applyPlatform(document.documentElement,
detectPlatform(navigator.userAgent))`):

- `mac`: Liquid Glass. Translucent (`--material-glass-bg`), `backdrop-filter: blur(22px)
  saturate(185%)`, a specular rim and sheen. With `data-glass="refract"` it also bends what's behind it
  through the SVG displacement filter `<GlassFilter />` adds (Chromium supports `url()` in
  `backdrop-filter`). Used for the command palette and the tray panel.
- `windows`, `linux`: frost (less translucency, lighter blur).
- Reduced transparency or high contrast: solid with a stronger edge.

Inside a window the CSS can only blur the window's own content. For the tray popover's window itself
to be glass over the desktop, the main process should create it with `transparent: true`,
`vibrancy: 'popover'` and `visualEffectState: 'active'` on macOS, and `backgroundMaterial: 'acrylic'`
on Windows 11; the page background is then transparent and `TrayPanel` adds the rim and sheen.
The control window can opt in to sidebar vibrancy (`vibrancy: 'sidebar'`) and set
`data-vibrancy="sidebar"` on `<html>`. Paint every window with `backgroundColor` matching
`--bg-canvas` for the current theme so it never flashes white.

## Integrating into apps/desktop

1. Add `@valet/ui` to `apps/desktop` dependencies and `@tailwindcss/vite` to both renderer configs
   (`vite.config.ts` and the `renderer` section of `electron.vite.config.ts`).
2. In `control.tsx` and `tray.tsx` import `@valet/ui/styles.css` instead of `styles/*.css`; add
   `@source "../../src/renderer";` (relative to the CSS entry) if the app keeps its own classes.
3. Wrap each root in `<TooltipProvider>`, and add `<Toaster />` and `<GlassFilter />`. Call
   `applyPlatform` (or set `data-platform` from the main process's `process.platform`) and follow the
   person's theme setting with `applyTheme`.
4. Replace `components/ui.tsx` pieces: `Icon` with lucide icons, `Avatar` with `SiteAvatar`,
   `SideEffect` with `RiskBadge`, `SecretBadge`, `Hash` with `HashChip`, `Segmented`, `Switch`,
   `LoadState` with `Skeleton`/`EmptyState`/`Banner`, `Spark` with `Sparkline`.
5. Build each page from `Page`/`PageHeader`/`PageBody` and the IA in `docs/ux/` (the UX thread's
   wireframes name these components).
6. CSP: the renderer's `style-src 'self'` blocks runtime `<style>` tags. Sonner's base CSS is
   imported into the stylesheet and Radix Select's scrollbar rule is restated there, so both work.
   `react-remove-scroll` (inside Radix Dialog) still logs a blocked style while a dialog is open; it
   only locks body scrolling, which the app shell doesn't have, so it's harmless.

## Component catalogue

| Area        | Components                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions     | `Button` (primary, secondary, ghost, quiet, danger, danger-soft, link; sm 24, md 28, lg 36; loading; disabledReason), `IconButton`, `SplitButton`, `HoldToConfirm`, `CopyButton` (icon or labelled), `RetryPopover`                                                                                                                                                                                                                                 |
| Inputs      | `Field`, `Label`, `Input`, `SearchInput`, `Textarea`, `Checkbox`, `Switch` (pending), `RadioGroup`/`RadioOption`, `CheckboxOption`, `ChoiceCard`, `Select`, `Segmented`                                                                                                                                                                                                                                                                             |
| Status      | `Badge`, `RiskBadge`/`RiskGlyph`, `SecretBadge`, `StatusDot`, `Count`, `HealthLine`, `DeadlineChip` (countdown or clock, md or lg), `CheckedAt`, `OutcomeBadge`, `CheckList`/`CheckItem`, `HandoffBanner`, `Banner`, `ShellStatus`, `Progress`, `Skeleton`, `Spinner`                                                                                                                                                                               |
| Objects     | `ObjectLink` (kind, copyValue, contextual name), `HashChip`, `SiteAvatar`, `Value`, `Code`, `CodeBlock`, `Kbd`, `Shortcut`, `TextLink`, `BrowserBar`                                                                                                                                                                                                                                                                                                |
| Collections | `List`/`ListRow`, `Table` (compact, bare; `TH`/`TD` priority hides columns when narrow)/`THead`/`TBody`/`TR`/`TH`/`TD`/`RowLink`, `DescriptionList`, `Diff`, `ChangeList` (widens, adds, removes, same), `CodeDiff` (unified or split), `Timeline`, `Sparkline`, `CanReach` (callers, reachedBy, basis, badges, collapsed, live), `InboxList`/`InboxItem`/`NeedsYouItem`, `useRowNavigation` (roving rows: ↑↓, Return, mod+C, Delete), `EmptyState` |
| Navigation  | `AppShell`, `Sidebar`/`SidebarGroup`/`SidebarFooter`/`NavItem`, `TitleBar`, `Toolbar`, `Tabs`, `NavTabs`, `Breadcrumb`, `Stepper` (with blocked), `CommandPalette`, `FilterBar` (live count)/`FilterSelect`/`FilterChip`/`AddFilter`                                                                                                                                                                                                                |
| Layout      | `Page`, `PageHeader` (status, overflowActions), `PageBody`, `ActionBar`, `Section`, `SplitView`, `Stack`, `Inline`, `Spacer`, `Card`, `Separator`                                                                                                                                                                                                                                                                                                   |
| Overlays    | `DialogContent`, `SheetContent`, `DrawerContent`, `ConfirmDialog`, `Popover`, `Tooltip`, `DropdownMenu`, `ContextMenu`, `Toaster`/`toast`/`toast.undo` (mod+Z runs the newest Undo)                                                                                                                                                                                                                                                                 |
| Windows     | `ConfirmationPanel` (arming, ready, expired, answered; write or irreversible), `TrayPanel` (autoFocus)/`TrayHeader`/`TrayBody`/`TraySection` (more)/`TrayRow` (two-line, deadline, verb, urgent)/`TrayMenuItem`/`TrayFooter`                                                                                                                                                                                                                        |
| Delight     | `ValetMark`, `ApprovalSeal`, `SuccessCheck`, `Sparkle`, `AnimatedNumber`, `GlassFilter`                                                                                                                                                                                                                                                                                                                                                             |

## Assumptions recorded (Nick was asleep)

- Visual identity: ink blue accent, brass delight, bundled Inter and JetBrains Mono. A brand change
  is a token edit.
- The mark is a brass bow tie on an ink tile, replacing the placeholder icon in the app only once
  Nick has seen it (the packaged icon is out of scope here).
- Control heights are 24/28/36, not the wireframe kit's 22/28/34, because 22 px fails WCAG 2.5.8's
  24 px target size.
- Site avatars use a stable hue per adapter id, never a site's real brand colours or marks.
