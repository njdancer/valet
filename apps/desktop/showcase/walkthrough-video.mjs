// Turns the walkthrough's recordings (e2e/walkthrough.spec.ts) into one video: the Mac on the left,
// the iPhone in the middle, the agent's MCP calls on the right, and a caption bar along the
// bottom. Text is drawn by Chrome into PNGs and overlaid, since Homebrew's ffmpeg has no text
// filters. Also writes the captions as an .srt.
//
//   node showcase/walkthrough-video.mjs --out <dir with mac.mp4, phone.mp4, timeline.json>

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values } = parseArgs({ options: { out: { type: 'string' } } })
const out = values.out
if (out === undefined) throw new Error('--out <dir>')
const timeline = JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'))
const W = 1920
const H = 1080
const MAC = { x: 24, y: 64, w: 1068, h: 801 }
const PHONE = { x: 1116, y: 64, h: 801 }
const AGENT = { x: 1508, y: 64, w: 388, h: 801 }
const BAR = { x: 24, y: 889, w: 1872, h: 167 }

const t0 = Math.max(timeline.macStartedAt, timeline.phoneStartedAt)
const at = (ms) => Math.max(0, (ms - t0) / 1000)
const lastEvent = Math.max(
  ...timeline.captions.map((c) => c.at),
  ...timeline.marks.map((m) => m.at),
  ...timeline.agent.map((a) => a.at),
)
const duration = at(lastEvent) + 5

const parts = join(out, 'parts')
mkdirSync(parts, { recursive: true })
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const font = `font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;`

