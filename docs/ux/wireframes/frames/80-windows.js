// Own windows: the confirmation and the login hand-off (principle 5, P10, E5; P7 and P2 walkthroughs).
;(function () {
  const { K, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Own windows'] =
    "Only two things get their own window, because they must be answered on the Mac and at once: the confirmation (floats on top, on every Space) and the login hand-off (the site's own login page with Valet's banner above it). Needs you, the menu bar and the notification all bring these windows forward; none of them answers in their place."

  // ---- confirmation window (460 x 620) ----
  const focusRing = 'outline:2px solid var(--wf-act);outline-offset:2px;'
  const tick = (t) =>
    `<div class="row" style="align-items:flex-start;gap:8px"><span style="color:var(--wf-ok);font-weight:700">✓</span><span>${t}</span></div>`
  const conf = ({ strip, stripTone = '', body, foot }) =>
    `<div class="wf-conf" style="height:auto;max-height:620px">
      <div class="row" style="padding:10px 16px;border-bottom:1px solid var(--wf-line);flex:none;gap:8px;${stripTone ? `background:var(--wf-tint-${stripTone})` : 'background:var(--wf-paper-2)'}">
        <span class="wf-av" style="width:20px;height:20px">V</span><b style="font-size:11.5px" class="grow">Confirm: Remove from cart (Woolworths)</b>${strip}</div>
      <div style="flex:1;min-height:0;overflow:hidden;padding:18px 20px;display:flex;flex-direction:column;gap:12px">${body}</div>
      <div style="border-top:1px solid var(--wf-line);padding:12px 20px 10px;flex:none;display:flex;flex-direction:column;gap:6px;background:var(--wf-paper)">${foot}</div>
    </div>`
  const sentence = (dim = false) => `
    <span class="muted" style="font-size:11.5px">Claude Code asks to:</span>
    <div style="font:600 20px/1.3 var(--f-head);${dim ? 'color:var(--wf-ink-3);text-decoration:line-through;text-decoration-thickness:1px' : ''}">Remove Cavendish Bananas (2 × $0.79) from your trolley?</div>
    <span class="faint" style="font-size:11px">Woolworths' adapter wrote this sentence; Valet can't check its wording. Valet checked the request itself:</span>`
  const checked = `
    <div class="col" style="gap:6px;padding:10px 12px;border:1px solid var(--wf-line);border-radius:8px">
      ${tick('Changes only your trolley, with one request to woolworths.com.au')}
      ${tick('Woolworths 0.3.0, the version you approved on 2 Nov')}
      ${tick("Can't pay, check out or change your account")}
      <span class="faint" style="font-size:11px">▸ Details: tool, request and input</span>
    </div>
    <div class="muted" style="font-size:11.5px">If nobody answers by 9:50 pm, nothing is removed and Claude is told it timed out.</div>`
  const idLine = `<div class="faint mono" style="font-size:10px">remove_from_cart · call ${K.link('7F2A')} · Woolworths 0.3.0 · ${K.value('9f3c1a7e')}</div>`
  const buttons = (left, removeDisabled = false) =>
    `<div class="row" style="gap:8px">${left}<span class="grow"></span>
      <span class="wf-btn lg" style="${focusRing}">Don't remove</span>
      <span class="wf-btn lg primary" style="${removeDisabled ? 'opacity:.4;' : ''}">Remove</span></div>`

  FRAMES.push({
    id: 'confirm-arming',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, just came forward (arming)',
    personas: ['P1', 'P2', 'P5', 'P7'],
    desc: 'For 0.8 s after the window appears or regains focus, Remove is disabled and says why. "Don\'t remove" already has focus.',
    html: conf({
      strip: '<span class="faint" style="font-size:11px">1 of 3 waiting</span>',
      body: sentence() + checked,
      foot:
        buttons(K.countdown('1:42', '9:50 pm'), true) +
        `<div class="faint" style="font-size:11px;text-align:right">Remove is ready in a moment, so a key press meant for another app can't answer this.</div>` +
        idLine,
    }),
    notes: [
      [
        290,
        12,
        'Valet\'s own title (the Needs you title), then "1 of 3 waiting" so P7 knows whether he can go back to the couch.',
      ],
      [440, 92, 'Leads with the sentence (P10). Its accessible name is this sentence (P5).'],
      [
        440,
        150,
        'Attributed in kind words, under it, not as a warning above it (P2 refines P10; P3 and P6 keep the attribution).',
      ],
      [
        440,
        214,
        'What Valet checked, in three plain lines; the POST path and hash move under Details (E8, P2).',
      ],
      [
        212,
        378,
        'Countdown sits beside the buttons, not in a corner (P7). Buttons are verbs (P10); focus and Return are on the safe one (P1, P5).',
      ],
      [
        440,
        428,
        'The reason Remove is disabled is visible and is its accessible description; it clears at 0.8 s.',
      ],
    ],
  })

  FRAMES.push({
    id: 'confirm-ready',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, ready',
    personas: ['P2', 'P4', 'P5', 'P7'],
    desc: 'The normal state. Return and Escape choose "Don\'t remove"; Remove needs a click or Tab then Space. The window sizes to its content up to 620 px (today it is a fixed 460 x 620 with an empty band) and scrolls above a sticky footer.',
    html: conf({
      strip: '<span class="faint" style="font-size:11px">1 of 3 waiting</span>',
      body:
        sentence() +
        `<div class="col" style="gap:6px;padding:10px 12px;border:1px solid var(--wf-line);border-radius:8px">
          ${tick('Changes only your trolley, with one request to woolworths.com.au')}
          ${tick('Woolworths 0.3.0, the version you approved on 2 Nov')}
          ${tick("Can't pay, check out or change your account")}
          <span style="font-size:11px">▾ Details</span>
          ${K.kv([
            ['Tool', 'Remove from cart ' + K.value('remove_from_cart')],
            ['Request', K.value('POST /api/v3/ui/trolley/update')],
            ['Input', K.value('{ "stockcode": 133211 }')],
          ])}
        </div>`,
      foot:
        buttons(K.countdown('1:42', '9:50 pm')) +
        `<div class="faint" style="font-size:11px">Valet never pays. Checkout is always you, on woolworths.com.au.</div>` +
        idLine,
    }),
    notes: [
      [
        440,
        214,
        'Details open in place (and stay open with "Show technical details" on, P1). Values are selectable with copy; the rest is not (E3).',
      ],
      [
        212,
        410,
        "Return = Don't remove, as today (P1). Focus is contained in the window; Tab order: Details, Don't remove, Remove (P5).",
      ],
      [440, 444, 'The money line Sam asked for in this window (P2 part 4).'],
      [
        440,
        470,
        'Tool id, call id and version in small type, so a test confirm can be matched to its run (P4). The call link opens the main window on the trace.',
      ],
    ],
  })

  FRAMES.push({
    id: 'confirm-urgent',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, under 30 seconds',
    personas: ['P7', 'P5'],
    desc: 'The countdown grows and turns to the alert colour; one announcement at 30 s. Nothing else moves, so the buttons stay where the hand already is.',
    html: conf({
      strip: '<b style="font-size:11px;color:var(--wf-bad)">Ends in 0:24</b>',
      stripTone: 'bad',
      body: sentence() + checked,
      foot:
        buttons(
          `<span class="wf-count" style="font-size:22px;color:var(--wf-bad)">0:24<small> until 9:50 pm</small></span>`,
        ) +
        `<div style="font-size:11px;color:var(--wf-bad)">At 9:50 pm nothing is removed and Claude is told it timed out.</div>` +
        idLine,
    }),
    notes: [
      [
        330,
        12,
        'The strip turns to the alert tint and states the time left in words, which VoiceOver reads once at 30 s (not every second; P5).',
      ],
      [
        76,
        372,
        'Bigger countdown, same position: no layout shift under the pointer. Reduce Motion: no pulse, colour and size only.',
      ],
      [440, 412, 'Says what zero means ("nothing is removed"), which Sam asked for (P2 interview).'],
      [
        430,
        100,
        'Never auto-focus Remove or change the default as time runs out: urgency must not make approving easier.',
      ],
    ],
  })

  FRAMES.push({
    id: 'confirm-missed',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, missed',
    personas: ['P7', 'P6', 'P2'],
    desc: 'If the window is on screen when time runs out, it stays and says what happened instead of vanishing. The same item moves to Needs you › Missed for 24 hours.',
    html: conf({
      strip: '<span class="wf-badge idle">Missed</span>',
      body:
        `<div class="wf-banner idle"><div class="grow"><b>Missed: nobody answered by 9:50 pm.</b> Nothing was removed. Claude Code was told it timed out.</div></div>` +
        sentence(true) +
        `<div class="h3" style="margin-top:6px">What now</div>
         <div class="muted">If you still want the bananas removed, ask Claude to try again. It will ask you to confirm again.</div>
         <div class="row">${K.primary('Copy a retry note for Claude')}${K.btn('Open call 7F2A')}</div>
         <div class="faint" style="font-size:11px">Copies: "The Valet confirmation for Remove from cart timed out at 9:50 pm. Please try again; I'm at the Mac now."</div>`,
      foot:
        `<div class="row"><span class="faint" style="font-size:11px">Also in Needs you › Missed until 9:50 pm tomorrow</span><span class="grow"></span><span class="wf-btn lg" style="${focusRing}">Close</span></div>` +
        idLine,
    }),
    notes: [
      [
        440,
        66,
        'Says which (missed, not declined) and when, unlike today\'s "answered or has timed out" (P7 C5.3). Tool results tell the two apart too (P6).',
      ],
      [440, 150, 'The sentence stays, struck through, so the person recognises what they missed.'],
      [
        440,
        262,
        "The next step is Claude's: copy a sentence to paste. Valet never retries by itself (principle 1, Missed row).",
      ],
      [
        300,
        446,
        'Assumption: the window stays only if it was on screen; if the Mac was locked it closes and the Missed notification and Needs you row remain.',
      ],
    ],
  })

  // ---- login hand-off (1180 x 780: the login window with Valet's banner on top) ----
  const loginWin = ({ title, tone = 'warn', what, deadline, buttons, foot, page }) =>
    `<div class="wf-banner-win">
      <div class="wf-titlebar" style="height:34px"><span class="lights"><i></i><i></i><i></i></span><span class="grow" style="text-align:center;color:var(--wf-ink-2)">${title} — Valet</span><span style="width:60px"></span></div>
      <div style="flex:none;padding:14px 20px;background:var(--wf-tint-${tone});display:flex;gap:16px;align-items:flex-start;border-bottom:1px solid var(--wf-line-2)">
        <span class="wf-kind" style="background:var(--wf-paper)">→</span>
        <div class="grow col" style="gap:6px">
          <b style="font-size:15px">${title}</b>
          ${what}
          <span class="muted" style="font-size:11px">${foot}</span>
        </div>
        <div class="col" style="align-items:flex-end;gap:8px;flex:none">${deadline}<div class="row">${buttons}</div></div>
      </div>
      <div class="row faint" style="flex:none;padding:6px 20px;font-size:11px;gap:18px;background:var(--wf-paper-2);border-bottom:1px solid var(--wf-line)">
        <span>🔒 Private login window. Nothing from the adapter runs here.</span><span>Can only open ${K.value('woolworths.com.au')} ${K.value('auth.woolworths.com.au')}</span><span class="grow"></span><span>Valet filled: your email and password, from 1Password</span></div>
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;background:var(--wf-paper)">
        <div class="row" style="flex:none;padding:6px 14px;border-bottom:1px solid var(--wf-line)">${K.icon('‹')}${K.icon('↻')}<span class="wf-input" style="flex:1;font-family:var(--f-mono);font-size:11px">🔒 auth.woolworths.com.au/u/login</span></div>
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:40px;gap:12px">${page}</div>
      </div>
    </div>`
  const steps = (items) =>
    `<div style="display:flex;flex-direction:column;gap:3px">${items.map((t, i) => `<div class="row" style="gap:8px;align-items:baseline"><b style="width:12px;flex:none">${i + 1}.</b><span>${t}</span></div>`).join('')}</div>`
  const siteBox = (inner) =>
    `<div style="width:380px;border:1px dashed var(--wf-line-2);border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:12px;align-items:stretch"><b style="font-size:16px;text-align:center">Woolworths</b><span class="faint" style="text-align:center;font-size:10.5px">(the site's own page, drawn as a placeholder)</span>${inner}</div>`

  FRAMES.push({
    id: 'login-handoff',
    group: 'Own windows',
    title: 'Login hand-off: verification check',
    personas: ['P2', 'P7', 'P6', 'P5'],
    desc: 'Valet logged in with the 1Password login and hit a check only a person may do. The banner says what to do, in order, until when, and what each button does.',
    html: loginWin({
      title: 'Log in to Woolworths (verification check)',
      what: steps([
        'Finish the check on the Woolworths page below.',
        'If Woolworths asks again, log in. Valet already typed your email and password.',
        "Press <b>I'm done</b>. Valet checks you're logged in and Claude's next call goes through.",
      ]),
      deadline: `<div style="text-align:right">${K.countdown('12:30', '10:03 pm')}<div class="faint" style="font-size:11px">then this window closes</div></div>`,
      buttons: `${K.btn('Give up')}<span class="wf-btn primary lg">I'm done</span>`,
      foot: `Asked by ${K.link('Claude Code')} for Get cart at 9:47 pm · call ${K.link('7F2A')} · Give up closes this window and tells Claude you didn't log in.`,
      page: siteBox(
        `<div style="border:1px solid var(--wf-line-2);border-radius:6px;padding:14px;display:flex;gap:10px;align-items:center">${K.check('Verify you are human', false)}<span class="grow"></span><span class="faint">[check]</span></div>${K.lines(2)}<span class="wf-btn" style="justify-content:center">Continue</span>`,
      ),
    }),
    notes: [
      [
        660,
        50,
        "Same title as Needs you, the notification and Claude's message (vocabulary table; P5 can jump to it by name).",
      ],
      [40, 106, 'Numbered steps answer Sam\'s question "do I press I\'m done before or after?" (P2 S2).'],
      [
        960,
        60,
        'Deadline as countdown plus clock time, and what happens at zero (E5). Turns to the alert tint under 1 minute (P7 C2.3).',
      ],
      [
        1150,
        112,
        'I\'m done is primary and focused only after the page is used; Give up says in the line below what it does (P2: "sounds final").',
      ],
      [
        40,
        140,
        'Who asked and the call are links into the main window (principle 3). Hosts are values, not prose (E3).',
      ],
      [
        700,
        330,
        "The page is the site's own. Valet never marks anything inside it, where the site could fake it; all of Valet's words stay in the banner.",
      ],
    ],
  })

  FRAMES.push({
    id: 'login-handoff-code',
    group: 'Own windows',
    title: 'Login hand-off: one-time code',
    personas: ['P2', 'P7', 'P1'],
    desc: "Woolworths texted a code that Valet can't read. Same window, a different title and steps, and a way to let Valet read codes next time.",
    html: loginWin({
      title: 'Log in to Woolworths (one-time code)',
      tone: 'info',
      what:
        steps([
          'Woolworths texted a code to your phone. Type it on the page below.',
          "Press <b>I'm done</b>.",
        ]) +
        `<div class="row" style="gap:8px;margin-top:2px"><span class="muted">Valet can read these codes from Messages for you next time.</span>${K.btn('Set up one-time codes…')}</div>`,
      deadline: `<div style="text-align:right">${K.countdown('9:05', '10:03 pm')}<div class="faint" style="font-size:11px">the code itself expires sooner</div></div>`,
      buttons: `${K.btn('Give up')}<span class="wf-btn primary lg">I'm done</span>`,
      foot: `Asked by ${K.link('Claude Code')} for Get cart at 9:53 pm · call ${K.link('7F31')}`,
      page: siteBox(
        `<span>Enter the 6-digit code we sent to •••• 042</span><span class="wf-input" style="width:auto;justify-content:center;letter-spacing:8px;outline:2px solid var(--wf-act);outline-offset:1px">_ _ _ _ _ _</span><span class="wf-btn" style="justify-content:center">Verify</span><span class="faint" style="text-align:center">Resend code</span>`,
      ),
    }),
    notes: [
      [560, 50, 'Title "(one-time code)" matches the vocabulary row and the tool result (P6).'],
      [
        690,
        120,
        '"Set up one-time codes…" opens Secrets › One-time codes as a sheet over the main window, and returns here (principle 5).',
      ],
      [
        790,
        405,
        "Focus goes to the page's first field so the code can be typed at once; the banner stays reachable with ⌘⌥↑ (assumption; P5 needs a named landmark for it).",
      ],
      [
        960,
        64,
        "The window deadline is Valet's; the code's own expiry is the site's, so the banner says so rather than guessing.",
      ],
    ],
  })

  FRAMES.push({
    id: 'login-handoff-not-yet',
    group: 'Own windows',
    title: 'Login hand-off: "I\'m done" but not logged in',
    personas: ['P2', 'P7'],
    desc: 'Valet checked after "I\'m done" and Woolworths still shows the login page. Today nothing says what happens in this case (P7 C2.3).',
    html: loginWin({
      title: 'Log in to Woolworths (verification check)',
      tone: 'bad',
      what: `<div><b>Woolworths still shows its login page.</b> Valet checked at 9:55 pm and you're not logged in yet. Finish on the page below, then press I'm done again.</div>`,
      deadline: `<div style="text-align:right"><span class="wf-count" style="color:var(--wf-bad)">0:48<small> until 10:03 pm</small></span><div style="font-size:11px;color:var(--wf-bad)">then this window closes</div></div>`,
      buttons: `${K.btn('Give up')}<span class="wf-btn primary lg">I'm done</span>`,
      foot: `Still stuck? ${K.link('Open woolworths.com.au in Safari')} to check your password works there, then ${K.link('change the login Valet uses')}.`,
      page: siteBox(
        `${K.input('Email', '100%')}${K.input('Password', '100%')}<span class="wf-btn" style="justify-content:center">Log in</span>`,
      ),
    }),
    notes: [
      [
        700,
        56,
        'Says what Valet saw, when it checked, and what to do; the window stays open (no silent close).',
      ],
      [960, 64, 'Under 1 minute: alert colour and one announcement (P5, P7 C2.3).'],
      [
        700,
        94,
        'A way out of a loop: check the password outside Valet, then change the login from the Woolworths site page (principle 4).',
      ],
    ],
  })
})()
