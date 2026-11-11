import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import {
  AnimatedNumber,
  ApprovalSeal,
  Banner,
  Button,
  HoldToConfirm,
  Inline,
  Segmented,
  Sparkle,
  Stack,
  SuccessCheck,
  Switch,
  Text,
  toast,
  ValetMark,
} from '../../src'
import { duration, easing } from '../../src/tokens'
import { GalleryPage, Row, Specimen } from './frame'

function Curve({ name, value }: { name: string; value: string }) {
  const [run, setRun] = useState(0)
  return (
    <button
      type="button"
      onClick={() => setRun((r) => r + 1)}
      className="flex cursor-pointer flex-col gap-2 rounded-lg bg-canvas p-3 text-left ring-[0.5px] ring-line ring-inset hover:ring-line-strong"
      aria-label={`Play the ${name} curve`}
    >
      <div className="relative h-10 overflow-hidden rounded-sm bg-inset">
        <span
          key={run}
          className="absolute top-2 left-2 size-6 rounded-full bg-accent-solid shadow-2"
          style={{
            animation: run ? `curve-move 900ms ${value} both` : undefined,
          }}
        />
      </div>
      <span className="text-sm font-semibold">{name}</span>
      <code className="selectable line-clamp-1 text-2xs text-fg-subtle">{value}</code>
    </button>
  )
}

function Replay({ label, children }: { label: string; children: (key: number) => React.ReactNode }) {
  const [key, setKey] = useState(1)
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-canvas p-4 ring-[0.5px] ring-line ring-inset">
      <div className="flex h-24 items-center justify-center">{children(key)}</div>
      <Inline gap={2}>
        <span className="text-sm font-medium">{label}</span>
        <Button size="sm" variant="quiet" leading={<RotateCcw />} onClick={() => setKey((k) => k + 1)}>
          Replay
        </Button>
      </Inline>
    </div>
  )
}

export function MotionSection() {
  const [count, setCount] = useState(12)
  const [on, setOn] = useState(true)
  const [view, setView] = useState<'all' | 'reads' | 'changes'>('all')
  return (
    <GalleryPage
      title="Motion and delight"
      intro="Motion explains where things come from and go. Fast in, faster out. Every distance is multiplied by a token that reduced motion sets to zero, so entrances still fade but nothing travels. Delight is rare and earned: it marks a finished job."
    >
      <Specimen
        title="Easing"
        notes="Click a curve to play it. Standard for things that move within the page, enter and exit for things that arrive and leave, emphasized for sheets and dialogs, spring for toggles and delight."
      >
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(easing)
            .filter(([k]) => k !== 'linear')
            .map(([k, v]) => (
              <Curve key={k} name={k} value={v} />
            ))}
        </div>
      </Specimen>

      <Specimen
        title="Duration"
        notes="Instant for hover and press, fast for exits and small fades, base for popovers, slow for sheets and dialogs, slower for drawn ticks, glacial for the approval seal only."
      >
        <Stack gap={2}>
          {Object.entries(duration).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[96px_1fr] items-center gap-4">
              <code className="text-xs text-fg-subtle">
                {k} · {v}ms
              </code>
              <span className="h-2 rounded-full bg-accent-solid/70" style={{ width: v / 2 }} />
            </div>
          ))}
        </Stack>
      </Specimen>

      <Specimen
        title="Entrances"
        notes="Pop for anchored popovers (from the trigger), rise for new content in a page, sheet from the window's top edge, drawer from the right."
      >
        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ['Pop', 'animate-pop-in'],
              ['Rise', 'animate-rise-in'],
              ['Sheet', 'animate-sheet-in'],
              ['Drawer', 'animate-drawer-in'],
            ] as const
          ).map(([label, cls]) => (
            <Replay key={label} label={label}>
              {(k) => (
                <div
                  key={k}
                  className={`h-16 w-24 rounded-lg bg-raised shadow-3 ring-[0.5px] ring-line ring-inset ${cls}`}
                />
              )}
            </Replay>
          ))}
        </div>
      </Specimen>

      <Specimen
        title="Micro-interactions"
        notes="The switch thumb and segmented pill travel on the spring. Buttons dip when pressed. Counts roll."
      >
        <Row label="Switch">
          <Switch checked={on} onCheckedChange={setOn} aria-label="Demo switch" />
        </Row>
        <Row label="Segmented">
          <Segmented
            label="Filter"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'all', label: 'All calls' },
              { value: 'reads', label: 'Reads' },
              { value: 'changes', label: 'Changes' },
            ]}
          />
        </Row>
        <Row label="Animated number">
          <span className="text-2xl font-semibold">
            <AnimatedNumber value={count} />
          </span>
          <Button size="sm" onClick={() => setCount((c) => c + Math.ceil(Math.random() * 20))}>
            Add calls
          </Button>
        </Row>
        <Row label="Press">
          <Button variant="primary">Press and watch</Button>
          <Button>Secondary</Button>
        </Row>
        <Row label="Toast">
          <Button
            onClick={() =>
              toast.success('Woolworths paused', {
                description: 'Its tools refuse calls until you resume it.',
                action: { label: 'Undo', onClick: () => toast('Resumed') },
              })
            }
          >
            Show a toast with Undo
          </Button>
        </Row>
      </Specimen>

      <Specimen
        title="Delight"
        notes="Each one marks a finished job. The seal stamps when an adapter or update is approved; the tick draws when a test call works; sparks fly once when setup is done; hold-to-confirm guards the irreversible."
      >
        <div className="grid grid-cols-4 gap-3">
          <Replay label="Approval seal">{(k) => <ApprovalSeal key={k} />}</Replay>
          <Replay label="Success tick">{(k) => <SuccessCheck key={k} size={56} />}</Replay>
          <Replay label="Setup sparkle">
            {(k) => (
              <Sparkle key={k}>
                <ValetMark size={48} />
              </Sparkle>
            )}
          </Replay>
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg bg-canvas p-4 ring-[0.5px] ring-line ring-inset">
            <HoldToConfirm onConfirm={() => toast.success('Erased (not really)')}>
              Hold to erase
            </HoldToConfirm>
            <Text size="sm" tone="muted">
              Hold 1.2 s, or hold Space
            </Text>
          </div>
        </div>
      </Specimen>

      <Specimen
        title="Attention"
        notes="Something waiting on the person pulses its dot, never the whole screen. Banners rise in once."
      >
        <Banner
          tone="attention"
          title="Woolworths has an update waiting for your review"
          action={
            <Button size="sm" variant="primary">
              Review update
            </Button>
          }
        >
          It asks for one new permission. Its tools keep running the approved version until you decide.
        </Banner>
      </Specimen>
    </GalleryPage>
  )
}
