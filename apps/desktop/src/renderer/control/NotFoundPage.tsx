import { Button, EmptyState, Page, PageBody, PageHeader } from '@valet/ui'
import { href } from '../lib/router'

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="Not found" />
      <PageBody>
        <EmptyState
          title="There’s nothing at this address"
          action={
            <Button asChild variant="primary">
              <a href={href.needsYou()}>Go to Needs you</a>
            </Button>
          }
        >
          It may have been an old link, or something that has since been removed.
        </EmptyState>
      </PageBody>
    </Page>
  )
}
