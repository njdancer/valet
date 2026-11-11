import { ArrowRight, ExternalLink, MoreHorizontal, Pause, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Code,
  CodeBlock,
  Count,
  Field,
  IconButton,
  Input,
  Kbd,
  RadioGroup,
  RadioOption,
  RiskBadge,
  SearchInput,
  SecretBadge,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Shortcut,
  Stack,
  StatusDot,
  Switch,
  Textarea,
  TextLink,
  Value,
} from '../../src'
import { GalleryPage, Row, Specimen } from './frame'

export function FormsSection() {
  const [q, setQ] = useState('')
  const [notify, setNotify] = useState(true)
  const [store, setStore] = useState('')
  return (
    <GalleryPage
      title="Actions and inputs"
      intro="Three control heights (24, 28, 36). One primary per screen. Every control has hover, pressed, focus-visible and disabled states, an arrow cursor except on links and text fields, and a name a screen reader can read."
    >
      <Specimen
        title="Button"
        notes="Primary: the one thing this screen is for. Secondary: everything else. Ghost and quiet: toolbars and rows. Danger: only what can't be undone. Loading keeps the width and the focus."
      >
        <Row label="Variants">
          <Button variant="primary">Approve update</Button>
          <Button>Open trolley</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="quiet">Details</Button>
          <Button variant="danger">Erase all data</Button>
          <Button variant="danger-soft">Revoke</Button>
          <Button variant="link">Learn how pacing works</Button>
        </Row>
        <Row label="Sizes">
          <Button size="sm" variant="primary">
            Small
          </Button>
          <Button size="md" variant="primary">
            Medium
          </Button>
          <Button size="lg" variant="primary">
            Large
          </Button>
        </Row>
        <Row label="With icons">
          <Button leading={<Plus />}>Add adapter</Button>
          <Button variant="primary" trailing={<ArrowRight />}>
            Continue
          </Button>
          <Button variant="quiet" leading={<ExternalLink />}>
            Open in browser
          </Button>
        </Row>
        <Row label="States">
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </Row>
        <Row label="Icon buttons">
          <IconButton label="Refresh" icon={<RefreshCw />} shortcut="mod+R" />
          <IconButton label="Pause tools" icon={<Pause />} />
          <IconButton label="More actions" icon={<MoreHorizontal />} variant="secondary" />
          <IconButton label="Delete" icon={<Trash2 />} variant="danger-soft" />
        </Row>
      </Specimen>

      <Specimen
        title="Badges, dots and counts"
        notes="A badge labels a state or kind and is never a button. When it names something, the row or link around it is the target. Risk differs by shape as well as colour."
      >
        <Row label="Tones">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="success">Signed in</Badge>
          <Badge tone="warning">Waiting</Badge>
          <Badge tone="danger">Failed</Badge>
          <Badge tone="info">Info</Badge>
          <Badge tone="brass">Built in</Badge>
        </Row>
        <Row label="Risk">
          <RiskBadge purpose="read" />
          <RiskBadge purpose="write" />
          <RiskBadge purpose="irreversible" />
          <SecretBadge name="Woolworths password" />
        </Row>
        <Row label="Outline, small">
          <Badge variant="outline" tone="accent">
            v1.4.0
          </Badge>
          <Badge size="sm" tone="success">
            new
          </Badge>
        </Row>
        <Row label="Dots">
          <StatusDot tone="success" label="Healthy" />
          <StatusDot tone="warning" pulse label="Waiting on you" />
          <StatusDot tone="danger" label="Failed" />
          <StatusDot label="Off" />
        </Row>
        <Row label="Counts">
          <Count value={3} />
          <Count value={2} attention />
          <Count value={140} />
        </Row>
      </Specimen>

      <Specimen
        title="Text inputs"
        notes="Fields wire the label, hint and error to the control. Errors rise in once, never shake the page."
      >
        <div className="grid grid-cols-2 gap-6">
          <Stack gap={4}>
            <Field label="Public name" description="What Claude sees in its tool list.">
              <Input defaultValue="woolworths_add_to_cart" />
            </Field>
            <Field label="Store" error="Pick the store you shop at, so prices and stock are right.">
              <Input placeholder="Search suburbs" />
            </Field>
            <Field label="Note" optional>
              <Textarea placeholder="Why you paused this" />
            </Field>
          </Stack>
          <Stack gap={4}>
            <Field label="Search">
              <SearchInput value={q} onValueChange={setQ} placeholder="Search calls" />
            </Field>
            <Field label="Sizes">
              <Stack gap={2}>
                <Input size="sm" placeholder="Small" aria-label="Small" />
                <Input placeholder="Medium" aria-label="Medium" />
                <Input size="lg" placeholder="Large" aria-label="Large" />
              </Stack>
            </Field>
            <Field label="Disabled">
              <Input disabled defaultValue="Can't change this" />
            </Field>
          </Stack>
        </div>
      </Specimen>

      <Specimen
        title="Choices"
        notes="A switch applies at once. A checkbox waits for Save. Radios for two to five exclusive options; a select for more; segmented for views and filters."
      >
        <div className="grid grid-cols-2 gap-6">
          <Stack gap={4}>
            <Field
              inline
              label="Notify me when a call needs me"
              description="A system notification, and the tray icon changes."
            >
              <Switch checked={notify} onCheckedChange={setNotify} />
            </Field>
            <Field inline label="Start Valet when I log in">
              <Switch defaultChecked={false} />
            </Field>
            <Field inline label="Disabled switch">
              <Switch disabled />
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox id="c1" defaultChecked />
              <label htmlFor="c1" className="cursor-pointer text-md">
                Allow add_to_cart
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="c2" checked="indeterminate" />
              <label htmlFor="c2" className="cursor-pointer text-md">
                Some tools allowed
              </label>
            </div>
          </Stack>
          <Stack gap={4}>
            <RadioGroup defaultValue="totp" aria-label="Second factor">
              <RadioOption
                value="totp"
                label="One-time code from 1Password"
                description="Valet reads it from the same item as the password."
              />
              <RadioOption
                value="sms"
                label="Code from Messages"
                description="Valet reads the newest code sent by the site."
              />
              <RadioOption value="none" label="Ask me each time" disabled />
            </RadioGroup>
            <Field label="Store">
              <Select value={store} onValueChange={setStore}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Choose a store" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bondi" description="Bondi Junction NSW 2022">
                    Bondi Junction
                  </SelectItem>
                  <SelectItem value="newtown" description="Newtown NSW 2042">
                    Newtown
                  </SelectItem>
                  <SelectItem value="town-hall" description="Sydney NSW 2000">
                    Town Hall
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Segmented
              label="Theme"
              value="system"
              onValueChange={() => {}}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Stack>
        </div>
      </Specimen>

      <Specimen
        title="Values, code and keys"
        notes="Chrome text isn't selectable. Values a person may copy are: IDs, hashes, URLs, paths, errors and logs."
      >
        <Row label="Value">
          <Value mono copy="https://valet.example.com/mcp">
            https://valet.example.com/mcp
          </Value>
        </Row>
        <Row label="Truncated">
          <Value
            mono
            truncate
            copy="/Users/nick/Library/Application Support/Valet/audit/2026-11-11.jsonl"
            className="w-64"
          >
            /Users/nick/Library/Application Support/Valet/audit/2026-11-11.jsonl
          </Value>
        </Row>
        <Row label="Inline code">
          <span>
            Call <Code>woolworths_get_cart</Code> first.
          </span>
        </Row>
        <Row label="Keys">
          <Shortcut keys="mod+K" />
          <Shortcut keys="mod+shift+P" />
          <span className="inline-flex gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Row>
        <Row label="Link">
          <TextLink href="#/controls">Open the audit log</TextLink>
          <TextLink href="https://example.com" external>
            Woolworths help
          </TextLink>
        </Row>
        <div className="pt-2">
          <CodeBlock copy label="Claude Desktop config">
            {`{
  "mcpServers": {
    "valet": { "command": "/Applications/Valet.app/Contents/MacOS/valet-bridge" }
  }
}`}
          </CodeBlock>
        </div>
      </Specimen>
    </GalleryPage>
  )
}
