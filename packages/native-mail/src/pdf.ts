// A PDF attachment's text through macOS's own PDFKit, each page after a "--- Page N of M ---"
// line so an agent can ask for pictures of the pages it needs (render.ts), from a fixed JXA script
// (no library of our own). The bytes go to a private temporary file that is removed straight after; the script only
// reads it. Valet itself runs this, not the reader helper: the bytes are already out of Mail's files.

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PDF_TEXT_SCRIPT = `
ObjC.import('PDFKit');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil()) return '';
  var total = doc.pageCount, parts = [], any = false;
  for (var i = 0; i < total; i++) {
    var text = doc.pageAtIndex(i).string;
    var words = text.isNil() ? '' : ObjC.unwrap(text);
    if (words.trim().length > 0) any = true;
    parts.push('--- Page ' + (i + 1) + ' of ' + total + ' ---\n' + words);
  }
  return any ? parts.join('\n\n') : '';
}
`

/** At most this much text comes back from one PDF. */
const MAX_PDF_TEXT_BYTES = 16 * 1024 * 1024

export type PdfRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

const osascript: PdfRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_PDF_TEXT_BYTES },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout: String(stdout) })
      },
    )
  })

/** The text of a PDF, or null when it has none or can't be read. */
export async function pdfText(
  bytes: Buffer,
  run: PdfRunner = osascript,
  timeoutMs = 60_000,
): Promise<string | null> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return null
  const dir = await mkdtemp(join(tmpdir(), 'valet-pdf-'))
  try {
    await chmod(dir, 0o700)
    const file = join(dir, 'attachment.pdf')
    await writeFile(file, bytes, { mode: 0o600 })
    const result = await run(['-l', 'JavaScript', '-e', PDF_TEXT_SCRIPT, file], timeoutMs)
    if (result.code !== 0) return null
    const text = result.stdout.replace(/\n$/, '')
    return text.trim().length === 0 ? null : text
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
