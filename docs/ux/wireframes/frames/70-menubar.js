// Menu bar: the icon, its popover and the notifications (P11, E5, E10; P7's walk back to the Mac).
;(function () {
  const { K, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Menu bar'] =
    'The first thing the person sees from across the room. The icon carries the Needs you count; the popover behaves like a menu (arrow keys, focus on the first waiting row) and mirrors Needs you with the same titles, in the same order. Every row, number and site opens something.'

  // ---- popover parts (400 x 640) ----
  const head = (status, tone, right) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--wf-line);flex:none">
      <span class="wf-av" style="width:28px;height:28px;border-radius:7px;font-size:12px">V</span>
      <div class="grow" style="display:flex;flex-direction:column;gap:1px"><b style="font-size:13px">Valet</b>
        <span class="row muted" style="gap:6px;font-size:11px">${K.dot(tone)}${status}</span></div>${right}</div>`
  const pauseBtn = `<span class="row" style="gap:0">${K.btn('Pause Valet')}<span class="wf-btn" style="border-left:0;border-radius:0 6px 6px 0;margin-left:-2px;padding:0 6px">▾</span></span>`
  const sec = (label, right = '') =>
    `<div class="row" style="padding:10px 14px 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--wf-ink-3);flex:none">${label}<span class="grow"></span>${right}</div>`
  const due = (left, until, verb) =>
    `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex:none">${left ? `<span class="wf-count">${left}</span><small class="faint" style="font-size:10px">until ${until}</small>` : ''}<span style="font-size:11px;color:var(--wf-link);font-weight:600">${verb} ›</span></div>`
  const row = (kind, title, sub, right, opts = {}) =>
    `<div style="display:flex;align-items:center;gap:10px;margin:1px 8px;padding:7px 8px;border-radius:8px;flex:none;${opts.focus ? 'outline:2px solid var(--wf-act);outline-offset:-2px;background:var(--wf-sel);' : ''}${opts.urgent ? 'box-shadow:inset 3px 0 0 var(--wf-warn);' : ''}">
      <span class="wf-kind" style="width:24px;height:24px;font-size:12px">${kind}</span>
      <div class="grow" style="display:flex;flex-direction:column;gap:1px"><b style="font-size:12px;line-height:1.3">${title}</b><small class="muted" style="font-size:10.5px">${sub}</small></div>${right}</div>`
  const site = (l, name, tone, line, right = '') =>
    `<div style="display:flex;align-items:center;gap:10px;margin:0 8px;padding:6px 8px;border-radius:8px;flex:none">${K.avatar(l)}
      <div class="grow" style="display:flex;flex-direction:column"><span style="font-weight:600">${name}</span><span class="row muted" style="gap:5px;font-size:10.5px">${K.dot(tone)}${line}</span></div>${right}<span class="faint">›</span></div>`
  const item = (label, kbd = '', cls = '') =>
    `<div class="row ${cls}" style="padding:0 14px;height:26px;flex:none">${label}<span class="grow"></span>${kbd ? `<span class="faint" style="font-size:11px">${kbd}</span>` : ''}</div>`
  const hr = `<div style="border-top:1px solid var(--wf-line);margin:6px 0;flex:none"></div>`
  const tile = (num, label, tone = '') =>
    `<div style="flex:1;border:1px solid var(--wf-line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px"><b class="big" style="font-size:18px;${tone ? `color:var(--wf-${tone})` : ''}">${num}</b><span class="muted" style="font-size:10.5px">${label} ›</span></div>`
  const today = (inline) =>
    inline
      ? `<div class="row" style="padding:4px 14px 2px;gap:6px;flex:none"><span class="muted">Today</span> ${K.link('37 calls')} · ${K.link('2 failed')} · ${K.link('12 blocked')}</div>`
      : `<div class="row" style="padding:2px 14px;gap:8px;flex:none">${tile('37', 'calls')}${tile('2', 'failed', 'bad')}${tile('12', 'requests blocked')}</div>`
  const foot = (extra = '') =>
    `<div class="grow"></div>${hr}${extra}${item('Open my trolley on woolworths.com.au…')}${item('Open Valet', '⌘O')}${item('Quit Valet', '⌘Q')}<div style="height:6px;flex:none"></div>`
  const sites = (rows) => sec('Sites') + rows.join('')
  const SITES_OK = [
    site('W', 'Woolworths', 'ok', 'Ready · Town Hall · logged in'),
    site('Y', 'Yahoo Finance', 'warn', 'Yahoo is limiting requests · resumes 9:52 pm'),
    site('W', 'Wikipedia', 'ok', 'Ready'),
  ]

  // 1. Nothing waiting
  FRAMES.push({
    id: 'menubar-normal',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, nothing waiting',
    personas: ['P2', 'P7', 'P1'],
    desc: 'Says "Nothing needs you" in words, then one row per site and today\'s numbers as doors. The popover sizes to its content (up to 640 px), so there is no empty band above the menu items.',
    html: `<div class="wf-pop" style="height:auto">
      ${head('Ready · 2 apps connected', 'ok', pauseBtn)}
      ${sec('Needs you')}
      <div class="row" style="padding:6px 14px 8px;gap:8px;flex:none">${K.dot('ok')}<span class="grow"><b>Nothing needs you</b><br><small class="muted">You'll get a notification and a count on this icon when something does.</small></span>${K.ghost('Notifications…')}</div>
      ${sites(SITES_OK)}
      ${sec('Today')}
      ${today(false)}
      ${foot()}
    </div>`,
    notes: [
      [
        384,
        18,
        'Pause has a menu (▾) holding Lock down… (P3, principle 10). Pause acts at once with Undo; Lock down asks first.',
      ],
      [
        384,
        96,
        'P7\'s "notify me about…" line lives here when the list is empty; it opens Settings › Notifications.',
      ],
      [
        372,
        178,
        'Each site row is one button that opens its Overview, with its health line (P11, E6). Today the rows are dead text.',
      ],
      [
        220,
        328,
        'Numbers are doors (E7): each tile opens Activity › Calls filtered (outcome=failed, blocked). Full tiles only when nothing waits.',
      ],
      [
        300,
        404,
        '"Open my trolley", never "Check out": Sam won\'t click anything that sounds like paying (P2).',
      ],
    ],
  })

  // 2. Several waiting
  FRAMES.push({
    id: 'menubar-waiting',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, four things waiting',
    personas: ['P7', 'P5', 'P1', 'P6'],
    desc: 'Needs you comes first and gets the room: three full rows sorted by deadline, then "+1 more", then Missed. Today shrinks to one line.',
    html: `<div class="wf-pop" style="height:auto">
      ${head('4 things need you · next ends 9:50 pm', 'warn', pauseBtn)}
      ${sec('Needs you', '<span class="wf-alert" style="margin:0">4</span>')}
      ${row('✓', 'Confirm: Remove from cart (Woolworths)', 'Claude Code is waiting · nothing is removed if no answer', due('1:42', '9:50 pm', 'Answer'), { focus: true, urgent: true })}
      ${row('⇄', 'Approve a connection', 'A cloud agent · type the code your browser shows', due('4:10', '9:52 pm', 'Approve'))}
      ${row('→', 'Log in to Woolworths (verification check)', 'Login window is open · for Claude Code', due('12:30', '10:03 pm', 'Show'))}
      <div class="row" style="padding:4px 16px;flex:none">${K.link('+1 more in Valet')}<span class="faint" style="font-size:11px">&nbsp;· Review the Woolworths update (0.4.0)</span></div>
      <div class="row muted" style="padding:2px 16px 4px;flex:none;font-size:11px">${K.dot('idle')} ${K.link('Missed (1)')} · Confirm: Remove from cart, 6:12 pm</div>
      ${sites([
        site('W', 'Woolworths', 'warn', 'Needs you: log in · 0.4.0 waiting for review'),
        site('Y', 'Yahoo Finance', 'ok', 'Ready'),
        site('W', 'Wikipedia', 'ok', 'Ready'),
      ])}
      ${today(true)}
      ${foot()}
    </div>`,
    notes: [
      [
        0,
        100,
        'Focus starts here on open. ↑↓ move between rows, Tab moves between groups; each row is one button whose name is the title plus "until 9:50 pm" (P5).',
      ],
      [
        312,
        94,
        'Countdown and clock time on the right of every timed row, soonest first (E5, P7). Under 30 s the row is announced once.',
      ],
      [
        312,
        132,
        '"Answer" brings the floating confirmation window forward. Never a copy inside the main window, where Allow can\'t work (today\'s S0, P7 C1.4).',
      ],
      [
        0,
        176,
        'Remote connection requests are Needs you items like any other (P7 C3). Approve opens the code sheet over Needs you.',
      ],
      [
        384,
        282,
        '"+N more" opens Needs you in the window; no scroll area inside a popover (P1). Missed (n) opens the Missed section (P7).',
      ],
      [
        255,
        482,
        "With anything waiting, Today collapses to one line so Needs you gets the room (P7 refinement 2, today's clipping bug).",
      ],
    ],
  })

  // 3. Paused
  FRAMES.push({
    id: 'menubar-paused',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, Valet paused',
    personas: ['P1', 'P3', 'P6'],
    desc: 'Paused is the state, Resume is the button beside it. Claude\'s calls come back with "Valet is paused, nothing was sent".',
    html: `<div class="wf-pop" style="height:auto">
      ${head('Paused since 9:41 pm · calls are refused', 'warn', K.primary('Resume Valet'))}
      <div class="wf-banner warn" style="margin:10px 12px 0;flex:none;border-radius:8px"><div class="grow"><b>Valet is paused.</b> Claude is told "Valet is paused, nothing was sent" and to ask you to resume.</div></div>
      ${sec('Needs you')}
      <div class="row muted" style="padding:4px 14px 8px;flex:none">${K.dot('idle')} Nothing waiting. New requests can't arrive while paused.</div>
      ${sites([
        site('W', 'Woolworths', 'idle', 'Paused with Valet'),
        site('Y', 'Yahoo Finance', 'idle', 'Paused with Valet'),
        site('W', 'Wikipedia', 'idle', 'Paused with Valet'),
      ])}
      ${sec('Today')}
      <div class="row" style="padding:2px 14px;gap:6px;flex:none">${K.link('37 calls')} · ${K.link('2 failed')} · ${K.link('5 refused while paused')}</div>
      ${foot(item('Lock down…', '', 'muted'))}
    </div>`,
    notes: [
      [380, 26, 'Resume is the primary button and takes focus on open (E10). ⇧⌘P in the app does the same.'],
      [0, 90, 'The words match the tool result exactly (vocabulary table, "Paused · Resume"; P6).'],
      [
        300,
        220,
        'Each site says why it is quiet ("Paused with Valet"), so a paused site and a paused Valet are told apart (P1).',
      ],
      [
        262,
        364,
        'Refused calls are counted and open Calls filtered to them, so P1 can see what Claude tried while paused.',
      ],
      [110, 402, 'Lock down stays reachable while paused: Pause is not a lockdown (P3).'],
    ],
  })

  // 4. First run
  FRAMES.push({
    id: 'menubar-first-run',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, setup not finished',
    personas: ['P2', 'P5'],
    desc: 'On a fresh Mac there is no fake data: no stat tiles, no "12 blocked". The one thing to do is the first row.',
    html: `<div class="wf-pop" style="height:auto">
      ${head("Not set up yet · Claude can't use any site", 'idle', '')}
      ${sec('Needs you', '<span class="wf-alert" style="margin:0">1</span>')}
      ${row('↻', 'Finish setup (5 steps left)', 'Next: connect 1Password · about 4 minutes', due('', '', 'Continue setup'), { focus: true })}
      ${sites([
        site('W', 'Woolworths', 'idle', 'Not approved yet · part of setup'),
        site('Y', 'Yahoo Finance', 'idle', 'Not approved yet'),
      ])}
      ${sec('Today')}
      <div class="muted" style="padding:2px 14px;flex:none">No calls yet. When Claude uses a site, its calls show up here.</div>
      <div class="wf-banner ok" style="margin:12px 12px 0;flex:none"><div class="grow">Valet never pays. Checkout is always you, on woolworths.com.au.</div></div>
      ${foot()}
    </div>`,
    notes: [
      [
        370,
        22,
        'No Pause button before anything can run: there is nothing to pause yet. It appears once a site is approved.',
      ],
      [
        0,
        104,
        'Setup is re-entrant: this row opens Setup on the next unfinished step, same title as in Needs you (P9, P2 "Finish setup").',
      ],
      [
        350,
        162,
        'Site rows open the site page, where "Approve Woolworths" sits on the Overview (principle 4).',
      ],
      [384, 276, 'Honest empty state instead of the demo numbers Sam saw on day one (P2 fixture caveat).'],
      [384, 322, 'The line Sam asked for on the first screen of every surface she sees (P2 part 4).'],
    ],
  })

  // ---- desktop scenes ----
  const menubar = (icon, time = '9:48 pm') =>
    `<div style="height:26px;flex:none;display:flex;align-items:center;gap:16px;padding:0 14px;background:color-mix(in srgb,var(--wf-paper) 85%,transparent);border-bottom:1px solid var(--wf-line);font-size:12px">
      <b></b><b>Finder</b><span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Window</span><span class="grow"></span>
      ${icon}<span>⌕</span><span>Wi-Fi</span><span>Wed 11 Nov ${time}</span></div>`
  const vIcon = (badge, tone = 'alert', on = false) =>
    `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;${on ? 'background:var(--wf-sel);' : ''}"><span style="width:14px;height:14px;border:1.5px solid var(--wf-ink);border-radius:4px;display:inline-block;position:relative">${badge === 'dot' ? '' : ''}</span>${badge ? `<b style="font-size:11px;${tone === 'alert' ? 'color:var(--wf-alert)' : 'color:var(--wf-ink-2)'}">${badge}</b>` : ''}</span>`
  const note = (title, body, actions, opts = {}) =>
    `<div style="width:344px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:14px;box-shadow:0 10px 30px var(--wf-shadow);padding:10px 12px;display:flex;flex-direction:column;gap:6px;${opts.dim ? 'opacity:.6;' : ''}">
      <div class="row" style="gap:8px"><span class="wf-av" style="width:22px;height:22px;border-radius:6px">V</span><span class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">Valet</span><span class="grow"></span><span class="faint" style="font-size:10.5px">${opts.when || 'now'}</span></div>
      <b style="font-size:12.5px">${title}</b><span class="muted" style="font-size:11.5px">${body}</span>
      ${actions ? `<div class="row" style="gap:6px;border-top:1px solid var(--wf-line);padding-top:6px">${actions}</div>` : ''}</div>`
  const desk = (inner) =>
    `<div class="wf-window" style="background:linear-gradient(160deg,var(--wf-paper-2),var(--wf-sel))">${inner}</div>`

  FRAMES.push({
    id: 'menubar-icon-notification',
    group: 'Menu bar',
    title: 'Menu bar icon with its count, and the notifications',
    personas: ['P7', 'P1', 'P2', 'P6'],
    desc: 'From the doorway, the icon says "3". The notification says what, for whom and by what clock time, and opens the item itself.',
    html: desk(`
      ${menubar(vIcon('3', 'alert', true))}
      <div style="position:absolute;top:40px;right:14px;display:flex;flex-direction:column;gap:10px">
        ${note('Confirm: Remove from cart (Woolworths)', 'Claude Code is waiting. Answer by 9:50 pm, or nothing is removed.', K.primary('Answer') + K.btn('Decline'))}
        ${note('Log in to Woolworths (verification check)', 'Woolworths showed a check only you can do. The login window is open until 10:03 pm.', K.primary('Show login window'))}
        ${note('Approve a connection', 'A cloud agent is asking to connect. Type the code your browser shows by 9:52 pm.', K.primary('Approve…') + K.btn('Decline'), { when: '1 min ago' })}
      </div>
      <div style="position:absolute;left:40px;top:80px;width:600px;display:flex;flex-direction:column;gap:14px">
        <div class="h3">The icon, by state</div>
        <div class="wf-table" style="--cols:150px 1fr;background:var(--wf-paper);border:1px solid var(--wf-line);border-radius:10px">
          <div class="tr"><span>${vIcon('')}</span><span>Ready, nothing waiting. Plain template icon.</span></div>
          <div class="tr"><span>${vIcon('3')}</span><span>3 things need you: the Needs you count, red. Same number as the sidebar and the popover.</span></div>
          <div class="tr"><span>${vIcon('!')}</span><span>Something is under 30 s: the count becomes "!" and the icon pulses once (none with Reduce Motion).</span></div>
          <div class="tr"><span>${vIcon('Paused', 'idle')}</span><span>Paused: the word, not a colour, so it reads in a glance and to VoiceOver.</span></div>
          <div class="tr"><span>${vIcon('Locked', 'idle')}</span><span>Locked down.</span></div>
          <div class="tr"><span>${vIcon('3 · Remote', 'alert')}</span><span>Remote access on adds "Remote" after the count, as today's REMOTE title does.</span></div>
        </div>
        <p class="muted" style="margin:0;max-width:560px">Clicking a notification opens the item itself: the confirmation window, the login window, or the code sheet over Needs you (P8a refinement). Clicking the icon opens the popover with focus on the first row.</p>
      </div>`),
    notes: [
      [
        905,
        4,
        'The icon carries the Needs you count while anything waits (P7 refinement 1). Today it only ever says REMOTE or DEMO.',
      ],
      [
        1158,
        62,
        'Title = the Needs you title, word for word, in all four places (principle 1, P5 vocabulary as accessible name).',
      ],
      [
        1158,
        104,
        'Body gives the deadline as a clock time, never "in 2 minutes", which is wrong by the time the Mac is unlocked (P7 C1.2).',
      ],
      [
        955,
        145,
        '"Answer" brings the confirmation window forward; Decline can be answered here because it is safe. Allow never happens from a notification (main-process rule).',
      ],
      [
        1158,
        250,
        'One notification per item, newest on top; a review gets none (no deadline). Notifications stay in Notification Centre until the item is answered or missed.',
      ],
      [40, 330, 'Each state is a word or a number, never colour alone (P5).'],
    ],
  })

  FRAMES.push({
    id: 'menubar-missed',
    group: 'Menu bar',
    title: 'Locked Mac, then the Missed notification',
    personas: ['P7', 'P2', 'P6'],
    desc: 'Left: what P7 sees on the lock screen while walking over. Right: after the deadline the notification is replaced, never silently taken down.',
    html: `<div class="wf-window" style="flex-direction:row">
      <div style="flex:1;background:linear-gradient(180deg,var(--wf-sel),var(--wf-paper-2));display:flex;flex-direction:column;align-items:center;padding-top:60px;gap:14px;border-right:1px solid var(--wf-line-2)">
        <span class="faint">Wednesday 11 November</span><b style="font:300 64px/1 var(--f-head)">9:48</b>
        <div style="margin-top:40px">${note('Confirm: Remove from cart (Woolworths)', 'Claude Code is waiting. Answer by 9:50 pm, or nothing is removed.', '', { when: 'now' })}</div>
        ${note('Log in to Woolworths (verification check)', 'Login window open until 10:03 pm.', '', { when: 'now' })}
        <span class="faint" style="margin-top:auto;padding-bottom:30px">Touch ID or enter password</span>
      </div>
      <div style="flex:1;background:linear-gradient(160deg,var(--wf-paper-2),var(--wf-sel));display:flex;flex-direction:column">
        ${menubar(vIcon('1', 'alert'), '9:51 pm')}
        <div style="padding:20px 24px;display:flex;flex-direction:column;gap:10px;align-items:flex-end">
          <span class="faint" style="align-self:flex-start">Notification Centre, 9:51 pm</span>
          ${note('Missed: Confirm: Remove from cart (Woolworths)', 'Nobody answered by 9:50 pm, so nothing was removed. Claude was told it timed out. Ask Claude to try again.', K.primary('Copy a retry note') + K.btn('Open call 7F2A') + K.ghost('Dismiss'), { when: '1 min ago' })}
          ${note('Log in to Woolworths (verification check)', 'Login window open until 10:03 pm.', K.primary('Show login window'), { when: '3 min ago' })}
          <div class="wf-card" style="width:344px"><div class="body"><b>Popover after the miss</b>
            <div class="row muted" style="font-size:11px">${K.dot('idle')} ${K.link('Missed (2)')} · Confirm: Remove from cart, 9:50 pm</div>
            <span class="faint" style="font-size:11px">The Missed line stays 24 hours and opens Needs you › Missed.</span></div></div>
        </div>
      </div>
    </div>`,
    notes: [
      [
        460,
        250,
        'Lock screen shows what and by when, so P7 knows whether to run (P7 part 4, point 3). Previews follow the macOS "show previews" setting; titles carry no product names (P6).',
      ],
      [
        1158,
        112,
        'The confirmation\'s notification is replaced by "Missed: …", same title with the prefix. Today it is taken down and nothing remains (P7 C5.1).',
      ],
      [
        1158,
        150,
        'Says what happened (nothing removed) and what to do next (ask Claude again). The retry note is a sentence copied to the clipboard; Valet never retries by itself.',
      ],
      [1050, 186, 'Open call 7F2A goes to the call trace, where the time-out is recorded (P7 C5.4).'],
      [960, 2, 'The icon count drops to what is still waiting; missed items are not counted (E11).'],
    ],
  })
})()
