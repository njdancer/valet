// J8. Everyday admin by agent: remote tool, store change, why a call failed.
;(() => {
  const { K, P, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J8 · Everyday admin'] =
    "Nick asks Claude for small things. A remote tool needs one card (ph-card-remote-tool, J4); changing the store is a Setting card where Nick picks from the adapter's list; explaining a failed call needs nothing from him at all."

  FRAMES.push({
    id: 'ph-card-store',
    group: 'J8 · Everyday admin',
    size: 'phone',
    title: 'Setting card: choose your Woolworths store',
    personas: ['P8', 'P1', 'X1', 'X2'],
    desc: 'J8b, 8:05 pm. The agent can only ask; the person picks from the adapter\'s own list (security model, Adapter settings). Nick typed "Bondi". A choice is neutral, so Face ID or passcode.',
    html: P.sheet(
      P.card({
        kind: 'Setting',
        ref: '3B77',
        age: 'just now',
        title: 'Choose your Woolworths store',
        asked: 'Asked by <b>Claude app</b> · 8:05 pm',
        where: 'Through the relay',
        risk: ['', 'You choose.', "Claude only asked. It can't pick or suggest a store."],
        extra: `<div class="ph-field on">⌕ Bondi</div>
          ${P.group(
            'Woolworths stores',
            [
              P.row(
                'Woolworths Bondi Junction',
                'Westfield Bondi Junction, Oxford St',
                '<span class="chev">✓</span>',
              ),
              P.row('Woolworths Bondi Beach', 'Hall St', ''),
            ],
            "From Woolworths' store list, read by the adapter. Now: Woolworths Town Hall.",
          )}`,
        rows: [['Changes', 'add', 'Store: Woolworths Town Hall → Woolworths Bondi Junction']],
        words: 'Nick asked me to change his store to Bondi Junction.',
        agent: 'Claude app',
        details: false,
        footer: 'Claude app sees only "set by the person", never which store.',
      }),
      { title: 'Needs you', actions: P.approveBar('Approve with Face ID') },
    ),
    notes: [
      [30, 250, 'Neutral: a choice from a list the adapter declares widens nothing. Face ID or passcode.'],
      [
        30,
        330,
        "Search filters the adapter's list on the phone. No match: \"No Woolworths stores match 'Bondie'\" (F3).",
      ],
      [
        30,
        470,
        "The agent's text appears once, under its words, after the facts; it never pre-selects a row.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-undo-faceid',
    group: 'J8 · Everyday admin',
    size: 'phone',
    title: 'Undo that loosens needs Face ID',
    personas: ['P8', 'P3', 'X2'],
    desc: 'Activity, Changes. At 7:05 pm Claude app turned off "Add to cart" for itself (Notify only). Undo turns it back on, which loosens, so it takes the same Face ID as the Remote tool card. Never from a notification, never during Lock down, never by an agent.',
    html: P.screen(
      `${K.seg(['Changes', 'Calls'], 0)}
       ${P.group('Today', [
         P.row(
           'Turned off "Add to cart" for itself',
           'Claude app · notify only · 7:05 pm',
           '<span class="ph-btn plain" style="flex:none">Undo</span>',
         ),
       ])}`,
      {
        tab: 'Activity',
        title: 'Activity',
        time: '8:10',
        badge: 0,
        over: P.alert(
          'Turn "Add to cart" back on for Claude app?',
          'Claude app could add to your Woolworths cart again, from anywhere. Each checkout still asks you.',
          [
            ['Turn on with Face ID', 'b'],
            ['Cancel', 'b2'],
          ],
        ),
      },
    ),
    notes: [
      [
        350,
        300,
        'Undo has the tier of the change it makes (approval-cards.md section 3). Undoing a loosening, such as an agent turning a tool on, is stricter and needs nothing.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-activity',
    group: 'J8 · Everyday admin',
    size: 'phone',
    title: 'Activity › Calls',
    personas: ['P8', 'P1', 'P4'],
    desc: 'J8c, if the person looks themselves. Admin calls appear under the site "Valet".',
    html: P.screen(
      `${K.seg(['Changes', 'Calls'], 1)}
       <div class="row" style="gap:6px;flex-wrap:wrap">${P.pill('Site: any')}${P.pill('Agent: any')}${P.pill('Outcome: any')}</div>
       ${P.group('Today', [
         P.row(
           '<b>1F07</b> · Valet · valet_submit_draft',
           'Claude app · 7:38 pm · waiting for approval 7B3F (+ 5A20, 5A21)',
         ),
         P.row('<b>0E5D</b> · Yahoo (draft) · live trial get_quote', 'Claude app · 7:36 pm · ok'),
         P.row(
           '<b>9B12</b> · Valet · valet_submit_draft',
           'Claude Code · 7:31 pm · waiting for approval 2D9C',
         ),
         P.row(
           '<b>6B3E</b> · Woolworths · search_products',
           '<span style="color:var(--wf-bad)">Claude Desktop · 6:58 pm · failed: site changed</span>',
         ),
       ])}`,
      { tab: 'Activity', title: 'Activity' },
    ),
    notes: [
      [
        360,
        205,
        "Filters are pills that open pickers; the same filters as the Mac's address (?site&agent&outcome).",
      ],
      [360, 600, 'Outcome in words as well as colour.'],
    ],
  })

  FRAMES.push({
    id: 'ph-call',
    group: 'J8 · Everyday admin',
    size: 'phone',
    title: 'Call 6B3E',
    personas: ['P8', 'P1', 'P4', 'P3'],
    desc: 'J8c. The steps and outcome, redacted: no request bodies, no page text. The repair and its waiting fix are linked.',
    html: P.screen(
      `${P.banner('bad', "<b>Failed: site changed.</b><span>Search products couldn't read Woolworths' results (stage tool-output, invalid).</span>")}
       ${P.group('', [
         P.row('Site', 'Woolworths 0.3.0', ''),
         P.row('Agent', 'Claude Desktop', ''),
         P.row('Time', 'Thu 19 Nov, 6:58 pm', ''),
       ])}
       ${P.group('Steps', [
         P.row('✓ Open search page', '0.9 s', ''),
         P.row('✓ Request search results', '1.4 s', ''),
         P.row('✕ Read results', "output didn't match the tool's schema", ''),
       ])}
       ${P.group('', [P.row('Repair R-4E1C', 'Woolworths changed: the adapter needs an update'), P.row('Update Woolworths to 0.3.1', 'Waiting for you · approval 2D9C')])}`,
      { tab: 'Activity', title: 'Call 6B3E', large: false, back: 'Activity' },
    ),
    notes: [
      [360, 120, 'Same words the agent quotes ("Valet shows call 6B3E failed: site changed").'],
      [360, 460, 'Redacted steps only; the full trace with request detail is on the Mac.'],
      [360, 640, 'Links both ways: call → repair → the fix waiting for approval.'],
    ],
  })

  const bubble = (who, text) =>
    who === 'me'
      ? `<div style="align-self:flex-end;max-width:78%;background:var(--wf-tint-info);border-radius:18px;padding:9px 13px;font-size:15px">${text}</div>`
      : `<div style="max-width:92%;font-size:15px;display:flex;flex-direction:column;gap:6px">${text}</div>`
  const toolchip = (t) =>
    `<span class="ph-pill" style="font-family:var(--f-mono);font-size:11.5px">${t}</span>`

  FRAMES.push({
    id: 'chat-agent-results',
    group: 'J8 · Everyday admin',
    size: 'phone',
    title: "In the chat: the agent uses Valet's words",
    personas: ['P9', 'P6', 'P8'],
    desc: "J8c and J8b from the person's side, in a generic chat app (not Valet). The agent quotes Valet's wording, so what it says matches the phone and the Mac.",
    html: `<div class="wf-phone"><div class="sbar"><span>8:06</span><span class="island"></span><span>▮▮▮ ◔</span></div>
      <div class="nbar"><div class="ntop"><span>‹</span><b>Chat</b><span></span></div></div>
      <div class="content" style="background:var(--wf-paper)">
        ${bubble('me', 'Why did my last Woolworths search fail?')}
        ${bubble('agent', `<div class="row" style="gap:4px;flex-wrap:wrap">${toolchip('valet_list_calls')}${toolchip('valet_get_call 6B3E')}</div><span>Valet shows call 6B3E failed: site changed. There's a repair open (R-4E1C) and a fix waiting for your approval: "Update Woolworths to 0.3.1".</span>`)}
        ${bubble('me', 'Ok. Also change my store to Bondi Junction.')}
        ${bubble('agent', `<div class="row" style="gap:4px;flex-wrap:wrap">${toolchip('valet_request_setting woolworths store')}</div><span>Valet asked you to choose the Woolworths store on your phone ("Choose your Woolworths store"). I can't pick it for you.</span>`)}
        ${bubble('agent', `<div class="row" style="gap:4px;flex-wrap:wrap">${toolchip('valet_status')}</div><span>Valet shows the Woolworths store was set by you.</span>`)}
      </div>
      <div style="flex:none;padding:8px 16px 34px;background:var(--wf-paper)"><div class="ph-field">Reply…</div></div><span class="home"></span></div>`,
    notes: [
      [360, 230, 'Reads need no approval and no notification (tier "No approval").'],
      [
        360,
        430,
        'The tool result text from information-architecture.md section 5, relayed nearly verbatim. The agent never learns which store was picked.',
      ],
    ],
  })
})()
