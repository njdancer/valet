/**
 * The refraction filter Liquid Glass surfaces use on macOS (materials.css, data-glass="refract").
 * Put it once near the root. A soft displacement map bends the edges of what's behind the glass,
 * like a thick pane; the centre stays clear so text behind a popover isn't smeared.
 */
export function GlassFilter() {
  return (
    <svg aria-hidden="true" width="0" height="0" className="pointer-events-none absolute">
      <filter
        id="valet-glass-refract"
        x="0"
        y="0"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.008 0.012"
          numOctaves="2"
          seed="7"
          result="noise"
        />
        <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="soft"
          scale="18"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  )
}
