// The hub's one MCP address (relay-hub.md, step 2): every node's tools under one URL, for an agent
// holding a grant. The hub answers `initialize`, `ping`, `tools/list` and `tools/call` itself and
// sends each node only what is for it, over that node's relay socket, as the Mac's own
// Streamable HTTP. The hub sends no credential: the frame names the grant, and the Mac serves the
// request only if it checked that grant itself against the account's device list.
//
// Stateless towards the agent: no session id, plain JSON answers, no event stream (so no
// `list_changed` yet). Towards each node it keeps one MCP session per grant, in memory only, made
// again whenever the node forgets it or this object restarts.
//
// Names: `<node slug>__<the node's own tool name>`, at most 64 characters of [A-Za-z0-9_-]. A node
// that goes offline keeps its tools listed for the grace period, and a call fails fast with a tool
// error that says so; after that its tools leave the list. A call to a tool that isn't there gets
// the same kind of answer.

/** The protocol versions the hub speaks to agents, newest first. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
/** What the hub speaks to nodes (the Mac's MCP SDK takes it). */
const NODE_VERSION = '2025-06-18'
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const SEPARATOR = '__'
/** Pages of a node's tool list the hub follows, and how long it waits for them. */
const MAX_PAGES = 10
const LIST_TIMEOUT_MS = 10_000

export interface HubNode {
  readonly macId: string
  readonly slug: string
  readonly name: string
  /** Heard from recently: calls go to it. */
  readonly online: boolean
  /** Offline, but within the grace period: its tools stay listed and calls fail fast. */
  readonly listed: boolean
}

export interface HubAgent {
  readonly grantId: string
  readonly clientName: string
}

export interface HubMcpDeps {
  /** One POST to a node's /mcp, as the hub's forward for this grant. */
  forward(
    macId: string,
    grantId: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response>
}

interface Tool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly [key: string]: unknown
}

