import {
  BrowserBar,
  Button,
  CheckItem,
  CheckList,
  ConfirmationPanel,
  Disclosure,
  HandoffBanner,
  SiteAvatar,
  Stack,
  Text,
} from '../../src'
import { GalleryPage, Specimen } from './frame'
import { SampleApp, SampleTray } from './sample-app'

const principles = [
  [
    'One scroll region per pane',
    'The page header (title, actions, tabs) never scrolls away; only PageBody does. A primary button can never fall below the window edge.',
  ],
  [
    'Design at 880 × 560 first',
    'The smallest window. Layouts that hold there hold at 1180 × 780 and beyond; extra width goes to content, not gaps.',
  ],
  [
    'Gaps, not margins',
    'Stack and Inline own spacing (24 / 12 / 8 / 6). A missing item leaves no stray gap.',
  ],
  ['Reading width', 'Forms and settings cap at 760 px, prose at 640. Tables and lists use the full width.'],
  [
    'Every object is a link',
    'A site, call, client, credential or hash named anywhere links to it, with a hover card and a context menu. Badges label; they are never the only way in.',
  ],
  [
    'The fix sits with the problem',
    'A banner about something actionable carries the action (Review update on the adapter page, not only in the tray).',
  ],
  [
    'Chrome is not text',
    'Labels and headings are not selectable and keep the arrow cursor. Values (IDs, hashes, URLs, logs) are, with a copy button.',
  ],
  [
    'One primary per view',
    'Secondary to its left. Destructive actions confirm and name the consequence, or offer Undo.',
  ],
  [
    'Keyboard first',
    '⌘K reaches everything. Arrow keys within groups, Tab between them, Escape closes the top layer.',
  ],
] as const

export function PatternsSection() {
  return (
    <GalleryPage
      title="Layout and patterns"
      intro="The rules every screen follows, and a sample adapter page and tray built only from the system at the real window size."
    >
      <Specimen title="Layout principles">
        <div className="grid grid-cols-3 gap-4">
          {principles.map(([title, body]) => (
            <Stack key={title} gap={1}>
              <Text weight="semibold">{title}</Text>
              <Text size="sm" tone="muted">
                {body}
              </Text>
            </Stack>
          ))}
        </div>
      </Specimen>
      <Specimen
        title="Control panel at 1180 × 780"
        notes="Sidebar 224, header with breadcrumb, tabs and actions, one scroll region, form width. The update banner carries its Review action on the adapter page itself."
        className="overflow-hidden p-0"
      >
        <div className="h-[780px] w-full overflow-hidden" style={{ width: 1180, maxWidth: '100%' }}>
          <SampleApp />
        </div>
      </Specimen>
      <Specimen
        title="Tray panel"
        notes="Liquid Glass with refraction on macOS. The same inbox item, with its action, as on the home page."
        className="wallpaper flex justify-center p-10"
      >
        <SampleTray />
      </Specimen>
      <Specimen
        title="Confirmation window"
        notes="Named by Valet's title. A change that can be put back gets a primary Allow; only an irreversible step says Can't be undone. Decline has focus, so Return and Escape decline."
        className="flex flex-wrap justify-center gap-6 p-6"
      >
        <div className="h-[460px] w-[440px] max-w-full overflow-hidden rounded-xl shadow-3 ring-[0.5px] ring-line">
          <ConfirmationPanel
            site={<SiteAvatar id="woolworths" name="Woolworths" />}
            title="Remove 2 items from your trolley?"
            sentence="Valet will remove oat milk and sourdough from your Woolworths trolley."
            fromSite="Remove items: oat milk 2L, sourdough loaf"
            purpose="write"
            allowLabel="Remove 2 items"
            declineLabel="Don't remove"
            state="ready"
            queue={{ position: 1, total: 4 }}
            details={
              <Disclosure summary="Details">
                <CheckList label="What Valet checked">
                  <CheckItem state="pass" title="The Woolworths adapter is the version you approved" />
                  <CheckItem state="pass" title="The trolley holds both items" />
                  <CheckItem state="info" title="Claude asked at 9:48 pm" />
                </CheckList>
              </Disclosure>
            }
            onAllow={() => {}}
            onDecline={() => {}}
          />
        </div>
        <div className="h-[460px] w-[440px] max-w-full overflow-hidden rounded-xl shadow-3 ring-[0.5px] ring-line">
          <ConfirmationPanel
            site={<SiteAvatar id="woolworths" name="Woolworths" />}
            title="Place this order?"
            sentence="Valet will place your Woolworths order: 14 items, $86.40, delivery tomorrow 7 to 9 am."
            purpose="irreversible"
            allowLabel="Place order"
            state="arming"
            armingReason="Available in 2 s, so a stray click can't place it"
            until={Date.now() + 4 * 60_000}
            onAllow={() => {}}
            onDecline={() => {}}
          />
        </div>
      </Specimen>
      <Specimen
        title="Login hand-off"
        notes="Valet's own chrome over the site's page: host first in the address strip, and the hand-off strip where the person finishes a code and says I'm done."
      >
        <Stack gap={4}>
          <div className="overflow-hidden rounded-lg ring-[0.5px] ring-line">
            <HandoffBanner
              site="Woolworths"
              state="waiting"
              until={Date.now() + 5 * 60_000}
              onDone={() => {}}
              onCancel={() => {}}
            />
            <BrowserBar
              url="https://auth.woolworths.com.au/login/verify"
              typedInto="woolworths.com.au, auth.woolworths.com.au"
            />
            <div className="flex h-28 items-center justify-center bg-canvas text-sm text-fg-subtle">
              The site's page
            </div>
          </div>
          <div className="overflow-hidden rounded-lg ring-[0.5px] ring-line">
            <HandoffBanner site="Woolworths" state="not-yet" onDone={() => {}} onCancel={() => {}} />
          </div>
          <div className="overflow-hidden rounded-lg ring-[0.5px] ring-line">
            <HandoffBanner
              site="Woolworths"
              state="success"
              onDone={() => {}}
              onCancel={() => {}}
              onClose={() => {}}
            />
          </div>
        </Stack>
      </Specimen>
      <Specimen
        title="Check list"
        notes="Setup steps, what Valet checked, the live test run. Each outcome has its own icon and word."
      >
        <CheckList label="Testing Woolworths" live>
          <CheckItem state="pass" title="Signed in as tess@example.com" />
          <CheckItem state="pass" title="Store set: Bondi Junction" />
          <CheckItem
            state="fail"
            title="Read your trolley"
            detail="The site answered too slowly. Valet will try again in 30 s."
            action={<Button size="sm">Try now</Button>}
          />
          <CheckItem state="pending" title="Search products" />
          <CheckItem state="skipped" title="Place an order (never tested; it can't be undone)" />
        </CheckList>
      </Specimen>
    </GalleryPage>
  )
}
