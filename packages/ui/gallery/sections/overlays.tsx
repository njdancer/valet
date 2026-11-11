import {
  Activity,
  Copy,
  ExternalLink,
  FileClock,
  Keyboard,
  Pause,
  Search,
  Settings,
  Store,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  Button,
  CommandGroup,
  CommandItem,
  CommandPalette,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DescriptionList,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  HashChip,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RiskBadge,
  SheetContent,
  Shortcut,
  SiteAvatar,
  Stack,
  Text,
  Timeline,
  Tooltip,
  toast,
} from '../../src'
import { GalleryPage, Row, Specimen } from './frame'

export function OverlaysSection() {
  const [palette, setPalette] = useState(false)
  const [allow, setAllow] = useState(true)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
  return (
    <GalleryPage
      title="Overlays"
      intro="Dialogs for a short self-contained question, sheets for a task that belongs to the page below, drawers for an item's detail beside its list. All trap focus, close on Escape and give focus back. Floating layers use the platform material."
    >
      <Specimen title="Dialog, sheet, drawer, confirm">
        <Row label="Dialog">
          <Dialog>
            <DialogTrigger asChild>
              <Button>Rename tool</Button>
            </DialogTrigger>
            <DialogContent
              title="Rename tool"
              description="The name Claude sees. Letters, digits and underscores."
              footer={
                <>
                  <DialogClose asChild>
                    <Button>Cancel</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="primary">Save</Button>
                  </DialogClose>
                </>
              }
            >
              <Field label="Public name">
                <Input defaultValue="woolworths_add_to_cart" />
              </Field>
            </DialogContent>
          </Dialog>
        </Row>
        <Row label="Sheet">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary">Grant credential</Button>
            </DialogTrigger>
            <SheetContent
              title="Let Woolworths use your password?"
              description="Valet types it into woolworths.com.au only. The adapter's code never sees it."
              footer={
                <>
                  <DialogClose asChild>
                    <Button>Not now</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="primary" onClick={() => toast.success('Granted')}>
                      Grant
                    </Button>
                  </DialogClose>
                </>
              }
            >
              <DescriptionList
                items={[
                  { term: 'Item', value: 'Woolworths (1Password, Private)' },
                  { term: 'Typed into', value: 'woolworths.com.au, auth.woolworths.com.au' },
                  { term: 'Used for', value: 'Logging in when a tool finds the session signed out' },
                ]}
              />
            </SheetContent>
          </Dialog>
        </Row>
        <Row label="Drawer">
          <Dialog>
            <DialogTrigger asChild>
              <Button>Open a call</Button>
            </DialogTrigger>
            <DrawerContent title="woolworths_update_cart" description="From “Claude” · 2 min ago">
              <Stack gap={5}>
                <DescriptionList
                  items={[
                    { term: 'Outcome', value: 'Done in 14 s' },
                    { term: 'Risk', value: <RiskBadge purpose="write" /> },
                    {
                      term: 'Audit entry',
                      value: (
                        <HashChip
                          value="a1b2c3d4e5f60718293a4b5c6d7e8f90"
                          href="#/audit"
                          label="audit hash"
                        />
                      ),
                    },
                  ]}
                />
                <Timeline
                  items={[
                    { id: '1', title: 'Queued behind 1 call', time: '0:00', tone: 'neutral' },
                    { id: '2', title: 'Waited 8 s for pacing', time: '0:02', tone: 'warning' },
                    { id: '3', title: 'Updated 3 items', time: '0:10', tone: 'success' },
                  ]}
                />
              </Stack>
            </DrawerContent>
          </Dialog>
        </Row>
        <Row label="Confirm">
          <ConfirmDialog
            trigger={<Button variant="danger-soft">Revoke Claude Desktop</Button>}
            title="Revoke Claude Desktop?"
            description="It can't call any tool until you connect it again. Calls already running finish."
            confirmLabel="Revoke"
            destructive
            onConfirm={() => toast('Revoked', { action: { label: 'Undo', onClick: () => {} } })}
          />
        </Row>
      </Specimen>

      <Specimen
        title="Popover, tooltip, menus"
        notes="Right-click the Woolworths tile for its context menu: every object has the same actions wherever it appears."
      >
        <Row label="Popover">
          <Popover>
            <PopoverTrigger asChild>
              <Button>Pacing</Button>
            </PopoverTrigger>
            <PopoverContent>
              <Stack gap={2}>
                <Text weight="semibold">Calls are 10 s apart</Text>
                <Text size="sm" tone="muted">
                  Woolworths sees one careful shopper, not a robot. Two calls queued.
                </Text>
              </Stack>
            </PopoverContent>
          </Popover>
        </Row>
        <Row label="Tooltip">
          <Tooltip content="Search Valet" shortcut="mod+K">
            <Button leading={<Search />}>Hover or focus me</Button>
          </Tooltip>
        </Row>
        <Row label="Dropdown">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>Woolworths actions</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Woolworths</DropdownMenuLabel>
              <DropdownMenuItem icon={<ExternalLink />} shortcut="mod+O">
                Open trolley
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Pause />}>Pause tools</DropdownMenuItem>
              <DropdownMenuCheckboxItem checked={allow} onCheckedChange={setAllow}>
                Allow add_to_cart
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Trash2 />} destructive>
                Remove adapter
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
        <Row label="Context menu">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex w-64 cursor-default items-center gap-3 rounded-lg bg-canvas p-3 ring-[0.5px] ring-line ring-inset">
                <SiteAvatar id="woolworths" name="Woolworths" />
                <div className="flex flex-col">
                  <Text weight="semibold">Woolworths</Text>
                  <Text size="sm" tone="muted">
                    Right-click me
                  </Text>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem icon={<Store />}>Open adapter</ContextMenuItem>
              <ContextMenuItem icon={<Activity />}>Show its calls</ContextMenuItem>
              <ContextMenuItem icon={<FileClock />}>Show in audit log</ContextMenuItem>
              <ContextMenuItem icon={<Copy />}>Copy adapter ID</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem icon={<Pause />}>Pause tools</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Row>
      </Specimen>

      <Specimen
        title="Command palette"
        notes="Press ⌘K or Ctrl+K anywhere. Every page, adapter, call and setting is reachable by name, and so is every action that waits on the person."
      >
        <Row label="Open">
          <Button leading={<Keyboard />} onClick={() => setPalette(true)}>
            Open palette
          </Button>
          <Shortcut keys="mod+K" />
        </Row>
        <CommandPalette open={palette} onOpenChange={setPalette}>
          <CommandGroup heading="Waiting for you">
            <CommandItem
              icon={<SiteAvatar id="woolworths" name="Woolworths" size="xs" />}
              hint="1 new permission"
              onSelect={() => setPalette(false)}
            >
              Review Woolworths update
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Go to">
            <CommandItem icon={<Store />} shortcut="mod+1">
              Adapters
            </CommandItem>
            <CommandItem icon={<Activity />} shortcut="mod+2">
              Activity
            </CommandItem>
            <CommandItem icon={<FileClock />} shortcut="mod+3">
              Audit log
            </CommandItem>
            <CommandItem icon={<Settings />} shortcut="mod+,">
              Settings
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem icon={<Pause />}>Pause all tools</CommandItem>
            <CommandItem icon={<Copy />}>Copy MCP address</CommandItem>
          </CommandGroup>
        </CommandPalette>
      </Specimen>
    </GalleryPage>
  )
}
