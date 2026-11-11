// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { ClientsSettingsPage } from '../legacy/ClientsSettings'
export function ClientPage(_props: { readonly clientId: string }) {
  return <ClientsSettingsPage />
}
