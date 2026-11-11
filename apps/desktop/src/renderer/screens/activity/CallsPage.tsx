// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import type { CallFilters } from '../../lib/router'
import { ActivityPage } from '../legacy/Activity'
export function CallsPage({ callId }: { readonly callId: string | null; readonly filters: CallFilters }) {
  return <ActivityPage callId={callId} />
}
