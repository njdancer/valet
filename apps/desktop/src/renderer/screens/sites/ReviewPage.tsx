// TEMPORARY: wraps the old screen until it is rebuilt on @valet/ui.
import { ReviewUpdate } from '../legacy/ReviewUpdate'
export function ReviewPage({ adapterId }: { readonly adapterId: string }) {
  return <ReviewUpdate adapterId={adapterId} />
}
