// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import type { SiteTab } from '../../lib/router'
import { AdapterDetailPage } from '../legacy/AdapterDetail'
export function SitePage({ adapterId }: { readonly adapterId: string; readonly tab: SiteTab }) {
  return <AdapterDetailPage adapterId={adapterId} />
}
