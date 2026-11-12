// J4. Approve on the phone: every card kind and state (approval-cards.md), and the Mac's versions.
;(() => {
  const { K, P, shell, sheet, FRAMES } = window.WF
  const G = 'J4 · Cards on the phone and Mac'
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO[G] =
    "The card spec walked kind by kind. Every card has the same anatomy in the same order on both devices: kind strip, title, asked by, risk line, pinned buttons, then what changes, checks, follow-ons, the agent's words and details."
  const SITES = [
    ['W', 'Woolworths', 'bad'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const bar = (o) => P.approveBar('Approve with Face ID', o)
  const push = (f) => FRAMES.push({ group: G, size: 'phone', ...f })

  const updateCard = (over = {}) =>
    P.card({
      kind: 'Update',
      ref: '2D9C',
      age: '9 min ago',
      title: 'Update Woolworths to 0.3.1',
      asked: 'Asked by <b>Claude Code</b> · 7:31 pm',
      where: 'This Mac',
      risk: ['', 'Code only.', 'No new permissions. Code and tests only.'],
      rows: [
        ['Changes', 'add', '"Search products": how results are read'],
        [
          'Same',
          'same',
          'Login: keeps 1Password item "Woolworths" (nothing about where it\'s typed changed)',
        ],
        ['Stays on', 'same', '"Search products" for Claude app'],
        ['Same', 'same', 'Hosts, other tools, sandbox'],
      ],
      because: ['same', `Repair ${K.link('R-4E1C')}: Search products is broken`],
      checks: [
        '✓ Reproduction check: 0.3.0 fails the same way on a fixture Valet recorded; 0.3.1 works',
        '✓ Build, manifest, lint',
      ],
      tests: '23 tests the agent wrote pass (Valet ran them).',
      words:
        'Woolworths moved the price into a new element. I changed one selector and the mapping for price.',
      agent: 'Claude Code',
      footer:
        "Expires Fri 20 Nov, 7:31 pm if nobody answers. Only you can approve this. Claude can't approve its own requests.",
      ...over,
    })
  window.WF.updateCard = updateCard

  // ---------- notification ----------
  push({
    id: 'ph-lock-notification',
    title: 'Lock screen: the notification, long-pressed',
    personas: ['P8', 'P2', 'X2'],
    desc: "Step 1. Valet's own wording plus the site's domain; never a tool title, the agent's words or page text (security model, Notifications). No action buttons: a tap opens Valet, which asks for Face ID to open.",
    html: P.lock(
      P.notif('Install an adapter for yahoo.com', 'Asked by Claude app', '7:38 pm') +
        `<div style="font-size:13px;color:var(--wf-ink-2);text-align:center">Tap to open in Valet · no actions here</div>`,
      { clock: '7:38' },
    ),
    notes: [
      [
        40,
        255,
        'The relay only ever sees "Valet needs you"; the real title is decrypted on the phone by the notification extension, and that generic text is what shows if it fails (R38).',
      ],
      [
        40,
        345,
        "No actions at all: no Approve, no Decline, no Undo (R7, R37). Decline lives on the card, so a locked phone can't pause an agent.",
      ],
    ],
  })

  // ---------- inbox ----------
  push({
    id: 'ph-needs-you',
    title: 'Needs you on the phone, two waiting',
    personas: ['P8', 'P1', 'P5'],
    desc: 'The same items and titles as the Mac, sorted the same way. The follow-on is folded into the install, so two items, badge 2.',
    html: P.screen(
      `${P.banner('info', `<span>${K.dot('ok')} <b>Nick's MacBook Pro</b> · online since 7:02 am</span>`)}
       ${P.group('Waiting', [
         P.item(
           '↓',
           'Install "Yahoo Finance" for yahoo.com',
           'Claude app · relay · 7:38 pm · + 2 tools asked',
         ),
         P.item('↑', 'Update Woolworths to 0.3.1', 'Claude Code · this Mac · 7:31 pm · repair R-4E1C'),
       ])}
       ${P.group('Earlier today', [P.row('Claude app made 1 change', '7:05 pm · turned off "Add to cart" for itself · Undo in Activity')])}`,
      { title: 'Needs you', right: '⋯' },
    ),
    notes: [
      [
        40,
        135,
        "The Mac's status line is status, not a button; Details is in the ⋯ menu with Pause Valet and Lock down.",
      ],
      [
        40,
        230,
        'Follow-ons show as "+ 2 tools asked", not as their own row; they are unticked on the card (approval-cards.md section 8).',
      ],
      [330, 65, '⋯ menu: Pause Valet, Lock down…, Notification settings.'],
    ],
  })

  push({
    id: 'ph-needs-you-flood',
    title: 'An agent paused after three declines (X2)',
    personas: ['P8', 'P3', 'X2'],
    desc: 'F5. One row about the agent, not three more cards. Revoke is right here.',
    html: P.screen(
      `${P.banner('bad', "<b>Claude app asked for 3 changes you declined.</b><span>It can't ask for more until 8:40 pm. This is the second time today.</span>" + P.btn('Revoke Claude app?', 'danger'))}
       ${P.group('Waiting', [P.item('↑', 'Update Woolworths to 0.3.1', 'Claude Code · this Mac · 7:31 pm · repair R-4E1C')])}
       ${P.group('Declined in the last hour ("Decline and stop asking")', [
         P.row('Let Claude app use your signed-in Woolworths', '7:33 pm'),
         P.row('Keep traces for 90 days instead of 14', '7:35 pm'),
         P.row('Turn on "Add to cart" for Claude app', '7:36 pm'),
       ])}`,
      { title: 'Needs you', right: '⋯', badge: 1 },
    ),
    notes: [
      [
        40,
        135,
        "Limits: 3 waiting per agent, 5 overall, 20 a day; 3 declines in an hour pause it. Declines with a note don't count. A second pause in a day suggests Revoke (R31). (A moment other than story.md's 7:40 pm.)",
      ],
      [40, 210, 'Revoke opens the confirm dialog (J7). No Face ID: it only makes Valet stricter.'],
    ],
  })

  push({
    id: 'ph-needs-you-empty',
    title: 'Nothing needs you',
    personas: ['P8', 'P2'],
    desc: 'The empty state carries the system status, as on the Mac (v3 decision).',
    html: P.screen(
      `<div style="text-align:center;padding:30px 0 6px"><div style="font:600 20px var(--f-head)">Nothing needs you</div><div class="muted" style="font-size:14px">Your agents will ask here before changing anything.</div></div>
       ${P.group("Nick's MacBook Pro", [
         P.row(`${K.dot('ok')} Online · since 7:02 am`, 'Valet 0.9.0 · relay ok', ''),
         P.row(`${K.dot('ok')} Woolworths`, 'Ready', ''),
         P.row(`${K.dot('ok')} Wikipedia`, 'Ready', ''),
         P.row(`${K.dot('ok')} Yahoo Finance`, 'Ready', ''),
       ])}
       ${P.group('', [P.row('Audit log verified 7:30 pm', 'See it on your Mac', '')])}`,
      { title: 'Needs you', right: '⋯', badge: 0 },
    ),
    notes: [[40, 295, 'Each line says when it was checked (v3 principle 8).']],
  })

  // ---------- kinds ----------
  push({
    id: 'ph-card-update',
    title: 'Update card (a repair)',
    personas: ['P8', 'P1', 'P4'],
    desc: 'J5 step 4. No new permissions, so neutral; the login row says why it is kept (D47).',
    html: P.sheet(updateCard(), { title: 'Needs you', right: '2 of 2', actions: bar() }),
    notes: [
      [30, 265, 'Neutral tone. "Unchanged" rows make "nothing new" visible rather than empty.'],
      [30, 395, 'Login kept only when everything that decides where it is typed is byte-identical.'],
    ],
  })

  push({
    id: 'ph-card-restore',
    title: 'Restore card: go back to an earlier version',
    personas: ['P8', 'P1'],
    desc: 'After a bad update. A restore is an approval like any other version, because grants are per version.',
    html: P.sheet(
      P.card({
        kind: 'Restore',
        ref: '3E44',
        age: 'just now',
        title: 'Go back to Woolworths 0.3.0',
        asked: 'Asked by <b>Claude Code</b> · 8:12 pm',
        where: 'This Mac',
        risk: ['', 'Nothing new.', 'Back to the version you approved on 6 Nov. Nothing new.'],
        rows: [
          ['Removes', 'rem', 'The 0.3.1 change to "Search products"'],
          ['Same', 'same', 'Login, hosts, tools'],
        ],
        checks: ['✓ 0.3.0 is the version approved on Fri 6 Nov, 8:12 pm (hash 9f3c…e0f1)'],
        words: '0.3.1 broke adding to cart. Going back while I look.',
        agent: 'Claude Code',
        detailRows: ['Compare 0.3.1 and 0.3.0', 'Fingerprint and request'],
      }),
      { title: 'Needs you', actions: bar() },
    ),
    notes: [
      [
        30,
        265,
        'If the older version widens anything compared with the current one, the full form (caution or strong) is used instead.',
      ],
    ],
  })

  const loginCard = (resync) =>
    P.card({
      kind: 'Login',
      ref: resync ? '6F18' : '4A90',
      age: 'just now',
      title: resync ? 'Re-sync your Woolworths password from 1Password' : 'Let Woolworths use your login',
      asked: resync ? 'Raised by Valet · 7:52 pm' : 'Asked by <b>Claude Code</b> · 8:10 pm',
      where: 'This Mac',
      risk: resync
        ? [
            '',
            'Same item.',
            'Valet reads the item "Woolworths" again and replaces its Keychain copy. Where it\'s typed doesn\'t change.',
          ]
        : [
            'caution',
            'Your password.',
            'Woolworths 0.3.2 may type your password, only on auth.woolworths.com.au.',
          ],
      extra: resync
        ? P.banner('', "Woolworths didn't accept the saved password at 7:51 pm.")
        : `<div class="ph-sec">Which login</div>${P.group('', [
            P.row(`${K.radio('', true)} "Woolworths"`, '1Password · Personal vault · nick@…', ''),
            P.row(`${K.radio('', false)} Choose another item…`, '', '<span class="chev">›</span>'),
          ])}`,
      rows: [
        [
          'Uses',
          'add',
          `1Password item "Woolworths" · typed only on ${P.host('auth.', 'woolworths.com.au')}`,
        ],
        ['Same', 'same', 'Claude never sees it; only Valet types it'],
      ],
      details: true,
      detailRows: ['Tools that can cause a login', 'Fingerprint and request'],
    })
  push({
    id: 'ph-card-login',
    title: 'Login card: choose the 1Password item on the card',
    personas: ['P8', 'P2', 'P3'],
    desc: 'Another moment (8:10 pm): Woolworths 0.3.2 changed its login and needs the login given again. The picker is part of the payload: the approval signs the item chosen. Face ID only.',
    html: P.sheet(loginCard(false), { title: 'Needs you', actions: bar() }),
    notes: [
      [30, 260, 'Caution: a password is involved. Strong only if it is typed on a new or moved origin.'],
      [30, 345, 'Item names come from 1Password; the password never reaches the phone.'],
    ],
  })
  push({
    id: 'ph-card-login-resync',
    title: 'Login card, re-sync form (J6)',
    personas: ['P8', 'P7'],
    desc: 'The password stopped working; the person approves Valet re-reading the same 1Password item (D6). Raised by Valet, not an agent.',
    html: P.sheet(loginCard(true), { title: 'Needs you', actions: bar() }),
    notes: [[30, 215, '"Raised by Valet": no agent asked for this, so there is no agent\'s words section.']],
  })

  push({
    id: 'ph-card-remote-tool',
    title: 'Remote tool card',
    personas: ['P8', 'P9'],
    desc: 'J8a. A read tool for a remote agent: neutral. Write tools get caution and their own card each.',
    html: P.sheet(
      P.card({
        kind: 'Remote',
        ref: '9D02',
        age: 'just now',
        title: 'Turn on "Search symbols" for Claude app',
        asked: 'Asked by <b>Claude app</b> · 8:02 pm',
        risk: ['caution', 'From anywhere.', 'Claude app could use it from anywhere. It only reads.'],
        rows: [['Turns on', 'add', '"Search symbols" (Yahoo Finance) · read · for Claude app only']],
        because: ['same', 'Follows Install "Yahoo Finance" for yahoo.com (approved 7:41 pm)'],
        words: 'So I can look up tickers when you give me a company name.',
        detailRows: ['Tools Claude app already has', 'Fingerprint and request'],
      }),
      { title: 'Needs you', actions: bar() },
    ),
    notes: [
      [
        30,
        260,
        'A read tool: Face ID or "Use passcode instead". A write tool needs Face ID itself; an irreversible tool adds "Each use will still need a Confirm on your phone or Mac." Agents can only ask for their own tools.',
      ],
    ],
  })

  push({
    id: 'ph-card-setting',
    title: 'Setting card: a setting that shortens evidence',
    personas: ['P8', 'P3', 'P9'],
    desc: 'J8 F1. The agent tried to set it directly; Valet turned it into this card. Anything that deletes or shortens evidence is a card, even though it looks "stricter" (R6).',
    html: P.sheet(
      P.card({
        kind: 'Setting',
        ref: '1B77',
        age: 'just now',
        title: 'Keep traces for 3 days instead of 14',
        asked: 'Asked by <b>Claude Code</b> · 8:06 pm',
        where: 'This Mac',
        risk: [
          'caution',
          'Deletes records.',
          "Traces older than 3 days are deleted now, including today's failed calls.",
        ],
        rows: [
          ['Changes', 'add', 'Trace retention: 14 days → 3 days'],
          ['Same', 'same', 'Audit log (only you, at the Mac, can shorten it)'],
        ],
        because: ['add', 'Not linked to anything Valet knows about'],
        words: 'Traces take a lot of space.',
        agent: 'Claude Code',
        detailRows: ['What traces contain', 'Fingerprint and request'],
      }),
      { title: 'Needs you', actions: bar() },
    ),
    notes: [
      [30, 255, 'The risk line is a plain sentence of what is now allowed, written per setting by Valet.'],
    ],
  })

  push({
    id: 'ph-card-session',
    title: 'Signed-in session card (D81)',
    personas: ['P8', 'P3', 'P4', 'X1'],
    desc: 'J5 F2. Strong: the agent would act as the person on the site. Per session, time-boxed, ended any time.',
    html: P.sheet(
      P.card({
        kind: 'Session',
        ref: '5E31',
        age: 'just now',
        title: 'Let Claude Code use your signed-in Woolworths',
        asked: 'Asked by <b>Claude Code</b> · 7:45 pm',
        where: 'This Mac',
        risk: ['strong', 'Acts as you.', 'Claude Code can act as you on woolworths.com.au until 8:15 pm.'],
        because: ['same', `Repair ${K.link('R-4E1C')}`],
        ack: 'on',
        extra: `<div class="ph-sec">For how long</div><div>${K.seg(['15 min', '30 min', '60 min'], 1)}</div>`,
        rows: [
          ['Opens', 'strong', 'Your signed-in Woolworths to Claude Code for 30 minutes'],
          ['Same', 'same', 'Valet still never shows Claude your password'],
          ['Same', 'same', 'Irreversible tools stay off in this session'],
        ],
        words:
          'The cart page changed and only shows when signed in. I need to look at it to fix update_cart_line.',
        agent: 'Claude Code',
        details: false,
      }),
      {
        title: 'Needs you',
        actions: bar({
          note: 'Not sure? Decline and ask Claude to explain. Nothing changes until you approve.',
        }),
      },
    ),
    notes: [
      [30, 260, 'Strong tone, with its own word, not just colour.'],
      [30, 345, 'Length is part of the signed payload; changing it re-renders the risk line.'],
    ],
  })

  push({
    id: 'ph-card-confirm',
    title: 'Confirm card: an irreversible checkout',
    personas: ['P8', 'P2', 'P5', 'X2'],
    desc: 'Another moment (story.md, J4). Approve each use (D46). Face ID only. The cart, store, total and payment are part of the signed payload; Valet re-reads them just before ordering and refuses if anything changed (R20).',
    html: P.sheet(
      P.card({
        kind: 'Confirm',
        ref: '7F90',
        age: K.countdown('2 min', '7:52 pm'),
        title: 'Confirm: Check out (Woolworths)',
        asked: 'Asked by <b>Claude app</b> · 7:50 pm · call 3D41',
        risk: [
          'strong',
          "Can't be undone.",
          "Orders 17 items for $84.20 from Woolworths Town Hall. This can't be undone.",
        ],
        ack: 'on',
        rows: [
          ['Store', 'same', 'Woolworths Town Hall · pick up Fri 20 Nov, 10–11 am'],
          ['Total', 'same', '$84.20 · 17 items'],
          ['Pays', 'strong', 'With the card saved in your Woolworths account'],
        ],
        extra: `<div class="ph-sec">From the site</div><div class="ph-words" style="font-style:normal">Trolley: Bananas 1 kg, Milk 2 L, … (17 items)</div>`,
        details: false,
        footer:
          "At 7:52 pm nothing is ordered. If your trolley changes after you confirm, nothing is ordered and you're told.",
      }),
      {
        title: 'Needs you',
        actions: `<div class="row">${P.btn('Decline')}<span class="ph-btn primary" style="flex:1.8">Check out with Face ID</span></div>`,
      },
    ),
    notes: [
      [
        30,
        260,
        'The site\'s own text (items) appears only under "From the site", never in the title or risk line.',
      ],
      [200, 745, 'Button names the tool ("Check out"), as on the Mac\'s confirmation window. Face ID only.'],
    ],
  })

  push({
    id: 'ph-card-strong',
    title: 'Strong card: a local data exception',
    personas: ['P3', 'P8', 'X1'],
    desc: 'An adapter that reads local data through a declared sandbox exception (D73). The strongest fact wins the risk line.',
    html: P.sheet(
      P.card({
        kind: 'Install',
        ref: '0C5A',
        age: 'just now',
        title: 'Install "Receipts" for this Mac only',
        asked: 'Asked by <b>Claude Code</b> · 8:20 pm',
        where: 'This Mac',
        risk: ['strong', 'Your files.', 'Can read ~/Documents/Receipts/ on your Mac.'],
        rows: [
          [
            'Adds',
            'strong',
            'Read access to <span class="ph-host">~/Documents/Receipts/</span> (sandbox exception)',
          ],
          ['Adds', 'add', '2 tools: List receipts, Read receipt · read'],
          ['Same', 'same', 'No hosts · sandbox on except the folder above'],
        ],
        checks: ['✓ Sandbox: only the declared folder is reachable', '✓ Build, manifest, lint'],
        tests: '9 tests the agent wrote pass (Valet ran them).',
        ack: 'off',
        words: 'You asked me to total your grocery receipts.',
        agent: 'Claude Code',
      }),
      {
        title: 'Needs you',
        actions: bar({
          note: 'Not sure? Decline and ask Claude to explain. Nothing changes until you approve.',
        }),
      },
    ),
    notes: [
      [
        30,
        255,
        'If an adapter runs without the sandbox, the line is "Runs without the sandbox: it can reach anything you can on this Mac."',
      ],
    ],
  })

  push({
    id: 'ph-card-waits',
    title: 'Waits for another request',
    personas: ['P8', 'P9'],
    desc: 'F7 / J3 D1. A Login for an adapter not yet installed: a separate card that waits. Approve is off; the link goes to the one it waits for.',
    html: P.sheet(
      P.card({
        kind: 'Login',
        ref: '9E11',
        age: 'just now',
        title: 'Let "Gumleaf" use your login',
        asked: 'Asked by <b>Claude Code</b> · 8:30 pm',
        where: 'This Mac',
        extra: P.banner(
          'info',
          `<b>Waits for: ${K.link('Install "Gumleaf" for gumleaf.example')}</b><span>It can't be approved before the adapter is installed.</span>`,
        ),
        risk: ['caution', 'Your password.', 'Gumleaf may type your password, only on login.gumleaf.example.'],
        rows: [['Uses', 'add', '1Password item "Gumleaf"']],
        checks: ['Login not tried yet: Valet tries it after you approve, and asks you if it fails.'],
        details: false,
      }),
      { title: 'Needs you', actions: bar({ off: true }) },
    ),
    notes: [[30, 255, 'If the request it waits for is declined, this one is declined too, and says why.']],
  })

  push({
    id: 'ph-card-answered-elsewhere',
    title: 'Answered on the Mac first',
    personas: ['P8', 'P1'],
    desc: 'F2. The card turns into its answer everywhere; no buttons.',
    html: P.sheet(
      `${P.state('ok', "<span>✓</span><div><b>Approved with Touch ID on Nick's MacBook Pro at 7:41 pm</b><br>Woolworths 0.3.1 is live. Claude Code will see this the next time it checks Valet.</div>")}
       ${updateCard({ age: 'answered' })}`,
      { title: 'Update Woolworths to 0.3.1', back: 'Needs you' },
    ),
    notes: [[30, 85, 'The notification on this phone is replaced by the same "Approved on …" line.']],
  })

  push({
    id: 'ph-card-not-used',
    title: "Your approval wasn't used",
    personas: ['P8', 'P1', 'P3'],
    desc: 'J4 F3, another moment: Nick declined on the Mac at the same time as approving on the phone. The first answer the Mac receives wins; the other device says so (R29).',
    html: P.sheet(
      `${P.state('warn', '<span>!</span><div><b>Declined on Nick\'s MacBook Pro first.</b><br>Your approval wasn\'t used, so nothing changed. Claude Code will see "declined" the next time it checks Valet.</div>')}
       ${updateCard({ age: 'answered' })}`,
      { title: 'Update Woolworths to 0.3.1', back: 'Needs you' },
    ),
    notes: [
      [
        30,
        100,
        'The audit log keeps both answers, with the one that was used marked. A late approval can never revive a declined request.',
      ],
    ],
  })

  push({
    id: 'ph-card-expired',
    title: 'Expired: nobody answered in 24 hours',
    personas: ['P8', 'P9', 'P7'],
    desc: 'J3 F8, another moment (Fri 20 Nov, 7:31 pm). Adapter kinds expire after 24 hours; Confirm and Connect at their own deadline. Nothing changed, and the card says so.',
    html: P.sheet(
      `${P.state('', '<span>◷</span><div><b>Nobody answered by Fri 20 Nov, 7:31 pm, so nothing changed.</b><br>Woolworths stays at 0.3.0. Ask Claude Code to send it again if you still want it.</div>')}
       ${updateCard({ age: 'expired' })}`,
      { title: 'Update Woolworths to 0.3.1', back: 'Needs you', time: '7:32' },
    ),
    notes: [
      [
        30,
        100,
        'The agent\'s tool result: "Expired: nobody answered approval 2D9C in 24 hours, so nothing changed. Ask the person before asking again." No reminder notification before expiry beyond the one at the start.',
      ],
    ],
  })

  push({
    id: 'ph-card-private-network',
    title: 'Private network card',
    personas: ['P8', 'P4', 'X1'],
    desc: "J3 F9, another moment. The scratch browser and live trials never reach the home network on their own (docs/relay.md rules). An agent that needs a printer's page has to ask, and the card is strong.",
    html: P.sheet(
      P.card({
        kind: 'Private network',
        ref: '4C18',
        age: 'just now',
        title: "Let Claude Code's scratch browser reach 192.168.1.20",
        asked: 'Asked by <b>Claude Code</b> · 8:40 pm',
        where: 'This Mac',
        risk: ['strong', 'Check this.', 'Can open 192.168.1.20 on your home network.'],
        rows: [
          ['Adds', 'add', 'Scratch browser may open http://192.168.1.20 (port 80 only)'],
          ['For', 'same', 'Draft "Brother printer" · until the draft is approved or deleted'],
          ['Same', 'same', 'No other home-network addresses, no .local names'],
        ],
        because: ['strong', 'Draft Brother printer, started 8:31 pm'],
        words: "The printer's status page is on your home network. I need it to read the ink levels.",
        agent: 'Claude Code',
        ack: 'off',
      }),
      {
        title: 'Needs you',
        actions: bar({
          off: true,
          note: 'Not sure? Decline and ask Claude to explain. Nothing changes until you approve.',
        }),
      },
    ),
    notes: [
      [
        30,
        260,
        'Strong tone, Face ID only. The address is shown in full, never as a device name the agent supplied.',
      ],
      [
        30,
        350,
        'Scoped to one address and port and to one draft; it ends with the draft. A finished adapter that needs it declares the host and goes through Install.',
      ],
      [200, 760, 'Approve stays off until "I\'ve read what this does" is ticked, as on every strong card.'],
    ],
  })

  push({
    id: 'ph-card-passcode',
    title: 'Face ID failed twice: passcode',
    personas: ['P8', 'P5'],
    desc: 'F1. On a neutral card only (this update adds no permissions), "Use passcode instead" is offered after Face ID fails. Recorded as iphone:passcode. Never on cards that widen access, connect, or spend.',
    html: P.sheet(updateCard(), {
      title: 'Needs you',
      actions: P.approveBar('Use passcode instead', {
        note: "Face ID didn't recognise you twice. This card adds no permissions, so your passcode works.",
      }),
    }),
    notes: [
      [
        200,
        725,
        'The button is available to everyone on neutral cards; there is no automatic VoiceOver route, since anyone can turn VoiceOver on (R2). Elsewhere: "Face ID didn\'t work. Try again, or approve on your Mac."',
      ],
    ],
  })

  push({
    id: 'ph-unpaired',
    title: 'This iPhone was removed from Valet',
    personas: ['P8', 'P3', 'X2'],
    desc: 'F4. After Remove on the Mac (lost phone, J7). Any approval from it is refused; the app says so and offers to pair again.',
    html: P.screen(
      `${P.state('bad', "<span>✕</span><div><b>This iPhone isn't paired with Nick's MacBook Pro any more.</b><br>It was removed on the Mac on Thu 19 Nov at 9:10 pm. Approvals from it are refused.</div>")}
       ${P.btn('Pair again', 'primary')}
       <div class="muted" style="font-size:13px">Pairing starts on the Mac: Connections, Devices, Pair a device.</div>`,
      { title: 'Valet', tab: 'Needs you', badge: 0, time: '9:12' },
    ),
    notes: [[40, 135, 'Everything cached on the phone (cards, activity) is deleted at the same moment.']],
  })

  // ---------- Mac ----------
  const macNeeds = (toast = '') => `
    ${K.header({ title: 'Needs you', status: '<span class="muted">2 waiting</span>' })}
    <div class="wf-scroll"><div class="col">
      ${K.inbox('↓', 'Install "Yahoo Finance" for yahoo.com', `Asked by ${K.link('Claude app')} · through the relay · 7:38 pm · approval ${K.link('7B3F')} · + 2 tools asked`, '', K.btn('Decline…') + K.primary('Review'))}
      ${K.inbox('↑', 'Update Woolworths to 0.3.1', `Asked by ${K.link('Claude Code')} · this Mac · 7:31 pm · repair ${K.link('R-4E1C')} · no new permissions`, '', K.btn('Decline…') + K.btn('Review update'))}
    </div></div>${toast}`
  FRAMES.push({
    id: 'mac-needs-you-agent',
    group: G,
    title: 'Mac: Needs you with requests from agents',
    personas: ['P1', 'P3', 'P5'],
    desc: 'Adapter kinds open the Review page with the card on top; other kinds open a card sheet over Needs you. Same titles as the phone.',
    html: shell('needs', macNeeds(), { badges: { needs: 2 }, sites: SITES }),
    notes: [
      [470, 140, "Asked-by uses the person-given name, as a link to the agent's page."],
      [1030, 140, 'Decline opens a small sheet with the optional note to the agent.'],
    ],
  })
  FRAMES.push({
    id: 'mac-needs-you-answered',
    group: G,
    title: 'Mac: answered on the iPhone',
    personas: ['P1', 'P7'],
    desc: 'The item leaves Needs you with a toast. No Undo: an approval is undone by its own action (restore, revoke), from Activity, Changes.',
    html: shell(
      'needs',
      macNeeds(
        `<div style="position:absolute;right:24px;bottom:24px;width:460px">${K.toast('Approved on Nick\'s iPhone: Install "Yahoo Finance" for yahoo.com', K.btn('Show change'))}</div>`,
      ).replace(
        /<div class="wf-inbox [^"]*"><span class="wf-kind">↓<\/span>[\s\S]*?Review<\/span><\/div>/,
        '',
      ),
      { badges: { needs: 1 }, sites: SITES },
    ),
    notes: [[700, 690, 'Show change opens Activity, Changes at this install.']],
  })

  const macSheet = (title, body, foot) =>
    shell('needs', macNeeds(), { badges: { needs: 2 }, sites: SITES, over: sheet(title, body, foot) })
  FRAMES.push({
    id: 'mac-card-sheet-login',
    group: G,
    title: 'Mac: Login card as a sheet',
    personas: ['P1', 'P3', 'P5'],
    desc: 'Another moment (8:10 pm, as ph-card-login). Same parts and order as the phone card, expanded.',
    html: macSheet(
      'Let Woolworths use your login',
      `<div class="col">${K.badge('Login · approval 4A90', 'secret')}<span class="muted">Asked by ${K.link('Claude Code')} · 8:10 pm · this Mac</span>
       ${K.banner('warn', 'Your password.', 'Woolworths 0.3.2 may type your password, only on auth.woolworths.com.au.')}
       ${K.card('Which login', `${K.radio('"Woolworths" · 1Password · Personal vault', true)}<br>${K.radio('Choose another item…')}`)}
       ${K.card(
         'What changes',
         K.kv([
           ['Uses', '1Password item "Woolworths" · typed only on auth.woolworths.com.au'],
           ['Same', 'Claude never sees it; only Valet types it'],
         ]),
       )}</div>`,
      `${K.btn('Decline…')}<span class="grow"></span>${K.primary('Approve with Touch ID')}`,
    ),
    notes: [
      [
        700,
        600,
        'A Mac without Touch ID asks for the Mac account password in the system prompt instead (R14).',
      ],
    ],
  })
  FRAMES.push({
    id: 'mac-card-sheet-remote',
    group: G,
    title: 'Mac: Remote tool card as a sheet',
    personas: ['P1', 'P3'],
    desc: 'Another moment (8:10 pm). A write tool for a remote agent: caution, one card per tool, Face ID or Touch ID only.',
    html: macSheet(
      'Turn on "Add to cart" for Claude app',
      `<div class="col">${K.badge('Remote · approval 2C6B', 'info')}<span class="muted">Asked by ${K.link('Claude app')} · 8:10 pm · through the relay</span>
       ${K.banner('warn', 'Changes things.', 'Claude app could change things on Woolworths from anywhere.')}
       ${K.card('What changes', K.kv([['Turns on', '"Add to cart" (Woolworths) · write · for Claude app only']]))}
       ${K.card("In Claude app's words", '<i class="muted">"So I can build your shopping list into the trolley while you\'re out."</i>')}</div>`,
      `${K.btn('Decline…')}<span class="grow"></span>${K.primary('Approve with Touch ID')}`,
    ),
    notes: [[700, 300, 'Caution tone and word, as on the phone.']],
  })
  FRAMES.push({
    id: 'mac-card-sheet-setting',
    group: G,
    title: 'Mac: Setting card as a sheet',
    personas: ['P1', 'P3'],
    desc: 'Another moment (8:06 pm, as ph-card-setting): deleting evidence is a card even though it looks stricter.',
    html: macSheet(
      'Keep traces for 3 days instead of 14',
      `<div class="col">${K.badge('Setting · approval 1B77', 'info')}<span class="muted">Asked by ${K.link('Claude Code')} · 8:06 pm · this Mac</span>
       ${K.banner('warn', 'Deletes records.', "Traces older than 3 days are deleted now, including today's failed calls.")}
       ${K.card(
         'What changes',
         K.kv([
           ['Changes', 'Trace retention: 14 days → 3 days'],
           ['Because', 'Not linked to anything Valet knows about'],
         ]),
       )}
       ${K.card("In Claude Code's words", '<i class="muted">"Traces take a lot of space."</i>')}</div>`,
      `${K.btn('Decline…')}<span class="grow"></span>${K.primary('Approve with Touch ID')}`,
    ),
    notes: [
      [
        700,
        300,
        'A setting the person changes in Settings themselves needs no card, but loosening still asks for Touch ID.',
      ],
    ],
  })
  FRAMES.push({
    id: 'mac-settings-approvals',
    group: G,
    title: 'Mac: Settings, Approvals',
    personas: ['P1', 'P3', 'P5'],
    desc: 'Mac only: approval policy can never be changed from the phone or by an agent (R1). Shows the gestures, the fixed limits and what is Mac only.',
    html: shell(
      'settings',
      `${K.header({ crumbs: ['Settings'], title: 'Approvals' })}
      <div class="wf-scroll"><div class="col" style="max-width:760px">
        ${K.card(
          'Devices that can approve',
          K.table(
            ['Device', 'Gesture', ''],
            [
              ["Nick's MacBook Pro (this Mac)", 'Touch ID', ''],
              [
                K.link("Nick's iPhone"),
                'Face ID · passcode on neutral cards only',
                K.btn('Manage in Connections'),
              ],
            ],
            { cols: '1.4fr 1.4fr auto' },
          ),
        )}
        ${K.card('Fallbacks', `<div class="col">${K.check('On iPhone, offer "Use passcode instead" on neutral cards', true)}<span class="faint">Cards that widen access, connect an agent or spend money always need Face ID or Touch ID. On a Mac without Touch ID, the Mac account password. An accessibility exception for someone who can't use Face ID is for B to decide.</span></div>`)}
        ${K.card(
          'Request limits',
          K.kv([
            ['Waiting per agent / overall', '3 / 5'],
            ['Requests per agent per day', '20'],
            ['Changes without approval per agent', '10 an hour'],
            ['Declines before an agent is paused', "3 in an hour (notes don't count)"],
            ['Adapter requests expire after', '24 hours'],
            ['A signed approval expires after', '2 minutes'],
          ]),
        )}
        ${K.card('Only on this Mac', '<span class="muted">Pair a device · Unlock after Lock down · Reset Valet · change the 1Password account · this page</span>')}
      </div></div>`,
      { badges: { needs: 2 }, sites: SITES },
    ),
    notes: [
      [
        470,
        330,
        "Changing a fallback needs Touch ID (or the Mac password) here, and can't be asked for by an agent or done from the phone.",
      ],
    ],
  })
})()
