// "Add to Claude Desktop" (D-connect): one button that writes the client's bridge entry into Claude
// Desktop's config, in place of copying JSON into the file by hand. The copy-and-paste snippet stays
// under it for anyone who'd rather do it themselves.

import { useState } from 'react'
import type { DesktopConfigWritten } from '../../shared/api'
import { useApi } from '../lib/api-context'
import { Icon } from './ui'

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function AddToClaudeDesktop({ clientId }: { readonly clientId: string }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [written, setWritten] = useState<DesktopConfigWritten | null>(null)

  const add = async () => {
    setBusy(true)
    setFailed(false)
    try {
      setWritten(await api.clients.addToClaudeDesktop(clientId))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack gap-2">
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={add}>
          <Icon name={written === null ? 'plus' : 'check'} size="sm" />
          {written === null ? 'Add to Claude Desktop' : 'Added to Claude Desktop'}
        </button>
        {written === null && !failed ? (
          <span className="xs muted">Keeps your other servers, and a copy of the old file</span>
        ) : null}
      </div>
      {written !== null ? (
        <div className="callout ok" role="status">
          <Icon name="check" />
          <div>
            Quit and reopen Claude Desktop to load Valet.
            {written.backup === null ? null : (
              <>
                {' '}
                The old config is kept beside it as <span className="mono">{fileName(written.backup)}</span>.
              </>
            )}
          </div>
        </div>
      ) : null}
      {failed ? (
        <div className="callout warn" role="alert">
          <Icon name="warn" />
          <div>
            Valet couldn’t update Claude Desktop’s config, and left it as it was. If the file has a mistake in
            it, fix that and try again, or copy the entry below into it yourself.
          </div>
        </div>
      ) : null}
    </div>
  )
}
