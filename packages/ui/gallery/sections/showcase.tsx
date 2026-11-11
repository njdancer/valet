// The motion showcase: a choreographed tour of the system's motion, scene by scene. It plays on
// its own (for the recorded video) and can be stepped by hand. ?autoplay=1 starts it at once;
// ?scene=N jumps to a scene.
import { ChevronLeft, ChevronRight, Pause, Play, Search, Store } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  AnimatedNumber,
  ApprovalSeal,
  Badge,
  Banner,
  Button,
  Diff,
  HealthLine,
  Inline,
  Kbd,
  Progress,
  RiskBadge,
  Segmented,
  SiteAvatar,
  Sparkle,
  Stack,
  Stepper,
  SuccessCheck,
  Switch,
  Text,
  ValetMark,
} from '../../src'
import { cn } from '../../src/lib/cn'
import { palette } from '../../src/tokens'
import { SampleTray } from './sample-app'

type Scene = { id: string; title: string; caption: string; ms: number; view: (t: number) => ReactNode }

/** Calls back with elapsed ms while mounted, so scenes can script their beats. */
function useElapsed(playing: boolean, resetKey: unknown): number {
  // The time is stored with the scene it was measured in, so a new scene never sees the last one's.
  const [state, setState] = useState<{ t: number; key: unknown }>({ t: 0, key: resetKey })
  const start = useRef(0)
  const offset = useRef(0)
  const key = useRef(resetKey)
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey restarts the clock
  useEffect(() => {
    key.current = resetKey
    offset.current = 0
    start.current = performance.now()
    setState({ t: 0, key: resetKey })
  }, [resetKey])
  useEffect(() => {
    if (!playing) return
    start.current = performance.now() - offset.current
    let frame = 0
    const tick = (now: number) => {
      offset.current = now - start.current
      setState({ t: offset.current, key: key.current })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  return state.key === resetKey ? state.t : 0
}

const at = (t: number, ms: number) => t >= ms

function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-full w-full items-center justify-center', className)}>{children}</div>
}

const scenes: Scene[] = [
  {
    id: 'intro',
    title: 'Valet',
    caption: 'A design system for a quiet concierge.',
    ms: 4200,
    view: (t) => (
      <Stage>
        <Stack gap={5} align="center">
          <Sparkle play={at(t, 700)} key={at(t, 700) ? 'on' : 'off'}>
            <div className="animate-seal">
              <ValetMark size={112} />
            </div>
          </Sparkle>
          <div
            className={cn(
              'flex flex-col items-center gap-2 opacity-0',
              at(t, 900) && 'animate-rise-in opacity-100',
            )}
          >
            <span className="text-4xl font-bold tracking-tight">Valet</span>
            <span className="text-xl text-fg-muted">Design system · motion</span>
          </div>
        </Stack>
      </Stage>
    ),
  },
  {
    id: 'palette',
    title: 'Tokens',
    caption: 'Primitives become semantic tokens. Graphite, one ink-blue accent, brass for delight.',
    ms: 5200,
    view: (t) => (
      <Stage>
        <div className="flex flex-col gap-2">
          {Object.entries(palette).map(([name, scale], row) => (
            <div key={name} className="flex gap-1.5">
              {Object.values(scale).map((v, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional
                  key={i}
                  className="size-11 animate-pop-in rounded-md"
                  style={{ background: v, animationDelay: `${row * 90 + i * 28}ms` }}
                />
              ))}
            </div>
          ))}
          <div
            className={cn(
              'pt-3 text-center text-lg text-fg-muted opacity-0',
              at(t, 2200) && 'animate-rise-in opacity-100',
            )}
          >
            Same perceived lightness across every hue (OKLCH)
          </div>
        </div>
      </Stage>
    ),
  },
  {
    id: 'theme',
    title: 'Light and dark',
    caption: 'Every surface, text and risk colour has a tested pair in both themes.',
    ms: 5200,
    view: (t) => {
      const dark = at(t, 2200)
      return (
        <Stage>
          <div
            data-theme={dark ? 'dark' : 'light'}
            className="flex w-[640px] flex-col gap-4 rounded-2xl bg-canvas p-6 shadow-4 ring-[0.5px] ring-line ring-inset transition-colors duration-(--v-duration-slower)"
          >
            <Inline gap={3}>
              <SiteAvatar id="woolworths" name="Woolworths" size="lg" />
              <Stack gap={0.5} className="flex-1">
                <span className="text-xl font-semibold">Woolworths</span>
                <span className="text-md text-fg-muted">6 tools · signed in</span>
              </Stack>
              <Badge tone="success">Healthy</Badge>
            </Inline>
            <Inline gap={2}>
              <RiskBadge purpose="read" />
              <RiskBadge purpose="write" />
              <RiskBadge purpose="irreversible" />
            </Inline>
            <HealthLine tone="success">Last call 2 min ago · 14 today</HealthLine>
            <Inline gap={2} justify="end">
              <Button>Pause</Button>
              <Button variant="primary">Open trolley</Button>
            </Inline>
          </div>
        </Stage>
      )
    },
  },
  {
    id: 'controls',
    title: 'Micro-interactions',
    caption: 'Toggles travel on a spring. Pills glide. Counts roll. Buttons dip when pressed.',
    ms: 6000,
    view: (t) => {
      const seg = t < 1400 ? 'all' : t < 2800 ? 'reads' : t < 4200 ? 'changes' : 'all'
      return (
        <Stage>
          <div className="flex w-[560px] flex-col gap-6 rounded-2xl bg-surface p-8 shadow-3 ring-[0.5px] ring-line ring-inset">
            <Inline gap={4} justify="between">
              <Text size="lg">Notify me when a call needs me</Text>
              <Switch checked={Math.floor(t / 1100) % 2 === 0} aria-label="Notify" />
            </Inline>
            <Segmented
              label="Filter"
              value={seg}
              onValueChange={() => {}}
              options={[
                { value: 'all', label: 'All calls' },
                { value: 'reads', label: 'Reads' },
                { value: 'changes', label: 'Changes' },
              ]}
            />
            <Inline gap={3} align="baseline">
              <span className="text-4xl font-semibold">
                <AnimatedNumber value={at(t, 600) ? (at(t, 3000) ? 31 : 17) : 3} duration={900} />
              </span>
              <Text tone="muted">calls today</Text>
            </Inline>
            <Progress value={Math.min(100, (t / 5200) * 100)} label="Progress" />
          </div>
        </Stage>
      )
    },
  },
  {
    id: 'glass',
    title: 'Liquid Glass',
    caption:
      'On macOS, floating layers are glass: blurred, saturated, refracting what moves behind them. Frost elsewhere.',
    ms: 6200,
    view: (t) => (
      <Stage className="relative overflow-hidden">
        <div
          className="wallpaper absolute inset-[-20%]"
          style={{
            transform: `translate(${Math.sin(t / 900) * 60}px, ${Math.cos(t / 1100) * 40}px) rotate(${t / 300}deg)`,
          }}
        />
        <div
          aria-hidden="true"
          className="absolute text-[180px] font-bold tracking-tight text-fg/25"
          style={{ transform: `translateX(${Math.sin(t / 1200) * 120}px)` }}
        >
          Valet
        </div>
        <div className="relative animate-dialog-in">
          <SampleTray />
        </div>
      </Stage>
    ),
  },
  {
    id: 'overlays',
    title: 'Where things come from',
    caption: 'The palette drops in from above. ⌘K reaches every page, site and action by name.',
    ms: 5600,
    view: (t) => (
      <Stage className="items-start pt-24">
        <div className="flex flex-col items-center gap-6">
          <Inline gap={1} className={cn('opacity-0', at(t, 200) && 'animate-fade-in opacity-100')}>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </Inline>
          {at(t, 700) ? (
            <div
              data-glass="refract"
              className="material-floating w-[600px] animate-dialog-in overflow-hidden rounded-xl"
            >
              <div className="flex items-center gap-2 border-b border-line-subtle px-4">
                <Search className="size-4 text-fg-subtle" />
                <span className="flex h-12 items-center text-lg">
                  {'review wool'.slice(0, Math.max(0, Math.floor((t - 1200) / 110)))}
                  <span className="ml-px inline-block h-5 w-px animate-pulse bg-fg" />
                </span>
              </div>
              <div className="p-1.5">
                <CommandGroupMock t={t} />
              </div>
            </div>
          ) : null}
        </div>
      </Stage>
    ),
  },
  {
    id: 'approve',
    title: 'The fix sits with the problem',
    caption: 'An update waits on the adapter itself. Review it there, approve it, and the seal stamps.',
    ms: 7600,
    view: (t) => (
      <Stage>
        <div className="flex w-[640px] flex-col gap-4">
          <Banner
            tone="attention"
            title="Woolworths 1.5.0 is waiting for your review"
            action={
              <Button size="sm" variant="primary" className={cn(at(t, 1400) && !at(t, 1700) && 'scale-95')}>
                Review update
              </Button>
            }
          >
            It adds one permission that can't be undone.
          </Banner>
          {at(t, 1700) ? (
            <div className="animate-sheet-in rounded-xl bg-raised p-5 shadow-4 ring-[0.5px] ring-line ring-inset">
              <Stack gap={3}>
                <Text weight="semibold" size="lg">
                  What changes
                </Text>
                <Diff
                  label="Changes"
                  lines={[
                    { kind: 'same', text: 'Read your trolley and orders' },
                    {
                      kind: 'add',
                      text: 'Place orders with your saved card',
                      note: <RiskBadge purpose="irreversible" />,
                    },
                  ]}
                />
                <Inline gap={2} justify="end">
                  <Button>Keep 1.4.0</Button>
                  <Button variant="primary" className={cn(at(t, 3600) && !at(t, 3900) && 'scale-95')}>
                    Approve 1.5.0
                  </Button>
                </Inline>
              </Stack>
            </div>
          ) : null}
          {at(t, 4000) ? (
            <div className="flex items-center justify-center gap-4 pt-2">
              <ApprovalSeal size={96} />
              <Stack gap={0.5} className="animate-rise-in [animation-delay:500ms]">
                <Text weight="semibold" size="lg">
                  Approved and recorded
                </Text>
                <Text tone="muted">Entry 1,285 in the audit log</Text>
              </Stack>
            </div>
          ) : null}
        </div>
      </Stage>
    ),
  },
  {
    id: 'done',
    title: 'Setup complete',
    caption: 'Delight is rare and earned. It marks a finished job.',
    ms: 6000,
    view: (t) => (
      <Stage>
        <div className="flex w-[640px] items-center gap-10">
          <Stepper
            className="w-56"
            steps={[
              { id: 'w', label: 'Welcome', state: 'done' },
              { id: 'p', label: '1Password', state: 'done' },
              { id: 's', label: 'Store', state: at(t, 800) ? 'done' : 'current' },
              {
                id: 'c',
                label: 'Connect Claude',
                state: at(t, 1800) ? 'done' : at(t, 800) ? 'current' : 'upcoming',
              },
            ]}
          />
          <div className="flex flex-1 flex-col items-center gap-3">
            {at(t, 2000) ? (
              <>
                <Sparkle>
                  <SuccessCheck size={88} />
                </Sparkle>
                <span className="animate-rise-in text-2xl font-semibold">Valet is ready</span>
                <span className="animate-rise-in text-md text-fg-muted [animation-delay:120ms]">
                  Claude can shop at Woolworths now.
                </span>
              </>
            ) : null}
          </div>
        </div>
      </Stage>
    ),
  },
  {
    id: 'reduced',
    title: 'Reduced motion',
    caption:
      'With reduced motion on, nothing travels or zooms. Things still fade, so changes are never silent.',
    ms: 5600,
    view: (t) => (
      <Stage>
        <div className="grid w-[760px] grid-cols-2 gap-6">
          {(['full', 'reduce'] as const).map((m) => (
            <div
              key={m}
              data-motion={m === 'reduce' ? 'reduce' : undefined}
              className="flex flex-col items-center gap-4 rounded-2xl bg-surface p-6 shadow-2 ring-[0.5px] ring-line ring-inset"
            >
              <Text weight="semibold">{m === 'full' ? 'Full motion' : 'Reduced motion'}</Text>
              <div
                key={Math.floor(t / 2200)}
                className="flex h-32 flex-col items-center justify-center gap-3"
              >
                <div className="animate-sheet-in rounded-lg bg-raised px-4 py-3 shadow-3 ring-[0.5px] ring-line ring-inset">
                  <Inline gap={2}>
                    <Store className="size-4 text-fg-muted" />
                    <span>Sheet</span>
                  </Inline>
                </div>
                <ApprovalSeal size={48} />
              </div>
            </div>
          ))}
        </div>
      </Stage>
    ),
  },
]

function CommandGroupMock({ t }: { t: number }) {
  // A static rendering of the palette's list (the real one is in Overlays), highlighting as you type.
  const highlight = at(t, 2400)
  return (
    <div className="flex flex-col">
      <div className="px-2.5 pt-2 pb-1 text-xs font-semibold text-fg-subtle">Waiting for you</div>
      <div
        className={cn(
          'flex h-9 items-center gap-2.5 rounded-sm px-2.5 transition-interactive',
          highlight && 'bg-selected-strong text-fg-on-selected',
        )}
      >
        <SiteAvatar id="woolworths" name="Woolworths" size="xs" />
        <span className="flex-1">Review Woolworths update</span>
        <span className={cn('text-sm text-fg-subtle', highlight && 'text-fg-on-selected/80')}>
          1 new permission
        </span>
      </div>
      <div className={cn('transition-opacity duration-(--v-duration-base)', at(t, 1700) && 'opacity-30')}>
        <div className="px-2.5 pt-2 pb-1 text-xs font-semibold text-fg-subtle">Go to</div>
        {['Adapters', 'Activity', 'Audit log', 'Settings'].map((x) => (
          <div key={x} className="flex h-9 items-center gap-2.5 rounded-sm px-2.5">
            <span className="flex-1">{x}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Showcase() {
  const params = new URLSearchParams(location.search)
  const [index, setIndex] = useState(() => Math.min(scenes.length - 1, Number(params.get('scene') ?? 0)))
  const [playing, setPlaying] = useState(params.get('autoplay') === '1')
  const scene = scenes[index] ?? scenes[0]
  const t = useElapsed(playing, index)
  useEffect(() => {
    if (!playing || !scene) return
    if (t >= scene.ms) {
      if (index < scenes.length - 1) setIndex(index + 1)
      else {
        setPlaying(false)
        document.documentElement.dataset['showcaseDone'] = '1'
      }
    }
  }, [t, scene, index, playing])
  if (!scene) return null
  return (
    <main className="flex h-screen flex-col bg-canvas text-fg">
      <h1 className="sr-only">Valet motion showcase</h1>
      <div key={scene.id} className="relative min-h-0 flex-1 animate-fade-in">
        {scene.view(playing ? t : Math.max(t, scene.ms))}
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t border-line-subtle px-8 py-4">
        <div
          key={`${scene.id}-cap`}
          className="flex min-w-0 flex-1 animate-rise-in flex-col"
          aria-live="polite"
        >
          <h2 className="m-0 text-lg font-semibold">{scene.title}</h2>
          <span className="text-md text-fg-muted">{scene.caption}</span>
        </div>
        <nav className="flex items-center" aria-label="Scenes">
          {scenes.map((s, i) => (
            // A 24 px target around a small dot.
            <button
              key={s.id}
              type="button"
              aria-current={i === index || undefined}
              aria-label={s.title}
              onClick={() => setIndex(i)}
              className="group flex h-6 items-center justify-center px-[3px]"
            >
              <span
                data-travel=""
                className={cn(
                  'block h-1.5 rounded-full transition-[width,background-color] duration-(--v-duration-slow) ease-spring',
                  i === index ? 'w-6 bg-accent-solid' : 'w-1.5 bg-fg-subtle/40 group-hover:bg-fg-subtle',
                )}
              />
            </button>
          ))}
        </nav>
        <Inline gap={1}>
          <Button
            size="sm"
            variant="quiet"
            aria-label="Previous scene"
            onClick={() => setIndex(Math.max(0, index - 1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leading={playing ? <Pause /> : <Play />}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label="Next scene"
            onClick={() => setIndex(Math.min(scenes.length - 1, index + 1))}
          >
            <ChevronRight />
          </Button>
          <Button size="sm" variant="quiet" asChild>
            <a href="#/foundations">Gallery</a>
          </Button>
        </Inline>
      </div>
    </main>
  )
}
