import { mkdtempSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDevices, readPhone, watchDevices, writeLayout } from '@valet/iphone'
import type { ToolCall } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakePhone, sampleState, startFakePhone } from '../../../packages/iphone/test/fake-phone'
import { IPhoneService } from '../src/main/core/iphone'

function call(tool: string, input: unknown): ToolCall {
  return { callId: `c_${Math.random()}`, tool, input, client: 'Test agent' } as unknown as ToolCall
}

async function out(service: IPhoneService, tool: string, input: unknown = {}) {
  const result = await service.call(call(tool, input), new AbortController().signal)
  if (result.status !== 'ok') throw new Error(`${tool} ${result.status}`)
  return result.output as Record<string, unknown>
}

describe('IPhoneService', () => {
  let phone: FakePhone | null = null
  let service: IPhoneService | null = null
  afterEach(async () => {
    service?.stop()
    await phone?.close()
  })

  async function setup(approve = true) {
    phone = await startFakePhone(sampleState())
    const deps = { socketPath: phone.socketPath }
    const notes: string[] = []
    const approvals: string[][] = []
    service = new IPhoneService({
      dir: mkdtempSync(join(tmpdir(), 'iphone-')),
      now: Date.now,
      audit: async () => undefined,
      notify: (t) => notes.push(t),
      approveWrite: async (preview) => {
        approvals.push([...preview])
        return approve
      },
      phone: {
        list: () => listDevices(deps),
        read: (d, have) => readPhone(d, { ...deps, haveIcon: have }),
        write: (d, s) => writeLayout(d, s, { ...deps, settleMs: 10 }),
        watch: (on) => watchDevices(on, deps),
      },
    })
    await service.start()
    return { notes, approvals, service }
  }

  it('saves the layout when the phone is plugged in, and lets an agent plan and apply', async () => {
    const { notes, approvals, service } = await setup()
    await new Promise((r) => setTimeout(r, 100))
    phone?.attach()
    for (let i = 0; i < 50 && notes.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(notes[0]).toContain('saved Test iPhone’s home screen')

    const layout = await out(service, 'layout', { cells: true })
    expect(layout['problem']).toBeNull()
    const proposal = layout['proposal'] as { revision: number; pages: { cells: unknown[] }[] }
    expect(proposal.pages[0]?.cells).toHaveLength(3)

    const edited = await out(service, 'edit', {
      revision: proposal.revision,
      changes: [{ op: 'move', item: 'com.apple.Maps', to: { where: 'page', page: 1, position: 1 } }],
      pageNames: { '1': 'Every day' },
    })
    expect(edited['problem']).toBeNull()
    expect(edited['changes']).toContain('Maps: page 2 position 1 → page 1 position 1.')

    const stale = await out(service, 'edit', {
      revision: proposal.revision,
      changes: [{ op: 'addPage' }],
    })
    expect(String(stale['problem'])).toMatch(/revision/)

    const icons = await out(service, 'icons', { ids: ['com.apple.Maps'] })
    expect((icons['icons'] as Record<string, string>)['com.apple.Maps']).toMatch(/^data:image\/png;base64,/)

    const focus = await out(service, 'plan_focus', { focus: [{ name: 'Work', pages: [1], notes: '' }] })
    expect((focus['checklist'] as string[])[0]).toContain('Work')

    const applied = await out(service, 'apply', { revision: focus['revision'] as number })
    expect(applied).toMatchObject({ problem: null })
    expect(applied['written']).toBe(true)
    expect(approvals[0]?.[0]).toContain('Test iPhone')
    expect(phone?.written).toHaveLength(1)
    const dir = (service as unknown as { deps: { dir: string } }).deps.dir
    const plists = (await readdir(join(dir, 'snapshots'))).filter((f) => f.endsWith('.plist'))
    expect(plists.length).toBeGreaterThanOrEqual(3)
  })

  it('writes nothing when the person says no, or the phone changed', async () => {
    const { service } = await setup(false)
    await out(service, 'snapshot')
    const edited = await out(service, 'edit', {
      changes: [{ op: 'move', item: 'com.apple.Maps', to: { where: 'dock' } }],
    })
    const no = await out(service, 'apply', { revision: edited['revision'] as number })
    expect(String(no['problem'])).toMatch(/didn’t approve/)
    if (phone !== null) phone.iconState = [[], ...(sampleState().slice(1) as never[])]
    const drift = await out(service, 'apply', { revision: edited['revision'] as number })
    expect(String(drift['problem'])).toMatch(/changed since/)
    expect(phone?.written).toHaveLength(0)
  })
})
