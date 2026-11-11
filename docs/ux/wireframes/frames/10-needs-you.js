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
        ${K.inbox('✓', 'Confirm: Remove from cart (Woolworths)', `Claude Code asked at 9:48 pm · call ${K.link('7F2A')}`, K.countdown('1:42', '9:50 pm'), K.primary('Answer…'), 'urgent')}
        ${K.inbox('⇄', 'Approve a connection', 'A cloud agent is asking to connect · type the code your browser shows', K.countdown('4:10', '9:52 pm'), K.primary('Approve…') + K.ghost('Decline'))}
        ${K.inbox('→', 'Log in to Woolworths (verification check)', `Valet stopped at a check only you can do · get_cart for ${K.link('Claude Code')}`, K.countdown('12:30', '10:03 pm'), K.primary('Show login window'))}
        ${K.inbox('↑', 'Review the Woolworths update (0.4.0)', 'Adds 1 host, 1 read tool · calls use 0.3.0 until you approve', '', K.primary('Review update'))}
      </div>
      <div class="row faint" style="margin-top:8px"><span class="h3" style="color:var(--wf-ink-2)">Missed in the last 24 hours</span></div>
      ${K.inbox('✓', 'Missed: Confirm: Remove from cart (Woolworths)', `Nobody answered by 6:12 pm, so nothing was removed · call ${K.link('5C10')}`, '', K.btn('Copy a retry note for Claude') + K.ghost('Dismiss'), 'missed')}
    </div>`

  FRAMES.push({
    id: 'needs-you',
    group: 'Needs you',
    title: 'Needs you, three things waiting',
    personas: ['P1', 'P2', 'P5', 'P6', 'P7'],
    desc: 'Sorted by deadline. Each row has one main action that opens the item where it is answered.',
    html: shell('needs', waiting, { badges: { needs: 4 } }),
    notes: [
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
        'Missed items stay 24 hours, so a timeout leaves a trace. The action copies a sentence for Claude; it never retries by itself.',
      ],
    ],
  })

  const empty = `
    ${K.header({ title: 'Needs you', status: K.badge('Nothing waiting', 'ok') })}
    <div class="wf-scroll">
      ${K.empty('Nothing needs you', 'When Claude needs a login, a confirmation or a review, it shows up here and in the menu bar.', '')}
      <div class="wf-card"><header><h4>Status</h4><span class="grow"></span>${K.ghost('Check all now')}</header><div class="body">
        ${K.health('ok', '<b>Woolworths</b> · Ready · store Town Hall · logged in, checked 9:40 pm', K.ghost('Open'))}
        ${K.health('warn', '<b>Yahoo Finance</b> · Yahoo is limiting requests · calls resume at 9:52 pm', K.btn('Try now') + K.ghost('Pause site'))}
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
    html: shell('needs', empty, { badges: {} }),
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
    `<p class="muted" style="margin:0">A cloud agent opened a sign-in page and is waiting. Type the code that page shows. If you didn't start this, decline it.</p>
     <div class="row">${K.input('ABCD-1234', '200px')} ${K.countdown('4:10', '9:52 pm')}</div>
     <div class="h3">Tools it may use</div>
     <div class="col">${K.check('Woolworths · Search products, Product details, View cart', true)}${K.check('Woolworths · Change cart (asks you to confirm removals)', false)}${K.check('Yahoo Finance · Quotes and history', true)}</div>
     <p class="faint" style="margin:0">It can use only what you tick. You can change this later in Connections.</p>`,
    `${K.ghost('Decline')}<span class="grow"></span>${K.btn('Cancel')}${K.primary('Approve')}`,
  )
  FRAMES.push({
    id: 'needs-you-approve-connection',
    group: 'Needs you',
    title: 'Approve a connection (code sheet)',
    personas: ['P3', 'P7'],
    desc: 'Opens over Needs you. The code is typed, never shown by Valet or Claude, so the check that it is really you stays intact (P7).',
    html: shell('needs', waiting, { badges: { needs: 4 }, over: approveSheet }),
    notes: [
      [610, 160, 'The code comes from the browser page only. Valet never displays it.'],
      [600, 222, 'Tools are chosen here, from the same tool list as Sites and Connections (one source, P3).'],
      [880, 360, 'Approve stays focusable while disabled and says why ("Type the code first") (P5).'],
    ],
  })
})()
