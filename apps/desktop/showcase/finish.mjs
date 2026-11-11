#!/usr/bin/env node
// Turns record.mjs's raw screen recording into the video to watch: each caption is drawn as a bar
// along the bottom (rendered to a PNG by headless Chrome, since Homebrew's ffmpeg has no text
// filters) and laid over the recording for its span, and captions.srt is written beside it.
//
//   node showcase/finish.mjs --out <dir>     # reads raw.mkv and captions.json, writes demo.mp4

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values } = parseArgs({ options: { out: { type: 'string', default: 'showcase-out' } } })
const OUT = values.out
const captions = JSON.parse(readFileSync(join(OUT, 'captions.json'), 'utf8'))
const raw = join(OUT, 'raw.mkv')

const [width] = execFileSync(
  'ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', raw],
  { encoding: 'utf8' },
)
  .trim()
  .split(',')
  .map(Number)

const srtTime = (s) => {
  const ms = Math.round(s * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}
writeFileSync(
  join(OUT, 'captions.srt'),
  captions
    .map(
      (c, i) =>
        `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end ?? c.start + 5)}\n${c.step ? `${c.step}: ` : ''}${c.text}\n`,
    )
    .join('\n'),
)

const escapeHtml = (t) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
mkdirSync(join(OUT, 'captions'), { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width, height: 200 }, deviceScaleFactor: 1 })
const files = []
for (const [i, c] of captions.entries()) {
  await page.setContent(`<html><body style="margin:0;background:transparent">
  <div id="bar" style="box-sizing:border-box;width:${width}px;padding:${Math.round(width / 90)}px ${Math.round(width / 40)}px;background:rgba(18,22,28,.86);color:#fff;font:${Math.round(width / 52)}px/1.35 -apple-system,Helvetica,Arial,sans-serif">
  ${c.step ? `<div style="color:#f2c14e;font-weight:700;font-size:.8em;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(c.step)}</div>` : ''}
  <div>${escapeHtml(c.text)}</div></div></body></html>`)
  const file = join(OUT, 'captions', `${String(i).padStart(3, '0')}.png`)
  await page.locator('#bar').screenshot({ path: file, omitBackground: true })
  files.push(file)
}
await browser.close()

// One overlay per caption, each shown only for its span, at the bottom edge.
const inputs = files.flatMap((f) => ['-i', f])
const chain = captions
  .map((c, i) => {
    const from = i === 0 ? '[0:v]' : `[v${i}]`
    const to = i === captions.length - 1 ? '[vout]' : `[v${i + 1}]`
    const end = c.end ?? c.start + 5
    return `${from}[${i + 1}:v]overlay=0:H-h:enable='between(t,${c.start.toFixed(2)},${end.toFixed(2)})'${to}`
  })
  .join(';')
execFileSync(
  'ffmpeg',
  ['-hide_banner', '-y', '-i', raw, ...inputs, '-filter_complex', chain, '-map', '[vout]']
    .concat([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ])
    .concat([join(OUT, 'demo.mp4')]),
  { stdio: 'inherit' },
)
process.stdout.write(`finish: ${join(OUT, 'demo.mp4')}\n`)
