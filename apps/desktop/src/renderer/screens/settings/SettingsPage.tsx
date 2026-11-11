// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import type { SettingsSection } from '../../lib/router'
import { ClientsSettingsPage } from '../legacy/ClientsSettings'
export function SettingsPage(_props: { readonly section: SettingsSection }) {
  return <ClientsSettingsPage focus="settings" />
}
