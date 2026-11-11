// Connections: the endpoint, apps on this Mac, cloud agents and remote access on one page (P5).
;(function () {
  const { K, shell, sheet, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Connections'] =
    'Who can call your tools. One page for this Mac\'s endpoint, the apps on this Mac, cloud agents and remote access, because "remote is just another kind of client" (P1, P3, P4, P5, P7). Each app and cloud agent has its own page with a computed <b>Can reach</b> panel (P3\'s blast radius), its calls, Reset access and Revoke.'

  // ---- local helpers ----
  const mono = (t) => `<span class="mono">${t}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  // Table built from divs: the kit's .wf-table styles every nested span as a cell.
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
        const bg =
          i === o.sel ? 'background:var(--wf-sel);' : i === o.hover ? 'background:var(--wf-paper-2);' : ''
        const fade = o.faded && o.faded.includes(i) ? 'opacity:.6;' : ''
        return r.map((x) => cell(x, bg + fade)).join('')
      })
      .join('')
    return `<div role="table" style="display:grid;grid-template-columns:${o.cols}">${th}${tr}</div>`
  }
  const who = (av, name, sub) =>
    `<div class="row" style="gap:10px;min-width:0">${K.avatar(av)}<div class="col" style="gap:1px;min-width:0"><b>${name}</b><small class="muted">${sub}</small></div></div>`
  const kvn = (rows, w = 120) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)

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
     <div class="faint">Turning it off stops every app on this Mac at once. You can undo it.</div>`,
    K.badge('Checked 9:46 pm', 'idle') + K.ghost('Check now'),
  )
  const remoteCard = K.card(
    'Remote access',
    `<div class="row">${K.toggle(false)}<b>Off</b><span class="muted">· cloud agents can't reach Valet</span></div>
     <div class="muted">Lets a cloud agent such as Claude on claude.ai call the tools you choose, through a public name your tunnel forwards to this Mac.</div>
     <div class="row">${K.btn('Set up remote access…')}${K.ghost('How it works')}</div>`,
  )
  const appRows = [
    [
      who('CC', 'Claude Code', 'calls itself “claude-code” · added 1 Nov'),
      '1 min ago',
      K.link('141 calls'),
      'All 12 tools on 3 sites',
      K.btn('Open'),
    ],
    [
      who('CD', 'Claude Desktop', 'calls itself “claude-ai” · access reset 9 Nov'),
      '4 min ago',
      K.link('28 calls'),
      'All 12 tools on 3 sites',
      K.btn('Open'),
    ],
    [
      who('C', 'Cursor', 'calls itself “cursor” · revoked 7 Nov'),
      '—',
      '0',
      K.badge('Revoked', 'idle'),
      K.ghost('Remove from list'),
    ],
  ]
  const appsCard = K.card(
    'Apps on this Mac',
    grid(['App', 'Last call', 'Calls · 7 days', 'Can reach', ''], appRows, {
      cols: 'minmax(0,1fr) 92px 110px 170px 130px',
      faded: [2],
      hover: 0,
    }),
    K.primary('Add an app…'),
    'flush',
  )
  const cloudCard = K.card(
    'Cloud agents',
    `<div class="row muted" style="padding:14px">None yet. Turn on remote access, then a cloud agent asks to connect and you approve it with a code it shows you.</div>`,
    '',
    'flush',
  )
  const overview = (over = '') => `
    ${K.header({
      title: 'Connections',
      sub: 'Apps and agents that can call your tools through Valet.',
    })}
    <div class="wf-scroll">
      <div class="grid2">${endpointCard}${remoteCard}</div>
      ${appsCard}
      ${cloudCard}
    </div>${over}`

  FRAMES.push({
    id: 'connections',
    group: 'Connections',
    title: 'Connections overview',
    personas: ['P1', 'P2', 'P3', 'P5'],
    desc: '#/connections (⌘4). The endpoint and remote access as two switches with their state in words, then every app and cloud agent with what it can reach.',
    html: shell('connections', overview()),
    notes: [
      [
        250,
        161,
        'The endpoint says its state in words, with the address as a copyable value. Turning it off acts at once with an Undo toast (E4); it stops every app on this Mac.',
      ],
      [462, 162, 'Every status says when it was checked, and can be re-checked (principle 8).'],
      [
        1000,
        440,
        'Each app says what it can reach in words: local apps get every approved tool, so say so plainly ("All 12 tools on 3 sites") (P3). "141 calls" opens Calls filtered to the app (E7).',
      ],
      [
        930,
        531,
        'A revoked app stays listed, greyed, with the date; "Remove from list" only tidies the list (P3 evidence).',
      ],
      [1146, 350, '"Add an app…" opens a sheet over this page; Escape returns focus here (principle 5).'],
      [
        697,
        264,
        'Remote access lives here because remote is just another kind of client (P1, P3, P4, P5, P7). Off says what that means.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Remote access on
  const toolRow = (title, name, kind, on) =>
    `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--wf-line)">${K.toggle(on)}<span>${title}</span>${mono(name)}${K.badge(kind === 'write' ? 'changes your trolley' : 'reads only', kind)}</div>`
  const remotePage = `
    ${K.header({
      crumbs: ['Connections', 'Remote access'],
      title: 'Remote access',
      status: K.badge('On', 'ok'),
      actions: K.btn('Turn off'),
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
          ${K.card(
            'Cloud agents',
            grid(
              ['Agent', 'Approved', 'Tools', ''],
              [
                [
                  `<div class="col" style="gap:1px"><b>Claude</b><small class="muted">${mono('claude.ai')} · from 203.0.113.24</small></div>`,
                  '9:20 pm',
                  '2 of 12',
                  K.btn('Open'),
                ],
              ],
              { cols: 'minmax(0,1fr) 70px 60px 70px' },
            ) +
              `<div class="wf-banner warn" style="margin:10px 12px 12px"><div class="grow"><b>Approve a connection</b> A cloud agent is asking now · ends 9:52 pm. Only approve it if you just started this.</div>${K.primary('Approve…')}</div>`,
            '',
            'flush',
          )}
        </div>
        ${K.card(
          'Tools cloud agents may use',
          `<div class="muted">Every tool starts off. An agent also gets only the tools you tick when you approve it.</div>
           <div class="h3" style="margin-top:4px">Woolworths</div>
           <div class="col" style="gap:0">
             ${toolRow('Search products', 'search_products', 'read', true)}
             ${toolRow('Product details', 'product_details', 'read', true)}
             ${toolRow('Get cart', 'get_cart', 'read', true)}
             ${toolRow('Add to cart', 'add_to_cart', 'write', false)}
             ${toolRow('Update cart line', 'update_cart_line', 'write', false)}
             ${toolRow('Remove from cart', 'remove_from_cart', 'write', false)}
           </div>
           <div class="row" style="justify-content:space-between"><span class="h3">Yahoo Finance</span><span class="muted">1 of 3 on ▸</span></div>
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
    desc: '#/connections/remote. Public names with a reachability check, the cloud agents approved so far, and one switch per tool, grouped by site.',
    html: shell('connections', remotePage),
    notes: [
      [1070, 91, '"On" is a status; Turn off is the button beside it (E1). It acts at once with Undo (E4).'],
      [
        488,
        206,
        'The public name is a value with copy, and reachability says when it was checked (principle 8).',
      ],
      [
        262,
        490,
        'A waiting request shows here as well as in Needs you, with the same title and the same code sheet (principle 1). "Only approve it if you just started this" (P2).',
      ],
      [
        1130,
        360,
        'One switch per tool, grouped by site, saying whether it changes your trolley. Every tool starts off (P3).',
      ],
      [1130, 500, "The same switches as each site's Tools tab: one source, two views (P3, link matrix)."],
    ],
  })

  // ---------------------------------------------------------------- App page: Claude Code
  const reachGroup = (title, items) =>
    `<div class="col" style="gap:3px"><span class="h3">${title}</span>${items.map((i) => `<span class="row" style="gap:6px">${i}</span>`).join('')}</div>`
  const canReach = K.card(
    'Can reach',
    `<div class="muted">Worked out from what is approved now. A call from Claude Code can make Valet:</div>
     ${reachGroup('Use 12 tools on 3 sites', [
       `${K.link('Woolworths')} 6 tools · 3 change your trolley · 1 asks you first`,
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
    [ref('9A71'), '9:47 pm', tool('get_cart'), K.badge('Waiting for you', 'warn')],
    [ref('6B3E'), '9:40 pm', tool('get_cart'), K.badge('Failed', 'bad')],
    [ref('8F2E'), '9:31 pm', tool('update_cart_line'), K.badge('ok, 2 blocked', 'info')],
    [ref('7B0C'), '9:30 pm', tool('search_products'), K.badge('ok', 'ok')],
  ]
  const appPage = (over = '', opts = {}) => `
    ${K.header({
      crumbs: ['Connections', 'Apps on this Mac'],
      title: 'Claude Code',
      status: opts.status || K.badge('Connected · 1 session', 'ok'),
      actions: K.btn('Reset access') + K.danger('Revoke…'),
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
            `${kvn(
              [
                [
                  'Calls itself',
                  `${mono('claude-code')} <span class="faint">(its own word, proves nothing)</span>`,
                ],
                ['Connects', 'Through the Valet bridge (stdio)'],
                ['Token', opts.token || 'Its own · issued 1 Nov · never reset'],
                ['Added', '1 Nov, 8:14 pm'],
              ],
              92,
            )}
             <div class="row">${K.btn('Reset access')}${K.danger('Revoke…')}<span class="grow"></span>${K.ghost('Show setup command')}</div>`,
          )}
        </div>
      </div>
    </div>${over}`

  FRAMES.push({
    id: 'connections-app',
    group: 'Connections',
    title: 'App page: Claude Code',
    personas: ['P1', 'P3', 'P5', 'P2'],
    desc: '#/connections/c_c7d2a1b2. What this app can reach (computed), what it did recently, and its access: Reset access first, Revoke in red.',
    html: shell('connections', appPage()),
    notes: [
      [
        337,
        163,
        "Can reach is computed from what is approved now: tools, sites, hosts, logins a call from this app can cause (P3 blast radius). Copy as text for P3's notes.",
      ],
      [
        250,
        249,
        'Each site links to its page; the counts say which tools change things and which ask you first.',
      ],
      [250, 410, 'Logins it can cause Valet to type, linked to the login page (P6 "can be triggered by").'],
      [
        250,
        456,
        'Local apps get every approved tool today; "Why?" explains. Per-app tool limits are an open IA gap (P3 asked for them).',
      ],
      [
        850,
        350,
        'The last 5 calls inline and a door to all of them, filtered (P1). "Its audit records" opens the Audit log filtered to this app.',
      ],
      [
        954,
        91,
        'Reset access looks like the default action and Revoke is red and confirms (P1, E4). Accessible names include the app: "Revoke Claude Code" (P5).',
      ],
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
     ${option(false, 'Another app', `<span class="muted">Any app that speaks MCP over stdio. Copy the JSON for its settings file.</span>`, `<div class="row">${K.btn('Copy JSON')}</div>`)}
     <div class="row muted">${K.dot('idle')} Waiting for the first call from the new app…</div>`,
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
        'Claude Desktop is one click: Valet edits its settings file and keeps a backup. The easy path comes first (P2).',
      ],
      [
        864,
        340,
        'The Claude Code command is a value: selectable, with copy (E3). The config path is unique to the new app.',
      ],
      [
        290,
        512,
        'The sheet waits for the first call and ticks when it arrives, linking the call (P9: done means it works).',
      ],
      [414, 462, 'Escape closes the sheet and focus returns to "Add an app…" (principle 5, P5).'],
    ],
  })

  // ---------------------------------------------------------------- Revoke dialog
  const revokeDialog = dialog(
    'Revoke Claude Code?',
    `<div>Claude Code can't call any tool until you add it again. Its token stops working now and its open session ends.</div>
     <div style="background:var(--wf-paper-2);border:1px solid var(--wf-line);border-radius:8px;padding:8px 10px" class="col">
       <span><b style="color:var(--wf-ink)">What it did recently</b> · ${K.link('141 calls in 7 days')}, last 1 min ago</span>
       <span>${ref('7F2A')} ${mono('remove_from_cart')} · waiting for you</span>
       <span>${ref('9A71')} ${mono('get_cart')} · waiting for you</span>
       <span>${ref('6B3E')} ${mono('get_cart')} · failed</span>
     </div>
     <div>Its 2 waiting calls will be declined. This can't be undone. To give it a new token instead, use Reset access.</div>`,
    `${K.ghost('Reset access instead')}<span class="grow"></span>${K.btn('Cancel')}${K.btn('Revoke Claude Code', 'danger primary').replace('wf-btn danger primary', 'wf-btn danger" style="background:var(--wf-bad);color:#fff;border-color:var(--wf-bad)')}`,
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
        "Names what stops working, using the app's name (E4). role=alertdialog, labelled by the question and described by the consequence (P5).",
      ],
      [391, 336, 'Evidence before the decision: what it did recently, each call a link (P3 E4 refine).'],
      [
        380,
        441,
        "Says what happens to its waiting calls and that it can't be undone, and offers Reset access as the gentler option (P1). No undo toast for a revoke (P3).",
      ],
      [
        594,
        482,
        'Initial focus on Cancel; Escape cancels; afterwards focus returns to the Revoke button, or to the h1 if the page changes (P5).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Reset access with undo
  const toast = K.toast('Claude Code has a new token · 1 session restarted', K.btn('Undo  ⌘Z'))
  FRAMES.push({
    id: 'connections-reset-undo',
    group: 'Connections',
    title: 'Reset access, with Undo',
    personas: ['P1', 'P3', 'P5'],
    desc: 'Reset access acts at once (it is the default, recoverable action) and offers Undo for a short grace period; Revoke is the one that confirms.',
    html: shell(
      'connections',
      appPage(toast, {
        status: K.badge('Connected · 1 session', 'ok'),
        token: `Its own · ${'<b>reset just now</b>'} · old token works for 10 s`,
      }),
    ),
    notes: [
      [
        896,
        712,
        'Reset access acts at once and offers Undo (and ⌘Z) while the old token still works, 10 s. The toast stays until 10 s after the last keyboard activity (P1, P5).',
      ],
      [970, 464, 'The page shows the change in place ("reset just now"), and a live region says it (P5).'],
      [
        954,
        72,
        'Assumption: P3 asked to treat Reset as destructive because it ends live sessions. We keep it one click with Undo because the bridge picks up the new token by itself. Revisit if sessions cannot resume.',
      ],
    ],
  })
})()
