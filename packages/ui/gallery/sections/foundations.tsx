import { Inline, Stack, Text } from '../../src'
import { cn } from '../../src/lib/cn'
import { color, fontSize, palette, radius, space } from '../../src/tokens'
import { GalleryPage, Specimen } from './frame'

const groups: { title: string; prefix: string[] }[] = [
  { title: 'Surfaces', prefix: ['bg-'] },
  { title: 'Text and icons', prefix: ['fg-'] },
  { title: 'Lines', prefix: ['border-'] },
  { title: 'Accent', prefix: ['accent-'] },
  { title: 'Status', prefix: ['success-', 'warning-', 'danger-', 'info-'] },
  { title: 'Risk', prefix: ['risk-'] },
  { title: 'Diff, code and delight', prefix: ['diff-', 'code-', 'brass-'] },
]

function SemanticGrid({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      data-theme={theme}
      className="flex flex-col gap-5 rounded-lg bg-canvas p-5 ring-[0.5px] ring-line ring-inset"
    >
      <Text size="sm" weight="semibold">
        {theme === 'light' ? 'Light' : 'Dark'}
      </Text>
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{g.title}</span>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.keys(color)
              .filter((k) => g.prefix.some((p) => k.startsWith(p)))
              .map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span
                    className="size-6 shrink-0 rounded-xs ring-[0.5px] ring-line ring-inset"
                    style={{ background: `var(--${k})` }}
                  />
                  <code className="selectable truncate text-xs text-fg-muted">{k}</code>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function FoundationsSection() {
  return (
    <GalleryPage
      title="Foundations"
      intro="Primitive tokens are the raw palette and scales. Semantic tokens say what a value is for, per theme, and are the only thing components use. Every text pair here is tested for WCAG contrast in both themes."
    >
      <Specimen
        title="Primitive palette"
        notes="OKLCH, so each step is the same perceived lightness across hues. Graphite neutrals with a faint ink cast; ink blue is the single accent; green, amber, red and violet carry status and risk; brass is for delight only."
      >
        <Stack gap={2}>
          {Object.entries(palette).map(([name, scale]) => (
            <div key={name} className="grid grid-cols-[64px_1fr] items-center gap-3">
              <span className="text-sm font-medium text-fg-muted">{name}</span>
              <div className="grid grid-cols-14 overflow-hidden rounded-md ring-[0.5px] ring-line ring-inset">
                {Object.entries(scale).map(([step, value]) => (
                  <div
                    key={step}
                    className="flex h-11 items-end p-1"
                    style={{ background: value }}
                    title={`${name}.${step} ${value}`}
                  >
                    <span
                      className={cn(
                        'text-2xs font-medium',
                        Number(step) >= 500 ? 'text-white/85' : 'text-black/60',
                      )}
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Stack>
      </Specimen>

      <Specimen
        title="Semantic colour"
        notes="The same names, two themes. Components never reach past these into the palette."
      >
        <div className="grid grid-cols-2 gap-4">
          <SemanticGrid theme="light" />
          <SemanticGrid theme="dark" />
        </div>
      </Specimen>

      <Specimen
        title="Type"
        notes="Inter and JetBrains Mono are bundled, so text looks the same on macOS, Windows and Linux. 13 px is body: dense enough for a 1180 × 780 window, readable at arm's length. Weights are slightly off the usual stops (420, 520, 620) because Inter is a variable font and these read best on both low- and high-DPI screens."
      >
        <Stack gap={3}>
          {(Object.entries(fontSize) as [string, number][])
            .slice()
            .reverse()
            .map(([k, v]) => (
              <div key={k} className="grid grid-cols-[96px_1fr] items-baseline gap-4">
                <code className="selectable text-xs text-fg-subtle">
                  text-{k} · {v}
                </code>
                <span style={{ fontSize: v }} className={cn(v >= 22 ? 'font-semibold tracking-tight' : '')}>
                  Valet adds three items to the trolley
                </span>
              </div>
            ))}
          <div className="grid grid-cols-[96px_1fr] items-baseline gap-4">
            <code className="selectable text-xs text-fg-subtle">mono · 12</code>
            <span className="font-mono text-sm">sha256:a1b2c3d4e5f6 woolworths.update_cart</span>
          </div>
        </Stack>
      </Specimen>

      <Specimen
        title="Spacing"
        notes="A 4 px grid. Sections 24 apart, items in a section 12, items in a group 8, a label to its control 6."
      >
        <Stack gap={1.5}>
          {Object.entries(space)
            .filter(([k]) => k !== 'px' && k !== '0')
            .map(([k, v]) => (
              <div key={k} className="grid grid-cols-[96px_1fr] items-center gap-4">
                <code className="selectable text-xs text-fg-subtle">
                  {k} · {v}px
                </code>
                <span className="h-3 rounded-xs bg-accent-solid/70" style={{ width: v }} />
              </div>
            ))}
        </Stack>
      </Specimen>

      <div className="grid grid-cols-2 gap-6">
        <Specimen
          title="Radius"
          notes="Controls 6, cards 12, dialogs 16. Nested corners shrink by the padding."
        >
          <Inline gap={4}>
            {Object.entries(radius)
              .filter(([k]) => k !== 'full')
              .map(([k, v]) => (
                <div key={k} className="flex flex-col items-center gap-1.5">
                  <span
                    className="size-12 bg-accent-soft ring-1 ring-accent-solid/40 ring-inset"
                    style={{ borderRadius: v }}
                  />
                  <code className="text-xs text-fg-subtle">{k}</code>
                </div>
              ))}
          </Inline>
        </Specimen>
        <Specimen
          title="Elevation"
          notes="Four layers. In dark mode an inner hairline does most of the work."
        >
          <Inline gap={4}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex flex-col items-center gap-1.5">
                <span
                  className="size-14 rounded-lg bg-raised"
                  style={{ boxShadow: `var(--elevation-${n})` }}
                />
                <code className="text-xs text-fg-subtle">shadow-{n}</code>
              </div>
            ))}
          </Inline>
        </Specimen>
      </div>

      <Specimen
        title="Materials"
        notes="Floating layers use a platform material. macOS: Liquid Glass (translucent, blurred, saturated, a specular rim, and refraction on large surfaces). Windows and Linux: frost. Reduced transparency or high contrast: solid. Switch the platform in the sidebar."
        className="wallpaper relative overflow-hidden p-0"
      >
        <div className="relative grid h-72 grid-cols-3 gap-6 p-8">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[120px] font-bold tracking-tight text-fg/20">
            Valet
          </div>
          <div className="material-floating relative flex flex-col justify-end rounded-xl p-4">
            <Text weight="semibold">material-floating</Text>
            <Text size="sm" tone="muted">
              Menus, tooltips, toasts
            </Text>
          </div>
          <div
            data-glass="refract"
            className="material-floating relative flex flex-col justify-end rounded-xl p-4"
          >
            <Text weight="semibold">refract</Text>
            <Text size="sm" tone="muted">
              Command palette, tray panel
            </Text>
          </div>
          <div className="relative flex flex-col justify-end rounded-xl bg-raised p-4 shadow-3 ring-[0.5px] ring-line ring-inset">
            <Text weight="semibold">solid</Text>
            <Text size="sm" tone="muted">
              Fallback, sheets, dialogs
            </Text>
          </div>
        </div>
      </Specimen>
    </GalleryPage>
  )
}
