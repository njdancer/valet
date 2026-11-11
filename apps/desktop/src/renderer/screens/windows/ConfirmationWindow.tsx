// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { ConfirmationPanel } from '../legacy/Confirmation'
export function ConfirmationWindow({ confirmationId }: { readonly confirmationId: string }) {
  return <ConfirmationPanel confirmationId={confirmationId} />
}
