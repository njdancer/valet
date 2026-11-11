// Needs you: the one inbox (P1, principles 1 and 2).
;(() => {
  const { K, shell, sheet, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Needs you'] =
    'The first place in the sidebar and where the window opens when anything waits (P8a). Every waiting thing in Valet is here, with the same title the menu bar, the notification and Claude use.'

  const waiting = `
    ${K.header({
      title: 'Needs you',
      status: K.badge('4 waiting · next ends in 1:42', 'warn'),
      actions: K.ghost('Notification settings'),
    })}
    <div class="wf-scroll">
      <div class="col">
        ${K.inbox('?', 'Confirm: Remove from cart (Woolworths)', `Claude Code asked at 9:48 pm · call ${K.link('7F2A')}`, K.countdown('1:42', '9:50 pm'), K.primary('Answer…'), 'urgent')}
        ${K.inbox('⇄', 'Approve a connection', 'Asked 9:47 pm from 203.0.113.24 · calls itself "Claude (claude.ai)" (not verified)', K.countdown('4:10', '9:52 pm'), K.btn('Decline') + K.btn('Approve…'))}
        ${K.inbox('→', 'Log in to Woolworths (verification check)', `A check only you can do · call ${K.link('9A71')} get_cart for ${K.link('Claude Code')}`, K.countdown('14:10', '10:02 pm'), K.btn('Show login window'))}
        ${K.inbox('↑', 'Review the Woolworths update (0.4.0)', 'Adds 1 host, 1 read tool · calls use 0.3.0 until you approve', '', K.btn('Review update'))}
      </div>
      <div class="row faint" style="margin-top:8px"><span class="h3" style="color:var(--wf-ink-2)">Missed in the last 24 hours</span></div>
      ${K.inbox('?', 'Missed: Confirm: Remove from cart (Woolworths)', `Nobody answered by 6:12 pm, so nothing was removed · call ${K.link('5C10')}`, '', K.btn('Ask Claude to try again…') + K.ghost('Dismiss'), 'missed')}
    </div>`

  FRAMES.push({
    id: 'needs-you',
    group: 'Needs you',
    title: 'Needs you, four things waiting',
    personas: ['P1', 'P2', 'P5', 'P6', 'P7'],
    desc: 'Sorted by deadline. Each row has one main action that opens the item where it is answered.',
    html: shell(
      'needs',
      waiting.replace(
        'wf-inbox urgent',
        'wf-inbox urgent" style="outline:2px solid var(--wf-act);outline-offset:2px',
      ),
      { badges: { needs: 4 } },
    ),
    notes: [
      [
        212,
        112,
        "Keyboard: ↑↓ move between rows (the first row has focus when the page opens), Return runs the row's main action, Delete dismisses a missed item (P1 M7, P5).",
      ],
      [
        470,
        66,
        'The header counts what waits and when the next one ends (P7). The window title says the same, for VoiceOver.',
      ],
      [
        1080,
        120,
        '"Answer…" brings the confirmation window forward. A confirmation is never approved here: the main process only accepts Allow from that window, which is today\'s tray bug (N03).',
      ],
      [
        470,
        120,
        'Every reference is a link: the call 7F2A opens its trace, Claude Code opens its Connections page (principle 3).',
      ],
      [
        960,
        120,
        'Deadline shows the countdown and the clock time. Under 30 s the row turns urgent; announced at 2 min, 1 min and 30 s only (P5).',
      ],
      [
        1060,
        290,
        'An update has no deadline, so it sorts last. "Review update" is the same label as on the site page and in Claude\'s words (E1).',
      ],
      [
        700,
        355,
        'Missed items stay 24 hours, so a timeout leaves a trace. "Ask Claude to try again…" shows the sentence to send, with Copy, so it works when Claude is on a phone; Valet never retries by itself.',
      ],
    ],
  })

  const empty = `
    ${K.header({ title: 'Needs you', status: K.badge('Nothing waiting', 'ok') })}
    <div class="wf-scroll">
      ${K.empty('Nothing needs you', 'When Claude needs a login, a confirmation or a review, it shows up here and in the menu bar.', '')}
      <div class="wf-card"><header><h4>Status</h4><span class="grow"></span>${K.ghost('Check all now')}</header><div class="body">
        ${K.health('ok', '<b>Woolworths</b> · Ready · store Town Hall · logged in, checked 9:40 pm', K.ghost('Open'))}
        ${K.health('warn', '<b>Yahoo Finance</b> · Yahoo Finance is limiting requests · calls resume at 9:52 pm', K.btn('Try now') + K.ghost('Pause site'))}
        ${K.health('ok', '<b>Wikipedia</b> · Ready', K.ghost('Open'))}
        <div class="row" style="border-top:1px solid var(--wf-line);padding-top:8px;gap:24px">
          <span class="row">${K.dot('ok')} Endpoint on, this Mac only · 2 apps connected ${K.link('Connections')}</span>
          <span class="row">${K.dot('ok')} Audit log checks out · verified 9:41 pm ${K.ghost('Check now')}</span>
          <span class="row">${K.dot('idle')} Remote access off</span>
        </div>
      </div></div>
      <div class="row muted">Today: ${K.link('37 calls')} · ${K.link('2 failed')} · ${K.link('12 requests blocked')} <span class="grow"></span> Valet never pays or checks out for you.</div>
    </div>`

  FRAMES.push({
    id: 'needs-you-empty',
    group: 'Needs you',
    title: 'Needs you, nothing waiting',
    personas: ['P2', 'P3'],
    desc: 'The empty state doubles as the system status that P2 and P3 wanted from a Home page.',
    html: shell('needs', empty, {
      badges: {},
      sites: [
        ['W', 'Woolworths', 'ok'],
        ['Y', 'Yahoo Finance', 'warn'],
        ['W', 'Wikipedia', 'ok'],
      ],
    }),
    notes: [
      [560, 140, 'Says it in words, then says what would appear here (P2).'],
      [
        960,
        236,
        'One health line per site with its action (E6). Limited sites get Try now and Pause site in place (P1).',
      ],
      [700, 380, 'Every status says when it was checked and can be re-checked (principle 8, P3).'],
      [420, 430, 'Numbers are doors: each opens Calls filtered (E7).'],
      [1000, 430, 'The line Sam asked for, always visible.'],
    ],
  })

  const approveSheet = sheet(
    'Approve a connection',
    `<div class="wf-banner warn"><div class="grow"><b>If you didn't start this, decline it.</b> Approving lets this agent call the tools you tick, from anywhere, until you remove it.</div></div>
     ${K.kv([
       ['Asked', '9:47 pm · ends 9:52 pm ' + K.countdown('4:10', '9:52 pm')],
       ['From', K.value('203.0.113.24')],
       ['Calls itself', '"Claude (claude.ai)" <span class="faint">· not verified</span>'],
     ])}
     <div class="row"><label class="h3" style="width:140px">Code</label>${K.input('Type the code your browser shows', '260px')}</div>
     <div class="h3">Tools it may use <span class="faint" style="font-weight:400">· none until you tick them</span></div>
     <div class="col">${K.check('Woolworths · Search products, Product details, View cart (read)', false)}${K.check('Woolworths · Change cart (asks you to confirm removals)', false)}${K.check('Yahoo Finance · Quotes and history (read)', false)}</div>
     <div class="wf-health"><span class="grow"><b>Can reach if approved:</b> nothing yet. Tick tools to see which sites and logins this agent could use.</span></div>`,
    `${K.btn('Decline')}<span class="grow"></span>${K.btn('Cancel')}${K.btn('Approve', 'primary" style="opacity:.55')}`,
  )
  FRAMES.push({
    id: 'needs-you-approve-connection',
    group: 'Needs you',
    title: 'Approve a connection (code sheet)',
    personas: ['P3', 'P7'],
    desc: 'Opens over Needs you. The code is typed, never shown by Valet or Claude, so the check that it is really you stays intact (P7).',
    html: shell('needs', waiting, { badges: { needs: 4 }, over: approveSheet }),
    notes: [
      [
        300,
        100,
        'Who is asking comes first: time, address and the name it claims, marked not verified, with a plain warning (P1 B2, P3).',
      ],
      [
        745,
        268,
        'The code comes from the browser page only. Valet never displays it, and neither does Claude (P7).',
      ],
      [
        300,
        300,
        'Nothing is pre-ticked: remote tools are off by default (P3). Same tool list as Sites and Connections (one source).',
      ],
      [
        330,
        380,
        'Can reach updates as tools are ticked, so the blast radius is visible before approving (P3).',
      ],
      [
        880,
        440,
        'Decline and Approve have equal weight. Approve stays focusable while disabled and says why ("Type the code first") (P5).',
      ],
    ],
  })
  const more = `
    ${K.header({ title: 'Needs you', status: K.badge('5 waiting · none time-limited', 'idle') })}
    <div class="wf-scroll"><div class="col">
      ${K.inbox('!', 'Woolworths changed: the adapter needs an update', `Call ${K.link('6B3E')} search_products failed at 8:05 pm · the authoring agent has a repair ticket`, '', K.btn('See what broke'))}
      ${K.inbox('⚿', 'Give Valet your Woolworths login', 'Woolworths can search without it; cart tools wait for a login', '', K.btn('Choose login…'))}
      ${K.inbox('⌂', 'Choose your Woolworths store', 'Prices, specials and stock depend on the store', '', K.btn('Choose store…'))}
      ${K.inbox('⚿', 'Unlock 1Password', 'Valet needs 1Password to re-sync the Woolworths login · nothing is waiting on it yet', '', K.btn('Open 1Password'))}
      ${K.inbox('▸', 'Finish setup (2 steps left)', 'Connect Claude and Test it', '', K.btn('Continue setup'))}
    </div></div>`
  FRAMES.push({
    id: 'needs-you-more',
    group: 'Needs you',
    title: 'Needs you, the items without a deadline',
    personas: ['P2', 'P4', 'P6'],
    desc: 'A different moment (first week of use): every Needs you kind that has no deadline, each with its one action. Titles match IA section 5 and the tool results word for word.',
    html: shell('needs', more, { badges: { needs: 5 } }),
    notes: [
      [1160, 140, 'The repair ticket is a Needs you item and links to the failing call (P4).'],
      [
        1160,
        206,
        '"Give Valet your Woolworths login" opens the grant sheet; never "connect", which points at Connections (P6).',
      ],
      [1160, 273, 'Same title as the store sheet: "Choose your Woolworths store" (P2, P6).'],
      [1160, 340, 'Unlock 1Password is informational until something waits on it; it says so.'],
      [1160, 406, 'Skipped setup steps collapse into one item that counts the action steps left (story.md).'],
    ],
  })
})()
