// J1. Install and pair: the shorter setup, pairing the iPhone by picking the words the phone shows.
;(() => {
  const { K, P, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J1 · Install and pair'] =
    'Thursday 12 November, from 8:05 pm, at the Mac. Setup is four steps between Welcome and Done now: the Woolworths steps move to the agent, which asks for them on cards. Pairing shows a QR code on the Mac; the phone shows four words, and the person picks the same four from three sets on the Mac before pairing with Touch ID. Then a recovery code to save in 1Password.'

  const STEPS = [
    ['Welcome', 'What Valet does'],
    ['1Password', 'Where passwords come from'],
    ['Messages', 'Optional · one-time codes'],
    ['Pair your phone', 'Approve from anywhere'],
    ['Connect an agent', 'Claude Code, Desktop or claude.ai'],
    ['Done', ''],
  ]
  // states per step: d done, c current, t to do, s skipped, b blocked
  const rail = (states, subs = {}) =>
    STEPS.map(([title, sub], i) => {
      const st = states[i] || 't'
      const mark = st === 'd' ? '✓' : st === 's' ? '–' : st === 'b' ? '!' : String(i + 1)
      const ms =
        st === 'd'
          ? 'background:var(--wf-ok);color:#fff;border-color:var(--wf-ok)'
          : st === 'c'
            ? 'background:var(--wf-act);color:#fff;border-color:var(--wf-act)'
            : st === 'b'
              ? 'color:var(--wf-warn);border-color:var(--wf-warn)'
              : ''
      return `<div class="row" style="gap:10px;padding:7px 10px;border-radius:8px;align-items:flex-start;${st === 'c' ? 'background:var(--wf-sel);' : ''}">
        <span style="width:20px;height:20px;border-radius:50%;border:1.5px solid var(--wf-line-2);display:grid;place-items:center;font-size:10.5px;font-weight:700;flex:none;${ms}">${mark}</span>
        <div class="col" style="gap:0"><span style="${st === 'c' ? 'font-weight:600' : ''}">${title}</span><small class="faint" style="font-size:10.5px;${st === 'b' ? 'color:var(--wf-warn)' : ''}">${subs[i] || (st === 'd' ? 'Done' : st === 's' ? 'Skipped' : sub)}</small></div></div>`
    }).join('')
  const setup = ({ states, subs, body, foot, over = '' }) =>
    `<div class="wf-window">
      <div class="wf-titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="grow" style="text-align:center;color:var(--wf-ink-2)">Set up Valet</span><span style="width:60px"></span></div>
      <div class="wf-body">
        <aside class="wf-side" style="width:224px;padding:16px 10px;gap:2px">
          <div class="grp" style="padding-top:0">Set up Valet · about 5 minutes</div>
          ${rail(states, subs)}
          <div class="grow"></div>
          <div class="foot" style="flex-direction:column;align-items:flex-start;gap:2px">After setup, your agent does the rest.<span class="faint">It asks you on your phone for anything that matters.</span></div>
        </aside>
        <main class="wf-main">
          <div class="wf-scroll" style="padding:48px 44px 24px;gap:16px"><div class="col" style="gap:16px;max-width:760px;width:100%;margin:0 auto">${body}</div></div>
          <div class="sticky-foot" style="padding:12px 44px">${foot}</div>
        </main>
      </div>${over}</div>`
  const h = (title, lede) =>
    `<div class="col" style="gap:6px"><h2 style="font:600 24px/1.2 var(--f-head);margin:0">${title}</h2>${lede ? `<p class="muted" style="margin:0;font-size:13px;max-width:620px">${lede}</p>` : ''}</div>`
  const lg = (label, kind = '') => `<span class="wf-btn lg ${kind}">${label}</span>`
  const SUBS = { 1: 'Connected', 2: 'Reading codes', 3: "Nick's iPhone" }
  const PRE = { 1: 'Connected', 2: 'Reading codes' }
  // shared with J2's frames
  window.WF.setupV2 = { setup, h, lg, SUBS }

  const qrBlock = (fade = false) =>
    `<div class="row" style="gap:28px;align-items:flex-start">
      <div class="col" style="gap:8px;align-items:center;${fade ? 'opacity:.25' : ''}"><div class="ph-qr"></div><span class="faint" style="font-size:11px">Scan with the Valet app</span></div>
      <div class="col" style="gap:12px;max-width:380px">
        <div class="col" style="gap:2px"><b>1. Get Valet for iPhone</b><span class="muted">Scan this with the iPhone camera, or search the App Store for "Valet".</span>
          <div class="row" style="gap:10px;margin-top:4px"><div class="ph-qr" style="width:64px;height:64px;border-width:4px;background-size:8px 8px"></div><span class="wf-link">App Store link</span></div></div>
        <div class="col" style="gap:2px"><b>2. Open it and tap Scan code</b><span class="muted">Point it at the big code.</span></div>
        <div class="col" style="gap:4px"><b>Camera not working?</b><span class="muted">Tap "Type the code instead" and type:</span>${K.value('<span style="letter-spacing:3px;font-size:14px">HX4R 9WQM</span>')}</div>
        ${fade ? K.banner('warn', 'This code has run out.', 'Codes last 10 minutes.', K.primary('Show a new code')) : `<span class="faint">Code and QR last ${K.countdown('9:12', '8:17 pm')}</span>`}
      </div></div>`

  FRAMES.push({
    id: 'mac-setup-welcome-v2',
    group: 'J1 · Install and pair',
    title: 'Mac: Welcome, four steps',
    personas: ['P8', 'P2', 'P1', 'P5'],
    desc: 'Step 1. What Valet is, the steps, and the hand-off: after setup your agent does the rest and asks on the phone.',
    html: setup({
      states: ['c'],
      body:
        h(
          'Let your agents use websites for you',
          'Valet runs websites on this Mac, as you, when your agents ask. After setup, your agent does the rest, and asks you on your phone for anything that matters.',
        ) +
        K.card(
          "What you'll do now",
          `<div class="col" style="gap:6px">
            <div>1. Connect 1Password, where Valet gets your passwords.</div>
            <div>2. Let Valet read one-time codes from Messages <span class="faint">(optional)</span>.</div>
            <div>3. Pair your iPhone, so you can approve things from anywhere.</div>
            <div>4. Connect an agent, like Claude Code or Claude on claude.ai.</div></div>`,
        ) +
        K.card(
          'What your agent does after',
          '<span class="muted">Sets up sites such as Woolworths, chooses your store, writes new site adapters and fixes broken ones. Every change that matters waits for you on a card, approved with Face ID or Touch ID.</span>',
        ),
      foot: `<span class="grow"></span>${lg('Get started', 'primary')}`,
    }),
    notes: [
      [
        270,
        180,
        'Rail: Welcome · 1Password · Messages (optional) · Pair your phone · Connect an agent · Done. The Woolworths steps left setup (IA assumption 1).',
      ],
      [320, 120, 'Plain words, no MCP or adapters in the lede (P2).'],
      [320, 470, "Says up front that the agent asks on the phone, so pairing isn't a surprise."],
    ],
  })

  FRAMES.push({
    id: 'mac-setup-pair',
    group: 'J1 · Install and pair',
    title: 'Mac: Pair your phone',
    personas: ['P8', 'P1', 'P2', 'P5'],
    desc: "Step 4. The pairing QR, the App Store QR, and an 8-character code for when the camera can't be used. Both last 10 minutes.",
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: PRE,
      body:
        h(
          'Pair your iPhone',
          'Valet asks you before agents change anything. With your iPhone paired, you can answer from anywhere, with Face ID.',
        ) + qrBlock(),
      foot: `${lg('Back')}<span class="grow"></span><span class="wf-link">Skip: approve on this Mac only</span>${K.btn('No iPhone? Android?')}`,
    }),
    notes: [
      [
        330,
        170,
        "The pairing QR carries the Mac's key and the relay rendezvous. Nothing is paired until the words match (next frames).",
      ],
      [
        575,
        400,
        'The typed code for J1 F1: unambiguous alphabet, shown with a gap for reading aloud. VoiceOver reads it one character at a time.',
      ],
      [700, 445, "Time left as the library's countdown; at 0 the QR fades (mac-setup-pair-expired is F2)."],
      [
        800,
        750,
        'Skip leads to the dead-end choice (mac-setup-pair-skip). No Continue: the step moves on by itself once paired.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-welcome',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: first launch',
    personas: ['P8', 'P2', 'P5'],
    desc: 'Step 5. One screen, one job.',
    html: P.screen(
      `<div class="col" style="gap:14px;margin-top:60px;align-items:center;text-align:center">
        <div style="width:84px;height:84px;border-radius:20px;background:var(--wf-ink);opacity:.85"></div>
        <h2 style="font:700 28px/1.2 var(--f-head);margin:0">Valet on your phone answers your Mac</h2>
        <div class="muted" style="font-size:16px">Your agents ask Valet before changing anything. With this app, you answer from anywhere.</div>
        <div class="muted" style="font-size:16px">Scan the code your Mac shows.</div></div>
        <div class="grow"></div>
        <div class="col" style="gap:8px">${P.btn('Scan code', 'primary')}${P.btn('Type the code instead', 'plain')}</div>`,
      { tab: false, large: false },
    ),
    notes: [
      [196, 300, 'No account and no sign-in: the Mac is the identity (D79, recommended).'],
      [196, 760, 'The typed route is always offered, not hidden behind a camera failure (F1).'],
    ],
  })

  FRAMES.push({
    id: 'ph-pair-scan',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: scanning the code',
    personas: ['P8', 'P5'],
    desc: 'Step 6. After the iOS camera permission sheet (first time only), a viewfinder.',
    html: P.screen(
      `<div class="ph-view"></div>
       <div class="muted" style="text-align:center;font-size:15px">Point at the code on your Mac's screen.</div>
       ${P.btn('Type the code instead', 'plain')}`,
      { tab: false, title: 'Scan code', large: false, back: 'Back' },
    ),
    notes: [
      [
        196,
        600,
        'If the camera is refused, this screen says so and offers the typed code (ph-pair-code). VoiceOver announces "Code found" with a haptic.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-pair-code',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: type the code instead (F1)',
    personas: ['P8', 'P5', 'P2'],
    desc: 'F1. Eight characters, auto-uppercased, pasted codes accepted, the gap ignored.',
    html: P.screen(
      `<div class="muted" style="font-size:15px">Type the code under the QR on your Mac.</div>
       <div class="ph-field on ph-code">HX4R 9WQ<span style="color:var(--wf-ink-3)">_</span></div>
       <div style="font-size:13px;color:var(--wf-ink-3)">Letters and numbers only; 0 and O mean the same.</div>
       ${P.btn('Continue', 'primary off')}
       <div class="grow"></div>
       <div class="ph-kb" style="margin:0 -16px -16px"><div class="keys"></div></div>`,
      { tab: false, title: 'Type the code', large: false, back: 'Back' },
    ),
    notes: [
      [
        196,
        150,
        "Unambiguous alphabet as in the relay's consent code (docs/relay.md). Continue arms at 8 characters.",
      ],
    ],
  })

  const wordsPhone = (over = '') =>
    P.screen(
      `<div class="col" style="gap:14px;margin-top:20px;text-align:center">
        <h2 style="font:700 24px/1.2 var(--f-head);margin:0">Your pairing words</h2>
        <div class="muted" style="font-size:15px">Nick's MacBook Pro shows three sets of words. Pick this one there.</div>
        <div class="ph-words4"><span>maple</span><span>otter</span><span>pencil</span><span>harbour</span></div></div>
        <div class="grow"></div>
        <div class="muted" style="font-size:14px">Pick these four words on your Mac.</div>
        <div class="col" style="gap:8px">${P.btn('Cancel pairing', '')}</div>`,
      { tab: false, title: 'Check the words', large: false, back: 'Cancel', over },
    )

  FRAMES.push({
    id: 'ph-pair-words',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: check the words',
    personas: ['P8', 'P3', 'P5', 'X2'],
    desc: "Step 7. Four words from the key exchange. A QR shown by someone else's screen, or a swapped code, gives different words.",
    html: wordsPhone(),
    notes: [
      [196, 260, 'Words, not digits: easy to compare aloud, and VoiceOver reads them naturally.'],
      [
        196,
        720,
        'The phone only shows; the person picks on the Mac. Picking from three sets makes them compare, where "they match" invites a habit tap (R39).',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-setup-pair-words',
    group: 'J1 · Install and pair',
    title: 'Mac: do the words match?',
    personas: ['P8', 'P1', 'P3'],
    desc: 'Step 7, on the Mac. The person picks the set their iPhone shows, then Touch ID. A wrong pick or "None of these" cancels both sides (F3).',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: PRE,
      body:
        h("Nick's iPhone wants to pair", 'Which words does your iPhone show?') +
        `<div class="col" style="gap:8px">${K.radio('<span style="font:600 16px var(--f-ui)">maple · otter · pencil · harbour</span>', true)}${K.radio('<span style="font:600 16px var(--f-ui)">maple · osprey · pencil · harvest</span>')}${K.radio('<span style="font:600 16px var(--f-ui)">meadow · otter · piston · harbour</span>')}${K.radio('None of these')}</div>` +
        K.card(
          'A paired iPhone can',
          '<div class="col" style="gap:4px"><span>Answer approvals with Face ID: installs, updates, logins, remote tools.</span><span>Pause Valet, lock it down, remove a lost device.</span><span class="faint">It can\'t pair other devices, unlock Valet, reset it or change approval settings. Those stay on this Mac.</span></div>',
        ),
      foot: `${lg('Cancel')}<span class="grow"></span>${lg('Pair with Touch ID', 'primary')}`,
    }),
    notes: [
      [
        330,
        200,
        'Decoys share words with the real set, so a glance isn\'t enough. No "your iPhone says they match" banner to prime a yes (R39).',
      ],
      [
        330,
        380,
        'What a paired phone may and may not do, from approval-cards.md section 12, before the person commits.',
      ],
      [
        960,
        700,
        "Touch ID proves presence at the Mac. On a Mac without Touch ID: the Mac account password in the system prompt, which a process with Accessibility permission can't type (R14).",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-pair-recovery',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: save the recovery code',
    personas: ['P8', 'P3', 'P1'],
    desc: "Step 8. For a lost phone when the Mac is far away (R1). On the relay's recovery page it can only lock Valet down at the relay and remove devices; it can never approve anything.",
    html: P.screen(
      `<div class="col" style="gap:14px;margin-top:20px;text-align:center">
        <h2 style="font:700 24px/1.2 var(--f-head);margin:0">Save your recovery code</h2>
        <div class="muted" style="font-size:15px">If you lose this iPhone and can't get to your Mac, this code lets you lock Valet down and remove the phone from the web.</div>
        <div class="ph-code" style="font-size:20px;letter-spacing:3px;background:var(--wf-paper);border-radius:10px;padding:12px">RKQ4-7MXT-PW9C-3HJD</div>
        <div class="muted" style="font-size:14px">It can't approve anything. Shown once.</div></div>
        <div class="grow"></div>
        <div class="col" style="gap:8px">${P.btn('Save to 1Password', 'primary')}${P.btn("I've saved it", '')}</div>`,
      { tab: false, title: 'Recovery code', large: false, time: '8:08' },
    ),
    notes: [
      [
        196,
        230,
        'Shown once; a new one replaces it from Valet, Devices. B designs what the relay stores (a hash) and how a revoke reaches the Mac.',
      ],
      [196, 720, '"I\'ve saved it" is required to continue; "Save to 1Password" uses the share sheet.'],
    ],
  })

  FRAMES.push({
    id: 'ph-pair-notifications',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: why notifications, before the iOS prompt',
    personas: ['P8', 'P2'],
    desc: 'Step 9. The reason first, then the system prompt. "Not now" is allowed and remembered.',
    html: P.screen(
      `<div class="col" style="gap:14px;margin-top:40px;text-align:center">
        <div style="font-size:48px">🔔</div>
        <h2 style="font:700 24px/1.2 var(--f-head);margin:0">Get asked when it matters</h2>
        <div class="muted" style="font-size:16px">Valet asks you before agents change anything. Without notifications you'll only see requests when you open the app.</div>
        <div class="muted" style="font-size:14px">Quiet for small changes. Time-sensitive only for things with a deadline, like a login code.</div></div>
        <div class="grow"></div>
        <div class="col" style="gap:8px">${P.btn('Allow notifications', 'primary')}${P.btn('Not now', 'plain')}</div>`,
      { tab: false, large: false },
    ),
    notes: [[196, 330, 'Interruption levels from approval-cards.md section 10, said in plain words.']],
  })

  FRAMES.push({
    id: 'ph-pair-done',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: paired, lands on Needs you',
    personas: ['P8', 'P2'],
    desc: "Step 10. Says which Mac and that it is online; the empty Needs you shows the Mac's status.",
    html: P.screen(
      `${P.banner('ok', "<b>Paired with Nick's MacBook Pro.</b><span>Your Mac is online. Finish setup on your Mac: connect an agent.</span>")}
       <div class="col" style="gap:6px;align-items:center;text-align:center;margin:30px 0 10px"><b style="font-size:18px">Nothing needs you</b><span class="muted">When an agent asks for something, it shows up here.</span></div>
       ${P.group('Your Mac', [
         P.row("Nick's MacBook Pro", 'Online · Valet 0.9.0', '<span class="wf-dot ok"></span>'),
         P.row('Woolworths', 'Not set up yet · ask your agent', ''),
       ])}`,
      { title: 'Needs you', badge: 0, time: '8:07' },
    ),
    notes: [
      [196, 150, 'One line on what comes next, on the Mac (J2).'],
      [196, 400, 'Status lines are not buttons; each site row opens its page (v3 principle 2).'],
    ],
  })

  FRAMES.push({
    id: 'ph-pair-expired',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: the code ran out (F2)',
    personas: ['P8', 'P2'],
    desc: 'F2. Codes last 10 minutes.',
    html: P.screen(
      `${P.state('warn', '<span>!</span><div><b>That code has run out.</b><br>Ask your Mac for a new one: "Show a new code" under the QR.</div>')}
       ${P.btn('Scan again', 'primary')}${P.btn('Type the code instead', 'plain')}`,
      { tab: false, title: 'Scan code', large: false, back: 'Back' },
    ),
    notes: [[196, 130, 'The Mac side: the QR fades with "Show a new code" (mac-setup-pair-expired).']],
  })

  FRAMES.push({
    id: 'mac-setup-pair-expired',
    group: 'J1 · Install and pair',
    title: 'Mac: the pairing code ran out (F2)',
    personas: ['P8', 'P2'],
    desc: "F2 on the Mac. The QR fades so an old code can't be scanned by mistake.",
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: PRE,
      body:
        h(
          'Pair your iPhone',
          'Valet asks you before agents change anything. With your iPhone paired, you can answer from anywhere, with Face ID.',
        ) + qrBlock(true),
      foot: `${lg('Back')}<span class="grow"></span><span class="wf-link">Skip: approve on this Mac only</span>`,
    }),
    notes: [[650, 450, "A new code replaces the old one at once; the old one can't pair any more."]],
  })

  FRAMES.push({
    id: 'ph-pair-mismatch',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: "The words didn't match (F3)",
    personas: ['P3', 'P8', 'X2'],
    desc: 'F3. A wrong pick or "None of these" on the Mac, or Cancel on either side, cancels both. Audited on the Mac.',
    html: P.screen(
      `${P.state('bad', "<span>✕</span><div><b>Nothing was paired.</b><br>Someone may have shown you a different code. Only scan a code on your own Mac's screen.</div>")}
       ${P.btn('Start again', 'primary')}`,
      { tab: false, title: 'Pairing cancelled', large: false },
    ),
    notes: [
      [
        196,
        130,
        'The Mac shows the same sentence and adds the attempt to the Audit log (Approvals category).',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-setup-pair-offline',
    group: 'J1 · Install and pair',
    title: "Mac: can't reach the relay (F4)",
    personas: ['P8', 'P1'],
    desc: 'F4. Pairing needs the relay, which carries the key exchange and every later message.',
    html: setup({
      states: ['d', 'd', 'd', 'b'],
      subs: { ...PRE, 3: 'Waiting for the internet' },
      body:
        h(
          'Pair your iPhone',
          'Valet asks you before agents change anything. With your iPhone paired, you can answer from anywhere, with Face ID.',
        ) +
        K.banner(
          'warn',
          "Valet can't reach its relay.",
          "Check this Mac's internet. Last tried 8:06 pm.",
          K.btn('Try again'),
        ) +
        '<span class="muted">Your phone talks to this Mac through Valet\'s relay, so pairing needs it. You can skip and pair later from Connections, Devices.</span>',
      foot: `${lg('Back')}<span class="grow"></span>${lg('Skip for now')}`,
    }),
    notes: [
      [
        620,
        200,
        "No QR is shown while the relay is unreachable: a code that can't complete would only confuse.",
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-setup-pair-skip',
    group: 'J1 · Install and pair',
    title: 'Mac: no iPhone, or Android (D1, D2)',
    personas: ['P2', 'P8', 'P1'],
    desc: 'Dead ends D1 and D2. Skipping is a choice, not a missing step: no "Finish setup" item.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: PRE,
      body:
        h(
          'Pair your iPhone',
          'Valet asks you before agents change anything. With your iPhone paired, you can answer from anywhere, with Face ID.',
        ) + qrBlock(),
      foot: `${lg('Back')}<span class="grow"></span>`,
      over: `<div class="wf-scrim"></div><div class="wf-dialog"><h3>Approve on this Mac only?</h3><div class="body"><div class="col" style="gap:8px">
        <span>Everything works without a phone. Requests from agents wait in Needs you on this Mac, and you answer them here with Touch ID.</span>
        <span class="muted">Android: Valet for Android isn't available yet.</span>
        <span class="muted">You can pair a phone any time in Connections, Devices.</span></div></div>
        <footer><span class="grow"></span>${K.btn('Go back')}${K.primary('Approve on this Mac only')}</footer></div>`,
    }),
    notes: [[590, 380, 'Android is D85 (after iOS). Said once, plainly, here.']],
  })

  FRAMES.push({
    id: 'ph-needs-you-no-notif',
    group: 'J1 · Install and pair',
    size: 'phone',
    title: 'iPhone: notifications are off (F5)',
    personas: ['P8', 'P7'],
    desc: 'F5. A banner that stays on Needs you until notifications are on.',
    html: P.screen(
      `${P.banner('', "<b>Notifications are off, so you'll only see requests when you open Valet.</b>" + P.btn('Turn on in Settings', 'plain'))}
       ${P.group('Waiting', [
         P.item('↓', 'Install "Yahoo Finance" for yahoo.com', 'Asked by Claude app · 7:38 pm'),
         P.item('↑', 'Update Woolworths to 0.3.1', 'Asked by Claude Code · 7:31 pm'),
       ])}`,
      { title: 'Needs you', badge: 2 },
    ),
    notes: [
      [
        196,
        160,
        '"Turn on in Settings" opens iOS Settings for Valet. The Mac\'s Devices row says "Nick\'s iPhone · notifications off".',
      ],
    ],
  })
})()
