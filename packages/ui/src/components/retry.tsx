import type { ReactNode } from 'react'
import { CopyButton } from './copy-button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

/**
 * "Ask Claude to try again…": Valet can't message Claude, so it gives the person the exact
 * sentence to paste, in a popover with a primary Copy. The sentence is selectable too.
 */
export function RetryPopover({
  trigger,
  title = 'Paste this to Claude',
  sentence,
  note,
}: {
  /** The button that opens it ("Ask Claude to try again…"). */
  trigger: ReactNode
  title?: ReactNode
  /** The exact words to paste. */
  sentence: string
  /** One line under the sentence ("Claude will run the order again from the start."). */
  note?: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-2.5">
        <p className="m-0 text-md font-semibold">{title}</p>
        <p className="selectable m-0 rounded-md bg-code-bg px-3 py-2 text-md text-code-fg">{sentence}</p>
        {note ? <p className="m-0 text-sm text-fg-muted">{note}</p> : null}
        <div className="flex justify-end">
          <CopyButton value={sentence} variant="primary" size="md">
            Copy sentence
          </CopyButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}
