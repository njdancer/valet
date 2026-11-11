// Connections: the endpoint, apps on this Mac, cloud agents and remote access on one page (P5).
// v2: story.md world (Sat 7 Nov, 9:48 pm), round 2 fixes (Reset asks first, agent page).
;(() => {
  const WF = window.WF
  const { K, sheet, dialog, FRAMES } = WF
  WF.GROUP_INTRO = WF.GROUP_INTRO || {}
  WF.GROUP_INTRO.Connections =
    'Who can call your tools. One page for this Mac\'s endpoint, the apps on this Mac, cloud agents and remote access, because "remote is just another kind of client" (P1, P3, P4, P5, P7). Each app and cloud agent has its own page with a computed <b>Can reach</b> panel (P3\'s blast radius), its calls, Reset access and Revoke. Revoked apps appear only in history, never in counts or Can reach.'

  const SITES = [
    ['W', 'Woolworths', 'warn'],
    ['Y', 'Yahoo Finance', 'warn'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const shell = (a, p, o = {}) => WF.shell(a, p, { badges: { needs: 4 }, sites: SITES, ...o })

  // ---- local helpers ----
  const mono = (t) => `<span class="mono">${t}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  const grid = (head, rows, o = {}) => {
    const pad = o.compact ? '5px 12px' : '8px 12px'
    const cell = (x, bg) =>
      `<div style="padding:${pad};border-bottom:1px solid var(--wf-line);display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;${bg}">${x}</div>`
    const th = head
      .map(
        (x) =>
          `<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--wf-ink-3);padding:6px 12px;border-bottom:1px solid var(--wf-line);white-space:nowrap">${x}</div>`,
      )
      .join('')
    const tr = rows
      .map((r, i) => {
        const bg = i === o.hover ? 'background:var(--wf-paper-2);' : ''
        const fade = o.faded?.includes(i) ? 'color:var(--wf-ink-2);' : ''
        return r.map((x) => cell(x, bg + fade)).join('')
      })
      .join('')
    return `<div role="table" style="display:grid;grid-template-columns:${o.cols}">${th}${tr}</div>`
  }
  const who = (av, name, sub) =>
    `<div class="row" style="gap:10px;min-width:0">${K.avatar(av)}<div class="col" style="gap:1px;min-width:0">${name}<small class="muted">${sub}</small></div></div>`
  const kvn = (rows, w = 120) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)
  const redBtn = (label) =>
    `<span class="wf-btn" style="background:var(--wf-bad);color:#fff;border-color:var(--wf-bad)">${label}</span>`
  const reachGroup = (title, items) =>
    `<div class="col" style="gap:3px"><span class="h3">${title}</span>${items.map((i) => `<span class="row" style="gap:6px">${i}</span>`).join('')}</div>`
  // The waiting request, as story.md has it. Decline and Approve have equal weight (round 2 decision).
  const askingBanner = (
    narrow,
  ) => `<div class="wf-banner warn" style="margin:10px 12px 12px;align-items:flex-start;${narrow ? 'flex-direction:column' : ''}">
      <div class="grow col" style="gap:3px"><b>1 asking to connect · ends 9:52 pm</b>
        <span>Asked 9:47 pm from ${mono('203.0.113.24')}. Calls itself “Claude (claude.ai)” <i>(not verified)</i>.</span>
        <span><b>If you didn't start this, decline it.</b> Anyone who knows your public name can ask.</span></div>
      <div class="row" style="flex:none">${K.btn('Decline')}${K.btn('Approve…')}</div></div>`
  const asking = askingBanner(false)

  // ---------------------------------------------------------------- Overview
  const endpointCard = K.card(
    "This Mac's endpoint",
    `<div class="row">${K.toggle(true)}<b>On</b><span class="muted">· this Mac only · 2 apps connected now</span></div>
     ${kvn(
       [
         ['Address', K.value('http://127.0.0.1:47821/mcp')],
         ['How apps connect', 'Each app has its own token, kept in its own config file'],
       ],
       116,
     )}
     <div class="faint">The switch stops every app on this Mac at once, with Undo.</div>`,
    `<span class="faint">Checked 9:46 pm</span>` + K.ghost('Check now'),
  )
  const remoteCard = K.card(
    'Remote access',
    `<div class="row">${K.toggle(true)}<b>On</b><span class="muted">· no cloud agents approved yet</span></div>
     ${kvn([['Public name', K.value('https://valet.example.com/mcp')]], 96)}
     <div class="muted">Cloud agents you approve can call only the tools you tick for them.</div>`,
    `<span class="faint">Reachable · checked 9:46 pm</span>` + K.ghost('Settings…'),
  )
  const appRows = [
    [
      who('CC', K.link('Claude Code'), 'calls itself “claude-code” · added 28 Oct'),
      '1 min ago',
      K.link('141 calls'),
      'All 12 tools on 3 sites',
    ],
    [
      who('CD', K.link('Claude Desktop'), 'calls itself “claude-ai” · access reset 5 Nov'),
      '26 min ago',
      K.link('28 calls'),
      'All 12 tools on 3 sites',
    ],
  ]
  const appsCard = K.card(
    'Apps on this Mac',
    grid(['App', 'Last call', 'Calls · 7 days', 'Can reach'], appRows, {
      cols: 'minmax(0,1fr) 110px 120px 190px',
      hover: 0,
    }) +
      `<div class="row muted" style="padding:8px 12px">1 revoked app (Cursor, revoked 3 Nov) is kept in history only. ${K.link('Show revoked')}</div>`,
    K.primary('Add an app…'),
    'flush',
  )
  const cloudCard = K.card(
    'Cloud agents',
    `<div class="muted" style="padding:12px 12px 0">None approved yet.</div>${asking}`,
    '',
    'flush',
  )
  const overview = () => `
    ${K.header({
      title: 'Connections',
      sub: 'Apps and agents that can call your tools through Valet.',
    })}
    <div class="wf-scroll">
      <div class="grid2">${endpointCard}${remoteCard}</div>
      ${appsCard}
      ${cloudCard}
    </div>`

  FRAMES.push({
    id: 'connections',
    group: 'Connections',
    title: 'Connections overview',
    personas: ['P1', 'P2', 'P3', 'P5'],
    desc: '#/connections (⌘4) at 9:48 pm. The endpoint and remote access (on, valet.example.com) as two switches with their state in words, the connected apps with what they can reach, and the one cloud agent asking to connect.',
    html: shell('connections', overview()),
    notes: [
      [
        262,
        161,
        'The switch is the control and its label says the state (P3 #11). Turning it off acts at once with an Undo toast (round 2 decision: Undo stays for the endpoint).',
      ],
      [
        466,
        163,
        "Every status, the endpoint's and remote access's, says when it was checked, and can be re-checked (principle 8).",
      ],
      [
        1160,
        472,
        'Local apps get every approved tool, said plainly (P3). Counts and Can reach list connected apps only: 2 apps, never Cursor (story, P1 M3).',
      ],
      [
        712,
        531,
        'Revoked Cursor lives in history only; "Show revoked" lists it with its audit records kept (P1 m6, P2 m9).',
      ],
      [1146, 350, '"Add an app…" opens a sheet over this page; Escape returns focus here (principle 5).'],
      [
        274,
        705,
        '1 asking to connect: the same request as Needs you, with who is asking (IP, time, claimed name marked not verified) and "If you didn\'t start this, decline it". Approve… opens the Needs you approval sheet; Decline and Approve… have equal weight (round 2 decision).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Remote access on
  const toolRow = (title, name, kind, on) =>
    `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--wf-line)">${K.toggle(on)}<span>${title}</span>${mono(name)}${K.badge(kind === 'write' ? 'changes your cart' : 'reads only', kind)}</div>`
  const remotePage = `
    ${K.header({
      crumbs: ['Connections', 'Remote access'],
      title: 'Remote access',
      sub: 'On · public name valet.example.com · no cloud agents approved yet.',
      actions: `<span class="row" style="gap:6px">${K.toggle(true)}<b>On</b></span>`,
    })}
    <div class="wf-scroll" style="gap:14px">
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="col" style="gap:14px">
          ${K.card(
            'Public names',
            `<div class="muted">The name your tunnel forwards to this Mac. Cloud agents connect to it.</div>
             <div class="row">${K.value('https://valet.example.com/mcp')}${K.ghost('Remove')}</div>
             <div class="row">${K.input('Add another name', '220px')}${K.btn('Add')}</div>
             <div class="row muted">${K.dot('ok')} Reachable from the internet · checked 9:46 pm ${K.ghost('Check now')}</div>`,
          )}
          ${K.card('Cloud agents', `<div class="muted" style="padding:12px 12px 0">None approved yet.</div>${askingBanner(true)}`, '', 'flush')}
        </div>
        ${K.card(
          'Tools cloud agents may use',
          `<div class="muted">Every tool starts off. An agent gets only the tools you tick when you approve it, and never more than these.</div>
           <div class="h3" style="margin-top:4px">Woolworths</div>
           <div class="col" style="gap:0">
             ${toolRow('Search products', 'search_products', 'read', true)}
             ${toolRow('Product details', 'product_details', 'read', true)}
             ${toolRow('Get cart', 'get_cart', 'read', true)}
             ${toolRow('Add to cart', 'add_to_cart', 'write', false)}
             ${toolRow('Update cart line', 'update_cart_line', 'write', false)}
             ${toolRow('Remove from cart', 'remove_from_cart', 'write', false)}
           </div>
           <div class="row" style="justify-content:space-between"><span class="h3">Yahoo Finance</span><span class="muted">0 of 3 on ▸</span></div>
           <div class="row" style="justify-content:space-between"><span class="h3">Wikipedia</span><span class="muted">0 of 3 on ▸</span></div>
           <div class="faint">The same switches are on each site's Tools tab.</div>`,
        )}
      </div>
    </div>`

  FRAMES.push({
    id: 'connections-remote-on',
    group: 'Connections',
    title: 'Remote access, turned on',
    personas: ['P1', 'P3', 'P7'],
    desc: '#/connections/remote at 9:48 pm. Public names with a reachability check, the request waiting, and one switch per tool, grouped by site.',
    html: shell('connections', remotePage),
    notes: [
      [
        1090,
        92,
        'At the story moment remote access is on with no agents approved. The switch is the control and says its state; turning off acts at once with Undo.',
      ],
      [
        522,
        251,
        'The public name is a value with copy; reachability says when it was checked (principle 8).',
      ],
      [
        274,
        566,
        'The waiting request with its identity and warning; in the narrow card the buttons drop below the text (round 2 decision).',
      ],
      [
        1130,
        387,
        'One switch per tool, grouped by site. Every tool starts off; reads were turned on here, writes stay off (P3).',
      ],
      [1130, 527, "The same switches as each site's Tools tab: one source, two views."],
    ],
  })

  // ---------------------------------------------------------------- App page: Claude Code
  const canReach = K.card(
    'Can reach',
    `<div class="muted">Worked out from what is approved now (9:48 pm). A call from Claude Code can make Valet:</div>
     ${reachGroup('Use 12 tools on 3 sites', [
       `${K.link('Woolworths')} 6 tools · 3 change your cart · 1 asks you first`,
       `${K.link('Yahoo Finance')} 3 tools · read only`,
       `${K.link('Wikipedia')} 3 tools · read only`,
     ])}
     ${reachGroup('Contact 5 hosts', [
       mono('www.woolworths.com.au · auth.woolworths.com.au'),
       mono('finance.yahoo.com · query1.finance.yahoo.com'),
       mono('en.wikipedia.org'),
     ])}
     ${reachGroup('Type 1 login', [
       `${K.link('Woolworths login')} ${K.badge('login', 'secret')} at ${mono('auth.woolworths.com.au')}`,
     ])}
     <div class="faint">Apps on this Mac can call every approved tool. ${K.link('Why?')}</div>`,
    K.ghost('Copy as text'),
  )
  const recent = [
    [ref('7F2A'), '9:48 pm', tool('remove_from_cart'), K.badge('Waiting for you', 'warn')],
    [ref('9A71'), '9:47 pm', tool('get_cart'), K.badge('Needs you · login', 'warn')],
    [ref('8F2E'), '9:31 pm', tool('update_cart_line'), K.badge('ok, 2 blocked', 'info')],
    [ref('5C10'), '6:10 pm', tool('remove_from_cart'), K.badge('Missed', 'idle')],
  ]
  const appPage = (o = {}) => `
    ${K.header({
      crumbs: ['Connections', 'Apps on this Mac'],
      title: 'Claude Code',
      status: K.badge('Connected · 1 session', 'ok'),
      actions: K.btn('Reset access…') + K.dangerSoft('Revoke…'),
    })}
    <div class="wf-scroll">
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        ${canReach}
        <div class="col" style="gap:16px">
          ${K.card(
            'Recent calls',
            grid([], recent, { cols: '54px 66px minmax(0,1fr) auto', compact: true }) +
              `<div class="row" style="padding:8px 12px">${K.link('All 141 calls in 7 days')}<span class="grow"></span>${K.link('Its audit records')}</div>`,
            '',
            'flush',
          )}
          ${K.card(
            'Access',
            kvn(
              [
                [
                  'Calls itself',
                  `${mono('claude-code')} <span class="faint">(its own word, proves nothing)</span>`,
                ],
                ['Connects', 'Through the Valet bridge (stdio)'],
                ['Token', o.token || 'Its own · issued 28 Oct · never reset'],
                ['Added', 'Wed 28 Oct, 8:14 pm'],
              ],
              92,
            ) + `<div class="row">${K.ghost('Show setup command')}</div>`,
          )}
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'connections-app',
    group: 'Connections',
    title: 'App page: Claude Code',
    personas: ['P1', 'P3', 'P5', 'P2'],
    desc: '#/connections/c_c7d2a1b2. What this app can reach (computed), what it did recently, and its access. Reset access and Revoke appear once, in the header.',
    html: shell('connections', appPage()),
    notes: [
      [349, 163, 'Can reach is computed from what is approved now and says when (P3 blast radius).'],
      [
        262,
        249,
        'Each site links to its page; the counts say which tools change things and which ask you first.',
      ],
      [262, 410, 'Logins it can cause Valet to type, linked to the login page (P6).'],
      [262, 456, 'Local apps get every approved tool today; per-app limits are an open IA gap (P3).'],
      [850, 320, 'Recent calls per story (7F2A, 9A71, 8F2E, 5C10) and a door to all of them (P1, E7).'],
      [942, 91, 'Reset access… and Revoke… appear once, in the header (P1 M8, P5 m7). Both ask first.'],
    ],
  })

  // ---------------------------------------------------------------- Add an app
  const option = (on, title, body, action) =>
    `<div style="border:1px solid ${on ? 'var(--wf-act)' : 'var(--wf-line)'};border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px">
      <div class="row">${K.radio('', on)}<b>${title}</b></div>${body}${action}</div>`
  const addSheet = sheet(
    'Add an app',
    `<p class="muted" style="margin:0">Each app gets its own token, so its calls show under its own name and you can revoke it alone.</p>
     ${option(
       true,
       'Claude Desktop',
       `<span class="muted">One click. Valet adds itself to Claude Desktop's settings and keeps a backup of the old file. Then quit and reopen Claude Desktop.</span>`,
       `<div class="row">${K.primary('Add to Claude Desktop')}<span class="faint">${mono('~/Library/Application Support/Claude/…')}</span></div>`,
     )}
     ${option(
       false,
       'Claude Code',
       `<span class="muted">Run this once in Terminal:</span>`,
       `<div class="row">${K.value("claude mcp add valet -- /Applications/Valet.app/Contents/MacOS/valet-bridge '…/client-configs/c_9e3f.json'")}</div>`,
     )}
     ${option(false, 'Another app', `<span class="muted">For developers: any app that speaks MCP over stdio. Copy the JSON for its settings file.</span>`, `<div class="row">${K.btn('Copy JSON')}</div>`)}
     <div class="row muted">${K.dot('idle')} Waiting for the first call from the new app… (announced when it arrives)</div>`,
    `${K.ghost('Help')}<span class="grow"></span>${K.btn('Done')}`,
  )

  FRAMES.push({
    id: 'connections-add-app',
    group: 'Connections',
    title: 'Add an app (sheet)',
    personas: ['P2', 'P1', 'P5'],
    desc: 'Opens over Connections from "Add an app…" (and from Setup). Three ways in, the easy one first; ends with a live tick when the first call arrives.',
    html: shell('connections', overview(), { over: addSheet }),
    notes: [
      [290, 118, 'Why each app gets its own token, in one sentence (P2).'],
      [
        480,
        229,
        'Claude Desktop is one click, with a backup of its settings file: the easy path first (P2).',
      ],
      [864, 340, 'The Claude Code command is a value: selectable, with copy (E3).'],
      [414, 462, '"Another app" says it is for developers, so P2 can skip it (P2 S5).'],
      [290, 512, 'Waits for the first call and announces the tick when it arrives (P5 S5, P9).'],
    ],
  })

  // ---------------------------------------------------------------- Revoke dialog
  const recentBox = `<div style="background:var(--wf-paper-2);border:1px solid var(--wf-line);border-radius:8px;padding:8px 10px" class="col">
       <span><b style="color:var(--wf-ink)">What it did recently</b> · ${K.link('141 calls in 7 days')}, last 1 min ago</span>
       <span>${ref('7F2A')} ${mono('remove_from_cart')} · waiting for you</span>
       <span>${ref('9A71')} ${mono('get_cart')} · needs you (login)</span>
       <span>${ref('8F2E')} ${mono('update_cart_line')} · ok, 2 blocked</span>
     </div>`
  const revokeDialog = dialog(
    'Revoke Claude Code?',
    `<div>Claude Code can't call any tool until you add it again. Its token stops working now and its open session ends.</div>
     ${recentBox}
     <div>Its 2 waiting calls (7F2A, 9A71) are declined. This can't be undone. To give it a new token instead, use Reset access.</div>`,
    `${K.ghost('Reset access instead…')}<span class="grow"></span>${K.btn('Cancel')}${redBtn('Revoke Claude Code')}`,
  )

  FRAMES.push({
    id: 'connections-revoke',
    group: 'Connections',
    title: 'Revoke dialog',
    personas: ['P3', 'P1', 'P5', 'P2'],
    desc: 'Opens over the app page. Names what stops working and shows what the app did recently, so the decision is made on evidence.',
    html: shell('connections', appPage(), { over: revokeDialog }),
    notes: [
      [
        380,
        286,
        "Names what stops working in the app's name (E4); role=alertdialog, labelled by the question (P5).",
      ],
      [391, 336, 'Evidence before the decision: what it did recently, per story refs (P3).'],
      [
        380,
        441,
        "Says which waiting calls are declined and that it can't be undone; Reset access instead… opens the reset dialog (P1).",
      ],
      [594, 482, 'Initial focus on Cancel; Escape cancels; focus returns to Revoke… (P5).'],
    ],
  })

  // ---------------------------------------------------------------- Reset access (asks first, no Undo)
  const resetDialog = dialog(
    "Reset Claude Code's access?",
    `<div>Claude Code gets a new token and <b>the old one stops working at once</b>. Use this if you think the token leaked.</div>
     <div>Its open session ends and its 2 waiting calls (7F2A, 9A71) are declined. The Valet bridge reads the new token from Claude Code's config file and reconnects by itself; nothing to set up again.</div>
     <div>This can't be undone. To cut Claude Code off completely, use Revoke.</div>`,
    `<span class="grow"></span>${K.btn('Cancel')}${K.danger('Reset access')}`,
  )

  FRAMES.push({
    id: 'connections-reset',
    group: 'Connections',
    title: 'Reset access (asks first)',
    personas: ['P3', 'P1', 'P5'],
    desc: "Replaces v1's Reset with Undo. A token may be reset because it leaked, so it stops at once, there is no grace period and no Undo (round 2 decision, P3 over P1).",
    html: shell('connections', appPage(), { over: resetDialog }),
    notes: [
      [
        380,
        315,
        'Reset asks first and the old token stops at once: no grace period, no Undo, because a reset may answer a leak (round 2 decision, P3 #3).',
      ],
      [380, 356, 'Says what ends (the session, the waiting calls) and why nothing has to be set up again.'],
      [380, 412, "States it can't be undone, and points to Revoke for cutting it off completely."],
      [
        596,
        472,
        'Initial focus on Cancel; afterwards focus returns to Reset access… and a live region says "Claude Code has a new token" (P5).',
      ],
    ],
  })

  // ---------------------------------------------------------------- A cloud agent's page
  const agentTool = (title, name, kind, on) =>
    `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--wf-line)">${K.toggle(on)}<span>${title}</span>${mono(name)}${K.badge(kind === 'write' ? 'changes your cart' : 'reads only', kind)}</div>`
  const agentPage = `
    ${K.header({
      crumbs: ['Connections', 'Cloud agents'],
      title: 'Claude (claude.ai)',
      status: K.badge('Connected', 'ok'),
      sub: `Calls itself “Claude (claude.ai)” <i>(not verified)</i> · approved 9:50 pm from ${mono('203.0.113.24')} · a later moment than the story`,
      actions: K.btn('Reset access…') + K.dangerSoft('Revoke…'),
    })}
    <div class="wf-scroll">
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="col" style="gap:16px">
          ${K.card(
            'Can reach',
            `<div class="muted">Worked out from the tools you gave it (9:50 pm). A call from this agent can make Valet:</div>
             ${reachGroup('Use 3 tools on 1 site', [`${K.link('Woolworths')} Search products, Product details, Get cart · read only`])}
             ${reachGroup('Contact 2 hosts', [mono('www.woolworths.com.au · auth.woolworths.com.au')])}
             ${reachGroup('Type 1 login', [`${K.link('Woolworths login')} ${K.badge('login', 'secret')} when Woolworths is logged out`])}`,
            K.ghost('Copy as text'),
          )}
          ${K.card(
            'Access',
            kvn(
              [
                ['Comes in through', mono('valet.example.com')],
                ['Token', 'Its own · issued 9:50 pm'],
                ['Ends', 'When you revoke it or turn remote access off'],
              ],
              112,
            ),
          )}
        </div>
        <div class="col" style="gap:16px">
          ${K.card(
            'Tools it may use',
            `<div class="muted">Only tools that are on for cloud agents can be given. Writes stay off unless you turn them on here.</div>
             <div class="col" style="gap:0">
               ${agentTool('Search products', 'search_products', 'read', true)}
               ${agentTool('Product details', 'product_details', 'read', true)}
               ${agentTool('Get cart', 'get_cart', 'read', true)}
             </div>
             <div class="faint">3 more Woolworths tools are off for all cloud agents. ${K.link('Remote access')}</div>`,
          )}
          ${K.card(
            'Calls',
            `<div class="muted">No calls yet. Its calls will show here and in ${K.link('Activity')}, filtered to this agent.</div>`,
          )}
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'connections-agent',
    group: 'Connections',
    title: 'Cloud agent page: Claude (claude.ai)',
    personas: ['P3', 'P1', 'P7'],
    desc: '#/connections/rc_7a2f… Two minutes after the story moment, once the request was approved with 3 read tools. Same template as an app page, plus where it comes in from and its own tool switches.',
    html: shell('connections', agentPage, { badges: { needs: 3 } }),
    notes: [
      [
        522,
        124,
        'Who it is, as far as Valet knows: the name it calls itself (not verified), where it came from, when approved (P3, P7).',
      ],
      [262, 275, "Can reach for a cloud agent is narrower than an app's: only the tools it was given (P3)."],
      [
        262,
        361,
        'Even read tools can cause a login to be typed; said here and in the approve sheet (P3 #2).',
      ],
      [1126, 222, 'Its own tool switches (per-agent scope), limited by the remote access switches (P3 #7).'],
      [262, 477, 'Where it comes in and when its token ends; Revoke… asks first, like an app (E4).'],
    ],
  })
})()
