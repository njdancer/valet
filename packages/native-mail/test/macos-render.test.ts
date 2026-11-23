// The fixed JXA scripts against macOS's own PDFKit and AppKit: a made-up two-page PDF and a big
// PNG, drawn into pictures and read as text. Only on a Mac (CI's swift-bridge job runs it).

import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pdfText } from '../src/pdf'
import { renderPictures } from '../src/render'

/** A PDF of `pages` A4 pages, each saying "Valet page <n>", with a correct cross-reference table. */
function makePdf(pages: number): Buffer {
  const objects: string[] = []
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 36 Tf 72 700 Td (Valet page ${i + 1}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function crc32(bytes: Buffer): number {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ -1) >>> 0
}

/** A grey RGB PNG of the given size. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x80)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const isPicture = (data: Buffer): boolean =>
  data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
  data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))

describe.runIf(process.platform === 'darwin')('on macOS', () => {
  it('reads a PDF’s text, each page after its marker', async () => {
    const text = await pdfText(makePdf(2))
    expect(text).toMatch(/^--- Page 1 of 2 ---\nValet page 1\s*\n\n--- Page 2 of 2 ---\nValet page 2\s*$/)
  })

  it('draws the PDF pages asked for, the longest side as asked, leaving out ones past the end', async () => {
    const drawn = await renderPictures(makePdf(3), { kind: 'pdf', pages: [3, 1, 7], edge: 1400 })
    expect(drawn?.pageCount).toBe(3)
    expect(drawn?.pictures.map((p) => p.page)).toEqual([3, 1])
    for (const picture of drawn?.pictures ?? []) {
      expect(isPicture(picture.data)).toBe(true)
      expect(Math.max(picture.width, picture.height)).toBe(1400)
      expect(picture.height).toBeGreaterThan(picture.width)
    }
  })

  it('scales a big image down, and never a small one up', async () => {
    const big = await renderPictures(makePng(3000, 2000), { kind: 'image' })
    expect(big?.pictures[0]).toMatchObject({ width: 1568, height: 1045 })
    expect(isPicture(big?.pictures[0]?.data ?? Buffer.alloc(0))).toBe(true)
    const small = await renderPictures(makePng(40, 30), { kind: 'image' })
    expect(small?.pictures[0]).toMatchObject({ width: 40, height: 30 })
  })

  it('draws nothing from bytes that aren’t an image', async () => {
    expect(await renderPictures(Buffer.from('not an image'), { kind: 'image' })).toBeNull()
  })
})
