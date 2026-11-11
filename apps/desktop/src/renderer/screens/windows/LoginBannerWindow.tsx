// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { NeedsUserBanner } from '../legacy/NeedsUserBanner'
export function LoginBannerWindow({ adapterId }: { readonly adapterId: string }) {
  return <NeedsUserBanner adapterId={adapterId} />
}
