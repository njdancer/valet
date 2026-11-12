// Other screens: the iPhone tabs and Valet settings, and the Mac's Agent and Relay pages.
// All at story.md's 7:40 pm unless a frame says otherwise.
;(() => {
  const { K, P, shell, FRAMES } = window.WF
  const G = 'Other screens · iPhone and Mac'
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO[G] =
    "The places the journeys pass through: the iPhone's Sites, Agents and Valet settings, and the Mac's Agent and Relay pages. The phone shows and stops; anything that loosens asks for Face ID, and approval settings stay on the Mac."
  const push = (f) => FRAMES.push({ group: G, ...f })
  const mono = (l) => `<span class="wf-av" style="flex:none">${l}</span>`

  push({
    id: 'ph-sites',
    size: 'phone',
    title: 'Sites',
    personas: ['P8', 'P1', 'P4'],
    desc: 'Health first, in words. Drafts are listed read-only: approving one is its card, in Needs you.',
    html: P.screen(
      `${P.group('Installed', [
        P.row(
          `${K.dot('bad')} <b>Woolworths</b> 0.3.0`,
          'Search products is failing: site changed · a fix is waiting for you',
        ),
        P.row(`${K.dot('ok')} <b>Wikipedia</b> 0.2.1`, 'Ready · no login'),
      ])}
       ${P.group(
         'Drafts',
         [
           P.row('<b>Yahoo Finance</b> 1.0.0', 'Claude app · submitted 7:38 pm · waiting for you'),
           P.row('<b>Woolworths</b> 0.3.1', 'Claude Code · submitted 7:31 pm · waiting for you'),
         ],
         'Agents write drafts on your Mac. Nothing in a draft runs for real until you approve it.',
       )}`,
      { tab: 'Sites', title: 'Sites' },
    ),
    notes: [
      [360, 170, "Same health sentence as the Mac and the agent's valet_status."],
      [360, 330, "A draft row opens its card if it's waiting, otherwise a read-only summary."],
    ],
  })

  push({
    id: 'ph-site',
    size: 'phone',
    title: 'Sites › Woolworths',
    personas: ['P8', 'P1', 'P3'],
    desc: 'One site: health, tools per agent, settings, login, versions with who wrote and who approved them, and Pause this site.',
    html: P.screen(
      `${P.banner('bad', '<b>Search products is failing: site changed.</b><span>Repair R-4E1C · "Update Woolworths to 0.3.1" is waiting for you.</span>')}
       ${P.group(
         'Tools for Claude app (remote)',
         [
           P.row('Search products', 'read', K.toggle(true)),
           P.row('Get cart', 'read · signed in', K.toggle(false)),
           P.row('Add to cart', 'changes your cart · off since 7:05 pm', K.toggle(false)),
         ],
         'Turning a tool on needs Face ID. Off is immediate.',
       )}
       ${P.group('Settings', [P.row('Store', 'Woolworths Town Hall'), P.row('Login', '1Password "Woolworths" · Keychain copy')])}
       ${P.group('Versions', [P.row('0.3.0 · live', 'Built in'), P.row('0.3.1 · draft', 'Written by Claude Code · waiting for you')])}
       ${P.group('', [P.row('Pause this site', '', '', 'act')])}`,
      { tab: 'Sites', title: 'Woolworths', back: 'Sites', large: false },
    ),
    notes: [
      [360, 120, 'Links to the repair and the waiting card.'],
      [
        360,
        260,
        "Per agent: a segmented picker above this list switches agent. Local agents' tools are on the Mac page; turning a local tool on is an Approve card too.",
      ],
      [
        360,
        525,
        'Store opens the same picker as "Choose your Woolworths store" (ph-card-store), Face ID or passcode. Login opens the Login card form.',
      ],
      [360, 700, 'Each version says who wrote it and, once live, who approved it, where and how.'],
    ],
  })

  const agentRow = (m, name, badge, sub) =>
    `<div class="ph-row">${mono(m)}<div class="grow"><b style="font-weight:600">${name}</b> ${P.pill(badge)}<small>${sub}</small></div><span class="chev">›</span></div>`

  push({
    id: 'ph-agents',
    size: 'phone',
    title: 'Agents',
    personas: ['P8', 'P3', 'X2'],
    desc: 'Every agent by the name Nick typed, its monogram and its badge. Revoke is two taps away from here (row, then Revoke).',
    html: P.screen(
      `${P.group('', [
        agentRow(
          'CC',
          'Claude Code',
          'This Mac',
          "Use tools · See Valet (all agents' activity) · Ask for changes · 1 waiting",
        ),
        agentRow(
          'CA',
          'Claude app',
          'Through the relay',
          'Use tools · See Valet (its own activity) · Ask for changes · 1 waiting',
        ),
        agentRow('CD', 'Claude Desktop', 'This Mac', 'Use tools · See Valet'),
      ])}
       ${P.group('', [P.row('Add an agent', 'Opens Valet to one new agent for 10 minutes')], 'Local agents are connected on the Mac. A remote agent starts from its own app and you type the code it shows.')}`,
      { tab: 'Agents', title: 'Agents' },
    ),
    notes: [
      [
        360,
        170,
        "The badge is Valet's, not the agent's claim. What a remote agent calls itself is in its Details only.",
      ],
      [360, 400, 'Add an agent is a loosening: Face ID. Without it the relay refuses new agents (R44).'],
    ],
  })

  push({
    id: 'ph-secrets',
    size: 'phone',
    title: 'Valet › Secrets',
    personas: ['P8', 'P3', 'P1'],
    desc: 'Which logins Valet may use and what uses them. Values are never shown. Remove is allowed here (stricter); adding or changing one is a Login card.',
    html: P.screen(
      `${P.group(
        'Logins',
        [
          P.row(
            '<b>Woolworths</b>',
            '1Password item "Woolworths" · Keychain copy · used by Woolworths 0.3.0 · last used 6:58 pm',
            '<span class="ph-btn plain" style="flex:none;color:var(--wf-bad)">Remove</span>',
          ),
        ],
        'Valet types a login only on the origin its adapter declared. Adapter code never sees it.',
      )}
       ${P.group('1Password', [P.row("Access granted on Nick's MacBook Pro", '12 Nov 8:10 pm · change it on the Mac', '')])}`,
      { tab: 'Valet', title: 'Secrets', back: 'Valet', badge: 2 },
    ),
    notes: [
      [
        360,
        190,
        'Remove deletes the Keychain copy, not the 1Password item. Calls that need it then ask for a Login card.',
      ],
      [360, 330, 'Granting 1Password is a Mac-only setup step (J1).'],
    ],
  })

  push({
    id: 'ph-settings-notifications',
    size: 'phone',
    title: 'Valet › Notifications',
    personas: ['P8', 'P2', 'P5'],
    desc: "What interrupts and how. Every notification is Valet's own words plus a site's domain, with no actions on it (security model, Notifications).",
    html: P.screen(
      `${P.group(
        'Notify me about',
        [
          P.row('Requests that need me', 'Time sensitive', K.toggle(true)),
          P.row('Logins that need me', 'Time sensitive · a code or a check', K.toggle(true)),
          P.row('Changes agents made', 'Notify-only changes, in one summary an hour', K.toggle(true)),
          P.row('My Mac is offline', 'After 10 minutes', K.toggle(true)),
        ],
        'Turning one off is immediate. Turning one back on needs Face ID.',
      )}
       ${P.group('This iPhone', [P.row('Require Face ID to open Valet', '', K.toggle(true))], 'Turning it off needs Face ID.')}
       ${P.group('', [P.row('Approval settings', 'Only on your Mac: Settings, Approvals', '')])}`,
      { tab: 'Valet', title: 'Notifications', back: 'Valet', badge: 2 },
    ),
    notes: [
      [
        360,
        170,
        'One notification per request; a follow-on rides on its parent (approval-cards.md section 10).',
      ],
      [
        360,
        300,
        'Turning notifications back on counts as a loosening because a silent phone is safer for nobody; assumption, for H.',
      ],
      [360, 520, "Tiers and gestures stay a Mac setting, so a stolen unlocked phone can't relax them."],
    ],
  })

  // ---------- Mac ----------
  push({
    id: 'mac-agent-page',
    title: 'Mac: Connections › Agents › Claude app',
    personas: ['P1', 'P3', 'X2'],
    desc: 'One agent on the Mac: the name Nick typed, its badge, what it can do, its remote tools, what it asked for and changed, and what it claims to be (Details only).',
    html: shell(
      'connections',
      `${K.header({ crumbs: ['Connections', 'Agents'], title: `${K.avatar('CA')} Claude app`, sub: 'Through the relay · connected 12 Nov 8:31 pm', actions: K.dangerSoft('Revoke…') })}
      <div class="wf-scroll"><div class="col" style="max-width:820px">
        ${K.card('Can', `<div class="col" style="gap:8px">${K.check('Use tools', true)}${K.check('See Valet: its own activity', true)}${K.check('Ask for changes (off by default for remote agents; you turned it on)', true)}</div>`)}
        ${K.card(
          'Remote tools',
          K.table(
            ['Site', 'Tool', 'Kind', 'On'],
            [
              ['Wikipedia', 'Search articles, Get summary, Get article', 'read', K.toggle(true)],
              ['Woolworths', 'Search products', 'read', K.toggle(true)],
              ['Woolworths', 'Get cart', 'read · signed in', K.toggle(false)],
              ['Woolworths', 'Add to cart', 'changes your cart', K.toggle(false)],
            ],
            { cols: '1fr 2.2fr 1fr auto' },
          ),
        )}
        ${K.card('Waiting for you', `${K.link('Install "Yahoo Finance" for yahoo.com')} · 7:38 pm · with 2 tools asked`)}
        ${K.card('Recent changes', '<div class="col" style="gap:4px"><span>7:24 pm · Started a draft: Yahoo Finance · notify only</span><span>7:05 pm · Turned off "Add to cart" for itself · notify only · Undo needs Touch ID</span></div>')}
        ${K.card(
          'Details',
          K.kv([
            ['Calls itself', 'Claude (claude.ai)'],
            ['Goes back to', 'claude.ai'],
            ['Limits', '3 waiting, 10 notify-only changes an hour'],
          ]),
        )}
      </div></div>`,
      { badges: { needs: 2 } },
    ),
    notes: [
      [500, 90, 'The title is the name Nick typed at connect; the monogram and badge match the phone.'],
      [900, 180, 'Turning a capability or a tool on needs Touch ID; off is immediate.'],
      [
        900,
        590,
        "The agent's claimed identity is here only, never on a card, so it can't pass as another agent.",
      ],
    ],
  })

  push({
    id: 'mac-relay',
    title: 'Mac: Connections › Relay',
    personas: ['P1', 'P3', 'P8'],
    desc: 'Relay replaces Remote access: whether it is up, whether new agents may connect, any lock the relay holds, and the recovery code.',
    html: shell(
      'connections',
      `${K.header({ title: 'Connections', tabs: K.tabs(['Agents', 'Devices', 'Relay'], 2) })}
      <div class="wf-scroll"><div class="col" style="max-width:760px">
        ${K.card(
          'Relay',
          K.kv([
            ['Status', `${K.dot('ok')} Connected since 7:02 am`],
            ['Address', K.value('relay.valet.example/m/7Q…')],
            ['Remote agents', '1 · Claude app'],
            ['Paired devices', "1 · Nick's iPhone"],
          ]),
        )}
        ${K.card('New agents', `<div class="col" style="gap:6px"><span>Off. "Add an agent" opens Valet to one new agent for 10 minutes.</span>${K.btn('Add an agent…')}</div>`)}
        ${K.card('Lock at the relay', '<span>None. A lock sent from your iPhone or the recovery page shows here, with when and from where.</span>')}
        ${K.card('Recovery code', `<div class="col" style="gap:6px"><span>Made 12 Nov 8:07 pm, when you paired Nick's iPhone. Never used.</span><span class="faint">It can only lock Valet down at the relay and remove devices. A new code replaces the old one at once.</span>${K.btn('Make a new recovery code… (Touch ID)')}</div>`)}
      </div></div>`,
      { badges: { needs: 2 } },
    ),
    notes: [
      [700, 150, 'Status says when it was last checked; Details opens the relay log.'],
      [700, 330, 'Add an agent needs Touch ID, as on the phone.'],
      [700, 520, 'Workstream B to confirm what the relay stores for the code (a verifier only).'],
    ],
  })
})()
