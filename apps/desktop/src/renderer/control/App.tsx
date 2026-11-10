// The control panel: a sidebar window with hash routes, plus three chromeless routes the main
// process opens in their own windows (review, confirmation, login hand-off banner), and first-run
// setup, which takes the whole control panel window.

import type { ReactNode } from 'react'
import { href, type Route, useRoute } from '../lib/router'
import { ActivityPage } from '../screens/Activity'
import { AdapterDetailPage } from '../screens/AdapterDetail'
import { AdaptersPage } from '../screens/Adapters'
import { AuditLogPage } from '../screens/AuditLog'
import { ClientsSettingsPage } from '../screens/ClientsSettings'
import { ConfirmationPanel } from '../screens/Confirmation'
import { CredentialsPage } from '../screens/Credentials'
import { GrantSheet } from '../screens/GrantSheet'
import { NeedsUserBanner } from '../screens/NeedsUserBanner'
import { RemoteConsentPage } from '../screens/RemoteConsent'
import { ReviewUpdate } from '../screens/ReviewUpdate'
import { SETUP_ADAPTER, SetupPage } from '../screens/Setup'
import { Sidebar } from './Sidebar'

export function ControlPanel() {
  const route = useRoute()
  return <RouteView route={route} />
}

export function RouteView({ route }: { readonly route: Route }) {
  switch (route.page) {
    case 'review':
      return <ReviewUpdate adapterId={route.adapterId} />
    case 'confirm':
      return <ConfirmationPanel confirmationId={route.confirmationId} />
    case 'needs-user':
      return <NeedsUserBanner adapterId={route.adapterId} />
    case 'setup':
      // The review and the grant sheet are the app's own, opened over setup and returning to it.
      if (route.review)
        return (
          <ReviewUpdate
            adapterId={SETUP_ADAPTER}
            exits={{ approved: href.setup('grant'), closed: href.setup('approve') }}
          />
        )
      return (
        <div className="window">
          <div className="body" inert={route.secret !== null}>
            <SetupPage step={route.step} />
          </div>
          {route.secret !== null ? (
            <GrantSheet adapterId={SETUP_ADAPTER} secret={route.secret} closeTo={href.setup('grant')} />
          ) : null}
        </div>
      )
    default:
      return (
        <div className="window">
          {/* Under the grant sheet the window is inert: no focus, no clicks, nothing for a reader. */}
          <div className="body" inert={route.page === 'grant'}>
            <Sidebar route={route} />
            <main className="main">{mainFor(route)}</main>
          </div>
          {route.page === 'grant' ? <GrantSheet adapterId={route.adapterId} secret={route.secret} /> : null}
        </div>
      )
  }
}

function mainFor(route: Route): ReactNode {
  switch (route.page) {
    case 'adapters':
      return <AdaptersPage />
    case 'adapter':
    case 'grant':
      return <AdapterDetailPage adapterId={route.adapterId} />
    case 'activity':
      return <ActivityPage callId={route.callId} />
    case 'audit':
      return <AuditLogPage />
    case 'credentials':
      return <CredentialsPage />
    case 'clients':
    case 'settings':
      return <ClientsSettingsPage />
    case 'remote':
      return <RemoteConsentPage />
    default:
      return (
        <>
          <div className="titlebar">
            <div className="title">Not found</div>
          </div>
          <div className="empty">There’s nothing at this address.</div>
        </>
      )
  }
}
