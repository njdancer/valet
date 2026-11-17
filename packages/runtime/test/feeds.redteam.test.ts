// Red-team PoC for the XML reader tool code gets (core/src/feeds.ts). A failing test is a
// demonstrated hole.

import { parseXml } from '@valet/core'
import { describe, expect, it } from 'vitest'

describe('RF-1 namespace scopes are copied per element: quadratic CPU', () => {
  // 99 nested elements each declaring 64 xmlns prefixes build a 6,337-entry scope Map; every
  // sibling below that declares one more prefix copies the whole Map. 20k siblings (~400 KB of
  // XML) take ~12 s; the 4 MB limit allows ~190k (~2 minutes). Every bound in the reader holds
  // (depth 100, 200k elements, 64 attributes), so nothing refuses it.
  it('parses 400 KB of namespace-heavy XML in well under a second', () => {
    let open = ''
    for (let d = 0; d < 99; d++) {
      let attrs = ''
      for (let k = 0; k < 64; k++) attrs += ` xmlns:p${d}_${k}=""`
      open += `<a${attrs}>`
    }
    const doc = `${open}${'<b xmlns:z=""/>'.repeat(20_000)}${'</a>'.repeat(99)}`
    expect(doc.length).toBeLessThan(500_000)
    const started = Date.now()
    try {
      parseXml(doc)
    } catch {
      // A refusal is fine too: the point is time.
    }
    expect(Date.now() - started).toBeLessThan(1000)
  }, 120_000)
})
