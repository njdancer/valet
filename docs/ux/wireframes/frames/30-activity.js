// Activity: Calls and Audit log, two real tabs (IA section 1, P4, P5).
;(() => {
  const { K, shell, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Activity =
    'What happened. Two real tabs with their own URL, shortcut and heading: <b>Calls</b> (⌘3), every tool call with its short reference, and <b>Audit log</b> (⇧⌘3), the tamper-evident record. A call links to its records and every record links back to its call (principle 3).'

  // ---- local helpers ----
  // Table built from divs: the kit's .wf-table styles every nested span as a cell, which breaks
  // badges, links and buttons inside cells. Same look, inline styles.
  const grid = (head, rows, o = {}) => {
    const pad = o.compact ? '5px 10px' : '8px 10px'
    const cell = (x, bg) =>
      `<div style="padding:${pad};border-bottom:1px solid var(--wf-line);display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;${bg}">${x}</div>`
    const th = head
      .map(
        (x) =>
          `<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--wf-ink-3);padding:6px 10px;border-bottom:1px solid var(--wf-line);white-space:nowrap">${x}</div>`,
      )
      .join('')
    const tr = rows
      .map((r, i) => {
        const bg =
          i === o.sel ? 'background:var(--wf-sel);' : i === o.hover ? 'background:var(--wf-paper-2);' : ''
        return r.map((x) => cell(x, bg)).join('')
      })
      .join('')
    return `<div role="table" style="display:grid;grid-template-columns:${o.cols}">${th}${tr}</div>`
  }
  const mono = (t) => `<span class="mono">${t}</span>`
  // Tool, version and call references are object links (E2): one link style, mono for ids.
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  const ver = (v) => `<span class="wf-link mono">${v}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  // Long values wrap inside the inspector instead of overflowing it.
  const val = (v) =>
    `<span class="wf-value" style="display:inline;word-break:break-all;line-height:1.6">${v} <span class="wf-copy">⧉</span></span>`
  const kvn = (rows, w = 92) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)
  const what = (site, t, sentence) =>
    `<div class="col" style="gap:1px;min-width:0"><span class="row" style="gap:5px"><b>${site}</b><span class="faint">·</span>${tool(t)}</span><span class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sentence}</span></div>`
  // Filter bar bound to the URL: search first, then chips (wf-chip), plain controls left as they are.
  const filterBar = (ph, w, chips, right = '') =>
    `<div class="wf-filters"><span class="wf-input search" style="min-width:${w}px">⌕ ${ph}</span>${chips
      .map((c) => (c.startsWith('<') ? c : `<span class="wf-chip">${c}</span>`))
      .join('')}<span class="grow"></span>${right}</div>`
  const tabs = (i) => K.tabs([`Calls ${K.kbd('⌘3')}`, `Audit log ${K.kbd('⇧⌘3')}`], i)
  const fact = (label, value) =>
    `<div class="col" style="gap:2px;min-width:0"><span class="faint" style="font-size:10.5px">${label}</span><span class="row" style="gap:4px;white-space:nowrap">${value}</span></div>`
  const facts = (items) =>
    `<div class="row" style="gap:24px;padding:10px 24px;border-bottom:1px solid var(--wf-line);flex:none">${items.join('')}</div>`
  // Outcome badges. "ok, N blocked" is its own state, never plain green (P4, E6 refine).
  const OUT = {
    ok: K.badge('ok', 'ok'),
    okb: (n) => K.badge(`ok, ${n} blocked`, 'info'),
    fail: (why) => K.badge(`Failed · ${why}`, 'bad'),
    wait: (why) => K.badge(`Waiting for you · ${why}`, 'warn'),
    missed: K.badge('Missed · nobody answered', 'idle'),
    declined: K.badge('Declined by you', 'idle'),
  }

  // ---------------------------------------------------------------- Calls list
  const callRows = [
    [
      ref('7F2A'),
      '9:48 pm',
      what('Woolworths', 'remove_from_cart', 'Remove Cavendish Bananas from the trolley'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.wait('confirm'),
      K.btn('Answer…'),
    ],
    [
      ref('9A71'),
      '9:47 pm',
      what('Woolworths', 'get_cart', 'Read the trolley'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.wait('log in'),
      K.btn('Show login'),
    ],
    [
      ref('1C55'),
      '9:44 pm',
      what('Yahoo Finance', 'get_quote', 'Quote for CBA.AX'),
      K.link('Claude Desktop'),
      ver('1.2.0'),
      OUT.fail('site limiting'),
      '',
    ],
    [
      ref('6B3E'),
      '9:40 pm',
      what('Woolworths', 'get_cart', 'Read the trolley'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.fail('site changed'),
      '',
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
      ref('7B0C'),
      '9:30 pm',
      what('Woolworths', 'search_products', 'Search for “milk”'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.ok,
      '',
    ],
    [
      ref('5E1F'),
      '9:12 pm',
      what('Woolworths', 'add_to_cart', 'Add Wonder White Sandwich Bread 700g'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.ok,
      '',
    ],
    [
      ref('4D20'),
      '8:55 pm',
      what('Wikipedia', 'get_summary', 'Summary of “Sydney Opera House”'),
      K.link('Claude Desktop'),
      ver('0.2.1'),
      OUT.ok,
      '',
    ],
    [
      ref('5C10'),
      '6:12 pm',
      what('Woolworths', 'remove_from_cart', 'Remove Cavendish Bananas from the trolley'),
      K.link('Claude Code'),
      ver('0.3.0'),
      OUT.missed,
      '',
    ],
  ]
  const CALL_COLS = '54px 62px minmax(0,1fr) 104px 52px 196px 92px'
  const callsHead = ['Ref', 'Time', 'Site · tool · what it did', 'App', 'Version', 'Outcome', '']

  const callsList = `
    ${K.header({
      crumbs: ['Activity'],
      title: 'Calls',
      actions: K.ghost('Traces kept 14 days · Change') + K.btn('Export…'),
      tabs: tabs(0),
    })}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${filterBar(
        'Search tool names, sites, refs  ⌘F',
        230,
        [
          'Site <b>Any</b> ▾',
          'Tool <b>Any</b> ▾',
          'App <b>Any</b> ▾',
          'Outcome <b>Any</b> ▾',
          'Version <b>Any</b> ▾',
          K.check('Has blocked requests'),
          'Since <b>Today</b> ▾',
        ],
        `<span class="muted">37 calls today · newest first</span>`,
      )}
      ${grid(callsHead, callRows, { cols: CALL_COLS, hover: 4 })}
    </div>`

  FRAMES.push({
    id: 'activity-calls',
    group: 'Activity',
    title: 'Calls, everything today',
    personas: ['P1', 'P4', 'P5', 'P6', 'P7'],
    desc: 'The first tab of Activity. One row per call with the short reference Claude quotes, the tool name and a plain sentence, the app, the version it ran on and the outcome.',
    html: shell('activity', callsList),
    notes: [
      [
        440,
        138,
        'Real tablist: each tab has its own URL, shortcut and h1 ("Calls" / "Audit log"); arrow keys move between tabs (P5, IA decision 1). The Activity sidebar item carries no count (E11).',
      ],
      [
        900,
        161,
        'Every filter lives in the URL (#/activity/calls?site=woolworths&outcome=failed&version=0.3.0&blocked=1), so Back works and notifications can link here (principle 7). Version and "Has blocked requests" are P4\'s filters.',
      ],
      [
        234,
        184,
        'Search matches tool names (get_cart) as well as sentences, sites and refs (P1). ⌘F focuses it.',
      ],
      [
        295,
        292,
        'The ref is the same short id Claude quotes in tool results ("see call 7F2A") and opens the trace (P6, E2).',
      ],
      [
        965,
        493,
        '"ok, 2 blocked" is its own state and tone, never plain green: the tool worked but Valet refused requests the adapter did not declare (P4, E6 refine).',
      ],
      [
        1155,
        268,
        'A waiting call carries its next step as a button beside the badge (E1). Missed and declined are told apart in words (P7, vocabulary).',
      ],
      [866, 91, 'Retention is reachable from Calls, not only from Settings (P4 on T11).'],
    ],
  })

  // ---------------------------------------------------------------- Filtered from a link
  const usedRows = [
    [
      ref('9A71'),
      '9:47 pm',
      what('Woolworths', 'get_cart', 'Read the trolley'),
      K.link('Claude Code'),
      mono('user, pass'),
      OUT.wait('log in'),
    ],
    [
      ref('8F2E'),
      '9:31 pm',
      what('Woolworths', 'update_cart_line', 'Set Dairy Farmers Milk 2L to 2'),
      K.link('Claude Code'),
      mono('user, pass'),
      OUT.okb(2),
    ],
    [
      ref('3D19'),
      'Mon 6:20 pm',
      what('Woolworths', 'remove_from_cart', 'Remove Cavendish Bananas from the trolley'),
      K.link('Claude Code'),
      mono('user, pass'),
      OUT.declined,
    ],
    [
      ref('0E4B'),
      'Sun 7:12 pm',
      what('Woolworths', 'get_cart', 'Read the trolley'),
      K.link('Claude Desktop'),
      mono('user, pass'),
      OUT.ok,
    ],
    [
      ref('B812'),
      'Sun 7:10 pm',
      what('Woolworths', 'search_products', 'Search for “bananas”'),
      K.link('Claude Desktop'),
      mono('user, pass'),
      OUT.ok,
    ],
  ]
  const callsFiltered = `
    ${K.header({
      crumbs: ['Activity'],
      title: 'Calls',
      actions: K.ghost('Traces kept 14 days · Change') + K.btn('Export…'),
      tabs: tabs(0),
    })}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${K.banner('idle', 'Calls that used your Woolworths login.', `You came from ${K.link('Secrets › Woolworths login')}.`, K.btn('‹ Back to the login') + K.ghost('Clear filters'))}
      ${filterBar(
        'Search tool names, sites, refs  ⌘F',
        230,
        ['Login used <b>Woolworths login</b> ✕', 'Since <b>Last 7 days</b> ✕', '+ Filter'],
        `<span class="muted">5 calls match</span>`,
      )}
      ${grid(['Ref', 'Time', 'Site · tool · what it did', 'App', 'Typed', 'Outcome'], usedRows, {
        cols: '54px 90px minmax(0,1fr) 110px 90px 196px',
      })}
      <div class="muted">That's every call in the last 7 days. Valet keeps traces for 14 days; the ${K.link('audit log')} keeps the record of each login use for good.</div>
    </div>`

  FRAMES.push({
    id: 'activity-calls-filtered',
    group: 'Activity',
    title: 'Calls, filtered from a link (login used)',
    personas: ['P1', 'P3', 'P4'],
    desc: 'Arrived from the "Calls that used it" link on the Woolworths login page. The same Calls tab, with the filters set by the URL and a line that says where you came from.',
    html: shell('activity', callsFiltered),
    notes: [
      [
        249,
        194,
        'Says why the list is short and where you came from, with a way back (principle 7). Back in the titlebar does the same.',
      ],
      [
        600,
        224,
        'Filters set by a link show as removable chips. "Login used" needs a new URL parameter (?login=woolworths/login): IA gap, the route table lists only site, tool, client, outcome, version and since.',
      ],
      [
        955,
        312,
        'Which fields of the login were typed, so P3 sees the password was used and not only the username.',
      ],
      [
        236,
        566,
        'Answers the weakest tree task, T6 "calls that used the login" (P1, P4, P5, P7), as a first-class link rather than an audit filter.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Empty
  const callsEmpty = `
    ${K.header({
      crumbs: ['Activity'],
      title: 'Calls',
      actions: K.ghost('Traces kept 14 days · Change') + K.btn('Export…'),
      tabs: tabs(0),
    })}
    <div class="wf-scroll" style="gap:10px;padding-top:14px">
      ${filterBar(
        'Search tool names, sites, refs  ⌘F',
        230,
        ['Site <b>Wikipedia</b> ✕', 'Outcome <b>Failed</b> ✕', 'Since <b>Today</b> ✕', '+ Filter'],
        `<span class="muted">0 calls match</span>`,
      )}
      <div style="border:1px dashed var(--wf-line-2);border-radius:10px;margin-top:6px">
        ${K.empty(
          'No failed Wikipedia calls today',
          `Wikipedia's last call, ${ref('4D20')} at 8:55 pm, worked. 6 calls today, all ok.`,
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
    desc: 'An empty result says what was asked for in words, what the last real call was, and offers the two ways out. The card below shows the never-used variant of the same page.',
    html: shell('activity', callsEmpty),
    notes: [
      [
        815,
        252,
        'Restates the filters as a sentence ("No failed Wikipedia calls today") so P2 reads the empty list as good news. Announced politely when the filters change (P5).',
      ],
      [567, 310, 'Focus goes to "Clear filters", the way out, not to the top of the page (P5 focus rule).'],
      [
        250,
        420,
        'First-run variant: no filters, so the page explains what will appear here and links to Connections instead of showing a blank table (P2, P9).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Trace: ok with blocked
  const step = (t, tone, text, right = '', indent = 0) => [
    `<span class="mono faint">${t}</span>`,
    K.dot(tone),
    `<span style="padding-left:${indent * 18}px;min-width:0">${text}</span>`,
    `<span class="faint" style="white-space:nowrap">${right}</span>`,
  ]
  const blocked = (s) => `<span style="color:var(--wf-bad);font-weight:600">${s}</span>`
  const allowed = (s) => `<span style="color:var(--wf-ok)">${s}</span>`
  const traceSteps = [
    step('0.000', 'info', `Called by ${K.link('Claude Code')} ${K.badge('changes your trolley', 'write')}`),
    step('0.004', 'idle', "Checked whether you're logged in: <b>not logged in</b>", '212 ms'),
    step(
      '0.220',
      'info',
      `Logged in with ${K.link('Woolworths login')} ${K.badge('login', 'secret')}`,
      '2.9 s',
    ),
    step('1.502', 'idle', `Typed username · 3 checks passed`, '640 ms', 1),
    step('2.143', 'idle', `Typed password · 3 checks passed`, '520 ms', 1),
    step('3.162', 'idle', 'Handed the session to the tool · 14 cookies', '9 ms'),
    step('3.171', 'ok', 'Checked the login worked: <b>logged in</b>', '402 ms'),
    step('3.573', 'info', "Ran the adapter's tool code", '1.6 s'),
    step('3.704', 'ok', `${mono('GET /apis/ui/Trolley')}`, allowed('allowed · read · 200'), 1),
    step(
      '4.122',
      'bad',
      `${mono('POST /apis/ui/Trolley/Recommendations')}`,
      blocked('blocked · not declared'),
      1,
    ),
    step(
      '4.133',
      'bad',
      `${mono('POST collect.tealiumiq.com/event')}`,
      blocked('blocked · host not allowed'),
      1,
    ),
    step('4.522', 'ok', `${mono('POST /api/v3/ui/trolley/update')}`, allowed('allowed · write · 200'), 1),
    step('5.194', 'ok', 'Returned the result to Claude Code · 2 values hidden', '412 B'),
  ]
  const traceHead = (title, status, refId, actions) =>
    K.header({
      crumbs: ['Activity', 'Calls', refId],
      title,
      status,
      actions,
    })
  const traceFacts = facts([
    fact('Site', K.link('Woolworths')),
    fact('Version', `${ver('0.3.0')} <span class="faint">live</span>`),
    fact('Tool', tool('update_cart_line')),
    fact('App', K.link('Claude Code')),
    fact('When', '9:31 pm · 5.2 s'),
    fact('Login used', K.link('Woolworths login')),
    fact('Requests', `4 allowed · ${K.link('2 blocked')}`),
  ])
  const requestInspector = `
    <div class="row"><span class="h3">Blocked request</span><span class="grow"></span>${K.badge('Step 4.122 s', 'idle')}</div>
    ${kvn([
      ['Request', val('POST https://www.woolworths.com.au/apis/ui/Trolley/Recommendations')],
      ['Asked for by', "The adapter's tool code (not the page)"],
      ['Decision', 'Blocked before it left Valet'],
      ['Why', "The adapter doesn't declare this request. Its host is allowed, the path isn't."],
      ['Sent', 'Nothing. No response.'],
    ])}
    <div class="col" style="gap:6px">
      ${K.btn('Show in adapter declaration')}
      ${K.btn('Copy as request declaration')}
      <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4801 ›')}</div>
    </div>
    <div style="border-top:1px solid var(--wf-line);padding-top:10px" class="col">
      <span class="h3">Input from Claude Code</span>
      ${val('{ "stockcode": 133211, "quantity": 2 }')}
      <span class="faint">Output and the 2 hidden values are below the timeline.</span>
    </div>`
  const traceOkBlocked = `
    ${traceHead('Update cart line', OUT.okb(2), '8F2E', K.value('8F2E') + K.btn('Copy as JSON') + K.btn('Audit records (8)'))}
    ${traceFacts}
    <div class="split">
      <div class="list" style="padding:12px 16px 0 24px;gap:10px">
        ${K.banner('warn', "It worked, but Valet blocked 2 requests the adapter didn't declare.", 'Nothing was sent. If this keeps happening the site may have changed.', K.btn('Show blocked only'))}
        <div class="row">${K.seg(['Timeline', 'Requests only'], 0)}<span class="grow"></span>${K.ghost('Expand all')}</div>
        ${grid([], traceSteps, { cols: '56px 28px minmax(0,1fr) 168px', compact: true, sel: 9 })}
      </div>
      <div class="insp">${requestInspector}</div>
    </div>`

  FRAMES.push({
    id: 'activity-call-ok-blocked',
    group: 'Activity',
    title: 'Call trace: worked, with 2 blocked requests',
    personas: ['P1', 'P3', 'P4', 'P6'],
    desc: '#/activity/calls/8F2E. Header facts are all links; the timeline on the left, the selected step or request in the inspector on the right.',
    html: shell('activity', traceOkBlocked),
    notes: [
      [
        236,
        156,
        'Every fact is a link: site, version (opens Versions), tool, app (its Connections page), login used (its Secrets page) (P4, link matrix). Version is always shown so P4 can tell which build ran.',
      ],
      [
        816,
        91,
        'The ref is a value with copy; "Audit records (8)" opens the Audit log filtered to this call (P3, P4).',
      ],
      [
        249,
        201,
        'The outcome is explained in one sentence with its one action, not left to a colour (E6 refine, P4).',
      ],
      [
        240,
        549,
        'Selecting a step or request opens it in the inspector; arrow keys move through steps; the inspector is a labelled region "Step details" (P5).',
      ],
      [940, 229, 'The full URL is a value: selectable, wraps, copies whole (E3).'],
      [
        1145,
        440,
        "P4's step inspector actions: show the matching line in the adapter declaration, copy a ready-to-paste request declaration, copy the step as JSON, open its audit record.",
      ],
    ],
  })

  // ---------------------------------------------------------------- Trace: failed
  const failSteps = [
    step('0.000', 'info', `Called by ${K.link('Claude Code')} ${K.badge('reads only', 'read')}`),
    step('0.003', 'ok', "Checked whether you're logged in: <b>logged in</b>", '188 ms'),
    step('0.194', 'info', "Ran the adapter's tool code", '1.8 s'),
    step('0.310', 'ok', `${mono('GET /api/ui/v2/bootstrap')}`, allowed('allowed · read · 200'), 1),
    step('1.420', 'bad', `${mono('GET /apis/ui/Trolley')}`, blocked('allowed · read · 404'), 1),
    step('1.998', 'bad', "The tool code stopped: <b>the site's answer wasn't what it expected</b>", ''),
    step('2.001', 'idle', 'Told Claude Code: "Failed · see call 6B3E"', ''),
  ]
  const traceFailed = `
    ${traceHead('Get cart', OUT.fail('site changed'), '6B3E', K.value('6B3E') + K.btn('Copy as JSON') + K.btn('Audit records (2)'))}
    ${facts([
      fact('Site', K.link('Woolworths')),
      fact('Version', `${ver('0.3.0')} <span class="faint">live</span>`),
      fact('Tool', tool('get_cart')),
      fact('App', K.link('Claude Code')),
      fact('When', '9:40 pm · 2.0 s'),
      fact('Login used', '<span class="faint">none, already logged in</span>'),
      fact('Requests', '2 allowed · 0 blocked'),
    ])}
    <div class="split">
      <div class="list" style="padding:12px 16px 0 24px;gap:10px">
        <div class="wf-banner bad" style="align-items:flex-start;flex-direction:column;gap:8px">
          <div><b>Woolworths changed how its trolley page answers, so the adapter couldn't read it.</b> Nothing in your trolley was changed. Claude Code was told the call failed and given this reference.</div>
          <div class="row" style="flex-wrap:wrap">
            <span class="h3" style="margin-right:4px">What to do</span>
            ${K.primary('Copy a repair note')}
            ${K.btn('Pause Woolworths')}
            ${K.ghost('Compare with 0.4.0 (waiting)')}
          </div>
          <div class="faint">3 of the last 4 Woolworths calls failed this way since 9:20 pm. ${K.link('See them')}</div>
        </div>
        <div class="row">${K.seg(['Timeline', 'Requests only'], 0)}<span class="grow"></span>${K.ghost('Expand all')}</div>
        ${grid([], failSteps, { cols: '56px 28px minmax(0,1fr) 168px', compact: true, sel: 4 })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Request</span><span class="grow"></span>${K.badge('Step 1.420 s', 'idle')}</div>
        ${kvn([
          ['Request', val('GET https://www.woolworths.com.au/apis/ui/Trolley')],
          ['Asked for by', "The adapter's tool code"],
          ['Decision', 'Allowed: declared as a read'],
          ['Answer', '404 Not Found · 1.1 KB · HTML, not JSON'],
          ['Declared as', mono('GET /apis/ui/Trolley · read')],
        ])}
        <div class="col" style="gap:6px">
          ${K.btn('Show in adapter declaration')}
          <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4805 ›')}</div>
        </div>
        <div style="border-top:1px solid var(--wf-line);padding-top:10px" class="col">
          <span class="h3">Details</span>
          ${kvn([
            ['Stage', mono('tool-run')],
            ['Error class', mono('unexpected-response')],
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
    desc: '#/activity/calls/6B3E. The page the Needs you repair item ("Woolworths changed: the adapter needs an update") and Claude\'s "see call 6B3E" both land on.',
    html: shell('activity', traceFailed),
    notes: [
      [
        249,
        201,
        'What happened in one plain sentence and what it did not do ("Nothing in your trolley was changed") (P2, E8).',
      ],
      [
        478,
        235,
        '"What to do" has real buttons. Valet never retries by itself; the repair note is text for the authoring agent (P4 repair ticket, IA section 5).',
      ],
      [
        249,
        280,
        'Is it this call or the site? The pattern line opens Calls filtered to Woolworths, failed, since 9:20 pm (E7).',
      ],
      [
        240,
        470,
        'The failing step is pre-selected, so the inspector opens on the cause; focus lands on the h1 first (P5).',
      ],
      [
        1150,
        500,
        'Technical names (stage, error class) sit under Details, or inline with "Show technical details" on (P1, E8).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Step inspector: a login fill
  const fillInspector = `
    <div class="row"><span class="h3">Typed your password</span><span class="grow"></span>${K.badge('Step 2.143 s', 'idle')}</div>
    ${kvn([
      ['Login', `${K.link('Woolworths login')} · password field`],
      ['Where', val('https://auth.woolworths.com.au')],
      ['Into', val('input#password')],
      ['Source', 'Copy in your Keychain of 1Password item “Woolworths”'],
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
      <div class="row">${K.btn('Copy step as JSON')}${K.ghost('Audit record 4799 ›')}</div>
    </div>`
  const traceFill = `
    ${traceHead('Update cart line', OUT.okb(2), '8F2E', K.value('8F2E') + K.btn('Copy as JSON') + K.btn('Audit records (8)'))}
    ${traceFacts}
    <div class="split">
      <div class="list" style="padding:12px 16px 0 24px;gap:10px">
        ${K.banner('warn', "It worked, but Valet blocked 2 requests the adapter didn't declare.", 'Nothing was sent. If this keeps happening the site may have changed.', K.btn('Show blocked only'))}
        <div class="row">${K.seg(['Timeline', 'Requests only'], 0)}<span class="grow"></span>${K.ghost('Expand all')}</div>
        ${grid([], traceSteps, { cols: '56px 28px minmax(0,1fr) 168px', compact: true, sel: 4 })}
      </div>
      <div class="insp">${fillInspector}</div>
    </div>`

  FRAMES.push({
    id: 'activity-call-step-login',
    group: 'Activity',
    title: 'Call trace: a login step in the inspector',
    personas: ['P3', 'P4', 'P5'],
    desc: 'The same trace with the password step selected. A login step links to the login page in Secrets and lists what Valet checked before typing.',
    html: shell('activity', traceFill),
    notes: [
      [
        1160,
        229,
        'The login is a link to its page in Secrets, which links back here under "Calls that used it" (principle 3, P1 T6).',
      ],
      [1010, 369, 'Each check is listed with its result, not summarised as a green pill (P3: evidence).'],
      [839, 480, 'Says plainly what is never kept: the value. Redaction is a promise P2 can read.'],
      [
        240,
        414,
        'The selected row keeps a visible selection and focus ring; Escape returns focus to the timeline (P5).',
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
      ev('Call waiting for you', 'warn'),
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
      '9:44:00 pm',
      ev('Site limiting', 'bad'),
      cell(`${mono('query1.finance.yahoo.com')} · calls resume 9:52 pm`),
      'Yahoo Finance',
      ref('1C55'),
    ],
    [
      '4806',
      '9:43:58 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_quote')} by Claude Desktop`),
      'Yahoo Finance',
      ref('1C55'),
    ],
    [
      '4805',
      '9:40:14 pm',
      ev('Call failed', 'bad'),
      cell(`${mono('GET /apis/ui/Trolley')} answered 404`),
      'Woolworths',
      ref('6B3E'),
    ],
    [
      '4804',
      '9:40:12 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_cart')} by Claude Code`),
      'Woolworths',
      ref('6B3E'),
    ],
    [
      '4803',
      '9:31:05 pm',
      ev('Call finished', 'ok'),
      cell('ok, 2 blocked · 5.2 s'),
      'Woolworths',
      ref('8F2E'),
    ],
    [
      '4802',
      '9:31:04 pm',
      ev('Request blocked', 'bad'),
      cell(`${mono('POST collect.tealiumiq.com/event')} · host not allowed`),
      'Woolworths',
      ref('8F2E'),
    ],
    [
      '4801',
      '9:31:04 pm',
      ev('Request blocked', 'bad'),
      cell(`${mono('POST /apis/ui/Trolley/Recommendations')} · not declared`),
      'Woolworths',
      ref('8F2E'),
    ],
  ]
  const auditFilters = filterBar(
    'Search refs, tools, hosts  ⌘F',
    200,
    [
      K.seg(['All', 'Calls', 'Logins', 'Login use', 'Blocked', 'Confirmations', 'Approvals'], 0),
      'Site <b>Any</b> ▾',
      'App <b>Any</b> ▾',
      'Since <b>7 days</b> ▾',
    ],
    '',
  )
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
        hover: 12,
      })}
    </div>`

  FRAMES.push({
    id: 'activity-audit',
    group: 'Activity',
    title: 'Audit log, intact',
    personas: ['P1', 'P3', 'P5'],
    desc: '#/activity/audit. The second tab, with its own heading. Status with when it was checked and a Check now button beside it; every record links to its call.',
    html: shell('activity', auditPage),
    notes: [
      [
        440,
        138,
        'Its own tab, h1 and shortcut ⇧⌘3, so "verify the audit log" is one keystroke for P1 and audible for P5.',
      ],
      [
        970,
        91,
        "Status says when it was checked, with Check now beside it (principle 8). Export writes JSON Lines for P3's own tools.",
      ],
      [
        898,
        196,
        'The newest hash is a value: shown short, but selecting or copying takes all 64 characters (P3, E3).',
      ],
      [
        700,
        224,
        'Categories in plain words; "Login use" finds every time a login was typed, the second route to T6.',
      ],
      [
        1160,
        306,
        'The Call column links to the trace; the trace links back with "Audit records" (P4, link matrix).',
      ],
      [
        514,
        694,
        'Event names are plain words. With Show technical details on, the record kind (request-blocked) shows instead (P1, E8).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Audit record selected
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
          sel: 14,
        })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Record 4801</span><span class="grow"></span>${K.badge('In the verified chain', 'ok')}</div>
        ${kvn(
          [
            ['Time', '9:31:04 pm, Wed 11 Nov'],
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
          <div class="row">${K.btn('‹ 4800')}${K.btn('4802 ›')}<span class="grow"></span>${K.ghost('▸ Record as JSON')}</div>
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'activity-audit-record',
    group: 'Activity',
    title: 'Audit log, a record selected',
    personas: ['P1', 'P3', 'P4'],
    desc: '#/activity/audit/4801. The record in plain fields with its links, Open call as the main action, and its place in the chain.',
    html: shell('activity', auditSelected),
    notes: [
      [
        1060,
        478,
        'Every field that names an object is a link: site, version, call, app (link matrix, audit record row).',
      ],
      [
        1080,
        541,
        '"Open call 8F2E" is the main action, the round trip P1 and P3 asked for. Copy record copies the stored JSON line exactly.',
      ],
      [
        1012,
        608,
        'Previous and next walk the chain; each hash copies in full (E3). The raw JSON is one click away under "Record as JSON".',
      ],
      [
        236,
        705,
        'Arrow keys move the selection and the URL follows (#/activity/audit/4801), so Back returns to the same record (principle 7).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Audit broken
  const brokenRows = [
    ['4797', '7:05:13 pm', ev('Call finished', 'ok'), cell('ok · 0.9 s'), ref('A3C9')],
    [
      '4796',
      '7:05:12 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_summary')} by Claude Desktop`),
      ref('A3C9'),
    ],
    ['4795', '6:40:02 pm', ev('Call finished', 'ok'), cell('ok · 1.1 s'), ref('D41E')],
    [
      '4794',
      '6:40:01 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_price_history')} by Claude Desktop`),
      ref('D41E'),
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
    [
      '4789',
      '4:28:00 pm',
      ev('Site limit lifted', 'ok'),
      cell(`${mono('www.woolworths.com.au')} · calls allowed again`),
      '',
    ],
    [
      '4788',
      '3:58:00 pm',
      ev('Site limiting', 'bad'),
      cell(`${mono('www.woolworths.com.au')} · until 4:28 pm`),
      ref('2A8F'),
    ],
    [
      '4787',
      '3:57:58 pm',
      ev('Call started', 'info'),
      cell(`${mono('get_cart')} by Claude Desktop`),
      ref('2A8F'),
    ],
    ['4786', '3:12:40 pm', ev('Call finished', 'ok'), cell('ok · 2.0 s'), ref('91AA')],
    [
      '4785',
      '3:12:38 pm',
      ev('Call started', 'info'),
      cell(`${mono('search_products')} by Claude Code`),
      ref('91AA'),
    ],
  ].map((r, i) => [
    r[0],
    r[1],
    r[2],
    r[3],
    i <= 7 ? K.badge('after the break', 'bad') : K.badge('checks out', 'ok'),
    r[4],
  ])
  const auditBroken = `
    ${auditHead(K.badge("Doesn't check out · from 4790", 'bad'))}
    <div style="padding:12px 24px 10px;display:flex;flex-direction:column;gap:10px;flex:none;border-bottom:1px solid var(--wf-line)">
      <div class="wf-banner bad" style="align-items:flex-start">
        <div class="grow"><b>The audit log doesn't check out from record 4790.</b> Record 4790 doesn't link to the record before it, so it, or something before it, was changed after it was written. Records 1 to 4789 check out. Checked 9:48 pm.</div>
        <div class="row">${K.primary('Check again')}${K.btn('Export as is')}${K.ghost('What can cause this')}</div>
      </div>
      ${auditFilters}
    </div>
    <div class="split">
      <div class="list">
        ${grid(['Seq', 'Time', 'Event', 'Details', 'Chain', 'Call'], brokenRows, {
          cols: '48px 80px 140px minmax(0,1fr) 104px 46px',
          compact: true,
          sel: 7,
        })}
      </div>
      <div class="insp">
        <div class="row"><span class="h3">Record 4790</span><span class="grow"></span>${K.badge("Doesn't match", 'bad')}</div>
        ${kvn(
          [
            ['Event', 'Call started'],
            ['Call', `${ref('5C10')} by ${K.link('Claude Code')}`],
            ['Expects before it', K.value('77c1…3e0a')],
            ['Record 4789 is', K.value('d2a9…f418')],
          ],
          112,
        )}
        <div class="faint">Valet keeps writing new records. Every new record links to the last good one, so later checks still find this break.</div>
        <div class="col" style="gap:6px">${K.btn('Copy both records')}${K.btn('Open call 5C10')}</div>
      </div>
    </div>`

  FRAMES.push({
    id: 'activity-audit-broken',
    group: 'Activity',
    title: 'Audit log, chain broken',
    personas: ['P1', 'P3', 'P2'],
    desc: 'Where the Needs you item "The audit log doesn\'t check out" (See where) lands: scrolled to the first bad record, which is selected.',
    html: shell('activity', auditBroken, { badges: { needs: 4 } }),
    notes: [
      [
        248,
        186,
        'Says where it broke, what that means and what still checks out, in words P2 can follow; the record numbers are for P3 (E8).',
      ],
      [800, 168, 'Check again and Export as is: the evidence is exported unchanged, never "repaired" (P3).'],
      [750, 329, 'Each row says which side of the break it is on in words, not colour alone (P5).'],
      [1150, 420, 'The mismatch is shown as two values P3 can copy and compare.'],
      [
        130,
        66,
        'Also raised as the Needs you item "The audit log doesn\'t check out" (See where lands here), so the count goes up (IA section 5).',
      ],
    ],
  })
})()
