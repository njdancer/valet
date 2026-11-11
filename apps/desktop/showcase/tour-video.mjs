#!/usr/bin/env node
// Turns e2e/app-tour.spec.ts's scenes into the app tour video: each scene's frames (the window's own
// screencast, at its real size) are laid on a backdrop, with the chapter and the caption of the
// moment drawn under the window (PNGs rendered by headless Chrome, so any ffmpeg will do), then the
// scenes are joined with short fades. Writes tour-<theme>.mp4 and tour-<theme>.srt next to tour.json.
//
//   node showcase/tour-video.mjs --dir <VALET_TOUR_OUT>
//
// CHROMIUM_PATH picks the browser when Playwright's own isn't installed.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values } = parseArgs({ options: { dir: { type: 'string', default: 'out/app-tour' } } })
const DIR = resolve(values.dir)
const tour = JSON.parse(readFileSync(join(DIR, 'tour.json'), 'utf8'))
const dark = tour.theme === 'dark'
const mac = tour.platform === 'darwin'
const W = 1360
const H = 960
const AREA_H = 852 // the window's part of the canvas; the captions sit under it
const FPS = 30
const FADE = 0.25
const work = join(DIR, 'video')
mkdirSync(work, { recursive: true })

const colors = dark
  ? {
      bg1: '#15171c',
      bg2: '#1d2230',
      fg: '#eef0f4',
      muted: '#9aa3b2',
      accent: '#7aa7ff',
      shadow: 'rgba(0,0,0,.55)',
    }
  : {
      bg1: '#eef1f6',
      bg2: '#dfe6f2',
      fg: '#1b1e24',
      muted: '#5d6675',
      accent: '#2f6fe4',
      shadow: 'rgba(20,30,60,.22)',
    }

