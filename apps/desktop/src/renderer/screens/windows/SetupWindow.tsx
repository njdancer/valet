// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { href, type Route } from '../../lib/router'
import { GrantSheet } from '../legacy/GrantSheet'
import { ReviewUpdate } from '../legacy/ReviewUpdate'
import { SETUP_ADAPTER, SetupPage } from '../legacy/Setup'

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
        <SetupPage step={route.step} />
      </div>
      {route.secret !== null ? (
        <GrantSheet adapterId={SETUP_ADAPTER} secret={route.secret} closeTo={href.setup('grant')} />
      ) : null}
    </div>
  )
}
