import { cn } from '../lib/cn'

// A site's monogram tile. Hues come from the id so each site keeps its colour everywhere, without
// using any site's real brand (adapters are third-party; the app doesn't imitate their marks).
const hues = [258, 152, 25, 300, 70, 200, 340, 110]

function hueFor(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return hues[h % hues.length] ?? 258
}

export function SiteAvatar({
  id,
  name,
  size = 'md',
  className,
}: {
  id: string
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const hue = hueFor(id)
  const letter = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold text-white',
        size === 'xs' && 'size-4 rounded-[4px] text-2xs',
        size === 'sm' && 'size-5 rounded-[5px] text-2xs',
        size === 'md' && 'size-8 rounded-sm text-md',
        size === 'lg' && 'size-10 rounded-md text-lg',
        size === 'xl' && 'size-14 rounded-lg text-2xl',
        className,
      )}
      style={{
        background: `linear-gradient(160deg, oklch(0.62 0.15 ${hue}), oklch(0.5 0.16 ${hue}))`,
        boxShadow: 'inset 0 1px 0 oklch(1 0 0 / 0.25), inset 0 0 0 0.5px oklch(0 0 0 / 0.15)',
      }}
    >
      {letter}
    </span>
  )
}
