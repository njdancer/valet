// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import type { AuditFilters } from '../../lib/router'
import { AuditLogPage } from '../legacy/AuditLog'
export function AuditPage(_props: { readonly seq: number | null; readonly filters: AuditFilters }) {
  return <AuditLogPage />
}
