// Which page fills the main column for a route. Sheets (a login, a store, approving a connection)
// open over the page they belong to, so that page renders under them; closing returns to it.

import type { ReactNode } from 'react'
import type { Route } from '../lib/router'
import { AuditPage } from '../screens/activity/AuditPage'
import { CallsPage } from '../screens/activity/CallsPage'
import { ApproveConnectionSheet } from '../screens/connections/ApproveConnectionSheet'
import { ClientPage } from '../screens/connections/ClientPage'
import { ConnectionsPage } from '../screens/connections/ConnectionsPage'
import { RemotePage } from '../screens/connections/RemotePage'
import { NeedsYouPage } from '../screens/needs-you/NeedsYouPage'
import { LoginPage } from '../screens/secrets/LoginPage'
import { SecretsPage } from '../screens/secrets/SecretsPage'
import { SettingsPage } from '../screens/settings/SettingsPage'
import { GrantSheet } from '../screens/sites/GrantSheet'
import { ReviewPage } from '../screens/sites/ReviewPage'
import { SettingSheet } from '../screens/sites/SettingSheet'
import { SitePage } from '../screens/sites/SitePage'
import { SitesPage } from '../screens/sites/SitesPage'
import { NotFoundPage } from './NotFoundPage'

export function MainView({ route }: { readonly route: Route }): ReactNode {
  switch (route.page) {
    case 'needs-you':
      return <NeedsYouPage item={route.item} />
    case 'sites':
      return <SitesPage />
    case 'site':
      return <SitePage adapterId={route.adapterId} tab={route.tab} />
    case 'review':
      return <ReviewPage adapterId={route.adapterId} />
    case 'grant':
      return (
        <>
          <SitePage adapterId={route.adapterId} tab="overview" />
          <GrantSheet adapterId={route.adapterId} secret={route.secret} />
        </>
      )
    case 'setting':
      return (
        <>
          <SitePage adapterId={route.adapterId} tab="overview" />
          <SettingSheet adapterId={route.adapterId} setting={route.setting} />
        </>
      )
    case 'calls':
      return <CallsPage callId={route.callId} filters={route.filters} />
    case 'audit':
      return <AuditPage seq={route.seq} filters={route.filters} />
    case 'connections':
      return <ConnectionsPage />
    case 'client':
      return <ClientPage clientId={route.clientId} />
    case 'remote':
      return <RemotePage />
    case 'approve-connection':
      return (
        <>
          <NeedsYouPage item={null} />
          <ApproveConnectionSheet />
        </>
      )
    case 'secrets':
      return <SecretsPage />
    case 'login':
      return <LoginPage adapterId={route.adapterId} secret={route.secret} />
    case 'settings':
      return <SettingsPage section={route.section} />
    default:
      return <NotFoundPage />
  }
}
