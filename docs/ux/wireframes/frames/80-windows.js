// Own windows: the confirmation and the login hand-off (principle 5, P10, E5; P7 and P2 walkthroughs).
;(() => {
  const { K, shell, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Own windows'] =
    "Only two things get their own window, because they must be answered on the Mac and at once: the confirmation (floats on top, on every Space) and the login hand-off (the site's own login page with Valet's banner above it). Needs you, the menu bar and the notification all bring these windows forward; none of them answers in their place. Story moment: 9:48 pm, 4 waiting."

  // ---- confirmation window (460 wide, content-sized up to 620) ----
  const focusRing = 'outline:2px solid var(--wf-act);outline-offset:2px;'
  const tick = (t) =>
    `<div class="row" style="align-items:flex-start;gap:8px"><span style="color:var(--wf-ok);font-weight:700">✓</span><span>${t}</span></div>`
  const conf = ({ strip, stripTone = '', body, foot }) =>
    `<div class="wf-conf" style="height:auto;max-height:620px">
      <div class="row" style="padding:8px 16px;border-bottom:1px solid var(--wf-line);flex:none;gap:8px;${stripTone ? `background:var(--wf-tint-${stripTone})` : 'background:var(--wf-paper-2)'}">
        <span class="wf-av" style="width:20px;height:20px">V</span><span class="grow muted" style="font-size:11.5px">Valet</span>${strip}</div>
      <div style="flex:1;min-height:0;overflow:hidden;padding:16px 20px;display:flex;flex-direction:column;gap:12px">${body}</div>
      ${foot ? `<div style="border-top:1px solid var(--wf-line);padding:12px 20px 12px;flex:none;display:flex;flex-direction:column;gap:6px;background:var(--wf-paper)">${foot}</div>` : ''}
    </div>`
  const title = `<div style="font:600 17px/1.3 var(--f-head)">Confirm: Remove from cart (Woolworths)</div>
    <span class="muted" style="margin-top:-6px">Claude Code asked at 9:48 pm to run <b>Remove from cart</b> on Woolworths.</span>`
  const fromSite = (dim = false) => `
    <div style="padding:10px 12px;border-radius:8px;border:1px dashed var(--wf-line-2);display:flex;flex-direction:column;gap:4px">
      <span class="faint" style="font-size:11px">From the site · written by the Woolworths adapter; Valet can't check its wording</span>
      <div style="font:600 18px/1.3 var(--f-head);${dim ? 'color:var(--wf-ink-3);text-decoration:line-through;text-decoration-thickness:1px' : ''}">Remove Cavendish Bananas (2 × $0.79) from your trolley?</div>
    </div>`
  const checked = (details = false) => `
    <div class="col" style="gap:6px;padding:10px 12px;border:1px solid var(--wf-line);border-radius:8px">
      <span class="faint" style="font-size:11px">Valet checked the request itself</span>
      ${tick('Changes only your cart, with one request to woolworths.com.au')}
      ${tick('Woolworths 0.3.0, the version you approved on Fri 6 Nov')}
      ${tick("Can't pay, check out or change your account")}
      ${
        details
          ? `<span style="font-size:11px">▾ Details</span>${K.kv([
              ['Tool', `Remove from cart ${K.value('remove_from_cart')}`],
              ['Call', K.link('7F2A')],
              ['Request', K.value('POST /api/v3/ui/trolley/update')],
              ['Input', K.value('{ "stockcode": 133211 }')],
              ['Version', `0.3.0 ${K.value('9f3c…e0f1')}`],
            ])}`
          : '<span class="faint" style="font-size:11px">▸ Details: tool, call, request, version</span>'
      }
    </div>`
  const buttons = (left, removeDisabled = false) =>
    `<div class="row" style="gap:8px">${left}<span class="grow"></span>
      <span class="wf-btn lg" style="${focusRing}">Don't remove</span>
      ${removeDisabled ? '<span class="wf-btn lg" aria-disabled="true" style="color:var(--wf-ink-3);border-style:dashed">Remove from cart</span>' : '<span class="wf-btn lg primary">Remove from cart</span>'}</div>`
  const of4 = '<span class="faint" style="font-size:11px">1 of 4 waiting</span>'

  FRAMES.push({
    id: 'confirm-arming',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, just came forward (arming)',
    personas: ['P1', 'P2', 'P5', 'P7'],
    desc: 'For 0.8 s after the window appears or regains focus, "Remove from cart" is disabled and says why. "Don\'t remove" already has focus.',
    html: conf({
      strip: of4,
      body:
        title +
        fromSite() +
        checked() +
        `<div class="muted" style="font-size:11.5px">If nobody answers by 9:50 pm, nothing is removed and Claude is told it timed out.</div>`,
      foot:
        buttons(K.countdown('1:42', '9:50 pm'), true) +
        `<div class="faint" style="font-size:11px;text-align:right">Ready in a moment, so a key press meant for another app can't answer this.</div>`,
    }),
    notes: [
      [354, 10, '"1 of 4 waiting", the same count as the icon, the sidebar and the popover (P7 must-fix 2).'],
      [
        385,
        56,
        "The window's accessible name and heading are Valet's title, the same as Needs you and Claude's words (P5 B1, round 2 decision).",
      ],
      [
        432,
        169,
        'The site\'s own sentence still leads visually, inside an attributed "From the site" box; it is the dialog\'s description, not its name (P3, P6, P10).',
      ],
      [
        312,
        300,
        'What Valet checked, in three plain lines; tool, call, hash and request move under Details (E8, P2 m2).',
      ],
      [
        149,
        431,
        'Countdown beside the buttons (P7). Buttons use the tool\'s approved title, "Remove from cart", and "Don\'t remove"; focus and Return are on the safe one (IA §10, P1, P5).',
      ],
      [
        0,
        463,
        'The reason "Remove from cart" is disabled is visible and is its accessible description; it clears at 0.8 s.',
      ],
    ],
  })

  FRAMES.push({
    id: 'confirm-ready',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, ready, with Details open',
    personas: ['P2', 'P4', 'P5', 'P7'],
    desc: 'The normal state. Return and Escape choose "Don\'t remove"; "Remove from cart" needs a click, or Tab then Space. The window sizes to its content up to 620 px and scrolls above a sticky footer.',
    html: conf({
      strip: of4,
      body: title + fromSite() + checked(true),
      foot:
        buttons(K.countdown('1:42', '9:50 pm')) +
        `<div class="faint" style="font-size:11px">Valet never pays. Checkout is always you, on woolworths.com.au.</div>`,
    }),
    notes: [
      [
        12,
        392,
        'Details open in place, and stay open when "Show technical details" is on (P1). Tool id, call 7F2A and version for matching a run (P4); values are selectable with copy (E3).',
      ],
      [
        149,
        510,
        "Return = Don't remove (P1). Focus is contained in the window; Tab order: Details, Don't remove, Remove from cart (P5).",
      ],
      [442, 543, 'The money line Sam asked for in this window (P2 part 4).'],
    ],
  })

  FRAMES.push({
    id: 'confirm-urgent',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, under 30 seconds',
    personas: ['P7', 'P5'],
    desc: 'The countdown grows and turns to the alert colour; one announcement at 30 s. The count stays, and nothing else moves, so the buttons stay where the hand already is.',
    html: conf({
      strip:
        '<b style="font-size:11px;color:var(--wf-bad)">Ends in 0:24</b><span class="faint" style="font-size:11px">· 1 of 4 waiting</span>',
      stripTone: 'bad',
      body: title + fromSite() + checked(),
      foot:
        buttons(
          `<span class="wf-count" style="font-size:22px;color:var(--wf-bad);display:flex;align-items:baseline;gap:8px">0:24<small>until 9:50 pm</small></span>`,
        ) +
        `<div style="font-size:11px;color:var(--wf-bad)">At 9:50 pm nothing is removed and Claude is told it timed out.</div>`,
    }),
    notes: [
      [
        273,
        10,
        'The strip turns to the alert tint and keeps "1 of 4 waiting" beside the time left (P7 m7). VoiceOver reads it once at 30 s, not every second (P5).',
      ],
      [
        151,
        392,
        'Bigger countdown, same position, with space before "until" (P5 m2). Reduce Motion: no pulse, colour and size only.',
      ],
      [442, 420, 'The time-out sentence appears once, here (P7 m7).'],
      [432, 234, 'Urgency never moves focus to "Remove from cart" or changes the default.'],
    ],
  })

  FRAMES.push({
    id: 'confirm-answered',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, just answered',
    personas: ['P7', 'P5', 'P6'],
    desc: 'After "Remove from cart", the window says what happened and offers the next waiting item, then closes by itself after 5 s (unless it has focus or the pointer).',
    html: conf({
      strip: '<span class="faint" style="font-size:11px">3 still waiting</span>',
      stripTone: 'ok',
      body: `<div style="font:600 17px/1.3 var(--f-head)">Confirm: Remove from cart (Woolworths)</div>
        <div class="wf-banner ok"><div class="grow"><b>You chose Remove from cart at 9:48 pm.</b> Valet is doing it now; Claude Code gets the result of call ${K.link('7F2A')}.</div></div>
        <div class="h3">Next, by deadline</div>
        ${K.inbox('⇄', 'Approve a connection', 'Asked 9:47 pm · calls itself "Claude (claude.ai)", not verified', K.countdown('3:58', '9:52 pm'), `<span class="wf-btn" style="${focusRing}">Open</span>`)}
        <span class="faint" style="font-size:11px">If you chose "Don't remove", this says "You chose Don't remove at 9:48 pm. Nothing was removed; Claude Code was told you declined."</span>`,
      foot: `<div class="row"><span class="faint" style="font-size:11px">Closes in 5 s</span><span class="grow"></span>${K.btn('Close')}</div>`,
    }),
    notes: [
      [
        442,
        106,
        'Says what was chosen and when, in the same words as the buttons, and names the call (P7 m8).',
      ],
      [
        56,
        195,
        'The next item by deadline, one step away, so P7 knows whether to stay at the Mac. Open goes to the code sheet; a confirmation would open in place.',
      ],
      [425, 274, 'The declined wording is told apart from missed (confirm: declined vs timed-out, P6).'],
      [91, 333, 'Closes after 5 s unless focused or hovered; the result is announced politely (P5).'],
    ],
  })

  const retryBox = `<div class="col" style="gap:6px;padding:10px 12px;border-radius:8px;border:1px solid var(--wf-line-2);box-shadow:0 8px 20px var(--wf-shadow)">
      <b>Ask Claude to try again</b><span class="muted" style="font-size:11.5px">Send this to Claude, wherever you're talking to it:</span>
      <div style="padding:8px 10px;border-radius:6px;background:var(--wf-paper-2);border:1px solid var(--wf-line);user-select:text">In Valet, "Confirm: Remove from cart (Woolworths)" was missed at 9:50 pm (call 7F2A). Please try again; I'm at the Mac now.</div>
      <div class="row">${K.primary('Copy')}<span class="faint" style="font-size:11px">Big enough to retype on a phone.</span></div></div>`
  FRAMES.push({
    id: 'confirm-missed',
    group: 'Own windows',
    size: 'conf',
    title: 'Confirmation, missed',
    personas: ['P7', 'P6', 'P2'],
    desc: 'Runs on from the story to 9:50 pm. If the window is on screen when time runs out, it stays and says what happened. The same item moves to Needs you › Missed for 24 hours.',
    html: conf({
      strip: K.badge('Missed', 'idle'),
      body:
        `<div style="font:600 17px/1.3 var(--f-head)">Missed: Confirm: Remove from cart (Woolworths)</div>` +
        `<div class="wf-banner idle"><div class="grow"><b>Nobody answered by 9:50 pm.</b> Nothing was removed. Claude Code was told it timed out.</div></div>` +
        fromSite(true) +
        `<div class="row">${K.btn('Ask Claude to try again…')}${K.ghost('Open call 7F2A')}</div>` +
        retryBox,
      foot: `<div class="row"><span class="faint" style="font-size:11px">Also in Needs you › Missed until 9:50 pm tomorrow</span><span class="grow"></span><span class="wf-btn lg" style="${focusRing}">Close</span></div>`,
    }),
    notes: [
      [
        442,
        56,
        'The title takes the "Missed:" prefix, the same as the notification and the Needs you row (P6 M5).',
      ],
      [
        442,
        106,
        'Says which (missed, not declined) and when, unlike today\'s "answered or has timed out" (P7 C5.3).',
      ],
      [
        308,
        275,
        'The one retry action: "Ask Claude to try again…" opens this box with the sentence and Copy. Valet never retries by itself (round 2 decision).',
      ],
      [
        291,
        502,
        'Only if the window was on screen does it stay; if the Mac was locked it closes and the Missed notification and row remain (IA §10).',
      ],
    ],
  })

  // ---- login hand-off (1180 x 780: the login window with Valet's banner on top) ----
  const loginWin = ({
    title,
    tone = 'warn',
    what,
    deadline,
    buttons,
    foot,
    page,
    url = 'auth.woolworths.com.au/u/login',
  }) =>
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
        <span>🔒 Private login window; no adapter code runs here.</span><span>Can only open ${K.value('woolworths.com.au')} ${K.value('auth.woolworths.com.au')}</span><span class="grow"></span><span>Valet filled your email and password (Keychain copy)</span></div>
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;background:var(--wf-paper)">
        <div class="row" style="flex:none;padding:6px 14px;border-bottom:1px solid var(--wf-line)">${K.icon('‹')}${K.icon('↻')}<span class="wf-input" style="flex:1;font-family:var(--f-mono);font-size:11px">🔒 ${url}</span></div>
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:40px;gap:12px">${page}</div>
      </div>
    </div>`
  const steps = (items) =>
    `<div style="display:flex;flex-direction:column;gap:3px">${items.map((t, i) => `<div class="row" style="gap:8px;align-items:baseline"><b style="width:12px;flex:none">${i + 1}.</b><span>${t}</span></div>`).join('')}</div>`
  const siteBox = (inner) =>
    `<div style="width:380px;border:1px dashed var(--wf-line-2);border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:12px;align-items:stretch"><b style="font-size:16px;text-align:center">Woolworths</b><span class="faint" style="text-align:center;font-size:10.5px">(the site's own page, drawn as a placeholder)</span>${inner}</div>`
  const doneBtns = (more = true) =>
    `<span class="wf-btn primary lg" style="${focusRing}">I'm done</span>${more ? K.btn('5 more minutes') : ''}${K.ghost('Give up')}`
  const asked = `Asked by ${K.link('Claude Code')} for Get cart at 9:47 pm · call ${K.link('9A71')}`

  FRAMES.push({
    id: 'login-handoff',
    group: 'Own windows',
    title: 'Login hand-off: verification check',
    personas: ['P2', 'P7', 'P6', 'P5'],
    desc: 'Valet logged in with the Keychain copy of the 1Password login and hit a check only a person may do. The banner says what to do, in order, until when, and what each button does.',
    html: loginWin({
      title: 'Log in to Woolworths (verification check)',
      what: steps([
        'Finish the check on the Woolworths page below.',
        'If Woolworths asks again, log in. Valet already typed your email and password.',
        "Press <b>I'm done</b>. Valet checks you're logged in, and Claude's next call goes through.",
      ]),
      deadline: `<div style="text-align:right">${K.countdown('14:10', '10:02 pm')}<div class="faint" style="font-size:11px">then this window closes</div></div>`,
      buttons: doneBtns(),
      foot: `${asked} · Claude finds out on its next call, whichever button you press.`,
      page: siteBox(
        `<div style="border:1px solid var(--wf-line-2);border-radius:6px;padding:14px;display:flex;gap:10px;align-items:center">${K.check('Verify you are human', false)}<span class="grow"></span><span class="faint">[check]</span></div>${K.lines(2)}<span class="wf-btn" style="justify-content:center">Continue</span>`,
      ),
    }),
    notes: [
      [
        869,
        51,
        "Same title as Needs you, the notification and Claude's message (vocabulary table; P5 can jump to it by name).",
      ],
      [51, 75, 'Numbered steps answer Sam\'s "do I press I\'m done before or after?" (P2 S2).'],
      [
        1014,
        64,
        '15 minutes from 9:47 pm: until 10:02 pm (story; P7 #13). Turns to the alert tint under 1 minute.',
      ],
      [
        977,
        73,
        'I\'m done comes first in reading and Tab order and has focus when the window opens; the banner is a named region (P5 M6, round 2 fix). "5 more minutes" can be pressed any time (P7 #4).',
      ],
      [
        869,
        135,
        'Call 9A71 and Claude Code are links into the main window. "Claude finds out on its next call" replaces a promise nothing kept (P6 M1).',
      ],
      [
        785,
        336,
        "The page is the site's own. Valet never marks anything inside it, where the site could fake it.",
      ],
    ],
  })

  FRAMES.push({
    id: 'login-handoff-code',
    group: 'Own windows',
    title: 'Login hand-off: one-time code',
    personas: ['P2', 'P7', 'P1'],
    desc: "The same call, 9A71, when Woolworths texts a code that Valet can't read. Same window, a different title and steps, and a way to let Valet read codes next time.",
    html: loginWin({
      title: 'Log in to Woolworths (one-time code)',
      tone: 'info',
      what:
        steps([
          'Woolworths texted a code to your phone. Type it on the page below.',
          "Press <b>I'm done</b>.",
        ]) +
        `<div class="row" style="gap:8px;margin-top:2px"><span class="muted">Valet can read these codes from Messages for you next time.</span>${K.btn('Set up one-time codes…')}</div>`,
      deadline: `<div style="text-align:right">${K.countdown('14:10', '10:02 pm')}<div class="faint" style="font-size:11px">the code itself may expire sooner</div></div>`,
      buttons: doneBtns(),
      foot: `${asked} · Claude finds out on its next call.`,
      page: siteBox(
        `<span>Enter the 6-digit code we sent to •••• 042</span><span class="wf-input" style="width:auto;justify-content:center;letter-spacing:8px">_ _ _ _ _ _</span><span class="wf-btn" style="justify-content:center">Verify</span><span class="faint" style="text-align:center">Resend code</span>`,
      ),
    }),
    notes: [
      [869, 51, 'Title "(one-time code)" matches the vocabulary row and the tool result (P6).'],
      [
        590,
        126,
        '"Set up one-time codes…" opens Secrets › One-time codes as a sheet over the main window, and returns here (principle 5).',
      ],
      [
        785,
        382,
        "Focus starts on I'm done like every hand-off; ⌘⌥↓ (or one Tab) moves into the page, where the code field is first (P5 M6).",
      ],
      [
        966,
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
    desc: 'Runs on to 10:01 pm. Valet checked after "I\'m done" and Woolworths still shows the login page; under a minute is left, so "5 more minutes" is the obvious way out.',
    html: loginWin({
      title: 'Log in to Woolworths (verification check)',
      tone: 'bad',
      what: `<div><b>Woolworths still shows its login page.</b> Valet checked at 10:01 pm and you're not logged in yet. Finish on the page below, then press I'm done again.</div>`,
      deadline: `<div style="text-align:right"><span class="wf-count" style="color:var(--wf-bad)">0:48<small> until 10:02 pm</small></span><div style="font-size:11px;color:var(--wf-bad)">then this window closes</div></div>`,
      buttons: doneBtns(),
      foot: `Still stuck? ${K.link('Open woolworths.com.au in Safari')} to check your password works there, then ${K.link('Choose login…')} on the Woolworths page.`,
      page: siteBox(
        `${K.input('Email', '100%')}${K.input('Password', '100%')}<span class="wf-btn" style="justify-content:center">Log in</span>`,
      ),
    }),
    notes: [
      [
        29,
        75,
        'Says what Valet saw, when it checked, and what to do; the window stays open (no silent close).',
      ],
      [
        1038,
        49,
        'Under 1 minute: alert colour and one announcement. "5 more minutes" adds time once per press, up to 30 minutes in all (assumption; P7 #4).',
      ],
      [
        611,
        113,
        'A way out of a loop: check the password outside Valet, then "Choose login…" on the Woolworths page (principle 4; the story\'s button word).',
      ],
    ],
  })

  FRAMES.push({
    id: 'login-handoff-success',
    group: 'Own windows',
    title: 'Login hand-off: logged in',
    personas: ['P7', 'P6', 'P2'],
    desc: 'Runs on to 9:55 pm. After "I\'m done", Valet checked and the person is logged in. The banner says so, says what Claude will be told, and the window closes itself.',
    html: loginWin({
      title: 'Log in to Woolworths (verification check)',
      tone: 'ok',
      what: `<div><b>Logged in to Woolworths.</b> Valet checked at 9:55 pm. This window closes in 5 s.</div>
        <div class="row" style="gap:8px;align-items:flex-start"><span class="muted" style="flex:none">Claude Code's next call is told:</span>${K.value('The person finished logging in to Woolworths at 9:55 pm. Call again now.')}</div>`,
      deadline: `<span class="faint" style="font-size:11px">3 still waiting in Needs you</span>`,
      buttons: `<span class="wf-btn primary lg" style="${focusRing}">Close</span>${K.btn('Open Needs you')}`,
      foot: `${asked} · Logged in once; later calls reuse this login until Woolworths ends it.`,
      url: 'www.woolworths.com.au/shop',
      page: siteBox(`<span style="text-align:center">Hi Sam</span>${K.lines(3)}`),
    }),
    notes: [
      [
        29,
        75,
        'The finished state P7 asked for: what happened and when, in green, then the window closes itself (P7 #3).',
      ],
      [
        774,
        99,
        'The exact sentence Claude gets on its next call, as a copyable value, so the app and the tool result can be checked against each other (P6 M1, P4).',
      ],
      [
        1000,
        48,
        'The count of what is still waiting, with a way there, so P7 knows whether he can go back to the couch.',
      ],
      [
        954,
        122,
        'Assumption: Valet doesn\'t push this to Claude; it can only answer the next call. Claude Code\'s result for 9A71 already said "call again after the person has logged in".',
      ],
    ],
  })

  const expiredPage = `
    ${K.header({ title: 'Needs you', status: K.badge('3 waiting', 'warn') })}
    <div class="wf-scroll">
      <div class="col">
        ${K.inbox('⇄', 'Approve a connection', 'Asked 10:00 pm · calls itself "Claude (claude.ai)" (not verified)', K.countdown('3:10', '10:05 pm'), K.btn('Decline') + K.btn('Approve…'))}
        ${K.inbox('↑', 'Review the Woolworths update (0.4.0)', 'Adds 1 host, 1 read tool · calls use 0.3.0 until you approve', '', K.primary('Review update'))}
      </div>
      <div class="row faint" style="margin-top:8px"><span class="h3" style="color:var(--wf-ink-2)">Missed in the last 24 hours</span></div>
      <div style="outline:2px solid var(--wf-act);outline-offset:2px;border-radius:10px">${K.inbox('→', 'Missed: Log in to Woolworths (verification check)', `The login window closed at 10:02 pm without a login · call ${K.link('9A71')}`, '', K.btn('Ask Claude to try again…') + K.btn('Log in now…') + K.ghost('Dismiss'), 'missed')}</div>
      ${K.inbox('?', 'Missed: Confirm: Remove from cart (Woolworths)', `Nobody answered by 6:12 pm, so nothing was removed · call ${K.link('5C10')}`, '', K.btn('Ask Claude to try again…') + K.ghost('Dismiss'), 'missed')}
      <div class="row muted" style="font-size:11.5px;gap:8px">Claude Code's next Woolworths call is told: ${K.value('The login window for Woolworths closed at 10:02 pm without a login (needs-user: missed).')}</div>
    </div>`
  const expiredNote = `<div style="position:absolute;top:56px;right:16px;z-index:6;width:344px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:14px;box-shadow:0 10px 30px var(--wf-shadow);padding:10px 12px;display:flex;flex-direction:column;gap:6px">
      <div class="row" style="gap:8px"><span class="wf-av" style="width:22px;height:22px;border-radius:6px">V</span><span class="faint" style="font-size:10.5px;text-transform:uppercase">Valet</span><span class="grow"></span><span class="faint" style="font-size:10.5px">10:02 pm</span></div>
      <b style="font-size:12.5px">Missed: Log in to Woolworths (verification check)</b><span class="muted" style="font-size:11.5px">The login window closed at 10:02 pm without a login.</span>
      <div class="row" style="gap:6px;border-top:1px solid var(--wf-line);padding-top:6px">${K.primary('Open')}</div></div>`
  FRAMES.push({
    id: 'login-handoff-expired',
    group: 'Own windows',
    title: 'Login hand-off ran out',
    personas: ['P7', 'P6', 'P2'],
    desc: 'Runs on to 10:02 pm, 15 minutes after call 9A71. The login window closes, its notification is replaced by "Missed: …", and the item moves to Needs you › Missed, like a missed confirmation.',
    html: shell('needs', expiredPage, { badges: { needs: 3 }, over: expiredNote }),
    notes: [
      [
        786,
        118,
        'The notification is replaced, never taken down: "Missed: {original title}" (P7 #3, Needs you table).',
      ],
      [
        969,
        296,
        'The Missed row has focus when opened from the notification. "Log in now…" opens a fresh login window without waiting for Claude (assumption: a login on its own is safe, it fills only the approved login page).',
      ],
      [791, 296, 'The same retry action as a missed confirmation (round 2 decision).'],
      [1144, 452, 'The exact result string Claude Code gets on its next Woolworths call (P6 M1).'],
    ],
  })
})()
