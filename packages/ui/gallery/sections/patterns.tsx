import { Stack, Text } from '../../src'
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
    </GalleryPage>
  )
}
