// J6. A login needs you while you're away: what the phone can and can't do.
;(() => {
  const { K, P, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J6 · Login while away'] =
    "A Woolworths call finds the session signed out and Valet's login can't finish by itself. The phone can type a code, send a new one, or put the login off; it can't solve a verification check, and says so."

  const head = (title, sub) =>
    `<div class="ph-card"><div class="ph-kind"><span class="k">Login</span><span>call 9A71</span><span class="grow"></span>${K.countdown('15 min', '7:55 pm')}</div><h2 class="ph-title">${title}</h2><div class="ph-asked">${sub}</div></div>`
  const raised = 'Raised by Valet for <b>Claude Code</b> · get_cart · 7:40 pm'

  FRAMES.push({
    id: 'ph-login-code',
    group: 'J6 · Login while away',
    size: 'phone',
    title: 'Type the code Woolworths sent you',
    personas: ['P8', 'P7', 'P5'],
    desc: "Happy path, step 2. Texts aren't forwarded to the Mac, so Valet can't read the code. iOS offers it from Messages above the keyboard; one tap fills it.",
    html: `<div class="wf-phone sheet"><div class="sbar"><span>7:40</span><span class="island"></span><span>▮▮▮ ◔</span></div><div class="sheetbody"><div class="grabber"></div><div class="nbar"><div class="ntop"><span>‹ Needs you</span><b></b><span></span></div></div>
      <div class="content">${head('Log in to Woolworths (one-time code)', raised)}
        <div style="font-size:15px">Woolworths sent you a code. Type it here and Valet will enter it on your Mac.</div>
        <div class="ph-field on"><span class="ph-code">4 8 _ _ _ _</span></div>
        ${P.btn('Send code', 'primary off')}
        <div style="font-size:13px;color:var(--wf-ink-3)">Valet types it only into Woolworths' code field on auth.woolworths.com.au. No Face ID: a code isn't an approval.</div>
      </div>
      <div class="ph-kb"><div class="sugg">From Messages · 482913</div><div class="keys"></div></div></div><span class="home"></span></div>`,
    notes: [
      [
        360,
        150,
        "Same title as the Mac's Needs you item and the agent's tool result. The deadline is the login window: 15 min · until 7:55 pm.",
      ],
      [360, 330, 'Code field uses iOS one-time-code content type, digits keypad, paste accepted.'],
      [130, 610, "The suggestion comes from iOS, on the phone. Valet never reads the phone's messages."],
      [
        360,
        440,
        "Origin-bound: the code goes only into the field the login flow declared, on the flow's own origin (J6 table).",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-login-done',
    group: 'J6 · Login while away',
    size: 'phone',
    title: 'Logged in',
    personas: ['P8', 'P9'],
    desc: 'Step 3. Logging in… then Done. The agent retries on its own; the phone says so.',
    html: P.sheet(
      `${P.state('ok', '<span>✓</span><div><b>Logged in to Woolworths at 7:41 pm.</b><br>Claude Code will see this the next time it checks Valet. Nothing else needs you.</div>')}
       ${P.group('', [P.row('Back to Needs you'), P.row('Woolworths', 'Open the site')])}`,
      { title: 'Log in to Woolworths', back: 'Needs you' },
    ),
    notes: [
      [360, 130, 'While Valet works the button reads "Logging in…" and is disabled; this is the end state.'],
    ],
  })

  FRAMES.push({
    id: 'ph-login-wrong-code',
    group: 'J6 · Login while away',
    size: 'phone',
    title: "Woolworths didn't accept that code",
    personas: ['P8', 'P2'],
    desc: 'F1. The site rejected the code. If the flow declares a resend step, the phone offers it.',
    html: P.sheet(
      `${head('Log in to Woolworths (one-time code)', raised)}
       ${P.banner('bad', "<b>Woolworths didn't accept that code.</b><span>Check the newest message from Woolworths, or ask for a new code.</span>")}
       <div class="ph-field on"><span class="ph-code">_ _ _ _ _ _</span></div>`,
      {
        title: '',
        back: 'Needs you',
        actions: `<div class="row">${P.btn('Send a new code')}${P.btn('Send code', 'primary off')}</div>`,
      },
    ),
    notes: [
      [360, 260, "Wording from the site's refusal is never shown; Valet's sentence only."],
      [60, 770, '"Send a new code" exists only when the login flow declares a resend step.'],
    ],
  })

  FRAMES.push({
    id: 'ph-login-mac-offline',
    group: 'J6 · Login while away',
    size: 'phone',
    title: "Your Mac is offline, so the login can't continue",
    personas: ['P8', 'P7'],
    desc: "F3. Logins run on the Mac. The phone says so and doesn't pretend to help.",
    html: P.sheet(
      `${head('Log in to Woolworths (one-time code)', raised)}
       ${P.state('bad', "<span>✕</span><div><b>Your Mac is offline. Logins need it.</b><br>Nick's MacBook Pro was last online at 7:39 pm. Claude Code's calls fail with \"Valet isn't reachable\" until it's back.</div>")}`,
      { title: '', back: 'Needs you' },
    ),
    notes: [[360, 260, 'The agent hears this from the relay, not the Mac: "Valet isn\'t reachable".']],
  })

  FRAMES.push({
    id: 'ph-login-check',
    group: 'J6 · Login while away',
    size: 'phone',
    title: 'A verification check only works on the Mac',
    personas: ['P8', 'P7', 'P9', 'P2'],
    desc: "Dead end D1. A CAPTCHA or device check can't be done on the phone. The person chooses when they'll do it at the Mac, or puts it off; the agent sees which the next time it checks.",
    html: P.sheet(
      `${head('Log in to Woolworths (verification check)', raised)}
       <div style="font-size:15px">Woolworths wants a check that only works on your Mac. Valet can't show it on your phone.</div>
       ${P.group(
         'Remind me at…',
         [
           P.row('In 1 hour', '8:40 pm', ''),
           P.row('Tonight', '8:00 pm', ''),
           P.row('Tomorrow morning', '8:00 am', '<span class="chev">✓</span>'),
           P.row("When I'm next at my Mac", 'next time you unlock it', ''),
         ],
         "Claude Code will see this the next time it checks Valet, and won't retry before then.",
       )}`,
      {
        title: '',
        back: 'Needs you',
        actions: `<div class="row">${P.btn('Not now')}${P.btn('Remind me', 'primary')}</div><small>Not now ends the login. Calls that need it fail until you\'re back.</small>`,
      },
    ),
    notes: [
      [
        360,
        300,
        'Why not show the login page here: it would stream the most sensitive page through the relay. Open question 1 for Nick (information-architecture.md section 9).',
      ],
      [
        360,
        440,
        'Remind me gives the agent, the next time it checks: "The person will log in to Woolworths at their Mac, around 8:00 am tomorrow. Don\'t retry before then."',
      ],
      [
        60,
        770,
        'Not now gives the agent: "The person can\'t log in to Woolworths until they\'re back at their Mac. Calls that need it will fail until then."',
      ],
      [
        360,
        600,
        '"When I\'m next at my Mac" means the next time the person unlocks the Mac (R48). The Needs you item stays, marked "Reminder set". Lock down cancels the hand-off (F4).',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-needs-you-login-deferred',
    group: 'J6 · Login while away',
    size: 'phone',
    title: 'Needs you with the login put off until the morning',
    personas: ['P8', 'P7'],
    desc: "After D1. The item stays, marked with its reminder, so it isn't forgotten. A password that stopped working is a Login card instead (re-sync from 1Password: ph-card-login).",
    html: P.screen(
      P.group('Waiting', [
        P.item(
          '→',
          'Log in to Woolworths (verification check)',
          'Reminder set for 8:00 am · do it at your Mac',
        ),
        P.item('↑', 'Update Woolworths to 0.3.1', 'Asked by Claude Code · 7:31 pm'),
      ]),
      { title: 'Needs you', badge: 2 },
    ),
    notes: [
      [360, 190, 'Mac Needs you shows the same row with "Log in now" for when the person is there (R49).'],
    ],
  })
})()
