// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { CredentialsPage } from '../legacy/Credentials'
export function LoginPage(_props: { readonly adapterId: string; readonly secret: string }) {
  return <CredentialsPage />
}
