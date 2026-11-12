// J5. Repair from chat: Woolworths changed its search page; Claude Code fixes it; Nick approves.
;(() => {
  const { K, P, shell, FRAMES } = window.WF
  const G = 'J5 · Repair from chat'
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO[G] =
    "Valet can't wake an agent, so a repair reaches the person, who hands it to an agent with one copied sentence. The agent fixes the adapter through Valet's tools; Valet's own reproduction check gates the submit; the person approves one card."
  const SITES = [
    ['W', 'Woolworths', 'bad'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const push = (f) => FRAMES.push({ group: G, size: 'phone', ...f })
  const sentence = 'Valet says Woolworths changed (repair R-4E1C). Please fix the adapter.'

  push({
    id: 'ph-notify-repair',
    title: 'Notification: Woolworths changed',
    personas: ['P8', 'P1'],
    desc: 'Step 1. Sent once, when the repair item opens (two failures in two sessions), not on every failed call.',
    html: P.lock(
      P.notif(
        'Woolworths changed: search is broken',
        'Ask Claude to fix it. Other Woolworths tools still work.',
        '7:12 pm',
      ),
      { clock: '7:12' },
    ),
    notes: [
      [
        40,
        255,
        "Active (not time-sensitive): there is no deadline. Never page text, only Valet's structured words.",
      ],
    ],
  })

  push({
    id: 'ph-needs-you-repair',
    title: 'The repair item, with a sentence to hand to an agent',
    personas: ['P8', 'P2', 'P9'],
    desc: 'Step 1. "Ask Claude to fix it…" opens this: the exact sentence, Copy and Share (to the Claude app or anywhere).',
    html: P.sheet(
      `<div class="ph-card"><div class="ph-kind"><span class="k">Repair</span><span>R-4E1C</span><span class="grow"></span><span>since 7:12 pm</span></div>
        <h2 class="ph-title">Woolworths changed: the adapter needs an update</h2>
        <div class="ph-asked">Raised by Valet · 7:12 pm</div>
        <div class="ph-risk caution"><b>Broken.</b><span>"Search products" fails since 6:58 pm. Other Woolworths tools still work.</span></div>
        <div class="ph-sec">Send this to Claude</div>
        <div class="ph-words" style="font-style:normal">${sentence}</div>
        <div class="row">${P.btn('Copy')}${P.btn('Share…', 'primary')}</div></div>
       ${P.group('What Valet saw', [
         P.row('Call 6B3E · 6:58 pm', 'Claude Desktop · failed: site changed'),
         P.row('Call 2A19 · 7:10 pm', 'Claude Code · failed: site changed'),
       ])}`,
      { title: 'Repair', back: 'Needs you' },
    ),
    notes: [
      [
        30,
        295,
        'The sentence names only the ref; the agent reads the structured ticket with valet_get_repair (never page text).',
      ],
      [
        200,
        325,
        'Share opens the iOS share sheet; from the phone that usually means the Claude app, which can do the repair as well as Claude Code. In the story Nick pasted it into Claude Code at the Mac at 7:14 pm, before leaving (R45).',
      ],
    ],
  })

  push({
    id: 'ph-card-update-repair',
    title: 'Update card for the repair, opened from Needs you',
    personas: ['P8', 'P4'],
    desc: 'Step 4. The J4 Update card (ph-card-update) plus the repair it closes: approving closes R-4E1C.',
    html: P.sheet(
      window.WF.updateCard({
        extra: P.banner(
          'ok',
          `<b>Approving closes repair R-4E1C.</b><span>Claude Code will see this the next time it checks Valet. A second agent\'s fix, if any, shows here as "2 fixes for R-4E1C" (R41).</span>`,
        ),
      }),
      { title: 'Needs you', right: '1 of 1', actions: P.approveBar() },
    ),
    notes: [
      [
        30,
        420,
        "The reproduction check is Valet's, on a fixture Valet's scratch browser recorded (never one the agent edited): the old version fails with the ticket's exact stage and class; the new one passes (R22).",
      ],
    ],
  })

  push({
    id: 'ph-card-login-moved',
    title: 'A repair that moves where the password is typed',
    personas: ['P3', 'P8', 'X1'],
    desc: 'F3. Strong. The login is not kept: the person chooses again (D47 re-bind only when nothing about the login changed).',
    html: P.sheet(
      window.WF.updateCard({
        title: 'Update Woolworths to 0.3.2',
        ref: '6C70',
        risk: ['strong', 'Your password.', 'Changes where your Woolworths password is typed.'],
        extra: '',
        ack: 'off',
        rows: [
          [
            'Moves',
            'strong',
            `Where your password is typed: /login → /signin on ${P.host('auth.', 'woolworths.com.au')}`,
          ],
          [
            'Login',
            'strong',
            `Choose again (where your password is typed changed) ${K.check('"Woolworths" · 1Password', false)}`,
          ],
          ['Same', 'same', 'Hosts, tools, sandbox'],
        ],
        checks: [
          '✓ Reproduction check: 0.3.1 fails on the new login page Valet recorded; 0.3.2 reaches the password step',
          '✓ Build, manifest, lint',
        ],
        tests: '25 tests the agent wrote pass (Valet ran them). Login not tried with your password yet.',
        words: 'Woolworths moved its sign-in page from /login to /signin.',
      }),
      {
        title: 'Needs you',
        actions: P.approveBar('Approve with Face ID', {
          note: 'Not sure? Decline and ask Claude to explain. Nothing changes until you approve.',
        }),
      },
    ),
    notes: [
      [
        30,
        255,
        'A moved secret fill is highlighted even when the origin is the same; it is exactly what an attack would look like.',
      ],
      [
        30,
        345,
        "Unticked by default. Without a login the update installs but Woolworths can't log in until one is chosen.",
      ],
    ],
  })

  push({
    id: 'ph-session-running',
    title: 'A signed-in session is running',
    personas: ['P8', 'P3'],
    desc: 'F2, after approving ph-card-session. Stays at the top of Needs you with its time left and End now.',
    html: P.screen(
      `${P.banner('bad', `<b>Claude Code is using your signed-in Woolworths</b><span>${K.countdown('24 min', '8:15 pm')} · 6 pages opened</span>${P.btn('End now', 'danger')}`)}
       ${P.group('Waiting', [P.item('↑', 'Update Woolworths to 0.3.1', 'Claude Code · this Mac · 7:31 pm · repair R-4E1C')])}`,
      { title: 'Needs you', right: '⋯', badge: 1, time: '7:51' },
    ),
    notes: [
      [
        40,
        135,
        'End now needs no Face ID (stricter). The session also ends at its deadline, on Lock down, and if the agent is revoked.',
      ],
    ],
  })

  push({
    id: 'ph-repair-blocked',
    title: 'Not a repair: the site is blocking',
    personas: ['P8', 'P9'],
    desc: "F5. Blocking is handled by Valet's pacing, not the adapter; there is no repair item. The site's health line says when calls resume.",
    html: P.screen(
      `${P.group('Woolworths', [
        P.row(
          `${K.dot('warn')} Woolworths is limiting requests`,
          'Calls resume at 7:52 pm · not a change to fix',
          '',
        ),
        P.row('Version 0.3.0', 'Approved Fri 6 Nov'),
        P.row('Pause Woolworths', '', '', 'act'),
      ])}
      <div class="muted" style="font-size:13px;padding:0 4px">An agent asking for a repair is told: "Woolworths is limiting or blocking Valet. That's not fixed in the adapter. Calls resume at 7:52 pm."</div>`,
      { title: 'Woolworths', back: 'Sites', large: false, tab: 'Sites', badge: 0 },
    ),
    notes: [[40, 115, '"Limited by site" is a warning, not a failure (v3, M32).']],
  })

  push({
    id: 'ph-repair-waiting',
    title: 'Nobody has fixed it yet',
    personas: ['P8', 'P2'],
    desc: 'D1. The repair item stays (no deadline). Only Search products is broken; the site shows which tool and what still works.',
    html: P.screen(
      `${P.group('Woolworths', [
        P.row(`${K.dot('bad')} Search is broken: site changed`, 'Since 6:58 pm · repair R-4E1C · no fix yet'),
        P.row('Ask Claude to fix it…', '', '', 'act'),
      ])}
      ${P.group('Tools', [
        P.row('Search products', 'Broken · calls fail with "site changed"', ''),
        P.row('Get cart', 'Works', ''),
        P.row('Update cart line', 'Works', ''),
        P.row('Remove from cart', 'Works', ''),
      ])}`,
      { title: 'Woolworths', back: 'Sites', large: false, tab: 'Sites', badge: 1, time: '9:30' },
    ),
    notes: [[40, 115, 'The same "Ask Claude to fix it…" sentence as ph-needs-you-repair.']],
  })

  FRAMES.push({
    id: 'mac-review-update-agent',
    group: G,
    title: "Mac: reviewing the repair, with Valet's reproduction check",
    personas: ['P1', 'P4', 'P3'],
    desc: 'D2. The card on top, then the reproduction runs side by side, then the v3 code diff. For a fix too big to judge on a phone.',
    html: shell(
      'sites',
      `${K.header({ crumbs: ['Sites', 'Woolworths', 'Versions'], title: 'Update Woolworths to 0.3.1', status: K.badge('Update · approval 2D9C', 'info'), sub: `Asked by ${K.link('Claude Code')} · 7:31 pm · this Mac · repairs ${K.link('R-4E1C')}` })}
      <div class="wf-scroll"><div class="col" style="max-width:860px">
        ${K.banner('idle', 'No new permissions.', 'Code and tests only.')}
        ${K.card('Because', `Repair ${K.link('R-4E1C')}: Search products is broken`)}
        ${K.card(
          'Reproduction check (Valet ran it, on a fixture Valet recorded)',
          K.table(
            ['Run', 'On the new fixture', 'Result'],
            [
              [
                '0.3.0 (live)',
                'search_products "milk"',
                K.badge('Fails: tool-output / invalid · same as R-4E1C', 'bad'),
              ],
              ['0.3.1 (this)', 'search_products "milk"', K.badge('Valid output · 24 products', 'ok')],
            ],
            { cols: '1fr 1.2fr 2fr' },
          ),
        )}
        ${K.card(
          'What changes',
          K.table(
            [],
            [
              ['Changes', '"Search products": how results are read (1 selector, price mapping)'],
              ['Same', 'Login: keeps 1Password item "Woolworths"'],
              ['Stays on', '"Search products" for Claude app'],
              ['Same', 'Hosts, other tools, sandbox'],
            ],
            { cols: '80px 1fr' },
          ),
        )}
        ${K.card('Tests the agent wrote', '23 pass (Valet ran them)')}
        ${K.card('Code', `<span class="muted">2 files · +14 −9</span> ${K.btn('See code changes')}`)}
        ${K.card("In Claude Code's words", '<i class="muted">"Woolworths moved the price into a new element. I changed one selector and the mapping for price."</i>')}
      </div></div>
      <div class="sticky-foot">${K.btn('Decline…')}<span class="grow"></span><span class="faint">Expires Fri 20 Nov, 7:31 pm</span>${K.primary('Approve with Touch ID')}</div>`,
      { badges: { needs: 2 }, sites: SITES, site: 0 },
    ),
    notes: [
      [
        470,
        200,
        "Only Valet's own runs; the agent's regression test is listed among the tests, not as the gate.",
      ],
      [900, 750, "Approving here answers the phone's card too."],
    ],
  })
})()
