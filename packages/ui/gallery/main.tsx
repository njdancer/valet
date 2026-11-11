import './gallery.css'
import { Blocks, Layers, Palette, PanelsTopLeft, Sparkles, SquareMousePointer, Table2 } from 'lucide-react'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  GlassFilter,
  Inline,
  NavItem,
  Segmented,
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  Text,
  Toaster,
  TooltipProvider,
  ValetMark,
} from '../src'
import { DataSection } from './sections/data'
import { FormsSection } from './sections/forms'
import { FoundationsSection } from './sections/foundations'
import { MotionSection } from './sections/motion'
import { OverlaysSection } from './sections/overlays'
import { PatternsSection } from './sections/patterns'
import { Showcase } from './sections/showcase'

const sections = [
  { id: 'foundations', label: 'Foundations', icon: <Palette />, view: <FoundationsSection /> },
  { id: 'motion', label: 'Motion and delight', icon: <Sparkles />, view: <MotionSection /> },
  { id: 'controls', label: 'Actions and inputs', icon: <SquareMousePointer />, view: <FormsSection /> },
  { id: 'overlays', label: 'Overlays', icon: <Layers />, view: <OverlaysSection /> },
  { id: 'data', label: 'Data and status', icon: <Table2 />, view: <DataSection /> },
  { id: 'patterns', label: 'Layout and patterns', icon: <PanelsTopLeft />, view: <PatternsSection /> },
] as const

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash.replace(/^#\/?/, '') || 'foundations')
  useEffect(() => {
    const on = () => setHash(location.hash.replace(/^#\/?/, '') || 'foundations')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

type ThemeChoice = 'light' | 'dark'
type PlatformChoice = 'mac' | 'windows' | 'linux'
type MotionChoice = 'full' | 'reduce'

function App() {
  const hash = useHash()
  const params = new URLSearchParams(location.search)
  const [theme, setTheme] = useState<ThemeChoice>((params.get('theme') as ThemeChoice) ?? 'light')
  const [platform, setPlatform] = useState<PlatformChoice>(
    (params.get('platform') as PlatformChoice) ?? 'mac',
  )
  const [motion, setMotion] = useState<MotionChoice>((params.get('motion') as MotionChoice) ?? 'full')
  useEffect(() => {
    const root = document.documentElement
    root.dataset['theme'] = theme
    root.dataset['platform'] = platform
    if (motion === 'reduce') root.dataset['motion'] = 'reduce'
    else delete root.dataset['motion']
  }, [theme, platform, motion])

  if (hash === 'showcase') return <Showcase />

  const current = sections.find((s) => s.id === hash) ?? sections[0]
  return (
    <div className="flex h-screen min-h-0 bg-canvas text-fg">
      <Sidebar label="Gallery sections" className="w-60">
        <Inline gap={2} className="px-2 pt-1 pb-2">
          <ValetMark size={22} />
          <span className="text-md font-semibold">Valet design system</span>
        </Inline>
        <SidebarGroup label="Sections">
          {sections.map((s) => (
            <NavItem key={s.id} href={`#${s.id}`} icon={s.icon} active={s.id === current.id}>
              {s.label}
            </NavItem>
          ))}
          <NavItem href="#showcase" icon={<Blocks />}>
            Motion showcase
          </NavItem>
        </SidebarGroup>
        <SidebarFooter className="gap-2.5 px-1">
          <Text size="xs" tone="subtle" className="px-1">
            Theme
          </Text>
          <Segmented
            size="sm"
            label="Theme"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
          <Text size="xs" tone="subtle" className="px-1">
            Platform material
          </Text>
          <Segmented
            size="sm"
            label="Platform"
            value={platform}
            onValueChange={setPlatform}
            options={[
              { value: 'mac', label: 'macOS' },
              { value: 'windows', label: 'Windows' },
              { value: 'linux', label: 'Linux' },
            ]}
          />
          <Text size="xs" tone="subtle" className="px-1">
            Motion
          </Text>
          <Segmented
            size="sm"
            label="Motion"
            value={motion}
            onValueChange={setMotion}
            options={[
              { value: 'full', label: 'Full' },
              { value: 'reduce', label: 'Reduced' },
            ]}
          />
        </SidebarFooter>
      </Sidebar>
      <main
        key={current.id}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be reachable by keyboard (axe scrollable-region-focusable)
        tabIndex={0}
        aria-label={current.label}
        className="min-h-0 min-w-0 flex-1 animate-rise-in overflow-y-auto"
      >
        {current.view}
      </main>
    </div>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider>
        <App />
        <Toaster />
        <GlassFilter />
      </TooltipProvider>
    </StrictMode>,
  )
