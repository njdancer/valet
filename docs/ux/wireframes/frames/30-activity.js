// Activity: Calls and Audit log, two real tabs (IA section 1, P4, P5). v2: story.md world (Sat 7 Nov,
// 9:48 pm; refs 7F2A 9A71 8F2E 4C21 6B3E 5C10), round 2 fixes.
;(() => {
  const WF = window.WF
  const { K, FRAMES } = WF
  WF.GROUP_INTRO = WF.GROUP_INTRO || {}
  WF.GROUP_INTRO.Activity =
    'What happened. Two real tabs with their own URL, shortcut and heading: <b>Calls</b> (⌘3), every tool call with its short reference, and <b>Audit log</b> (⇧⌘3), the tamper-evident record. A call links to its records and every record links back to its call (principle 3). All frames show Sat 7 Nov, 9:48 pm (story.md).'

  // Story moment: 4 waiting; Woolworths needs a login, Yahoo Finance is limiting requests.
  const SITES = [
    ['W', 'Woolworths', 'warn'],
    ['Y', 'Yahoo Finance', 'warn'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const shell = (a, p, o = {}) => WF.shell(a, p, { badges: { needs: 4 }, sites: SITES, ...o })

  // ---- local helpers ----
  // Table built from divs (kept from v1). o.sel: selected row, o.focus: keyboard-focused row.
  const grid = (head, rows, o = {}) => {
    const pad = o.compact ? '5px 10px' : '8px 10px'
    const ring = 'var(--wf-act)'
    const cell = (x, bg, j, n, focus) => {
      let sh = ''
      if (focus) {
        const s = [`inset 0 2px 0 ${ring}`, `inset 0 -2px 0 ${ring}`]
        if (j === 0) s.push(`inset 2px 0 0 ${ring}`)
        if (j === n - 1) s.push(`inset -2px 0 0 ${ring}`)
        sh = `box-shadow:${s.join(',')};`
      }
      return `<div style="padding:${pad};border-bottom:1px solid var(--wf-line);display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;${bg}${sh}">${x}</div>`
    }
    const th = head
      .map(
        (x) =>
          `<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--wf-ink-3);padding:6px 10px;border-bottom:1px solid var(--wf-line);white-space:nowrap">${x}</div>`,
      )
      .join('')
    const tr = rows
      .map((r, i) => {
        const bg =
          i === o.sel || i === o.focus
            ? 'background:var(--wf-sel);'
            : i === o.hover
              ? 'background:var(--wf-paper-2);'
              : ''
        return r.map((x, j) => cell(x, bg, j, r.length, i === o.focus)).join('')
      })
      .join('')
    return `<div role="table" style="display:grid;grid-template-columns:${o.cols}">${th}${tr}</div>`
  }
  const mono = (t) => `<span class="mono">${t}</span>`
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  const ver = (v) => `<span class="wf-link mono">${v}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  const val = (v) =>
    `<span class="wf-value" style="display:inline;word-break:break-all;line-height:1.6">${v} <span class="wf-copy">⧉</span></span>`
  const kvn = (rows, w = 92) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)
  const what = (site, t, sentence) =>
    `<div class="col" style="gap:1px;min-width:0"><span class="row" style="gap:5px"><b>${site}</b><span class="faint">·</span>${tool(t)}</span><span class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sentence}</span></div>`
  const tabs = (i) => K.tabs([`Calls ${K.kbd('⌘3')}`, `Audit log ${K.kbd('⇧⌘3')}`], i)
  const fact = (label, value) =>
    `<div class="col" style="gap:2px;min-width:0"><span class="faint" style="font-size:10.5px">${label}</span><span class="row" style="gap:4px;white-space:nowrap">${value}</span></div>`
  const facts = (items) =>
    `<div class="row" style="gap:24px;padding:10px 24px;border-bottom:1px solid var(--wf-line);flex:none">${items.join('')}</div>`
  // Search first, then chips; one line at 1180 wide (P1 m1: "Since" must not wrap).
  const filterBar = (ph, w, chips, right = '') =>
    `<div class="wf-filters" style="flex-wrap:nowrap"><span class="wf-input search" style="min-width:${w}px;width:${w}px;flex:none;white-space:nowrap;overflow:hidden">⌕ ${ph}</span>${chips
      .map((c) => (c.startsWith('<') ? c : `<span class="wf-chip" style="white-space:nowrap">${c}</span>`))
      .join('')}<span class="grow"></span>${right}</div>`
  // Outcomes in story words. "ok, N blocked" is its own state (P4, E6 refine).
  const OUT = {
    ok: K.badge('ok', 'ok'),
    okb: (n) => K.badge(`ok, ${n} blocked`, 'info'),
    changed: K.badge('Failed · site changed', 'bad'),
    limited: K.badge('Limited by site', 'warn'),
    wait: K.badge('Waiting for you', 'warn'),
    login: K.badge('Needs you · login', 'warn'),
    missed: K.badge('Missed · nobody answered', 'idle'),
  }

  // ---------------------------------------------------------------- Calls list
  const callRows = [
    [
      ref('7F2A'),
      '9:48 pm',
      what('Woolworths', 'remove_from_cart', 'Remove Cavendish Bananas 1kg from the cart'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.wait,
      K.btn('Answer…'),
    ],
    [
      ref('9A71'),
      '9:47 pm',
      what('Woolworths', 'get_cart', 'Get cart'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.login,
      K.btn('Show login window'),
    ],
    [
      ref('8F2E'),
      '9:31 pm',
      what('Woolworths', 'update_cart_line', 'Set Dairy Farmers Milk 2L to 2'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.okb(2),
      '',
    ],
    [
      ref('4C21'),
      '9:22 pm',
      what('Yahoo Finance', 'get_quote', 'Quote for CBA.AX'),
      K.link('Claude Desktop'),
      ver('1.2.0'),
      OUT.limited,
      '',
    ],
    [
      ref('6B3E'),
      '8:05 pm',
      what('Woolworths', 'search_products', 'Search for “milk”'),
      K.link('Claude Desktop'),
      ver('0.3.0'),
      OUT.changed,
      '',
    ],
    [
      ref('5C10'),
      '6:10 pm',
      what('Woolworths', 'remove_from_cart', 'Remove Cavendish Bananas 1kg from the cart'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.missed,
      K.btn('Ask Claude to try again…'),
    ],
  ]
  const CALL_COLS = '54px 62px minmax(0,1fr) 104px 52px 170px 170px'
  const callsHead = ['Ref', 'Time', 'Site · tool · what it did', 'App', 'Version', 'Outcome', '']
  const callsHeader = (count = '37 calls today: 2 failed, 12 requests blocked') =>
    K.header({
      crumbs: ['Activity'],
      title: 'Calls',
      actions:
        `<span class="muted">${count}</span>` +
        `<span class="faint">Traces kept 14 days</span> ${K.link('Change')}` +
        K.btn('Export…'),
      tabs: tabs(0),
    })
  const anyChips = [
    'Site <b>Any</b> ▾',
    'Tool <b>Any</b> ▾',
    'App <b>Any</b> ▾',
    'Outcome <b>Any</b> ▾',
    'Version <b>Any</b> ▾',
    `<span style="white-space:nowrap;flex:none">${K.check('Has blocked requests')}</span>`,
    'Since <b>Today</b> ▾',
  ]
  const callsBody = (o = {}) => `
    ${callsHeader()}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${filterBar('Search tools, refs  ⌘F', 160, anyChips)}
      ${grid(callsHead, callRows, { cols: CALL_COLS, ...o })}
      <div class="row muted"><span>Newest first · 31 earlier calls today</span><span class="grow"></span>${K.btn('Show earlier calls')}</div>
      ${o.extra || ''}
    </div>`

  FRAMES.push({
    id: 'activity-calls',
    group: 'Activity',
    title: 'Calls, everything today',
    personas: ['P1', 'P4', 'P5', 'P6', 'P7'],
    desc: '#/activity/calls (⌘3). One row per call with the short reference Claude quotes, the tool name and a plain sentence, the app, the version it ran on and the outcome. The six newest calls of the story.',
    html: shell('activity', callsBody({ hover: 2 })),
    notes: [
      [
        452,
        138,
        'Real tablist: each tab has its own URL, shortcut and h1 ("Calls" / "Audit log"); arrow keys move between tabs (P5). The Activity item carries no count (E11); totals are plain text in the header.',
      ],
      [
        788,
        166,
        'Every filter lives in the URL (#/activity/calls?site=woolworths&outcome=failed&version=0.3.0&blocked=1); Back works and notifications link here (principle 7). The bar stays on one line (P1 m1).',
      ],
      [
        248,
        184,
        'Search matches tool names (get_cart) as well as sentences, sites and refs (P1). ⌘F focuses it.',
      ],
      [
        912,
        360,
        '"ok, 2 blocked" is its own state and tone, never plain green (P4, E6 refine). Refs and outcomes follow story.md; the ref is the one Claude quotes (P6).',
      ],
      [
        1076,
        256,
        'Rows that hold their own button are not whole-row targets: the ref is the link, the button is a separate Tab stop (round 2 decision, P5 M3).',
      ],
      [
        1166,
        507,
        'One retry action everywhere: "Ask Claude to try again…" opens a popover with the sentence to send and Copy (round 2 decision, P7).',
      ],
      [866, 91, 'Retention is reachable from Calls, not only from Settings (P4 T11).'],
    ],
  })

  // ---------------------------------------------------------------- Keyboard (P1 M7)
  const keys = (pairs) =>
    `<div class="row" style="gap:16px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--wf-line);border-radius:8px;background:var(--wf-paper-2)">${pairs
      .map(
        ([k, t]) =>
          `<span class="row" style="gap:5px">${k
            .split(' ')
            .map((x) => K.kbd(x))
            .join('')}<span class="muted">${t}</span></span>`,
      )
      .join('')}</div>`
  const peek = `<div style="position:absolute;left:420px;top:338px;width:420px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:10px;box-shadow:0 12px 30px var(--wf-shadow);padding:12px 14px;z-index:5" class="col">
      <div class="row"><b>Call 9A71 · Get cart</b><span class="grow"></span>${K.badge('Needs you · login', 'warn')}</div>
      <span class="muted">Woolworths showed a verification check after the password page. The login window is open until 10:02 pm.</span>
      <div class="row">${K.btn('Show login window')}${K.ghost('Open call  ↩')}<span class="grow"></span><span class="faint">Space closes</span></div>
    </div>`
  FRAMES.push({
    id: 'activity-call-keyboard',
    group: 'Activity',
    title: 'Calls by keyboard: focus, arrows, Return, Space',
    personas: ['P1', 'P5'],
    desc: 'The same list after ⌘3 and ↓: the focus ring is on 9A71. Arrow keys move between rows, Return opens the call, Space shows a quick look, Tab reaches the row’s own button. The same keys work in Needs you and the Audit log.',
    html: shell(
      'activity',
      callsBody({
        focus: 1,
        extra: keys([
          ['↑ ↓', 'move between calls'],
          ['↩', 'open the call'],
          ['Space', 'quick look'],
          ['Tab', "the row's button"],
          ['⌘C', 'copy the ref'],
          ['⌘F', 'search'],
        ]),
      }) + peek,
    ),
    notes: [
      [
        246,
        302,
        'Focus ring on the whole row; ↑↓ move it (roving focus on the ref link), the URL does not change until Return opens the call (P1 M7, P5).',
      ],
      [
        792,
        398,
        "Space opens a quick look anchored to the row, with the row's main action; Space or Escape closes it and focus stays on the row.",
      ],
      [
        712,
        603,
        'The key legend is shown once, dismissible, and the same keys work in Needs you and the Audit log. Tab from a row goes to its own button.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Filtered from a link
  const usedRows = [
    [
      ref('9A71'),
      'Sat 9:47 pm',
      what('Woolworths', 'get_cart', 'Get cart'),
      K.link('Claude Code'),
      mono('user, pass'),
      OUT.login,
    ],
    [
      ref('8F2E'),
      'Sat 9:31 pm',
      what('Woolworths', 'update_cart_line', 'Set Dairy Farmers Milk 2L to 2'),
      K.link('Claude Code'),
      mono('user, pass'),
      OUT.okb(2),
    ],
    [
      ref('2D07'),
      'Fri 8:20 pm',
      what('Woolworths', 'get_cart', 'Get cart (the setup test)'),
      K.link('Claude Desktop'),
      mono('user, pass'),
      OUT.ok,
    ],
  ]
  const callsFiltered = `
    ${callsHeader('3 calls match')}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${K.banner('idle', 'Calls that used your Woolworths login.', `You came from ${K.link('Secrets › Woolworths login')}.`, K.btn('‹ Back to the login') + K.ghost('Clear filters'))}
      ${filterBar('Search tools, refs  ⌘F', 160, ['Login used <b>Woolworths login</b> ✕', 'Since <b>Fri 6 Nov</b> ✕', '+ Filter'])}
      ${grid(['Ref', 'Time', 'Site · tool · what it did', 'App', 'Typed', 'Outcome'], usedRows, {
        cols: '54px 90px minmax(0,1fr) 110px 90px 170px',
      })}
      <div class="muted">That's every call since the login was given on Fri 6 Nov. The ${K.link('audit log')} keeps the record of each login use for good.</div>
    </div>`

  FRAMES.push({
    id: 'activity-calls-filtered',
    group: 'Activity',
    title: 'Calls, filtered from a link (login used)',
    personas: ['P1', 'P3', 'P4'],
    desc: 'Arrived from "Calls that used it" on the Woolworths login page. The same Calls tab, with the filters set by the URL and a line that says where you came from.',
    html: shell('activity', callsFiltered),
    notes: [
      [261, 194, 'Says why the list is short and where you came from, with a way back (principle 7).'],
      [
        652,
        224,
        'Filters set by a link show as removable chips. "Login used" needs a new URL parameter (?login=woolworths/login): an IA gap.',
      ],
      [
        564,
        430,
        'Which fields were typed, so P3 sees the password was used. 2D07 is the setup test call on Fri 6 Nov, when the login was given (story).',
      ],
      [
        248,
        465,
        'Answers tree task T6, "calls that used the login" (P1, P4, P5, P7), as a first-class link.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Empty
  const callsEmpty = `
    ${callsHeader('0 calls match')}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${filterBar('Search tools, refs  ⌘F', 160, ['Site <b>Wikipedia</b> ✕', 'Outcome <b>Failed</b> ✕', 'Since <b>Today</b> ✕', '+ Filter'])}
      <div style="border:1px dashed var(--wf-line-2);border-radius:10px;margin-top:6px">
        ${K.empty(
          'No failed Wikipedia calls today',
          'Every Wikipedia call today worked.',
          `<div class="row" style="margin-top:6px">${K.primary('Clear filters')}${K.btn('Show the last 7 days')}</div>`,
        )}
      </div>
      <div class="wf-card"><header><h4>When there are no calls at all</h4></header><div class="body muted">
        <div><b style="color:var(--wf-ink)">No calls yet.</b> When Claude uses one of your sites, each call shows up here with a short reference like 7F2A that Claude can quote.</div>
        <div class="row">${K.btn('Connect an app')}${K.ghost('What can Claude do with my sites?')}</div>
      </div></div>
    </div>`

  FRAMES.push({
    id: 'activity-calls-empty',
    group: 'Activity',
    title: 'Calls, nothing matches',
    personas: ['P2', 'P5'],
    desc: 'An empty result says what was asked for in words and offers the two ways out. The card below shows the never-used variant of the same page.',
    html: shell('activity', callsEmpty),
    notes: [
      [
        827,
        252,
        'Restates the filters as a sentence so P2 reads the empty list as good news. Announced politely when the filters change (P5).',
      ],
      [579, 310, 'Focus goes to "Clear filters", the way out (P5 focus rule).'],
      [
        262,
        420,
        'First-run variant: explains what will appear and links to Connections instead of a blank table (P2, P9).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Trace helpers
  const step = (t, tone, text, right = '', indent = 0) => [
    `<span class="mono faint">${t}</span>`,
    K.dot(tone),
    `<span style="padding-left:${indent * 18}px;min-width:0">${text}</span>`,
    `<span class="faint" style="white-space:nowrap">${right}</span>`,
  ]
  const blocked = (s) => `<span style="color:var(--wf-bad);font-weight:600">${s}</span>`
  const allowed = (s) => `<span style="color:var(--wf-ok)">${s}</span>`
  const STEP_COLS = '56px 28px minmax(0,1fr) 168px'
  const traceHead = (title, status, refId, records) =>
    K.header({
      crumbs: ['Activity', 'Calls', refId],
      title,
      status,
      actions: K.value(refId) + K.btn('Copy as JSON') + K.btn(`Audit records (${records})`),
    })

  // ---------------------------------------------------------------- Trace: ok with blocked (8F2E)
  const traceSteps = [
    step('0.000', 'info', `Called by ${K.link('Claude Code')} ${K.badge('changes your cart', 'write')}`),
    step('0.004', 'idle', 'Check 1: are you logged in? <b>not logged in</b>', '212 ms'),
    step(
      '0.220',
      'info',
      `Logged in with ${K.link('Woolworths login')} ${K.badge('login', 'secret')}`,
      '2.9 s',
    ),
    step('1.502', 'idle', 'Typed username · 3 checks passed', '640 ms', 1),
    step('2.143', 'idle', 'Typed password · 3 checks passed', '520 ms', 1),
    step('3.162', 'idle', 'Handed the session to the tool · 14 cookies', '9 ms'),
    step('3.171', 'ok', 'Check 2: did the login work? <b>logged in</b>', '402 ms'),
    step('3.573', 'info', "Ran the adapter's tool code", '1.6 s'),
    step('3.704', 'ok', mono('GET /apis/ui/Trolley'), allowed('allowed · read · 200'), 1),
    step('4.122', 'bad', mono('POST /apis/ui/Trolley/Recommendations'), blocked('blocked · not declared'), 1),
    step('4.133', 'bad', mono('POST collect.tealiumiq.com/event'), blocked('blocked · host not allowed'), 1),
    step('4.522', 'ok', mono('POST /api/v3/ui/trolley/update'), allowed('allowed · write · 200'), 1),
    step('5.194', 'ok', 'Returned the result to Claude Code · 2 values hidden', '412 B'),
  ]
  const traceFacts = facts([
    fact('Site', K.link('Woolworths')),
    fact('Version', ver('0.3.0') + ' <span class="faint">live</span>'),
    fact('Tool', tool('update_cart_line')),
    fact('App', K.link('Claude Code')),
    fact('When', '9:31 pm · 5.2 s'),
    fact('Login used', K.link('Woolworths login')),
    fact('Requests', `2 allowed · ${K.link('2 blocked')} · 2 checks`),
  ])
  const requestInspector = `
    <div class="row"><span class="h3">Blocked request</span><span class="grow"></span><span class="faint">step at 4.122 s</span></div>
    ${kvn([
      ['Request', val('POST https://www.woolworths.com.au/apis/ui/Trolley/Recommendations')],
      ['Made by', `Tool code at ${val('src/tools/cart.ts:42')}`],
      ['Decision', 'Blocked before it left Valet'],
      ['Why', "The adapter doesn't declare this request. Its host is allowed, the path isn't."],
      ['Sent', 'Nothing. No response.'],
    ])}
    <div class="col" style="gap:6px">
      ${K.btn('Copy as request declaration')}
      <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4805 ›')}</div>
    </div>
    <div style="border-top:1px solid var(--wf-line);padding-top:10px" class="col">
      <span class="h3">Input from Claude Code</span>
      ${val('{ "stockcode": 133211, "quantity": 2 }')}
      <span class="faint">Output and the 2 hidden values are below the timeline.</span>
    </div>`
  const okBanner = K.banner(
    'warn',
    "It worked, but Valet blocked 2 requests the adapter didn't declare.",
    'Nothing was sent. If this keeps happening the site may have changed.',
    K.btn('Show blocked only'),
  )
  const traceOk = (insp, sel) => `
    ${traceHead('Update cart line', OUT.okb(2), '8F2E', 8)}
    ${traceFacts}
    <div class="split">
      <div class="list" style="padding:12px 16px 0 24px;gap:10px">
        ${okBanner}
        <div class="row">${K.seg(['Timeline', 'Requests only'], 0)}<span class="grow"></span>${K.ghost('Expand all')}</div>
        ${grid([], traceSteps, { cols: STEP_COLS, compact: true, sel })}
      </div>
      <div class="insp">${insp}</div>
    </div>`

  FRAMES.push({
    id: 'activity-call-ok-blocked',
    group: 'Activity',
    title: 'Call trace: worked, with 2 blocked requests',
    personas: ['P1', 'P3', 'P4', 'P6'],
    desc: '#/activity/calls/8F2E. Header facts are all links; the timeline on the left, the selected step or request in the inspector on the right.',
    html: shell('activity', traceOk(requestInspector, 9)),
    notes: [
      [
        248,
        156,
        'Every fact is a link (site, version, tool, app, login used). Request counts match the timeline: 2 allowed, 2 blocked, plus 2 login checks (P4).',
      ],
      [
        902,
        91,
        'The ref is a value with copy; "Audit records (8)" opens records 4800 to 4807, filtered to this call (P3, P4).',
      ],
      [261, 201, 'The outcome in one sentence with its one action, not left to a colour (E6 refine).'],
      [
        252,
        549,
        'Selecting a step or request opens it in the inspector, a labelled region "Step details"; arrow keys move through steps (P5).',
      ],
      [
        1126,
        315,
        '"Made by" names the tool-code line that made the request, the jump P4 makes into the editor.',
      ],
      [
        1145,
        452,
        'An undeclared request offers "Copy as request declaration", never "Show in adapter declaration": there is nothing to show (P4).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Trace: failed (6B3E)
  const failSteps = [
    step('0.000', 'info', `Called by ${K.link('Claude Desktop')} ${K.badge('reads only', 'read')}`),
    step('0.003', 'ok', 'Check: are you logged in? <b>logged in</b>', '188 ms'),
    step('0.194', 'info', "Ran the adapter's tool code", '1.8 s'),
    step('0.310', 'ok', mono('GET /api/ui/v2/bootstrap'), allowed('allowed · read · 200'), 1),
    step('1.420', 'bad', mono('POST /apis/ui/Search/products'), blocked('allowed · read · 404'), 1),
    step('1.998', 'bad', "The tool code stopped: <b>the site's answer wasn't what it expected</b>"),
    step(
      '2.001',
      'idle',
      `<span style="white-space:normal">Told Claude Desktop, word for word: ${val('The person can see it in Valet, Activity, call 6B3E')}</span>`,
    ),
  ]
  const traceFailed = `
    ${traceHead('Search products', OUT.changed, '6B3E', 2)}
    ${facts([
      fact('Site', K.link('Woolworths')),
      fact('Version', ver('0.3.0') + ' <span class="faint">live</span>'),
      fact('Tool', tool('search_products')),
      fact('App', K.link('Claude Desktop')),
      fact('When', '8:05 pm · 2.0 s'),
      fact('Login used', '<span class="faint">none, already logged in</span>'),
      fact('Requests', '2 allowed · 0 blocked · 1 check'),
    ])}
    <div class="split">
      <div class="list" style="padding:12px 16px 0 24px;gap:10px">
        <div class="wf-banner bad" style="align-items:flex-start;flex-direction:column;gap:8px">
          <div><b>Woolworths changed how its search answers, so the adapter couldn't read it.</b> Nothing was changed in your cart. Nothing you can fix here: Claude Desktop has been told.</div>
          <div class="row" style="flex-wrap:wrap">
            <span class="h3" style="margin-right:4px">What to do</span>
            ${K.primary('Ask the authoring agent for a fix…')}
            ${K.btn('Pause site')}
            ${K.ghost('Compare with 0.4.0 (waiting)')}
          </div>
          <div class="faint">The only failed Woolworths call today. Calls since then worked: ${K.link('8F2E at 9:31 pm')}.</div>
        </div>
        <div class="row">${K.seg(['Timeline', 'Requests only'], 0)}<span class="grow"></span>${K.ghost('Expand all')}</div>
        ${grid([], failSteps, { cols: STEP_COLS, compact: true, sel: 4 })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Request</span><span class="grow"></span><span class="faint">step at 1.420 s</span></div>
        ${kvn([
          ['Request', val('POST https://www.woolworths.com.au/apis/ui/Search/products')],
          ['Made by', `Tool code at ${val('src/tools/search.ts:31')}`],
          ['Decision', 'Allowed: declared as a read'],
          ['Answer', '404 Not Found · 1.1 KB · HTML, not JSON'],
          ['Declared as', mono('POST /apis/ui/Search/products · read')],
        ])}
        <div class="col" style="gap:6px">
          ${K.btn('Show in adapter declaration')}
          <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4795 ›')}</div>
        </div>
        <div style="border-top:1px solid var(--wf-line);padding-top:10px" class="col">
          <span class="h3">Details</span>
          ${kvn([
            ['Stage', mono('tool-run')],
            ['Error class', mono('site-changed')],
          ])}
          <span class="faint">Shown inline when Settings › General › Show technical details is on.</span>
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'activity-call-failed',
    group: 'Activity',
    title: 'Call trace: failed, with what to do',
    personas: ['P1', 'P2', 'P4', 'P6'],
    desc: '#/activity/calls/6B3E. Where the repair item ("Woolworths changed: the adapter needs an update") and Claude Desktop\'s "Activity, call 6B3E" both land.',
    html: shell('activity', traceFailed),
    notes: [
      [
        261,
        201,
        'What happened, what it did not do, and for P2 "Nothing you can fix here: Claude Desktop has been told."',
      ],
      [
        578,
        247,
        'Ask the authoring agent for a fix… opens the same popover pattern as Ask Claude to try again… (sentence plus Copy). "Pause site" uses the health line\'s label (P1 m4).',
      ],
      [261, 315, 'Story-true pattern line: the only failed Woolworths call today; later calls worked (P4).'],
      [252, 507, 'The failing step is pre-selected; focus lands on the h1 first (P5).'],
      [
        658,
        566,
        'The exact result string Claude Desktop received (IA section 7), copyable, so P1 and P4 can check the shared wording (P6 M2).',
      ],
      [
        1150,
        576,
        'Error class is site-changed, matching the badge (P6 M2). Technical names sit under Details unless "Show technical details" is on.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Step inspector: a login fill (8F2E)
  const fillInspector = `
    <div class="row"><span class="h3">Typed your password</span><span class="grow"></span><span class="faint">step at 2.143 s</span></div>
    ${kvn([
      ['Login', `${K.link('Woolworths login')} · password`],
      ['Where', val('https://auth.woolworths.com.au')],
      ['Into', val('input#password')],
      ['From', 'Keychain copy of 1Password item “Woolworths” (Personal vault)'],
    ])}
    <div class="col" style="gap:4px">
      <span class="h3">Checked before typing</span>
      <span>${K.dot('ok')} The page's frame is auth.woolworths.com.au</span>
      <span>${K.dot('ok')} The field is a password field</span>
      <span>${K.dot('ok')} The form submits to an allowed origin</span>
      <span>${K.dot('ok')} Typed as paced keystrokes</span>
    </div>
    <div class="faint">The password itself is never shown, stored in the trace or sent to Claude Code.</div>
    <div class="col" style="gap:6px">
      ${K.btn('Show in adapter declaration')}
      <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4803 ›')}</div>
    </div>`

  FRAMES.push({
    id: 'activity-call-step-login',
    group: 'Activity',
    title: 'Call trace: a login step in the inspector',
    personas: ['P3', 'P4', 'P5'],
    desc: 'The same trace with the password step selected. A login step links to the login page in Secrets and lists what Valet checked before typing.',
    html: shell('activity', traceOk(fillInspector, 4)),
    notes: [
      [
        1160,
        229,
        'The login links to its page in Secrets, which links back under "Calls that used it" (principle 3).',
      ],
      [1010, 369, 'Each check is listed with its result, not summarised as a green pill (P3).'],
      [851, 480, 'Says plainly what is never kept: the value (P2).'],
      [
        252,
        414,
        'A declared login step does offer "Show in adapter declaration"; Escape returns focus to the timeline (P4, P5).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Audit log
  const ev = (label, tone = 'idle') =>
    `<span class="row" style="gap:6px">${K.dot(tone)}<span>${label}</span></span>`
  const cell = (t) =>
    `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${t}</span>`
  const auditRows = [
    [
      '4815',
      '9:48:10 pm',
      ev('Confirmation asked', 'warn'),
      cell(`${mono('remove_from_cart')} · answer by 9:50 pm`),
      'Woolworths',
      ref('7F2A'),
    ],
    [
      '4814',
      '9:48:08 pm',
      ev('Call started', 'info'),
      cell(`${mono('remove_from_cart')} by Claude Code`),
      'Woolworths',
      ref('7F2A'),
    ],
    [
      '4813',
      '9:47:00 pm',
      ev('Call needs you', 'warn'),
      cell(`${mono('get_cart')} · verification check · 6.1 s`),
      'Woolworths',
      ref('9A71'),
    ],
    [
      '4812',
      '9:47:00 pm',
      ev('Login stopped', 'warn'),
      cell('Verification check only you can do'),
      'Woolworths',
      ref('9A71'),
    ],
    [
      '4811',
      '9:46:57 pm',
      ev('Login typed', 'secret'),
      cell(`password at ${mono('auth.woolworths.com.au')}`),
      'Woolworths',
      ref('9A71'),
    ],
    [
      '4810',
      '9:46:56 pm',
      ev('Login typed', 'secret'),
      cell(`username at ${mono('auth.woolworths.com.au')}`),
      'Woolworths',
      ref('9A71'),
    ],
    ['4809', '9:46:55 pm', ev('Login started'), cell('Started by a tool call'), 'Woolworths', ref('9A71')],
    [
      '4808',
      '9:46:54 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_cart')} by Claude Code`),
      'Woolworths',
      ref('9A71'),
    ],
    [
      '4807',
      '9:31:05 pm',
      ev('Call finished', 'ok'),
      cell('ok, 2 blocked · 5.2 s'),
      'Woolworths',
      ref('8F2E'),
    ],
    [
      '4806',
      '9:31:04 pm',
      ev('Request blocked', 'bad'),
      cell(`${mono('POST collect.tealiumiq.com/event')} · host not allowed`),
      'Woolworths',
      ref('8F2E'),
    ],
    [
      '4805',
      '9:31:04 pm',
      ev('Request blocked', 'bad'),
      cell(`${mono('POST /apis/ui/Trolley/Recommendations')} · not declared`),
      'Woolworths',
      ref('8F2E'),
    ],
    ['4804', '9:31:03 pm', ev('Login finished', 'ok'), cell('Logged in'), 'Woolworths', ref('8F2E')],
    [
      '4803',
      '9:31:02 pm',
      ev('Login typed', 'secret'),
      cell(`password at ${mono('auth.woolworths.com.au')}`),
      'Woolworths',
      ref('8F2E'),
    ],
    [
      '4802',
      '9:31:01 pm',
      ev('Login typed', 'secret'),
      cell(`username at ${mono('auth.woolworths.com.au')}`),
      'Woolworths',
      ref('8F2E'),
    ],
    ['4801', '9:31:00 pm', ev('Login started'), cell('Started by a tool call'), 'Woolworths', ref('8F2E')],
  ]
  const auditFilters = filterBar('Search refs, tools, hosts  ⌘F', 200, [
    'Category <b>All</b> ▾',
    'Site <b>Any</b> ▾',
    'App <b>Any</b> ▾',
    'Since <b>7 days</b> ▾',
  ])
  const auditHead = (status) =>
    K.header({
      crumbs: ['Activity'],
      title: 'Audit log',
      status,
      actions: K.btn('Check now') + K.btn('Export…'),
      tabs: tabs(1),
    })
  const chainOk = K.banner(
    'ok',
    'The audit log checks out.',
    `All 4,815 records verified at 9:48 pm. Newest record ${mono('4815')}, hash ${K.value('e73a18e0…b69d')}`,
    K.ghost('What this proves'),
  )
  const auditPage = `
    ${auditHead(K.badge('Checks out · verified 9:48 pm', 'ok'))}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${chainOk}
      ${auditFilters}
      ${grid(['Seq', 'Time', 'Event', 'Details', 'Site', 'Call'], auditRows, {
        cols: '50px 86px 168px minmax(0,1fr) 104px 52px',
        compact: true,
        hover: 10,
      })}
    </div>`

  FRAMES.push({
    id: 'activity-audit',
    group: 'Activity',
    title: 'Audit log, intact',
    personas: ['P1', 'P3', 'P5'],
    desc: '#/activity/audit (⇧⌘3). The second tab, with its own heading. Status with when it was checked and a Check now button beside it; every record links to its call.',
    html: shell('activity', auditPage),
    notes: [
      [452, 138, 'Its own tab, h1 and shortcut ⇧⌘3 (P1, P5).'],
      [
        970,
        91,
        'Status says when it was checked, with Check now beside it; the result is announced politely (principle 8, P5).',
      ],
      [898, 196, 'The newest hash is a value: shown short, copies all 64 characters (P3, E3).'],
      [
        652,
        226,
        'Category is one chip with a menu (All, Calls, Logins, Login use, Blocked, Confirmations, Approvals) so the bar fits at 880 px; "Login use" is the second route to T6 (P1 m1, design system).',
      ],
      [1160, 282, 'The call column links to the trace and the trace back (P4). Refs follow story.md.'],
      [
        526,
        554,
        'Event names are plain words; with Show technical details on, the record kind (request-blocked) shows instead (P1).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Audit record selected (4805)
  const auditRowsNarrow = auditRows.map(([s, t, e, d, , c]) => [s, t, e, d, c])
  const auditSelected = `
    ${auditHead(K.badge('Checks out · verified 9:48 pm', 'ok'))}
    <div style="padding:12px 24px 10px;display:flex;flex-direction:column;gap:10px;flex:none;border-bottom:1px solid var(--wf-line)">
      ${chainOk}
      ${auditFilters}
    </div>
    <div class="split">
      <div class="list">
        ${grid(['Seq', 'Time', 'Event', 'Details', 'Call'], auditRowsNarrow, {
          cols: '48px 82px 150px minmax(0,1fr) 50px',
          compact: true,
          sel: 10,
        })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Record 4805</span><span class="grow"></span>${K.badge('In the verified chain', 'ok')}</div>
        ${kvn(
          [
            ['Time', '9:31:04 pm, Sat 7 Nov'],
            ['Event', 'Request blocked'],
            ['Request', val('POST https://www.woolworths.com.au/apis/ui/Trolley/Recommendations')],
            ['Why', 'Not declared by the adapter'],
            ['Site', `${K.link('Woolworths')} ${ver('0.3.0')}`],
            ['Call', `${ref('8F2E')} by ${K.link('Claude Code')}`],
          ],
          70,
        )}
        <div class="row">${K.primary('Open call 8F2E')}${K.btn('Copy record')}</div>
        <div class="col" style="gap:4px;border-top:1px solid var(--wf-line);padding-top:10px">
          <span class="h3">Chain</span>
          ${kvn(
            [
              ['Previous', K.value('4f0b…91c2')],
              ['This', K.value('a83d…07e5')],
            ],
            70,
          )}
          <div class="row">${K.btn('‹ 4804')}${K.btn('4806 ›')}<span class="grow"></span>${K.ghost('▸ Record as JSON')}</div>
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'activity-audit-record',
    group: 'Activity',
    title: 'Audit log, a record selected',
    personas: ['P1', 'P3', 'P4'],
    desc: '#/activity/audit/4805. The record in plain fields with its links, Open call as the main action, and its place in the chain.',
    html: shell('activity', auditSelected),
    notes: [
      [930, 454, 'Every field that names an object is a link: site, version, call, app.'],
      [
        968,
        508,
        '"Open call 8F2E" is the main action, the round trip P1 and P3 asked for. For a record older than the 14-day trace retention it reads "Trace deleted after 14 days" (disabled, with the reason), never a dead link.',
      ],
      [1012, 576, 'Previous and next walk the chain (4804, 4806); each hash copies in full (E3).'],
      [210, 577, 'Arrow keys move the selection and the URL follows (#/activity/audit/4805) (principle 7).'],
    ],
  })

  // ---------------------------------------------------------------- Audit broken
  const brokenRows = [
    [
      '4797',
      '9:22:00 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_quote')} by Claude Desktop`),
      ref('4C21'),
    ],
    [
      '4796',
      '9:20:00 pm',
      ev('Update waiting', 'warn'),
      cell('Woolworths 0.4.0 from the authoring agent (IDE)'),
      '',
    ],
    [
      '4795',
      '8:05:03 pm',
      ev('Call failed', 'bad'),
      cell(`${mono('search_products')} · site changed`),
      ref('6B3E'),
    ],
    [
      '4794',
      '8:05:01 pm',
      ev('Call started', 'info'),
      cell(`${mono('search_products')} by Claude Desktop`),
      ref('6B3E'),
    ],
    [
      '4793',
      '6:12:00 pm',
      ev('Call finished', 'idle'),
      cell(`${mono('remove_from_cart')} · missed, nobody answered`),
      ref('5C10'),
    ],
    [
      '4792',
      '6:12:00 pm',
      ev('Confirmation missed', 'idle'),
      cell('Nobody answered by 6:12 pm, nothing removed'),
      ref('5C10'),
    ],
    [
      '4791',
      '6:10:02 pm',
      ev('Confirmation asked', 'warn'),
      cell(`${mono('remove_from_cart')} · answer by 6:12 pm`),
      ref('5C10'),
    ],
    [
      '4790',
      '6:10:00 pm',
      ev('Call started', 'info'),
      cell(`${mono('remove_from_cart')} by Claude Code`),
      ref('5C10'),
    ],
    ['4789', '5:41:13 pm', ev('Call finished', 'ok'), cell('ok · 1.4 s'), ref('3E8D')],
    [
      '4788',
      '5:41:12 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_summary')} by Claude Desktop`),
      ref('3E8D'),
    ],
    ['4787', '5:12:40 pm', ev('Call finished', 'ok'), cell('ok · 2.0 s'), ref('91AA')],
    [
      '4786',
      '5:12:38 pm',
      ev('Call started', 'info'),
      cell(`${mono('search_products')} by Claude Code`),
      ref('91AA'),
    ],
  ].map((r, i) => [
    r[0],
    r[1],
    r[2],
    r[3],
    i <= 7 ? K.badge("Can't be proved", 'bad') : K.badge('Checks out', 'ok'),
    r[4],
  ])
  const auditBroken = `
    ${auditHead(K.badge("Doesn't check out · from 4790", 'bad'))}
    <div style="padding:12px 24px 10px;display:flex;flex-direction:column;gap:10px;flex:none;border-bottom:1px solid var(--wf-line)">
      <div class="wf-banner bad" style="align-items:flex-start">
        <div class="grow"><b>The audit log doesn't check out from record 4790.</b> Record 4790 doesn't link to record 4789: a record between them was removed, or 4789 was changed. Records 1 to 4789 check out. Records 4790 to 4815 still link to each other, but can't be proved untouched. Checked 9:48 pm.</div>
        <div class="row">${K.primary('Check again')}${K.btn('Export as is')}${K.ghost('What can cause this')}</div>
      </div>
      ${auditFilters}
    </div>
    <div class="split">
      <div class="list">
        ${grid(['Seq', 'Time', 'Event', 'Details', 'Chain', 'Call'], brokenRows, {
          cols: '48px 80px 140px minmax(0,1fr) 116px 46px',
          compact: true,
          sel: 7,
        })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Record 4790</span><span class="grow"></span>${K.badge("Doesn't link back", 'bad')}</div>
        ${kvn(
          [
            ['Event', 'Call started'],
            ['Call', `${ref('5C10')} by ${K.link('Claude Code')}`],
            ['Expects before it', K.value('77c1…3e0a')],
            ['Record 4789 is', K.value('d2a9…f418')],
            ['Its own hash', 'Matches its content: this record itself is unchanged'],
          ],
          112,
        )}
        <div class="faint">The chain doesn't restart after a break. New records keep linking to the newest one, so every check from now on reports the same break at 4790.</div>
        <div class="col" style="gap:6px">${K.btn('Copy both records')}${K.btn('Open call 5C10')}</div>
      </div>
    </div>`

  FRAMES.push({
    id: 'activity-audit-broken',
    group: 'Activity',
    title: 'Audit log, chain broken',
    personas: ['P1', 'P3', 'P2'],
    desc: 'Where the Needs you item "The audit log doesn\'t check out" (See where) lands: scrolled to the first bad record, which is selected. A different evening from the story (5 waiting).',
    html: shell('activity', auditBroken, { badges: { needs: 5 } }),
    notes: [
      [
        260,
        186,
        'Says where it broke, whether a record was removed or changed, and what still checks out (P3 #8, E8).',
      ],
      [812, 168, 'Check again and Export as is: the evidence is never "repaired" (P3).'],
      [
        798,
        555,
        'Records from 4790 on say "Can\'t be proved", in words, not "after the break"; they are not called bad (P3 #8, P5).',
      ],
      [
        1150,
        454,
        'Valet can tell this record itself is unchanged (its own hash matches), so the gap is before it.',
      ],
      [
        1150,
        500,
        'One rule, stated once: the chain does not restart, so every later check reports the same break (P3 #8).',
      ],
    ],
  })
})()
