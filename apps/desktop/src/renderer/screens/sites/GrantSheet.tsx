// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { GrantSheet as Legacy } from '../legacy/GrantSheet'
export function GrantSheet({ adapterId, secret }: { readonly adapterId: string; readonly secret: string }) {
  return <Legacy adapterId={adapterId} secret={secret} />
}
