// The claude.ai manifest: Nick's Claude Code projects (each a project chat with a coordinator, and
// threads), so a Claude elsewhere (voice Claude on the phone, say) can consult a coordinator or a
// thread and report back. The brief is Nick's "Valet Claude.ai Adapter Brief".
//
// The calls are the ones claude.ai's own project pages make, seen in a signed-in browser on
// 2026-11-20: /v1/code/channels (a project is a "channel"), its timeline (the project chat, newest
// first), its threads, one thread's messages, the coordinator's session for whether it is working,
// and POST .../messages to send. Each /v1/ call needs an anthropic-version header; the session
// cookie does the rest. Assumed, not seen: a reply in a thread is a POST with
// reply_to_message_id set to the thread's root, as the thread composer's code sends it.
//
// The login: claude.ai signs in by an emailed link or code. For now the person signs in once in
// Valet's window (the hand-off), and the session is kept; Valet signing in by itself from the
// email (openMailLink) is the next step, once a mailbox is set up for it.

import { type AdapterManifest, type AuthStep, type Condition, parseManifest } from '@valet/core'
import { REAL_ORIGIN } from './site'

export { REAL_ORIGIN } from './site'

export interface ManifestOptions {
  readonly origin?: string
}

/** Paths on claude.ai the sign-in shows. Anywhere else, signed in or not, the probe decides. */
const ON_LOGIN: Condition = { urlRegex: '^/(login|magic-link)([/?#]|$)' }

/**
 * Where the sign-in page's bot checks load their frames from. The live page (2026-11-20) loaded
 * hCaptcha's frame from newassets.hcaptcha.com; refused, the form answered "Couldn't verify your
 * browser". hCaptcha's other frame hosts and Cloudflare's are listed too, so a change of provider
 * or host doesn't stop the sign-in again. A challenge that needs solving is solved by the person.
 */
const CHALLENGE_ORIGINS = [
  'https://newassets.hcaptcha.com',
  'https://assets.hcaptcha.com',
  'https://hcaptcha.com',
  'https://challenges.cloudflare.com',
]

export const NOTES = {
  signIn:
    'Sign in to claude.ai in this window: type your email, then the code from the email claude.ai sends you. Valet keeps the session, so this is rare.',
} as const

/**
 * The pauses while the sign-in page settles, 9 s in all: an already signed-in session (the auth
 * partition remembers it) is sent from /login straight on to a chat, with nothing to type.
 */
const SETTLE_PAUSES_MS = [500, 1000, 1500, 2000, 2000, 2000] as const

function settle(condition: Condition, pauses: readonly number[] = SETTLE_PAUSES_MS): AuthStep[] {
  const [first, ...rest] = pauses
  if (first === undefined) return []
  return [
    {
      op: 'when',
      condition: { not: condition },
      steps: [{ op: 'pause', ms: first }, ...settle(condition, rest)],
    },
  ]
}

function authSteps(origin: string): AuthStep[] {
  return [
    { op: 'goto', url: `${origin}/login` },
    ...settle({ not: ON_LOGIN }),
    {
      op: 'when',
      condition: ON_LOGIN,
      steps: [{ op: 'needsUser', reason: 'login-required', note: NOTES.signIn }],
    },
    { op: 'assertLoggedIn' },
  ]
}

/** The most requests Valet sends claude.ai in an hour, across every call. */
export const REQUESTS_PER_HOUR = 1200

export function createManifest({ origin = REAL_ORIGIN }: ManifestOptions = {}): AdapterManifest {
  const host = new URL(origin).hostname
  return parseManifest({
    schemaVersion: 1,
    id: 'claude-ai',
    name: 'Claude.ai projects',
    version: '0.1.1',
    description:
      "Talk to the person's Claude Code projects on claude.ai: list projects and threads, read a project chat or thread, and send a message to a project's coordinator or to one thread.",
    // A plain page on the site, so the tool page is same-origin with the API without running the
    // whole app (whose own calls the request surface would refuse).
    home: `${origin}/robots.txt`,
    navigation: [origin],
    egress: [host],
    session: {
      // claude.ai sets its session cookie for .claude.ai, which is stored against the bare host.
      cookieDomains: [host],
      probe: {
        kind: 'fetch',
        path: '/api/account',
        expectStatus: 200,
        loggedOutStatuses: [401, 403],
        // send_message may rest on a "signed in" answer for a minute.
        trustSeconds: 60,
      },
    },
    auth: { steps: authSteps(origin), frameOrigins: origin === REAL_ORIGIN ? CHALLENGE_ORIGINS : [] },
    // Exactly the calls the tools make. Nothing here can archive, leave, change members or settings:
    // the only write is sending a message.
    requests: [
      { method: 'GET', path: '/v1/code/channels', purpose: 'read' },
      { method: 'GET', path: '/v1/code/channels/:channel', purpose: 'read' },
      { method: 'GET', path: '/v1/code/channels/:channel/timeline', purpose: 'read' },
      { method: 'GET', path: '/v1/code/channels/:channel/threads', purpose: 'read' },
      { method: 'GET', path: '/v1/code/channels/:channel/threads/:thread', purpose: 'read' },
      { method: 'GET', path: '/v1/code/sessions/:session', purpose: 'read' },
      { method: 'POST', path: '/v1/code/channels/:channel/messages', purpose: 'write' },
    ],
    tools: [
      {
        name: 'list_projects',
        title: 'List projects',
        description:
          "The person's Claude Code projects on claude.ai: each one's id, title and description (what it is for), and when it was last active. Use the title and description to pick the project a request is about.",
        sideEffect: 'read',
      },
      {
        name: 'list_threads',
        title: 'List threads',
        description:
          "A project's threads: each one's id, title, status (working, needs_input, idle, failed, resolved) and its one-line status. A fallback for a thread whose id no coordinator reply has given you; coordinators name threads with their ids inline, as links like (#cmsg_…).",
        sideEffect: 'read',
      },
      {
        name: 'read_messages',
        title: 'Read messages',
        description:
          "Messages in a project chat (no threadId: the person and the coordinator) or in one thread, newer than `after` (a cursor from send_message or an earlier read_messages), or the latest few without it. Returns the messages oldest first, a new cursor, and `working`: whether the coordinator or thread is still busy, so more may come. Messages the person's account sent, including yours through send_message, are from 'person'.",
        sideEffect: 'read',
      },
      {
        name: 'send_message',
        title: 'Send message',
        description:
          "Sends a message as the person: to a project's coordinator (no threadId) or straight to one thread. It arrives in their name, so say in it that it comes from you on their behalf when that matters. Returns a cursor just after it for read_messages. With wait (the default), waits up to waitSeconds (at most 30) for the reply to finish; if it is still going, returns what there is with working: true. The coordinator answers itself and starts threads for longer work; it doesn't wait for those threads.",
        sideEffect: 'write',
        // Adds a message; nothing is changed or removed. Sending twice sends twice.
        destructive: false,
        idempotent: false,
      },
    ],
    // A read is one to four requests, a send with its wait up to about twenty, a second or more
    // apart. claude.ai's own page polls faster than this.
    limits: {
      requestsPerRun: 30,
      minGapMs: 1500,
      gapJitterPercent: 20,
      requestsPerMinute: 60,
      requestsPerHour: REQUESTS_PER_HOUR,
    },
  })
}

export default createManifest()