/** Where a window of this size goes: centred in the window area, scaled down only if it won't fit. */
function place(w, h) {
  const scale = Math.min(1, (W - 80) / w, (AREA_H - 64) / h)
  const sw = Math.round((w * scale) / 2) * 2
  const sh = Math.round((h * scale) / 2) * 2
  return { x: Math.round((W - sw) / 2), y: Math.max(36, Math.round((AREA_H - sh) / 2) + 8), w: sw, h: sh }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const fontStack = `Inter, -apple-system, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`
const bgCss = `radial-gradient(1200px 700px at 20% 0%, ${colors.bg2}, transparent), linear-gradient(180deg, ${colors.bg1}, ${colors.bg2})`

function backdropHtml(rect, chapter, caption, index, total) {
  return `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${bgCss};font-family:${fontStack};overflow:hidden">
  <div style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;border-radius:12px;box-shadow:0 24px 60px ${colors.shadow},0 0 0 1px ${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)'}"></div>
  <div style="position:absolute;left:90px;right:90px;top:${AREA_H + 4}px;display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${colors.accent}">
      <span>${esc(chapter)}</span><span style="flex:1;height:1px;background:${colors.accent};opacity:.25"></span>
      <span style="color:${colors.muted};font-weight:500">${index} / ${total}</span>
    </div>
    <div style="font-size:21px;line-height:1.35;color:${colors.fg};font-weight:500">${esc(caption)}</div>
  </div></body></html>`
}

/** The rounded corners (backdrop outside a rounded hole) and, for the Mac window, its traffic lights. */
function frameHtml(rect, lights) {
  const mask = `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><rect width='100%' height='100%' fill='white'/><rect x='${rect.x}' y='${rect.y}' width='${rect.w}' height='${rect.h}' rx='12' fill='black'/></svg>`,
  )}")`
  const dots = lights
    ? ['#ff5f57', '#febc2e', '#28c840']
        .map(
          (c, i) =>
            `<div style="position:absolute;left:${rect.x + 20 + i * 20}px;top:${rect.y + 18}px;width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.2)"></div>`,
        )
        .join('')
    : ''
  return `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden">
  <div style="position:absolute;inset:0;background:${bgCss};mask-image:${mask};mask-mode:luminance;-webkit-mask-image:${mask}"></div>${dots}</body></html>`
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const page = await browser.newPage({ viewport: { width: W, height: H } })
async function png(html, file, transparent = false) {
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: file, omitBackground: transparent })
}

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
const srt = []
const srtTime = (s) => {
  const ms = Math.round(s * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

const scenes = tour.scenes.filter((s) => s.end > s.start && s.frames.length > 0)
const parts = []
let clock = 0
for (const [i, s] of scenes.entries()) {
  const sdir = join(DIR, 'scenes', s.id)
  // A window stacked on another (the login banner on the shop's page) is placed as one.
  const under = s.under
  const full = place(Math.max(s.width, under?.width ?? 0), s.height + (under?.height ?? 0))
  const scale = full.w / Math.max(s.width, under?.width ?? 0)
  const even = (n) => Math.round(n / 2) * 2
  const rect = { x: full.x, y: full.y, w: even(s.width * scale), h: even(s.height * scale) }
  const frameRect = under === undefined ? rect : full
  const duration = s.end - s.start
  // The frames, each held until the next arrives.
  const frames = s.frames
    .map((f) => ({ ...f, t: Math.min(Math.max(f.t, s.start), s.end) }))
    .sort((a, b) => a.t - b.t)
  const lines = []
  for (const [k, f] of frames.entries()) {
    const next = k + 1 < frames.length ? frames[k + 1].t : s.end
    const d = Math.max(next - f.t, 0)
    if (d === 0 && k + 1 < frames.length) continue
    lines.push(`file '${join(sdir, f.file)}'`, `duration ${d.toFixed(4)}`)
  }
  lines.push(`file '${join(sdir, frames.at(-1).file)}'`)
  const list = join(work, `${s.id}.txt`)
  writeFileSync(list, `${lines.join('\n')}\n`)

  // One backdrop per caption beat, swapped in at the beat's time.
  const beats = s.beats.length > 0 ? s.beats : [{ t: s.start, text: '' }]
  const inputs = ['-f', 'concat', '-safe', '0', '-i', list]
  for (const [k, b] of beats.entries()) {
    const file = join(work, `${s.id}-beat${k}.png`)
    await png(backdropHtml(frameRect, s.chapter, b.text, i + 1, scenes.length), file)
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', duration.toFixed(3), '-i', file)
    const from = Math.max(0, b.t - s.start)
    const to = k + 1 < beats.length ? beats[k + 1].t - s.start : duration
    srt.push({ from: clock + from, to: clock + to, text: `${s.chapter}: ${b.text}` })
  }
  const frameFile = join(work, `${s.id}-frame.png`)
  await png(frameHtml(frameRect, mac && s.window === 'control'), frameFile, true)
  inputs.push('-loop', '1', '-framerate', String(FPS), '-t', duration.toFixed(3), '-i', frameFile)
  const underIndex = beats.length + 2
  if (under !== undefined)
    inputs.push(
      '-loop',
      '1',
      '-framerate',
      String(FPS),
      '-t',
      duration.toFixed(3),
      '-i',
      join(sdir, under.file),
    )

  const f = []
  let cur = '1:v'
  for (let k = 1; k < beats.length; k++) {
    const at = Math.max(0, beats[k].t - s.start).toFixed(3)
    f.push(`[${cur}][${k + 1}:v]overlay=0:0:enable='gte(t,${at})'[b${k}]`)
    cur = `b${k}`
  }
  if (under !== undefined) {
    f.push(
      `[${underIndex}:v]scale=${even(under.width * scale)}:${even(under.height * scale)}:flags=lanczos[under]`,
    )
    f.push(`[${cur}][under]overlay=${rect.x}:${rect.y + rect.h}[bu]`)
    cur = 'bu'
  }
  f.push(`[0:v]fps=${FPS},scale=${rect.w}:${rect.h}:flags=lanczos,setsar=1[win]`)
  f.push(`[${cur}][win]overlay=${rect.x}:${rect.y}:shortest=0[w]`)
  f.push(`[w][${beats.length + 1}:v]overlay=0:0[fr]`)
  f.push(
    `[fr]trim=duration=${duration.toFixed(3)},fade=t=in:st=0:d=${FADE},fade=t=out:st=${Math.max(0, duration - FADE).toFixed(3)}:d=${FADE},format=yuv420p[out]`,
  )
  const part = join(work, `${s.id}.mp4`)
  run([
    ...inputs,
    '-filter_complex',
    f.join(';'),
    '-map',
    '[out]',
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-t',
    duration.toFixed(3),
    part,
  ])
  parts.push(part)
  clock += duration
  console.log(`scene ${s.id} ${s.chapter}: ${duration.toFixed(1)} s, ${s.frames.length} frames`)
}
await browser.close()

const all = join(work, 'parts.txt')
writeFileSync(all, `${parts.map((p) => `file '${p}'`).join('\n')}\n`)
const out = join(DIR, `tour-${tour.theme}.mp4`)
run(['-f', 'concat', '-safe', '0', '-i', all, '-c', 'copy', '-movflags', '+faststart', out])
writeFileSync(
  join(DIR, `tour-${tour.theme}.srt`),
  srt
    .filter((c) => c.to > c.from)
    .map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`)
    .join('\n'),
)
console.log(`${out}: ${clock.toFixed(1)} s`)
