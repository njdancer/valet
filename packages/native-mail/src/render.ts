// Pictures of an attachment for an agent to look at, through macOS's own PDFKit and AppKit from a
// fixed JXA script (no library of our own): a PDF's pages, or an image scaled down and turned into
// PNG or JPEG, which every client that shows images can take (HEIC and TIFF photos included). The
// bytes go to a private temporary folder that is removed straight after; the script reads the file
// and writes its pictures beside it, and the request reaches it as one JSON argument, never as code.

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RENDER_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('PDFKit');
function encode(image, width, height, out, limit) {
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, width, height, 8, 4, true, false, $('NSDeviceRGBColorSpace'), 0, 0);
  if (rep.isNil()) return null;
  var context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  $.NSColor.whiteColor.setFill;
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, width, height));
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, width, height), $.NSMakeRect(0, 0, 0, 0), 2, 1.0);
  context.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  var data = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
  var type = 'image/png';
  if (data.isNil() || data.length > limit) {
    data = rep.representationUsingTypeProperties(3,
      $.NSDictionary.dictionaryWithObjectForKey($(0.8), $('NSImageCompressionFactor')));
    type = 'image/jpeg';
  }
  if (data.isNil() || !data.writeToFileAtomically(out, true)) return null;
  return { file: out, mimeType: type, width: width, height: height };
}
function fit(width, height, edge, grow) {
  var scale = edge / Math.max(width, height);
  if (!grow && scale > 1) scale = 1;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
function run(argv) {
  var req = JSON.parse(argv[0]);
  var pictures = [];
  if (req.kind === 'pdf') {
    var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(req.file));
    if (doc.isNil()) return JSON.stringify({ error: 'unreadable' });
    var total = doc.pageCount;
    for (var n = 0; n < req.pages.length; n++) {
      var i = req.pages[n];
      if (i >= total) continue;
      var page = doc.pageAtIndex(i);
      var bounds = page.boundsForBox(1);
      var w = bounds.size.width, h = bounds.size.height;
      if (page.rotation % 180 !== 0) { var t = w; w = h; h = t; }
      var size = fit(w, h, req.edge, true);
      var thumb = page.thumbnailOfSizeForBox($.NSMakeSize(size[0], size[1]), 1);
      var made = thumb.isNil() ? null : encode(thumb, size[0], size[1], req.out + '/page-' + i, req.limit);
      if (made === null) return JSON.stringify({ error: 'unreadable' });
      made.page = i + 1;
      pictures.push(made);
    }
    return JSON.stringify({ pageCount: total, pictures: pictures });
  }
  var image = $.NSImage.alloc.initWithContentsOfFile(req.file);
  if (image.isNil() || image.representations.count === 0) return JSON.stringify({ error: 'unreadable' });
  var first = image.representations.objectAtIndex(0);
  var pw = first.pixelsWide, ph = first.pixelsHigh;
  if (!(pw > 0 && ph > 0)) { pw = image.size.width; ph = image.size.height; }
  var dims = fit(pw, ph, req.edge, false);
  var picture = encode(image, dims[0], dims[1], req.out + '/image', req.limit);
  if (picture === null) return JSON.stringify({ error: 'unreadable' });
  return JSON.stringify({ pageCount: 1, pictures: [picture] });
}
`

export interface Picture {
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly data: Buffer
  readonly width: number
  readonly height: number
  /** A PDF page's number, from 1. */
  readonly page?: number
}

export interface Rendered {
  /** A PDF's pages in all, or 1 for an image. */
  readonly pageCount: number
  readonly pictures: readonly Picture[]
}

export interface RenderRequest {
  readonly kind: 'pdf' | 'image'
  /** A PDF's pages to draw, from 1, in order; ones past its end are left out. */
  readonly pages?: readonly number[]
  /** The longest side, in pixels. An image is never made bigger. */
  readonly edge?: number
}

export type RenderRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>

const osascript: RenderRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout: String(stdout) })
      },
    )
  })

/** Claude's own advice for the longest side of an image it is shown. */
export const PICTURE_EDGE = 1568
/** A picture over this as PNG is made a JPEG instead. */
const PNG_LIMIT = 1024 * 1024
const MAX_PAGES = 20

/** Pictures of a PDF's pages or of an image; null when it can't be drawn. */
export async function renderPictures(
  bytes: Buffer,
  request: RenderRequest,
  run: RenderRunner = osascript,
  timeoutMs = 60_000,
): Promise<Rendered | null> {
  if (request.kind === 'pdf' && (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-'))
    return null
  const dir = await mkdtemp(join(tmpdir(), 'valet-render-'))
  try {
    await chmod(dir, 0o700)
    const file = join(dir, request.kind === 'pdf' ? 'attachment.pdf' : 'attachment')
    await writeFile(file, bytes, { mode: 0o600 })
    const req = {
      kind: request.kind,
      file,
      out: dir,
      pages: [...new Set(request.pages ?? [1])]
        .filter((p) => Number.isInteger(p) && p >= 1)
        .slice(0, MAX_PAGES)
        .map((p) => p - 1),
      edge: Math.min(4096, Math.max(64, Math.floor(request.edge ?? PICTURE_EDGE))),
      limit: PNG_LIMIT,
    }
    const result = await run(['-l', 'JavaScript', '-e', RENDER_SCRIPT, JSON.stringify(req)], timeoutMs)
    if (result.code !== 0) return null
    let answer: unknown
    try {
      answer = JSON.parse(result.stdout.trim())
    } catch {
      return null
    }
    if (typeof answer !== 'object' || answer === null) return null
    const { pageCount, pictures } = answer as { pageCount?: unknown; pictures?: unknown }
    if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 0) return null
    if (!Array.isArray(pictures)) return null
    const made: Picture[] = []
    for (const picture of pictures as unknown[]) {
      if (typeof picture !== 'object' || picture === null) return null
      const p = picture as Record<string, unknown>
      // Only the files this run was told to write, in its own folder.
      if (typeof p['file'] !== 'string' || !p['file'].startsWith(`${dir}/`) || p['file'].includes('..'))
        return null
      if (p['mimeType'] !== 'image/png' && p['mimeType'] !== 'image/jpeg') return null
      made.push({
        mimeType: p['mimeType'],
        data: await readFile(p['file']),
        width: typeof p['width'] === 'number' ? p['width'] : 0,
        height: typeof p['height'] === 'number' ? p['height'] : 0,
        ...(typeof p['page'] === 'number' && Number.isInteger(p['page']) ? { page: p['page'] } : {}),
      })
    }
    return { pageCount, pictures: made }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
