// First-run setup (#/setup[/step]). On the approve step, `review` shows the adapter's review page
// over it, returning to setup; on the grant step, `secret` opens the grant sheet over it. Both are
// the app's own review and sheet, so setup can't approve or grant anything they wouldn't.

import { href, type Route } from '../../lib/router'
// The review page and grant sheet are rebuilt with the Sites pages; until they take `exits` and
// `closeTo`, setup uses the versions that do.
import { GrantSheet } from '../legacy/GrantSheet'
import { ReviewUpdate } from '../legacy/ReviewUpdate'
import { SetupFlow } from '../setup/SetupFlow'
import { SETUP_ADAPTER } from '../setup/setup-logic'

export function SetupWindow({ route }: { readonly route: Extract<Route, { page: 'setup' }> }) {
  if (route.review)
    return (
      <ReviewUpdate
        adapterId={SETUP_ADAPTER}
        exits={{ approved: href.setup('grant'), closed: href.setup('approve') }}
      />
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
