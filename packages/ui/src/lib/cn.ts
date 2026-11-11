import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge has to know Valet's own theme names, or it would treat text-md (a size) and
// text-fg-muted (a colour) as the same group and drop one of them.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
      shadow: ['0', '1', '2', '3', '4'],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'full'],
    },
  },
})

/** Joins class names and lets later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
