// First-run setup (#/setup[/step]). On the approve step, `review` shows the adapter's review page
// over it, returning to setup; on the grant step, `secret` opens the grant sheet over it. Both are
// the app's own review and sheet, so setup can't approve or grant anything they wouldn't.

import { href, type Route } from '../../lib/router'
import { SetupFlow } from '../setup/SetupFlow'
import { SETUP_ADAPTER } from '../setup/setup-logic'
import { GrantSheet } from '../sites/GrantSheet'
import { ReviewPage } from '../sites/ReviewPage'

export function SetupWindow({ route }: { readonly route: Extract<Route, { page: 'setup' }> }) {
  // The review fills the window, so it paints its own canvas (a Mac window's vibrancy would show
  // through otherwise) and keeps clear of the traffic lights, whose strip stays a drag region.
  if (route.review)
    return (
      <div className="relative flex h-full flex-col bg-canvas pt-[var(--window-inset-top)]">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[var(--window-inset-top)] [-webkit-app-region:drag]"
        />
        <ReviewPage
          adapterId={SETUP_ADAPTER}
          exits={{ approved: href.setup('grant'), closed: href.setup('approve') }}
        />
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1" inert={route.secret !== null}>
        <SetupFlow step={route.step} />
      </div>
      {route.secret !== null ? (
        <GrantSheet adapterId={SETUP_ADAPTER} secret={route.secret} closeTo={href.setup('grant')} />
      ) : null}
    </div>
  )
}
