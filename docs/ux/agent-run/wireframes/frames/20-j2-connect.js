// J2. Connect an agent: locally from setup, and remotely through the relay with the code typed on the phone.
;(() => {
  const { K, P, FRAMES } = window.WF
  const { setup, h, lg, SUBS } = window.WF.setupV2
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J2 · Connect an agent'] =
    'Thursday 12 November, 8:20 to 8:31 pm. Each agent gets three capabilities: Use tools, See Valet and Ask for changes. A local agent connects with one click; a remote one through the relay, with the code from its sign-in page typed into Valet on the phone. Remote agents start with Use tools only.'

  const caps = (a = true, b = true, c = true) =>
    `<div class="row" style="gap:14px;flex-wrap:wrap">${K.check('Use tools', a)}${K.check('See Valet', b)}${K.check('Ask for changes', c)}</div>`

  FRAMES.push({
    id: 'mac-setup-connect-v2',
    group: 'J2 · Connect an agent',
    title: 'Mac: Connect an agent',
    personas: ['P8', 'P1', 'P2', 'P9'],
    desc: 'Path A, step 1. Agents on this Mac connect in one click with their capabilities; claude.ai and phones connect through the relay.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'c'],
      subs: SUBS,
      body:
        h(
          'Connect an agent',
          'Your agent sets Valet up and keeps it working. Choose what each one may do; anything that matters still waits for you.',
        ) +
        K.card(
          'On this Mac',
          `<div class="col" style="gap:12px">
            <div class="row" style="align-items:flex-start">${K.avatar('C')}<div class="col grow" style="gap:4px"><b>Claude Code</b>${caps()}</div>${K.badge('Connected · first call 8:20 pm', 'ok')}</div>
            <div class="row" style="align-items:flex-start">${K.avatar('D')}<div class="col grow" style="gap:4px"><b>Claude Desktop</b>${caps(true, true, false)}</div>${K.primary('Connect')}</div>
          </div>`,
        ) +
        K.card(
          'On claude.ai or your phone',
          `<div class="row"><span class="muted grow">Add Valet as a connector in Claude. You'll approve it on your iPhone with a code.</span>${K.btn('Connect through the relay…')}</div>`,
        ) +
        '<span class="faint">Use tools: site tools like Woolworths. See Valet: status and this agent\'s own calls (all agents\' activity is a separate choice on its page). Ask for changes: settings, drafts and adapters, each still approved by you. A local name identifies a token, not a process.</span>',
      foot: `${lg('Back')}<span class="grow"></span>${lg('Continue', 'primary')}`,
    }),
    notes: [
      [
        330,
        260,
        'Defaults (journeys J2): all three on for an agent on this Mac. Unticking is allowed here and later on its Connections page.',
      ],
      [
        900,
        230,
        'The row turns to Connected after the agent\'s first call (valet_status), so "connected" means it actually works.',
      ],
      [700, 340, 'Remote agents get their own card (ph-card-connect), never a click here.'],
    ],
  })

  FRAMES.push({
    id: 'mac-setup-done-v2',
    group: 'J2 · Connect an agent',
    title: 'Mac: Done, with a first request to try',
    personas: ['P8', 'P2', 'P1'],
    desc: 'Path A, step 4. Suggests the sentence to send, keeps the do-it-yourself route, and the keep-awake warning (D3 of J1).',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'c'],
      subs: { ...SUBS, 4: 'Claude Code' },
      body:
        h('Valet is ready', 'Your agent can set things up now. Try asking it:') +
        `<div class="row">${K.value('Set up Woolworths for me.')}</div>` +
        '<span class="muted">It will ask you on your iPhone to approve Woolworths and your login, and may ask which store.</span>' +
        K.banner(
          'warn',
          'Keep this Mac awake and online',
          'so your phone and agents can reach it.',
          K.btn('Open Energy settings'),
        ) +
        `<span class="wf-link">Set up a site yourself</span><span class="faint" style="margin-top:-12px">For people without an agent: the Woolworths steps, one by one.</span>`,
      foot: `<span class="grow"></span>${lg('Open Valet', 'primary')}`,
    }),
    notes: [
      [330, 165, 'A value with Copy: the person pastes it into the agent.'],
      [
        330,
        255,
        'Whether Valet keeps the Mac awake is a question for Nick (IA section 9); this is the honest warning until then.',
      ],
      [330, 320, 'Leads to the v3 site steps (IA assumption 1 and question 5).'],
    ],
  })

  FRAMES.push({
    id: 'ph-connections-add',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: 'iPhone: Add an agent',
    personas: ['P8', 'P2', 'P1'],
    desc: 'Path B, step 1. The relay address with Copy and Share, and the three steps.',
    html: P.screen(
      `${P.group(
        "Valet's address for agents",
        [
          P.row('<span class="ph-host">https://relay.valet.example/m/8kq2…</span>', '', ''),
          P.row('Copy', '', '', 'act'),
          P.row('Share…', '', '', 'act'),
        ],
        "Only Nick's MacBook Pro answers at this address.",
      )}
      ${P.group('Then', [
        P.row('1. In Claude, add a custom connector with this address.', '', ''),
        P.row('2. Sign in when Claude asks. A page shows a code.', '', ''),
        P.row('3. Type the code into Valet here. A card will ask.', '', ''),
      ])}
      ${P.banner('info', '<span>Valet accepts new agents through the relay for the next 10 minutes, or until one connects. Then it stops again.</span>')}`,
      { tab: 'Agents', title: 'Add an agent', large: false, back: 'Agents', badge: 0, time: '8:29' },
    ),
    notes: [
      [196, 150, 'The address is a selectable value; the full address shows in Copy.'],
      [
        196,
        560,
        "The person's own Add an agent opens the relay to new agents, and only for 10 minutes or one connect (R44).",
      ],
    ],
  })

  FRAMES.push({
    id: 'br-consent-code',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: "Browser: the relay's sign-in page shows the code",
    personas: ['P8', 'P3', 'X2'],
    desc: 'Path B, step 3. Opened by Claude in Safari. The code is shown only here, never on the Mac or the phone card (docs/relay.md).',
    html: P.screen(
      `<div class="ph-field" style="justify-content:center;font-size:13px">🔒 relay.valet.example</div>
       <div class="col" style="gap:14px;margin-top:30px;text-align:center">
        <h2 style="font:700 24px/1.2 var(--f-head);margin:0">Connect Claude to Valet</h2>
        <div style="font-size:16px">Type this code into Valet on your iPhone or Mac:</div>
        <div class="ph-code" style="font-size:30px">KQFM-XDRT</div>
        <div class="muted" style="font-size:14px">Valet never sends this code by text message.</div>
        <div class="muted">Ends at 8:35 pm.</div>
        ${P.banner('', "<b>If you didn't just add a connector, close this page.</b>")}
        <div class="muted" style="font-size:14px">This page continues by itself once you approve in Valet.</div></div>`,
      { tab: false, large: false, time: '8:30' },
    ),
    notes: [
      [
        196,
        250,
        "Letters only, with a hyphen, so it never looks like a login code and iOS won't offer an SMS code for it (R11). Typed, not compared: an attacker's own claude.ai consent shows the code only in the attacker's browser (docs/relay.md, consent phishing).",
      ],
      [
        196,
        400,
        "The warning is the rule the app repeats: a request you didn't start was started by someone else.",
      ],
    ],
  })

  const connectCard = (o = {}) =>
    P.card({
      kind: 'Connect',
      ref: '3E9A',
      age: o.age || '4 min · until 8:35 pm',
      title: 'Did you just add Valet to an agent?',
      asked:
        'Started from <b>a different network, in Sydney (approx.)</b> · 8:30 pm · goes back to <b>claude.ai</b>',
      where: 'Through the relay',
      risk: ['strong', 'Check this.', 'Only approve if you started this. Type the code the page shows you.'],
      extra: `<div class="ph-sec">Code from the page you opened</div>${o.code || '<div class="ph-field on ph-code">KQFM-XDRT</div>'}
         <div style="font-size:12.5px;color:var(--wf-ink-3)">Valet never sends this code by text. No suggestions or autofill here.</div>
         <div class="ph-sec">What will you call it?</div><div class="ph-field on">Claude app</div>
         <div style="font-size:12.5px;color:var(--wf-ink-3)">Unique; no device words ("iPhone", "Mac"), "Valet" or "your".</div>
         <div class="ph-sec">It may</div>
         <div style="font-size:14px" class="col">${K.check('Use tools', true)}${K.check('See Valet (its own activity)', o.ticked !== false)}${K.check('Ask for changes', o.ticked !== false)}</div>
         <div class="ph-sec">Read tools it can use from anywhere</div>
         <div style="font-size:14px" class="col">${K.check('Wikipedia · Search articles', o.ticked !== false)}${K.check('Wikipedia · Get summary', o.ticked !== false)}${K.check('Wikipedia · Get article', o.ticked !== false)}${K.check('Woolworths · Search products', o.ticked !== false)}${K.check('Woolworths · Get cart', false)}</div>
         <div style="font-size:12.5px;color:var(--wf-ink-3)">Tools that change things are asked for later, one card each.</div>`,
      ack: o.ticked === false ? 'off' : 'on',
      footer:
        'Ends at 8:35 pm if nobody answers. Three wrong codes cancel every connect request. Calls itself "Claude (claude.ai)" and the address 203.0.113.24 are in Details.',
      details: true,
      detailRows: ['Calls itself "Claude (claude.ai)" · 203.0.113.24', 'Fingerprint and request'],
    })

  FRAMES.push({
    id: 'ph-card-connect',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: 'Connect card: type the code, name it, choose tools',
    personas: ['P8', 'P3', 'P5', 'X2'],
    desc: 'Path B, steps 4 and 5, shown filled in. The title is the question; Face ID only. The code selects the request; nothing can be approved until it matches. Defaults are Use tools only and no tools: the person ticked the rest here.',
    html: P.sheet(connectCard(), {
      title: 'Needs you',
      time: '8:31',
      actions: `<div class="row">${P.btn('No, decline')}${P.btn('Approve with Face ID', 'primary')}</div>`,
    }),
    notes: [
      [
        10,
        130,
        'The title is the question a first-line reader must answer (R32). Where it started is a network and rough place, not a bare IP (R42); the redirect host is in full (R12).',
      ],
      [10, 350, 'Strong: a phished connect is the attack docs/relay.md is built around.'],
      [
        10,
        455,
        "The field has autofill and one-time-code suggestions off, so an attacker's text message can't land here with one tap (R11).",
      ],
      [
        10,
        575,
        "The name starts empty, not prefilled with the agent's claim. Look-alikes of existing names are refused (R18).",
      ],
      [
        10,
        700,
        'Capabilities and, below, read tools only, all unticked by default; write tools are separate cards (R43).',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-connect-wrong',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: 'Connect card: wrong code (F1)',
    personas: ['P8', 'X2'],
    desc: "F1. The code doesn't match any request. The third wrong code cancels every pending connect request and audits it.",
    html: P.sheet(
      connectCard({
        code: `<div class="ph-field on ph-code" style="border-color:var(--wf-bad)">KQFM-XDRB</div><div style="font-size:13px;color:var(--wf-bad)">That code doesn't match any request. 2 tries left.</div>`,
      }),
      { title: 'Needs you', time: '8:31', actions: P.approveBar('Approve with Face ID', { off: true }) },
    ),
    notes: [[10, 440, 'Error in words and colour; Approve stays off until a code matches.']],
  })

  FRAMES.push({
    id: 'ph-card-connect-unexpected',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: "A connect request you didn't start (F2): declined",
    personas: ['P8', 'P3', 'X2'],
    desc: 'F2. After "No, decline", the card offers to stop new agents connecting through the relay for an hour.',
    html: P.sheet(
      `${P.state('', "<span>✓</span><div><b>Declined on Nick's iPhone at 8:31 pm.</b><br>Nothing was connected. A request you didn't start was started by someone else.</div>")}
       ${P.group('', [P.row('Turn off connecting through the relay for an hour', 'Agents already connected keep working.', P.btn('Turn off', 'plain'))])}`,
      { title: 'Connect an agent', back: 'Needs you', time: '8:31' },
    ),
    notes: [[196, 260, 'Stricter, so no Face ID. Listed in Activity, Changes with Undo.']],
  })

  FRAMES.push({
    id: 'ph-card-connect-done',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: 'Connected',
    personas: ['P8', 'P9'],
    desc: 'Path B, step 7. The browser continues to Claude by itself.',
    html: P.sheet(
      `${P.state('ok', "<span>✓</span><div><b>Connected Claude app at 8:31 pm.</b><br>Approved with Face ID on Nick's iPhone. It can use 4 read tools from anywhere. Go back to Claude to finish.</div>")}
       ${P.group('', [P.row('Claude app', 'Through the relay · Use tools · See Valet · Ask for changes'), P.row('Back to Claude', 'Opens the Claude app')])}`,
      { title: 'Connect an agent', back: 'Needs you', time: '8:31' },
    ),
    notes: [
      [
        196,
        140,
        'If the Mac had been asleep, no card would exist: the relay page says "Valet on this Mac didn\'t answer" (F3).',
      ],
    ],
  })

  FRAMES.push({
    id: 'br-consent-mac-asleep',
    group: 'J2 · Connect an agent',
    size: 'phone',
    title: "Browser: the Mac didn't answer (F3), or new agents are off (F5)",
    personas: ['P8', 'P7'],
    desc: 'F3 and F5. The relay page says what happened; no request waits for later.',
    html: P.screen(
      `<div class="ph-field" style="justify-content:center;font-size:13px">🔒 relay.valet.example</div>
       <div class="col" style="gap:14px;margin-top:30px;text-align:center">
        <h2 style="font:700 24px/1.2 var(--f-head);margin:0">Valet on this Mac didn't answer</h2>
        <div class="muted" style="font-size:16px">It may be asleep or offline. Nothing was connected. Wake the Mac, then add the connector again.</div>
        <div class="faint" style="font-size:14px;margin-top:20px">If new agents are off, the page instead says: "This Mac doesn't accept new agents right now."</div></div>`,
      { tab: false, large: false, time: '8:30' },
    ),
    notes: [
      [
        196,
        230,
        'No card reaches the phone: the Mac creates cards, so a sleeping Mac means no request at all.',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-connections-agent-no-oauth',
    group: 'J2 · Connect an agent',
    title: 'Mac: an agent that must run on this Mac (D1)',
    personas: ['P1', 'P4'],
    desc: 'Dead end D1. Agents without OAuth or MCP over HTTP get the local config snippet instead.',
    html: window.WF.shell(
      'connections',
      `${K.header({ title: 'Connections', sub: 'Agents · Devices · Relay' })}<div class="wf-scroll"></div>`,
      {
        badges: { needs: 0 },
        sites: [
          ['W', 'Woolworths', 'idle'],
          ['W', 'Wikipedia', 'ok'],
        ],
        over: window.WF.sheet(
          'Add an agent',
          `<div class="col" style="gap:12px">
            ${K.seg(['Through the relay', 'On this Mac'], 1)}
            <span>This agent needs to run on the same Mac as Valet. Add this to its MCP settings:</span>
            <div class="mono" style="background:var(--wf-paper-2);padding:10px;border-radius:8px">{ "valet": { "command": "/Applications/Valet.app/…/valet-mcp" } }</div>
            ${caps(true, true, false)}
          </div>`,
          `${K.btn('Copy')}<span class="grow"></span>${K.primary('Done')}`,
        ),
      },
    ),
    notes: [[600, 300, 'Capabilities are chosen here too; the connection is named on its first call.']],
  })
})()
