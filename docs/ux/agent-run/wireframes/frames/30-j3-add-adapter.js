// J3. "Add an adapter for Yahoo Finance": from chat on the phone to an installed adapter.
;(() => {
  const { K, P, shell, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J3 · Add an adapter'] =
    'Nick asks Claude in the Claude iPhone app (connected as "Claude app") for a Yahoo Finance adapter. The agent writes and tests it through Valet\'s tools; the only thing that reaches Nick is one card, with two unticked follow-ons for remote tools.'

  const installCard = (over = {}) =>
    P.card({
      kind: 'Install · 1.0.0',
      ref: '7B3F',
      age: '2 min ago',
      title: 'Install "Yahoo Finance" for yahoo.com',
      risk: ['', 'Reads only.', "Reads yahoo.com. No login. Can't change anything."],
      rows: [
        ['Adds', 'add', P.host('', 'finance.yahoo.com')],
        ['Adds', 'add', P.host('query1.finance.', 'yahoo.com')],
        ['Adds', 'add', P.host('query2.finance.', 'yahoo.com')],
        ['Adds', 'add', '3 tools: Get quote, Get price history, Search symbols · all read'],
        ['Usable', 'add', 'At once by Claude Code, Claude Desktop (this Mac): read tools'],
        ['Same', 'same', 'Sandbox on · no login · no local data'],
      ],
      because: ['same', 'Draft Yahoo Finance, started 7:24 pm by Claude app'],
      checks: ['✓ Build, manifest, lint', '✓ Live trial: Get quote (AAPL) at 7:36 pm', '✓ Sandbox on'],
      tests: '14 tests the agent wrote pass (Valet ran them). Fixtures recorded by Valet.',
      follow: [
        ['Turn on "Get quote" for Claude app (from anywhere)', false],
        ['Turn on "Get price history" for Claude app (from anywhere)', false],
      ],
      words:
        'You asked for stock prices. I based this on two published adapters but wrote my own; it only reads public quote pages.',
      ...over,
    })

  FRAMES.push({
    id: 'ph-notify-draft',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'A quiet notification: a draft was started (Notify only)',
    personas: ['P8', 'P1', 'X2'],
    desc: 'Step 3. Starting a draft needs no approval; the person hears about it once, quietly, grouped with anything else this agent does in the next hour.',
    html: P.lock(
      P.notif(
        'Claude app started a draft',
        'Yahoo Finance. Nothing is installed until you approve it.',
        '7:24 pm',
      ) +
        `<div style="font-size:13px;color:var(--wf-ink-2);text-align:center">Delivered quietly · no sound</div>`,
      { clock: '7:24' },
    ),
    notes: [
      [
        80,
        250,
        'Notify-only changes use the passive interruption level. They group per agent per hour: "Claude app made 3 changes" (approval-cards.md section 10).',
      ],
      [
        300,
        290,
        "The body never carries the agent's own words or page text, so X1 can't write into the notification.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-install',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'Install card, as it opens',
    personas: ['P8', 'P1', 'P2', 'P3', 'P5', 'X1'],
    desc: "Step 8. Kind, title, who asked and the risk line sit above the fold with the buttons pinned below. Everything Valet checked comes before the agent's own words.",
    html: P.sheet(installCard(), { title: 'Needs you', right: '1 of 2', actions: P.approveBar() }),
    notes: [
      [
        30,
        112,
        'Kind strip: kind word, approval ref (the same ref the agent quotes), age. VoiceOver reads kind, title and asked-by as one heading group.',
      ],
      [
        30,
        160,
        "Title names the real domain from Valet's diff; the agent's display name is only quoted (rule 1, review R3). Wraps, never truncates.",
      ],
      [
        30,
        240,
        'Neutral tone: reads only, no login. Caution and strong tones have their own word and tint ("Can\'t be undone.").',
      ],
      [30, 310, 'Hosts in full, registrable domain bold, wrapping not truncating (rule 7).'],
      [
        200,
        780,
        'Actions are pinned. Decline needs no Face ID. Approve never fires on a tap alone (rule 4).',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-install-scrolled',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: "Install card, scrolled: checks, follow-ons, the agent's words, details",
    personas: ['P8', 'P3', 'P4'],
    desc: 'Step 8, lower half. Follow-ons are tick boxes: read tools ticked, write tools never pre-ticked. One Face ID approves the install and what is ticked.',
    html: P.sheet(
      `<div style="margin-top:-330px;display:flex;flex-direction:column;gap:12px">${installCard()}</div>`,
      { title: 'Needs you', right: '1 of 2', actions: P.approveBar() },
    ),
    notes: [
      [
        8,
        360,
        '"Checks Valet ran" lists only Valet\'s own runs. The agent\'s tests are a separate plain line: Valet ran them, but the agent wrote them (R22).',
      ],
      [
        8,
        515,
        'Follow-ons: only remote tools of this adapter, never pre-ticked. Ticking one raises the risk line to caution: "+ Claude app could use 2 tools from anywhere" (section 8).',
      ],
      [
        8,
        635,
        'The agent\'s words: labelled, quoted, plain text, after the facts. "Show more" past 280 characters.',
      ],
      [
        8,
        742,
        "Details: code changes, the URLs of references it read (never installed, D75), the payload fingerprint and the agent's self-description.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-code',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'See code changes, on the phone',
    personas: ['P1', 'P4', 'P3'],
    desc: 'Step 9. A readable diff that wraps; a file list at the top; the manifest first because it decides what the adapter can reach. "Open on my Mac" for a proper read.',
    html: P.sheet(
      `${P.group('4 files · +212 lines', [
        P.row(
          '<span class="mono">manifest.json</span>',
          'hosts, tools, sandbox · +38',
          '<span class="chev">›</span>',
        ),
        P.row('<span class="mono">src/quote.ts</span>', '+96'),
        P.row('<span class="mono">src/history.ts</span>', '+51'),
        P.row('<span class="mono">tests/quote.test.ts</span>', '+27'),
      ])}
      <div class="ph-sec">manifest.json</div>
      <div class="ph-diff"><span class="a">+ "egress": [</span><span class="a">+   "finance.yahoo.com",</span><span class="a">+   "query1.finance.yahoo.com",</span><span class="a">+   "query2.finance.yahoo.com"</span><span class="a">+ ],</span><span class="a">+ "tools": {</span><span class="a">+   "get_quote": { "sideEffect": "read", …</span></div>
      ${P.btn('Open on my Mac', '')}`,
      { title: 'Code changes', back: 'Install', actions: P.approveBar() },
    ),
    notes: [
      [30, 120, 'Files sorted manifest first, then sources, then tests and fixtures.'],
      [30, 330, 'Monospace, wraps long lines, no horizontal scroll. Pinch to zoom.'],
      [
        30,
        600,
        "Open on my Mac brings this review to the front of the Mac window next time it's used (J3 D3). The card stays waiting on both.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-faceid',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'Approve with Face ID',
    personas: ['P8', 'P5', 'X2'],
    desc: "Step 10. The system Face ID sheet. Its success unlocks the Secure Enclave key that signs this payload's hash; the Mac accepts nothing else.",
    html: P.sheet(installCard(), {
      title: 'Needs you',
      right: '1 of 2',
      actions: P.approveBar(),
      over: P.faceid(),
    }),
    notes: [
      [
        200,
        470,
        'Face ID, or "Use passcode instead" on every card (Nick, 2026-11-12). (approval-cards.md section 6)',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-approved',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'Approved: what happened next',
    personas: ['P8', 'P2', 'P9'],
    desc: 'Step 10 to 11. The card says what Valet did. Agents can\'t be woken, so it never says the agent "has been told": the agent sees the answer the next time it calls Valet.',
    html: P.sheet(
      `${P.state('ok', '<span>✓</span><div><b>Approved with Face ID on Nick\'s iPhone at 7:41 pm</b><br>Yahoo Finance 1.0.0 is installed. "Get quote" and "Get price history" are on for Claude app. Claude app will see this the next time it checks Valet.</div>')}
      ${P.btn('Back to Claude', 'primary')}
      ${P.group('', [P.row('Yahoo Finance', 'Open the site')])}
      ${P.group('Still waiting', [P.item('↑', 'Update Woolworths to 0.3.1', 'Asked by Claude Code · 7:31 pm')])}`,
      { title: 'Install "Yahoo Finance"', back: 'Needs you' },
    ),
    notes: [
      [
        30,
        120,
        'Answered state (approval-cards.md section 9). Every other copy of this card, on the Mac too, shows the same line.',
      ],
      [30, 330, 'The next waiting item is right here, so a batch can be answered in a row.'],
    ],
  })

  FRAMES.push({
    id: 'ph-card-decline',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'Decline with a note to the agent',
    personas: ['P8', 'P9', 'P4'],
    desc: 'F3. Decline is one tap; the note is optional and goes to the agent verbatim, so it can fix the draft without another conversation.',
    html: P.sheet(
      `<div class="h3" style="font-size:17px">Decline "Install Yahoo Finance for yahoo.com"?</div>
       <div class="muted" style="font-size:14px">Nothing will be installed.</div>
       <div class="ph-sec">Tell Claude app why (optional)</div>
       <div class="ph-field on" style="min-height:92px;align-items:flex-start;padding-top:10px">Don't add query2, query1 is enough.</div>
       <div style="font-size:13px;color:var(--wf-ink-3)">Your note goes to Claude app as you wrote it.</div>`,
      { title: 'Decline', back: 'Cancel', actions: `<div class="row">${P.btn('Decline', 'danger')}</div>` },
    ),
    notes: [
      [
        30,
        200,
        "The note is the person's words. It goes only to the asking agent, never to other agents' reads (R56). A decline with a note doesn't count towards the 3-decline pause.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-replaced',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'A new request replaces the declined one',
    personas: ['P8', 'P9'],
    desc: 'F3, after the agent fixed the draft. The new card says what it replaces and what changed since.',
    html: P.sheet(
      installCard({
        ref: '8C01',
        age: 'just now',
        asked: 'Asked by <b>Claude app</b> · 7:46 pm',
        extra: P.banner(
          'info',
          '<b>Replaces the request you declined at 7:41 pm.</b><span>Since then: removes query2.finance.yahoo.com.</span>',
        ),
        rows: [
          ['Adds', 'add', P.host('', 'finance.yahoo.com')],
          ['Adds', 'add', P.host('query1.finance.', 'yahoo.com')],
          ['Adds', 'add', '3 tools: Get quote, Get price history, Search symbols · all read'],
          ['Same', 'same', 'Sandbox on · no login · no local data'],
        ],
      }),
      { title: 'Needs you', right: '1 of 2', actions: P.approveBar() },
    ),
    notes: [
      [
        30,
        250,
        "The difference from the declined request comes from Valet's diff of the two payloads, not from the agent.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-x1-host',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'A reference adapter steered the agent (X1)',
    personas: ['P3', 'P8', 'X1'],
    desc: "F4. The draft quietly adds a host from a reference adapter. The facts come first and in Valet's words; the agent's justification sits under them.",
    html: P.sheet(
      installCard({
        title: 'Install "Yahoo Finance" for 2 sites: yahoo.com, example.net',
        risk: [
          'caution',
          'Check this.',
          "Also reaches stats.yf-helper.example.net, which isn't part of yahoo.com.",
        ],
        rows: [
          ['Adds', 'add', P.host('stats.yf-helper.', 'example.net')],
          ['Adds', 'add', P.host('', 'finance.yahoo.com')],
          ['Adds', 'add', P.host('query1.finance.', 'yahoo.com')],
          ['Adds', 'add', P.host('query2.finance.', 'yahoo.com')],
          ['Adds', 'add', '3 tools · all read'],
        ],
        words: 'The stats host is needed for charts.',
      }),
      { title: 'Needs you', right: '1 of 2', actions: P.approveBar() },
    ),
    notes: [
      [30, 240, "Caution tone. A host outside the site's own domain is sorted first."],
      [
        30,
        300,
        'The registrable domain (example.net) is bold, and VoiceOver reads "owned by example.net, not yahoo.com" (rule 8).',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-mismatch',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: "The name doesn't match its hosts",
    personas: ['P3', 'P2', 'X1', 'X2'],
    desc: 'F5. A draft named "Yahoo Finance" whose hosts aren\'t under yahoo.com. Approve stays off until Details has been opened.',
    html: P.sheet(
      installCard({
        title: 'Install "Yahoo Finance" for example.net (the name doesn\'t match)',
        risk: [
          'strong',
          'Check this.',
          'It calls itself Yahoo Finance but reaches quotes-mirror.example.net, not yahoo.com.',
        ],
        ack: 'off',
        rows: [
          ['Adds', 'add', P.host('quotes-mirror.', 'example.net')],
          ['Adds', 'add', '3 tools · all read'],
        ],
        checks: undefined,
        follow: undefined,
      }),
      {
        title: 'Needs you',
        actions: P.approveBar('Approve with Face ID', {
          off: true,
          note: 'Open Details first to approve this.',
        }),
      },
    ),
    notes: [
      [
        30,
        170,
        'Title rule in approval-cards.md section 7: the name is quoted and qualified, so a first-line reader (P2) still sees the warning.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-changed',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'It changed while you were reading',
    personas: ['P3', 'X2'],
    desc: 'F6. The agent submitted again between the card opening and Face ID. The Mac refuses the stale signature; the phone says so plainly.',
    html: P.sheet(
      `${P.state('warn', '<span>!</span><div><b>This changed while you were reading it. Nothing was approved.</b><br>Claude app submitted a newer draft at 7:40 pm.</div>')}${P.btn('See what changed', 'primary')}`,
      { title: 'Install "Yahoo Finance"', back: 'Needs you' },
    ),
    notes: [
      [
        30,
        120,
        'Rule 2: what you see is what you sign. The signature covers the payload hash shown, so an approval can never land on a different payload.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-card-mac-offline',
    group: 'J3 · Add an adapter',
    size: 'phone',
    title: 'Not confirmed yet',
    personas: ['P8', 'P7'],
    desc: "F7. Face ID succeeded but the Mac hasn't acknowledged within 30 seconds. The phone can't know whether it arrived, so it says what will happen: the signed approval expires 2 minutes after signing.",
    html: P.sheet(
      `${P.state('warn', "<span>…</span><div><b>Not confirmed yet.</b><br>If your Mac gets it by 7:43 pm it will be used; after that it won't. Nick's MacBook Pro was last seen at 7:39 pm.</div>")}
       ${P.btn('Check again', 'primary')}
       <div style="font-size:13px;color:var(--wf-ink-3)">Check again resends the same approval, so it can never count twice. The request stays waiting until it expires (Fri 20 Nov, 7:38 pm).</div>`,
      { title: 'Install "Yahoo Finance"', back: 'Needs you' },
    ),
    notes: [
      [
        30,
        120,
        'Each approval carries a one-time nonce and expires 2 minutes after signing (approval-cards.md section 9). A resend is the same approval, so a lost acknowledgement never turns into a false "refused" alarm.',
      ],
      [
        30,
        300,
        'Other states: if the Mac was already offline before the person started, the kind strip says "Mac last seen 7:39 pm" and Approve says "Your Mac is offline. You\'ll be told when it\'s back." With no connection on the phone: "No connection. Nothing was sent."',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-sites-drafts',
    group: 'J3 · Add an adapter',
    title: 'Mac: Sites with a Drafts section',
    personas: ['P1', 'P4', 'P3'],
    desc: 'Step 5. Drafts appear above the sites only when there are any. Each says who is writing it and where it stands.',
    html: shell(
      'sites',
      `${K.header({ title: 'Sites', sub: '2 sites · 2 drafts by your agents' })}
      <div class="wf-scroll"><div class="col">
        ${K.card(
          'Drafts by your agents',
          K.table(
            ['Draft', 'Written by', 'Checks Valet ran', 'Status', ''],
            [
              [
                K.link('Yahoo Finance 1.0.0'),
                K.link('Claude app'),
                'build, lint ok · live trial ok · 14 agent tests pass',
                K.badge('Waiting for you', 'warn'),
                K.btn('Review'),
              ],
              [
                K.link('Woolworths 0.3.1'),
                K.link('Claude Code'),
                'Reproduction check passed',
                K.badge('Waiting for you', 'warn'),
                K.btn('Review update'),
              ],
            ],
            { cols: '1.3fr 1fr 1.5fr 1fr auto' },
          ),
        )}
        ${K.card(
          'Sites',
          K.table(
            ['Site', 'Version', 'Health', ''],
            [
              [
                K.link('Woolworths'),
                '0.3.0',
                K.health('bad', 'Search is broken: site changed · fix waiting'),
                '',
              ],
              [K.link('Wikipedia'), '0.2.1', K.health('ok', 'Ready'), ''],
            ],
            { cols: '1fr 0.6fr 2fr auto' },
          ),
        )}
      </div></div>`,
      {
        badges: { needs: 2 },
        sites: [
          ['W', 'Woolworths', 'bad'],
          ['W', 'Wikipedia', 'ok'],
        ],
      },
    ),
    notes: [
      [
        470,
        150,
        'A draft is a link to its page (#/sites/drafts/<id>); the status is a badge and the action is a real button beside it (v3 principle 2).',
      ],
      [700, 150, '"Checks Valet ran" only; nothing the agent claims.'],
    ],
  })

  FRAMES.push({
    id: 'mac-draft-page',
    group: 'J3 · Add an adapter',
    title: "Mac: a draft's page",
    personas: ['P4', 'P1', 'P3'],
    desc: "Step 5. Files, Valet's checks, the live trial, references the agent read, and the request it is waiting on.",
    html: shell(
      'sites',
      `${K.header({
        crumbs: ['Sites', 'Drafts'],
        title: 'Yahoo Finance 1.0.0',
        status: K.badge('Waiting for you', 'warn'),
        sub: `Draft by ${K.link('Claude app')} · started 7:24 pm · submitted 7:38 pm as approval ${K.link('7B3F')}`,
        actions: K.primary('Review'),
      })}
      <div class="wf-scroll"><div class="grid2">
        ${K.card(
          'Checks Valet ran',
          K.kv([
            ['Build, lint, manifest', K.badge('Passed', 'ok')],
            ['Tests', '14 passed · 7:37 pm'],
            ['Live trial', `Get quote (AAPL) ok · 7:36 pm · call ${K.link('0E5D')}`],
            ['Sandbox', 'On · no exceptions'],
          ]),
        )}
        ${K.card(
          'Files',
          K.table(
            ['File', 'Lines'],
            [
              ['manifest.json', '+38'],
              ['src/quote.ts', '+96'],
              ['src/history.ts', '+51'],
              ['tests/quote.test.ts', '+27'],
            ],
            { cols: '1fr auto' },
          ),
        )}
        ${K.card('References it read', `<div class="col">${K.value('github.com/…/valet-yahoo')}${K.value('github.com/…/yf-adapter')}<span class="faint">Read only. Valet never installs from a URL.</span></div>`)}
        ${K.card('Fixtures', '<span class="muted">3 recorded responses from the scratch browser, values kept, cookies stripped.</span>')}
      </div></div>`,
      {
        badges: { needs: 2 },
        sites: [
          ['W', 'Woolworths', 'bad'],
          ['W', 'Wikipedia', 'ok'],
        ],
      },
    ),
    notes: [[1050, 66, 'Review opens the Review page with the card on top (mac-review-install-agent).']],
  })

  FRAMES.push({
    id: 'mac-review-install-agent',
    group: 'J3 · Add an adapter',
    title: 'Mac: the review page, card on top',
    personas: ['P1', 'P3', 'P5'],
    desc: 'The same card parts in the same order as the phone, expanded. The v3 review (permissions, code) follows below the card.',
    html: shell(
      'sites',
      `${K.header({ crumbs: ['Sites', 'Drafts', 'Yahoo Finance 1.0.0'], title: 'Install "Yahoo Finance" for yahoo.com', status: K.badge('Install 1.0.0 · approval 7B3F', 'info'), sub: `Site: <span class="mono">finance.yahoo.com</span> · asked by ${K.link('Claude app')} · 7:38 pm · through the relay` })}
      <div class="wf-scroll"><div class="col" style="max-width:760px">
        ${K.banner('idle', 'Reads only.', "Reads yahoo.com. No login. Can't change anything.")}
        ${K.card(
          'What changes',
          K.table(
            [],
            [
              ['Adds', 'finance.yahoo.com'],
              ['Adds', 'query1.finance.yahoo.com'],
              ['Adds', 'query2.finance.yahoo.com'],
              ['Adds', '3 tools: Get quote, Get price history, Search symbols · read'],
              ['Same', 'Sandbox on · no login · no local data'],
            ],
            { cols: '80px 1fr' },
          ),
        )}
        ${K.card('Because', 'Draft Yahoo Finance, started 7:24 pm by Claude app')}
        ${K.card('Checks Valet ran', 'Build, manifest, lint · live trial ok 7:36 pm · sandbox on')}
        ${K.card('Tests the agent wrote', '14 pass (Valet ran them) · fixtures recorded by Valet')}
        ${K.card('Also asked', `${K.check('Turn on "Get quote" for Claude app (from anywhere)', false)} ${K.check('Turn on "Get price history" for Claude app (from anywhere)', false)}`)}
        ${K.card("In Claude app's words", '<i class="muted">"You asked for stock prices. I based this on two published adapters but wrote my own; it only reads public quote pages."</i>')}
      </div></div>
      <div class="sticky-foot">${K.btn('Decline…')}<span class="grow"></span><span class="faint">Expires Fri 20 Nov, 7:38 pm</span>${K.primary('Approve with Touch ID')}</div>`,
      {
        badges: { needs: 2 },
        sites: [
          ['W', 'Woolworths', 'bad'],
          ['W', 'Wikipedia', 'ok'],
        ],
      },
    ),
    notes: [
      [
        900,
        750,
        'Touch ID on the Mac; a Mac without it uses the Mac account password in the system prompt (approval-cards.md section 6).',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-site-written-by',
    group: 'J3 · Add an adapter',
    title: 'Mac: the installed site says who wrote it and who approved it',
    personas: ['P3', 'P1'],
    desc: 'Step 12. Provenance on the Overview and on every version row.',
    html: shell(
      'sites',
      `${K.header({ crumbs: ['Sites'], title: 'Yahoo Finance', status: K.badge('Ready', 'ok'), sub: `1.0.0 · written by ${K.link('Claude app')} · approved with Face ID on ${K.link("Nick's iPhone")}, 19 Nov 7:41 pm`, tabs: K.tabs(['Overview', 'Tools', 'Permissions', 'Versions', 'Calls']) })}
      <div class="wf-scroll"><div class="grid2">
        ${K.card('Health', K.health('ok', 'Ready · last call 7:42 pm'))}
        ${K.card(
          'Remote agents',
          K.kv([
            ['Claude app', 'Get quote, Get price history'],
            ['Others', 'none'],
          ]),
        )}
        ${K.card('Versions', K.table(['Version', 'Written by', 'Approved'], [['1.0.0', 'Claude app', "Nick's iPhone · Face ID · 19 Nov 7:41 pm"]], { cols: '0.6fr 1fr 2fr' }))}
      </div></div>`,
      {
        badges: { needs: 1 },
        sites: [
          ['W', 'Woolworths', 'bad'],
          ['W', 'Wikipedia', 'ok'],
          ['Y', 'Yahoo Finance', 'ok'],
        ],
        site: 2,
      },
    ),
    notes: [
      [
        470,
        100,
        "Both names are links: the agent's page and the device's page (object model, information-architecture.md section 6).",
      ],
    ],
  })
})()