const browser = await chromium.launch(process.env['CHROME'] ? { executablePath: process.env['CHROME'] } : {})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
async function png(path, html, width, height, transparent = true) {
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><html><body style="margin:0;${font}">${html}</body></html>`)
  await page.screenshot({ path, omitBackground: transparent, clip: { x: 0, y: 0, width, height } })
}

// The backdrop: labels over each pane.
const label = (x, text) =>
  `<div style="position:absolute;left:${x}px;top:22px;font-size:20px;font-weight:600;color:#3b4a3f">${text}</div>`
await png(
  join(parts, 'backdrop.png'),
  `<div style="position:relative;width:${W}px;height:${H}px;background:#eef1ea">
    ${label(MAC.x, 'Valet on the Mac')}
    ${label(PHONE.x, 'Valet on the iPhone (Simulator)')}
    ${label(AGENT.x, 'The agent, over MCP')}
    <div style="position:absolute;left:${AGENT.x}px;top:${AGENT.y}px;width:${AGENT.w}px;height:${AGENT.h}px;background:#1f2a22;border-radius:12px"></div>
    <div style="position:absolute;left:${BAR.x}px;top:${BAR.y}px;width:${BAR.w}px;height:${BAR.h}px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)"></div>
  </div>`,
  W,
  H,
  false,
)

// Captions, each until the next.
const captions = timeline.captions.map((c, i) => ({
  start: at(c.at),
  end: i + 1 < timeline.captions.length ? at(timeline.captions[i + 1].at) : duration,
  text: c.text,
}))
for (const [i, c] of captions.entries())
  await png(
    join(parts, `caption-${i}.png`),
    `<div style="width:${BAR.w}px;height:${BAR.h}px;display:flex;align-items:center;box-sizing:border-box;padding:0 40px;font-size:34px;line-height:1.3;color:#1d2420">${esc(c.text)}</div>`,
    BAR.w,
    BAR.h,
  )

// The agent pane: the last lines so far, redrawn at each new one.
const agentStates = timeline.agent.map((a, i) => ({
  start: at(a.at),
  end: i + 1 < timeline.agent.length ? at(timeline.agent[i + 1].at) : duration,
  lines: timeline.agent.slice(Math.max(0, i - 7), i + 1),
}))
for (const [i, s] of agentStates.entries())
  await png(
    join(parts, `agent-${i}.png`),
    `<div style="width:${AGENT.w}px;height:${AGENT.h}px;box-sizing:border-box;padding:18px;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;font:13px/1.4 ui-monospace, Menlo, monospace">
      ${s.lines
        .map(
          (l, j) =>
            `<div style="color:${l.who === 'agent' ? '#9fd3a8' : '#e9ece6'};opacity:${j === s.lines.length - 1 ? 1 : 0.7};white-space:pre-wrap;word-break:break-word">${l.who === 'agent' ? '→ ' : '← '}${esc(l.text)}</div>`,
        )
        .join('')}
    </div>`,
    AGENT.w,
    AGENT.h,
  )
await browser.close()

// ffmpeg: backdrop, the two recordings (trimmed to a shared start), then every overlay in time.
const inputs = [
  ['-loop', '1', '-t', String(duration), '-i', join(parts, 'backdrop.png')],
  ['-ss', String((t0 - timeline.macStartedAt) / 1000), '-i', join(out, 'mac.mp4')],
  ['-ss', String((t0 - timeline.phoneStartedAt) / 1000), '-i', join(out, 'phone.mp4')],
]
const overlays = []
for (const [i, c] of captions.entries()) {
  inputs.push(['-loop', '1', '-t', String(duration), '-i', join(parts, `caption-${i}.png`)])
  overlays.push({ index: inputs.length - 1, x: BAR.x, y: BAR.y, start: c.start, end: c.end })
}
for (const [i, s] of agentStates.entries()) {
  inputs.push(['-loop', '1', '-t', String(duration), '-i', join(parts, `agent-${i}.png`)])
  overlays.push({ index: inputs.length - 1, x: AGENT.x, y: AGENT.y, start: s.start, end: s.end })
}
const filters = [
  `[1:v]fps=30,scale=${MAC.w}:${MAC.h}:force_original_aspect_ratio=decrease,setpts=PTS-STARTPTS[mac]`,
  `[2:v]fps=30,scale=-2:${PHONE.h},setpts=PTS-STARTPTS[phone]`,
  `[0:v][mac]overlay=${MAC.x}:${MAC.y}:eof_action=repeat[s0]`,
  `[s0][phone]overlay=${PHONE.x}:${PHONE.y}:eof_action=repeat[s1]`,
]
let last = 's1'
for (const [n, o] of overlays.entries()) {
  const next = `o${n}`
  filters.push(
    `[${last}][${o.index}:v]overlay=${o.x}:${o.y}:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${next}]`,
  )
  last = next
}
const args = [
  '-hide_banner',
  '-y',
  ...inputs.flat(),
  '-filter_complex',
  filters.join(';'),
  '-map',
  `[${last}]`,
  '-t',
  String(duration),
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-crf',
  '22',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  join(parts, 'full.mp4'),
]
writeFileSync(join(parts, 'ffmpeg-args.json'), JSON.stringify(args, null, 1))
const result = spawnSync('ffmpeg', args, { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

// Cut the waiting: the Simulator can stall for a minute on a tap. Between two events, a long gap
// keeps its first AFTER seconds and its last BEFORE, so every step is seen arriving and settling.
const AFTER = 6
const BEFORE = 10
const events = [
  0,
  ...timeline.captions.map((c) => at(c.at)),
  ...timeline.marks.map((m) => at(m.at)),
  ...timeline.agent.map((a) => at(a.at)),
  duration,
]
  .filter((t) => t >= 0 && t <= duration)
  .sort((a, b) => a - b)
const keep = []
const add = (start, end) => {
  const last = keep[keep.length - 1]
  if (last !== undefined && start <= last[1] + 0.05) last[1] = Math.max(last[1], end)
  else keep.push([start, end])
}
for (let i = 0; i + 1 < events.length; i++) {
  const [a, b] = [events[i], events[i + 1]]
  if (b - a <= AFTER + BEFORE + 2) add(a, b)
  else {
    add(a, a + AFTER)
    add(b - BEFORE, b)
  }
}
/** Where a moment of the full recording lands in the cut one. */
const cut = (t) => keep.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(t, e) - s), 0)
const select = keep.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join('+')
const trim = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-y',
    '-i',
    join(parts, 'full.mp4'),
    '-vf',
    `select='${select}',setpts=N/30/TB`,
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    join(out, 'valet-pairing-walkthrough.mp4'),
  ],
  { stdio: 'inherit' },
)
if (trim.status !== 0) process.exit(trim.status ?? 1)

const stamp = (s) => {
  const ms = Math.round(s * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}
writeFileSync(
  join(out, 'valet-pairing-walkthrough.srt'),
  captions.map((c, i) => `${i + 1}\n${stamp(cut(c.start))} --> ${stamp(cut(c.end))}\n${c.text}\n`).join('\n'),
)
console.log(
  `video: ${join(out, 'valet-pairing-walkthrough.mp4')} (${cut(duration).toFixed(0)} s of ${duration.toFixed(0)})`,
)
