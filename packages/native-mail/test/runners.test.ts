// The default runners that start osascript or another program. Off a Mac there is no osascript, so
// they report a failure and the callers read nothing rather than throwing.

import { describe, expect, it } from 'vitest'
import { execRunner } from '../src/drafts'
import { pdfText } from '../src/pdf'
import { renderPictures } from '../src/render'

describe('default runners', () => {
  it('runs a program and hands back its exit code and output', async () => {
    const ok = await execRunner(process.execPath, ['-e', 'process.stdout.write("hi")'], 10_000)
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' })
    const failed = await execRunner(process.execPath, ['-e', 'process.exit(3)'], 10_000)
    expect(failed.code).toBe(3)
    expect((await execRunner('/nonexistent/valet-program', [], 10_000)).code).toBeNull()
  })

  it.runIf(process.platform !== 'darwin')('reads nothing from a PDF or image without osascript', async () => {
    expect(await pdfText(Buffer.from('%PDF-1.4\n'))).toBeNull()
    expect(await renderPictures(Buffer.from('%PDF-1.4\n'), { kind: 'pdf' })).toBeNull()
  })
})
