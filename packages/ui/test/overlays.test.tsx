import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Copy } from 'lucide-react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  Button,
  CommandGroup,
  CommandItem,
  CommandPalette,
  CommandSeparator,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  DrawerContent,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SheetContent,
  SplitButton,
  Toaster,
  Tooltip,
  TooltipProvider,
  toast,
} from '../src'
import { expectAccessible } from './axe'

const wrap = (ui: React.ReactNode) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

describe('Dialog, sheet and drawer', () => {
  it('a dialog is named, traps focus, closes on Escape and gives focus back', async () => {
    wrap(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Rename</Button>
        </DialogTrigger>
        <DialogContent
          title="Rename tool"
          description="The name Claude sees."
          size="sm"
          footer={
            <DialogClose asChild>
              <Button variant="primary">Save</Button>
            </DialogClose>
          }
        >
          <input aria-label="Name" />
        </DialogContent>
      </Dialog>,
    )
    const trigger = screen.getByRole('button', { name: 'Rename' })
    await userEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Rename tool' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    await expectAccessible(dialog)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('a dialog without a description has no dangling describedby, and can hide its close', async () => {
    wrap(
      <Dialog defaultOpen>
        <DialogContent title="Plain" hideClose size="lg">
          Body
        </DialogContent>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Plain' })
    expect(dialog.getAttribute('aria-describedby')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('sheets and drawers have titles, footers and a close button', async () => {
    wrap(
      <>
        <Dialog defaultOpen>
          <SheetContent
            title="Grant login"
            description="Typed into woolworths.com.au only."
            footer={<Button>Not now</Button>}
            wide
          >
            Sheet body
          </SheetContent>
        </Dialog>
      </>,
    )
    const sheet = screen.getByRole('dialog', { name: 'Grant login' })
    expect(within(sheet).getByRole('button', { name: 'Not now' })).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeTruthy()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a drawer opens beside the list', () => {
    wrap(
      <Dialog defaultOpen>
        <DrawerContent
          title="update_cart"
          description="2 min ago"
          footer={<Button>Open call</Button>}
          width={500}
        >
          Drawer body
        </DrawerContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'update_cart' })).toBeTruthy()
  })

  it('a drawer without a description or footer still renders', () => {
    wrap(
      <Dialog defaultOpen>
        <DrawerContent title="Bare">Body</DrawerContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Bare' }).getAttribute('aria-describedby')).toBeNull()
  })

  it('a sheet without a description or footer still renders', () => {
    wrap(
      <Dialog defaultOpen>
        <SheetContent title="Bare sheet">Body</SheetContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Bare sheet' })).toBeTruthy()
  })
})

describe('ConfirmDialog', () => {
  it('starts on Cancel and confirms on the destructive button', async () => {
    const onConfirm = vi.fn()
    wrap(
      <ConfirmDialog
        trigger={<Button>Revoke</Button>}
        title="Revoke Claude Desktop?"
        description="It can't call any tool until you connect it again."
        confirmLabel="Revoke access"
        destructive
        onConfirm={onConfirm}
      >
        <p>Extra</p>
      </ConfirmDialog>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke Claude Desktop?' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke access' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('a non-destructive confirm uses the primary button', () => {
    wrap(
      <ConfirmDialog
        open
        title="Turn on?"
        description="Claude can reach Valet."
        confirmLabel="Turn on"
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Turn on' }).className).toContain('bg-accent-solid')
  })
})

function Menu({ onPause }: { onPause: () => void }) {
  const [allow, setAllow] = useState(true)
  const [sort, setSort] = useState('new')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Woolworths</DropdownMenuLabel>
        <DropdownMenuItem icon={<Copy />} shortcut="⌘C">
          Copy ID
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPause}>Pause</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={allow} onCheckedChange={setAllow}>
          Allow add_to_cart
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="new">Newest</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="old">Oldest</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<Copy />}>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Nested</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('Popover, tooltip and menus', () => {
  it('a popover opens from its trigger', async () => {
    wrap(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Pacing</Button>
        </PopoverTrigger>
        <PopoverContent refract>Calls are 10 s apart</PopoverContent>
      </Popover>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Pacing' }))
    expect(screen.getByText('Calls are 10 s apart').getAttribute('data-glass')).toBe('refract')
  })

  it('a tooltip shows on focus with its shortcut', async () => {
    wrap(
      <Tooltip content="Search Valet" shortcut="⌘K" side="bottom">
        <Button>Search</Button>
      </Tooltip>,
    )
    await userEvent.tab()
    expect((await screen.findAllByText('Search Valet')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('⌘K').length).toBeGreaterThan(0)
  })

  it('a dropdown menu opens by keyboard and runs items', async () => {
    const onPause = vi.fn()
    wrap(<Menu onPause={onPause} />)
    screen.getByRole('button', { name: 'Actions' }).focus()
    await userEvent.keyboard('{Enter}')
    const menu = screen.getByRole('menu')
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Allow add_to_cart' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Newest' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Pause' }))
    expect(onPause).toHaveBeenCalled()
  })

  it('a context menu opens on right-click', async () => {
    const onOpen = vi.fn()
    wrap(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>Woolworths tile</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen} icon={<Copy />} shortcut="⌘O">
            Open
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem destructive>Remove</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('Woolworths tile'))
    await userEvent.click(screen.getByRole('menuitem', { name: /Open/ }))
    expect(onOpen).toHaveBeenCalled()
  })

  it('a split button runs its main action and opens its menu', async () => {
    const onPause = vi.fn()
    const onLock = vi.fn()
    wrap(
      <SplitButton
        onClick={onPause}
        menuLabel="More ways to pause"
        menu={<DropdownMenuItem onSelect={onLock}>Lock down</DropdownMenuItem>}
      >
        Pause Valet
      </SplitButton>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Pause Valet' }))
    expect(onPause).toHaveBeenCalled()
    screen.getByRole('button', { name: 'More ways to pause' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Lock down' }))
    expect(onLock).toHaveBeenCalled()
  })
})

describe('Command palette', () => {
  it('filters as you type and runs the chosen item', async () => {
    const onSelect = vi.fn()
    wrap(
      <CommandPalette open onOpenChange={() => {}}>
        <CommandGroup heading="Go to">
          <CommandItem onSelect={onSelect} shortcut="⌘2" hint="page">
            Adapters
          </CommandItem>
          <CommandItem>Activity</CommandItem>
        </CommandGroup>
        <CommandSeparator />
      </CommandPalette>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    await userEvent.type(within(dialog).getByRole('combobox'), 'adap')
    expect(within(dialog).queryByText('Activity')).toBeNull()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalled()
    await userEvent.type(within(dialog).getByRole('combobox'), 'zzz')
    expect(within(dialog).getByText(/Nothing matches/)).toBeTruthy()
  })
})

describe('Toasts', () => {
  it('shows a toast with an action', async () => {
    wrap(<Toaster />)
    act(() => {
      toast.success('Woolworths paused', { action: { label: 'Undo', onClick: () => {} } })
    })
    expect(await screen.findByText('Woolworths paused')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})