type Message = {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

class NodeFailed extends Error {}

export class HubMcp {
  /** The node's MCP session for a grant, `<grantId>:<macId>`. */
  private readonly sessions = new Map<string, string>()
  /** The node's tools as last listed for a grant: what an offline node shows during its grace. */
  private readonly tools = new Map<string, readonly Tool[]>()

  constructor(private readonly deps: HubMcpDeps) {}

  /** A POST to the hub's /mcp, from an agent already authenticated for `agent.grantId`. */
  async handle(request: Request, agent: HubAgent, nodes: readonly HubNode[]): Promise<Response> {
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
    let message: Message
    try {
      message = JSON.parse(await request.text()) as Message
    } catch {
      return reply(null, { error: { code: -32700, message: 'Parse error' } }, 400)
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0'
    )
      return reply(null, { error: { code: -32600, message: 'Invalid request' } }, 400)
    // A notification or a response from the agent: nothing to answer.
    if (message.id === undefined || message.method === undefined)
      return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
    const id = message.id
    switch (message.method) {
      case 'initialize': {
        const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const version = VERSIONS.find((v) => v === asked) ?? VERSIONS[0]
        return reply(id, {
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'valet', title: 'Valet', version: '1' },
            instructions:
              'Valet runs tools on the person’s own computers. Each tool name starts with the computer it runs on.',
          },
        })
      }
      case 'ping':
        return reply(id, { result: {} })
      case 'tools/list':
        return reply(id, { result: { tools: await this.list(agent, nodes) } })
      case 'tools/call':
        return reply(id, await this.call(id, message.params, agent, nodes, request.signal))
      default:
        return reply(id, { error: { code: -32601, message: 'Method not found' } })
    }
  }

  private async list(agent: HubAgent, nodes: readonly HubNode[]): Promise<Tool[]> {
    const lists = await Promise.all(
      nodes.map(async (node) => {
        const key = `${agent.grantId}:${node.macId}`
        if (node.online) {
          try {
            this.tools.set(key, await this.nodeTools(agent, node))
          } catch {
            // Keeps what it had: a node that didn't answer this once is not gone.
          }
        } else if (!node.listed) {
          this.tools.delete(key)
          this.sessions.delete(key)
        }
        const tools = node.online || node.listed ? (this.tools.get(key) ?? []) : []
        return tools.flatMap((tool) => {
          const name = `${node.slug}${SEPARATOR}${tool.name}`
          if (!NAME.test(name)) return []
          return [
            {
              ...tool,
              name,
              title: `${tool.title ?? tool.name} (${node.name})`,
              description: `On ${node.name}. ${tool.description ?? ''}`.trim(),
            },
          ]
        })
      }),
    )
    return lists.flat()
  }

  private async call(
    id: string | number | null,
    params: unknown,
    agent: HubAgent,
    nodes: readonly HubNode[],
    signal: AbortSignal,
  ): Promise<Omit<Message, 'jsonrpc' | 'id'>> {
    const p = params as { name?: unknown; arguments?: unknown } | undefined
    const name = typeof p?.name === 'string' ? p.name : ''
    const at = name.indexOf(SEPARATOR)
    const node = at > 0 ? nodes.find((n) => n.slug === name.slice(0, at)) : undefined
    const tool = at > 0 ? name.slice(at + SEPARATOR.length) : ''
    if (node === undefined || tool === '' || !(node.online || node.listed))
      return toolError(
        `There is no tool called ${JSON.stringify(name.slice(0, 80))}: the computer it ran on is offline or was removed, or the tool was turned off. List the tools again.`,
      )
    if (!node.online) return toolError(`${node.name} is offline, so nothing was sent. Try again shortly.`)
    try {
      const answer = await this.nodeRequest(
        agent,
        node,
        {
          jsonrpc: '2.0',
          id: id ?? 0,
          method: 'tools/call',
          params: { ...(p as object), name: tool },
        },
        signal,
      )
      if (answer.error !== undefined) return { error: answer.error }
      return { result: answer.result }
    } catch {
      return toolError(`${node.name} didn’t answer, so the call may not have run. Check before trying again.`)
    }
  }

  private async nodeTools(agent: HubAgent, node: HubNode): Promise<Tool[]> {
    const out: Tool[] = []
    let cursor: string | undefined
    const signal = AbortSignal.timeout(LIST_TIMEOUT_MS)
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await this.nodeRequest(
        agent,
        node,
        {
          jsonrpc: '2.0',
          id: `list-${page}`,
          method: 'tools/list',
          ...(cursor === undefined ? {} : { params: { cursor } }),
        },
        signal,
      )
      const result = answer.result as { tools?: unknown; nextCursor?: unknown } | undefined
      if (!Array.isArray(result?.tools)) throw new NodeFailed('no tools')
      for (const tool of result.tools as Tool[])
        if (typeof tool === 'object' && tool !== null && typeof tool.name === 'string') out.push(tool)
      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') break
      cursor = result.nextCursor
    }
    return out
  }

  /** One request to a node, in this grant's session there; a new session if the node forgot it. */
  private async nodeRequest(
    agent: HubAgent,
    node: HubNode,
    message: Message,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Message> {
    const key = `${agent.grantId}:${node.macId}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = this.sessions.get(key) ?? (await this.open(agent, node, signal))
      const response = await this.post(agent, node, message, session, signal)
      // The node restarted or closed the session: open another once.
      if (response.status === 404 && attempt === 0) {
        this.sessions.delete(key)
        continue
      }
      if (!response.ok) throw new NodeFailed(`node answered ${response.status}`)
      return await answerTo(response, message.id ?? null)
    }
    throw new NodeFailed('no session')
  }

  private async open(agent: HubAgent, node: HubNode, signal: AbortSignal): Promise<string> {
    const response = await this.post(
      agent,
      node,
      {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: NODE_VERSION,
          capabilities: {},
          clientInfo: {
            name: `${agent.clientName} (through your Valet account)`.slice(0, 100),
            version: '1',
          },
        },
      },
      null,
      signal,
    )
    const session = response.headers.get('mcp-session-id')
    if (!response.ok || session === null) throw new NodeFailed(`initialize: ${response.status}`)
    const answer = await answerTo(response, 'init')
    if (answer.error !== undefined) throw new NodeFailed('initialize refused')
    const done = await this.post(
      agent,
      node,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      session,
      signal,
    )
    await done.body?.cancel()
    this.sessions.set(`${agent.grantId}:${node.macId}`, session)
    return session
  }

  private post(
    agent: HubAgent,
    node: HubNode,
    message: Message,
    session: string | null,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.deps.forward(
      node.macId,
      agent.grantId,
      JSON.stringify(message),
      {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': NODE_VERSION,
        ...(session === null ? {} : { 'mcp-session-id': session }),
      },
      signal,
    )
  }
}

/** The node's answer to one request: plain JSON, or the matching message in an event stream. */
async function answerTo(response: Response, id: string | number | null): Promise<Message> {
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  const messages: unknown[] = []
  if (type.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data === '') continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        // Not a message; the stream's other events are not the hub's concern.
      }
    }
  } else {
    try {
      messages.push(JSON.parse(text))
    } catch {
      throw new NodeFailed('not JSON')
    }
  }
  const found = messages.find(
    (m): m is Message =>
      typeof m === 'object' && m !== null && (m as Message).id === id && (m as Message).method === undefined,
  )
  if (found === undefined) throw new NodeFailed('no answer')
  return found
}

function toolError(text: string): Omit<Message, 'jsonrpc' | 'id'> {
  return { result: { content: [{ type: 'text', text }], isError: true } }
}

function reply(id: string | number | null, body: Omit<Message, 'jsonrpc' | 'id'>, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, ...body }, { status, headers: { 'cache-control': 'no-store' } })
}
