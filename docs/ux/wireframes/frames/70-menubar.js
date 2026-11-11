// Menu bar: the icon, its popover and the notifications (P11, E5, E10; P7's walk back to the Mac).
;(() => {
  const { K, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Menu bar'] =
    'The first thing the person sees from across the room. The icon carries the Needs you count (4 at 9:48 pm, the same as the sidebar and the popover); the popover behaves like a menu (arrow keys, focus on the first waiting row) and mirrors Needs you with the same titles, in the same order. Every row, number and site opens something. Pause and Lock down are both visible rows.'

  // ---- popover parts (400 wide, content-sized up to 640) ----
  const head = (status, tone, right) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--wf-line);flex:none">
      <span class="wf-av" style="width:28px;height:28px;border-radius:7px;font-size:12px">V</span>
      <div class="grow" style="display:flex;flex-direction:column;gap:1px"><b style="font-size:13px">Valet</b>
        <span class="row" style="gap:6px;font-size:11px;color:var(--wf-link)">${K.dot(tone)}${status} ›</span></div>${right}</div>`
  const sec = (label, right = '') =>
    `<div class="row" style="padding:10px 14px 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--wf-ink-3);flex:none">${label}<span class="grow"></span>${right}</div>`
  const due = (left, until, verb) =>
    `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex:none">${left ? `<span class="wf-count">${left}</span><small class="faint" style="font-size:10px">until ${until}</small>` : ''}<span style="font-size:11px;color:var(--wf-link);font-weight:600">${verb} ›</span></div>`
  const row = (kind, title, sub, right, opts = {}) =>
    `<div style="display:flex;align-items:center;gap:10px;margin:1px 8px;padding:7px 8px;border-radius:8px;flex:none;${opts.focus ? 'outline:2px solid var(--wf-act);outline-offset:-2px;background:var(--wf-sel);' : ''}${opts.urgent ? 'box-shadow:inset 3px 0 0 var(--wf-warn);' : ''}">
      <span class="wf-kind" style="width:24px;height:24px;font-size:12px">${kind}</span>
      <div class="grow" style="display:flex;flex-direction:column;gap:1px"><b style="font-size:12px;line-height:1.3">${title}</b><small class="muted" style="font-size:10.5px">${sub}</small></div>${right}</div>`
  const site = (l, name, tone, line) =>
    `<div style="display:flex;align-items:center;gap:10px;margin:0 8px;padding:4px 8px;border-radius:8px;flex:none">${K.avatar(l)}
      <div class="grow" style="display:flex;flex-direction:column"><span style="font-weight:600">${name}</span><span class="row muted" style="gap:5px;font-size:10.5px">${K.dot(tone)}${line}</span></div><span class="faint">›</span></div>`
  const item = (label, kbd = '', sub = '') =>
    `<div class="row" style="padding:2px 14px;min-height:23px;flex:none;align-items:center"><span class="grow">${label}${sub ? `<br><small class="faint" style="font-size:10.5px">${sub}</small>` : ''}</span>${kbd ? `<span class="faint" style="font-size:11px">${kbd}</span>` : ''}</div>`
  const hr = `<div style="border-top:1px solid var(--wf-line);margin:6px 0;flex:none"></div>`
  const today = (third = K.link('12 blocked')) =>
    `${sec('Today')}<div class="row" style="padding:2px 14px 4px;gap:6px;flex:none">${K.link('37 calls')} · ${K.link('2 failed')} · ${third}</div>`
  const killRows = (paused) =>
    hr +
    (paused
      ? item(`<b>Resume Valet</b>`, '⇧⌘P')
      : item('Pause Valet', '⇧⌘P', 'Refuses every call until you resume')) +
    item('Lock down…', '⌥⇧⌘L', 'If something looks wrong: stops calls and cuts off apps')
  const foot = () =>
    `${hr}${item('Open my trolley on woolworths.com.au…')}${item('Open Valet', '⌘O')}${item('Quit Valet', '⌘Q')}<div style="height:6px;flex:none"></div>`
  const sites = (rows) => sec('Sites') + rows.join('')
  const pop = (inner) => `<div class="wf-pop" style="height:auto;max-height:640px">${inner}</div>`
  const pauseBtn = K.btn('Pause Valet')

  // 1. Nothing waiting
  FRAMES.push({
    id: 'menubar-normal',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, nothing waiting',
    personas: ['P2', 'P7', 'P1', 'P3'],
    desc: 'Says "Nothing needs you" in words, then one row per site and today\'s numbers as links. The popover sizes to its content (up to 640 px), so there is no empty band.',
    html: pop(`
      ${head('Ready · 2 apps connected', 'ok', pauseBtn)}
      ${sec('Needs you')}
      <div class="row" style="padding:6px 14px 8px;gap:8px;flex:none">${K.dot('ok')}<span class="grow"><b>Nothing needs you</b><br><small class="muted">You'll get a notification and a count on this icon when something does.</small></span>${K.ghost('Notifications…')}</div>
      ${sites([
        site('W', 'Woolworths', 'ok', 'Ready · Woolworths Town Hall · logged in'),
        site('Y', 'Yahoo Finance', 'warn', 'Yahoo Finance is limiting requests · calls resume at 9:52 pm'),
        site('W', 'Wikipedia', 'ok', 'Ready'),
      ])}
      ${today()}
      ${killRows(false)}
      ${foot()}`),
    notes: [
      [
        259,
        106,
        '"Notifications…" opens Settings › Notifications: P7\'s "notify me about…" line, here only when the list is empty.',
      ],
      [
        374,
        230,
        'Each site row is one button that opens its Overview, with its health line in the shared sentence ("{site} is limiting requests · calls resume at {time}", P6 M4). Every row has a chevron.',
      ],
      [
        196,
        317,
        'Today is one line of links in every state (P2 m5); each opens Activity › Calls filtered (E7). 37 is all sites.',
      ],
      [
        292,
        401,
        "Pause and Lock down are both visible rows with a one-line explanation (P3 #12, P2 m7), not hidden in Pause's menu.",
      ],
      [
        382,
        438,
        '"Open my trolley", never "Check out": Sam won\'t click anything that sounds like paying (P2).',
      ],
    ],
  })

  // 2. Four waiting
  FRAMES.push({
    id: 'menubar-waiting',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, four things waiting',
    personas: ['P7', 'P5', 'P1', 'P6'],
    desc: "9:48 pm, the story's moment. Needs you comes first and gets the room: three full rows sorted by deadline, the fourth named as a link, then Missed.",
    html: pop(`
      ${head('4 things need you · next ends 9:50 pm', 'warn', pauseBtn)}
      ${sec('Needs you', '<span class="wf-alert" style="margin:0">4</span>')}
      ${row('?', 'Confirm: Remove from cart (Woolworths)', 'Asked by Claude Code at 9:48 pm', due('2 min', '9:50 pm', 'Answer'), { focus: true, urgent: true })}
      ${row('⇄', 'Approve a connection', 'Asked 9:47 pm from 203.0.113.24 · calls itself "Claude (claude.ai)", not verified', due('4 min', '9:52 pm', 'Open'))}
      ${row('→', 'Log in to Woolworths (verification check)', 'Login window is open · for Claude Code', due('14 min', '10:02 pm', 'Show login window'))}
      <div class="row" style="padding:4px 16px;flex:none;gap:6px"><span class="faint">+1 more:</span>${K.link('Review the Woolworths update (0.4.0)')}</div>
      <div class="muted" style="padding:2px 16px 4px;flex:none;font-size:11px">${K.link('Missed (1)')} Missed: Confirm: Remove from cart (Woolworths) · 6:12 pm</div>
      ${sites([
        site('W', 'Woolworths', 'warn', 'Needs you: Log in (verification check) · Review the update'),
        site('Y', 'Yahoo Finance', 'warn', 'Yahoo Finance is limiting requests · calls resume at 9:52 pm'),
        site('W', 'Wikipedia', 'ok', 'Ready'),
      ])}
      <div class="row" style="padding:6px 14px 2px;gap:6px;flex:none"><span class="muted">Today</span> ${K.link('37 calls')} · ${K.link('2 failed')} · ${K.link('12 blocked')}</div>
      ${hr}<div class="row" style="padding:2px 14px;gap:8px;flex:none">${K.btn('Pause Valet ⇧⌘P')}${K.btn('Lock down… ⌥⇧⌘L')}</div>
      ${foot()}`),
    notes: [
      [
        23,
        106,
        'Focus starts here on open. ↑↓ move between rows, Tab moves between groups; each row is one button named "title, until 9:50 pm" (P5).',
      ],
      [
        334,
        98,
        'Countdown and clock time on every timed row, soonest first (E5, P7). The confirm icon is "?", not a tick that reads as done (P2 m4).',
      ],
      [
        315,
        129,
        '"Answer" brings the floating confirmation window forward; never a copy inside the main window, where Allow can\'t work (P7 C1.4).',
      ],
      [
        297,
        184,
        'The connection row names who is asking and marks the name as unverified; "Open" goes to the code sheet, where Decline and Approve have equal weight (P2 M6, P7 #5).',
      ],
      [
        292,
        282,
        'The fourth item is itself the link, not grey text (P7 #15). Missed keeps the full title with "(Woolworths)" (P6 M5).',
      ],
      [374, 370, 'Site rows use the Needs you titles minus the site name (P6 m3).'],
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
    html: pop(`
      ${head('Paused since 9:41 pm · calls are refused', 'warn', K.primary('Resume Valet'))}
      <div class="wf-banner warn" style="margin:10px 12px 0;flex:none;border-radius:8px"><div class="grow"><b>Valet is paused.</b> Claude is told "Valet is paused, nothing was sent" and to ask you to resume.</div></div>
      ${sec('Needs you')}
      <div class="row muted" style="padding:4px 14px 8px;flex:none">${K.dot('idle')} Nothing waiting. New requests can't arrive while paused.</div>
      ${sites([
        site('W', 'Woolworths', 'idle', 'Paused with Valet'),
        site('Y', 'Yahoo Finance', 'idle', 'Paused with Valet'),
        site('W', 'Wikipedia', 'idle', 'Paused with Valet'),
      ])}
      ${today(K.link('5 refused while paused'))}
      ${killRows(true)}
      ${foot()}`),
    notes: [
      [
        265,
        18,
        'Resume is the primary button and takes focus on open (E10). ⇧⌘P does the same while Valet is focused.',
      ],
      [4, 94, 'The words match the tool result exactly (vocabulary table, "Paused · Resume"; P6).'],
      [
        374,
        241,
        'Each site says why it is quiet ("Paused with Valet"), so a paused site and a paused Valet are told apart (P1).',
      ],
      [
        268,
        367,
        'Refused calls are counted and open Calls filtered to them, so P1 can see what Claude tried while paused.',
      ],
      [292, 444, 'Lock down stays reachable while paused: Pause is not a lockdown (P3).'],
    ],
  })

  // 4. First run
  FRAMES.push({
    id: 'menubar-first-run',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover, setup not started',
    personas: ['P2', 'P5'],
    desc: 'On a fresh Mac there is no fake data: no "12 blocked". The one thing to do is the first row. Setup has six action steps, so six are left.',
    html: pop(`
      ${head("Not set up yet · Claude can't use any site", 'idle', '')}
      ${sec('Needs you', '<span class="wf-alert" style="margin:0">1</span>')}
      ${row('↻', 'Finish setup (6 steps left)', 'Next: connect 1Password · about 5 minutes', due('', '', 'Continue setup'), { focus: true })}
      ${sites([
        site('W', 'Woolworths', 'idle', 'Review Woolworths before first use · part of setup'),
        site('Y', 'Yahoo Finance', 'idle', 'Review Yahoo Finance before first use'),
        site('W', 'Wikipedia', 'idle', 'Review Wikipedia before first use'),
      ])}
      ${sec('Today')}
      <div class="muted" style="padding:2px 14px;flex:none">No calls yet. When Claude uses a site, its calls show up here.</div>
      <div class="wf-banner ok" style="margin:12px 12px 0;flex:none"><div class="grow">Valet never pays. Checkout is always you, on woolworths.com.au.</div></div>
      ${foot()}`),
    notes: [
      [
        382,
        30,
        'No Pause or Lock down before anything can run: there is nothing to stop yet. They appear once a site is approved.',
      ],
      [
        3,
        98,
        "Same title and count as the Needs you item and Setup's done page: six action steps, all left (story; P2 M1).",
      ],
      [
        374,
        185,
        'Site rows open the site page, where "Review Woolworths before first use" sits on the Overview (principle 4).',
      ],
      [365, 311, 'Honest empty state instead of the demo numbers Sam saw on day one (P2 fixture caveat).'],
      [363, 360, 'The money line Sam asked for on the first surface she sees (P2 part 4).'],
    ],
  })

  // 5. 200% text
  FRAMES.push({
    id: 'menubar-200-text',
    group: 'Menu bar',
    size: 'pop',
    title: 'Popover at 200% text',
    personas: ['P5'],
    desc: 'Same 400 px popover, text doubled. Needs you keeps its place at the top with "+3 more"; the popover scrolls vertically and nothing clips sideways.',
    html: `<div class="wf-pop"><div style="zoom:2;width:200px;height:320px;display:flex;flex-direction:column;overflow:hidden;position:relative">
      <div class="row" style="padding:6px 8px;gap:6px;border-bottom:1px solid var(--wf-line);flex:none"><b class="grow">Valet</b>${K.btn('Pause')}</div>
      <div class="row muted" style="padding:4px 8px;font-size:10px;flex:none;flex-wrap:wrap">${K.dot('warn')} 4 things need you</div>
      <div style="margin:2px 6px;padding:5px 6px;border-radius:6px;outline:2px solid var(--wf-act);outline-offset:-2px;background:var(--wf-sel);flex:none">
        <b style="font-size:11px;line-height:1.25;display:block">Confirm: Remove from cart (Woolworths)</b>
        <span class="wf-count" style="font-size:11px">2 min</span><small class="faint" style="font-size:9px"> · until 9:50 pm</small>
        <div style="font-size:10px;color:var(--wf-link);font-weight:600">Answer ›</div></div>
      <div style="padding:4px 8px;flex:none;font-size:10.5px">${K.link('+3 more in Valet')}</div>
      <div style="padding:2px 8px;flex:none;font-size:10px">${K.link('Missed (1)')}</div>
      <div style="padding:6px 8px 2px;font-size:9px;text-transform:uppercase;color:var(--wf-ink-3);flex:none">Sites</div>
      <div class="row" style="padding:3px 8px;gap:5px;flex:none">${K.avatar('W')}<span class="grow" style="font-size:10.5px">Woolworths</span>›</div>
      <div class="row" style="padding:3px 8px;gap:5px;flex:none">${K.avatar('Y')}<span class="grow" style="font-size:10.5px">Yahoo Finance</span>›</div>
      <div class="row" style="padding:3px 8px;gap:5px;flex:none">${K.avatar('W')}<span class="grow" style="font-size:10.5px">Wikipedia</span>›</div>
      <div style="padding:6px 8px 2px;font-size:9px;text-transform:uppercase;color:var(--wf-ink-3);flex:none">Today</div>
      <div style="padding:0 8px;font-size:10.5px;flex:none">${K.link('37 calls')} · ${K.link('2 failed')}</div>
      <div style="position:absolute;right:1px;top:70px;width:3px;height:60px;border-radius:2px;background:var(--wf-line-2)"></div>
    </div></div>`,
    notes: [
      [
        382,
        282,
        'At 200% one Needs you row shows in full, then "+3 more in Valet", which opens Needs you in the window (P5 M2).',
      ],
      [
        351,
        163,
        'The row wraps onto several lines rather than truncating; the countdown keeps the clock time.',
      ],
      [
        382,
        458,
        'The popover scrolls vertically, with a visible indicator; Sites, Today, Pause, Lock down and the menu items follow below. Never a sideways scroll.',
      ],
      [249, 34, 'Pause keeps its word, never an icon alone.'],
    ],
  })

  // ---- desktop scenes ----
  const menubar = (icon, time = '9:48 pm') =>
    `<div style="height:26px;flex:none;display:flex;align-items:center;gap:16px;padding:0 14px;background:color-mix(in srgb,var(--wf-paper) 85%,transparent);border-bottom:1px solid var(--wf-line);font-size:12px">
      <b></b><b>Finder</b><span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Window</span><span class="grow"></span>
      ${icon}<span>⌕</span><span>Wi-Fi</span><span>Sat 7 Nov ${time}</span></div>`
  const vIcon = (badge, tone = 'alert', on = false) =>
    `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:5px;${on ? 'background:var(--wf-sel);' : ''}"><span style="width:14px;height:14px;border:1.5px solid var(--wf-ink);border-radius:4px;display:inline-block"></span>${badge ? `<b style="font-size:11px;${tone === 'alert' ? 'color:var(--wf-alert)' : 'color:var(--wf-ink-2)'}">${badge}</b>` : ''}</span>`
  const note = (title, body, actions, opts = {}) =>
    `<div style="width:344px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:14px;box-shadow:0 10px 30px var(--wf-shadow);padding:10px 12px;display:flex;flex-direction:column;gap:6px">
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
    desc: 'From the doorway, the icon says "4". Each notification says what and by what clock time. Notifications never approve: they offer Open, plus Decline for a confirmation or a connection.',
    html: desk(`
      ${menubar(vIcon('4', 'alert', true))}
      <div style="position:absolute;top:40px;right:14px;display:flex;flex-direction:column;gap:10px">
        ${note('Confirm: Remove from cart (Woolworths)', 'An app is waiting. Answer by 9:50 pm, or nothing is removed.', K.primary('Open') + K.btn('Decline'))}
        ${note('Approve a connection', 'Something calling itself "Claude (claude.ai)" asked at 9:47 pm. If you didn\'t start this, decline. Open by 9:52 pm to type the code.', K.btn('Open') + K.btn('Decline'), { when: '1 min ago' })}
        ${note('Log in to Woolworths (verification check)', 'Woolworths showed a check only you can do. The login window is open until 10:02 pm.', K.primary('Open'), { when: '1 min ago' })}
      </div>
      <div style="position:absolute;left:40px;top:80px;width:600px;display:flex;flex-direction:column;gap:14px">
        <div class="h3">The icon, by state</div>
        <div class="wf-table" style="--cols:150px 1fr;background:var(--wf-paper);border:1px solid var(--wf-line);border-radius:10px">
          <div class="tr"><span>${vIcon('')}</span><span>Ready, nothing waiting. Plain template icon.</span></div>
          <div class="tr"><span>${vIcon('4')}</span><span>4 things need you: the Needs you count, red. The same number as the sidebar, the popover header and "1 of 4" in the confirmation window. The review counts.</span></div>
          <div class="tr"><span>${vIcon('!')}</span><span>Something is under 30 s: the count becomes "!" and the icon pulses once (none with Reduce Motion).</span></div>
          <div class="tr"><span>${vIcon('Paused', 'idle')}</span><span>Paused: the word, not a colour, so it reads at a glance and to VoiceOver.</span></div>
          <div class="tr"><span>${vIcon('Locked', 'idle')}</span><span>Locked down.</span></div>
          <div class="tr"><span>${vIcon('4 · Remote', 'alert')}</span><span>Remote access on adds "Remote" after the count, as today's REMOTE title does.</span></div>
        </div>
        <p class="muted" style="margin:0;max-width:560px">Clicking a notification, or its Open button, opens the item itself: the confirmation window, the login window, or the code sheet over Needs you (P8a). Clicking the icon opens the popover with focus on the first row.</p>
      </div>`),
    notes: [
      [
        896,
        5,
        'The icon carries the Needs you count, 4, the same as every other count in this moment (P7 must-fix 2, P6 M7).',
      ],
      [1158, 79, 'Title = the Needs you title, word for word, in all four places (principle 1).'],
      [
        1138,
        102,
        'Body says "An app is waiting": an app\'s name is only what it calls itself, so it stays off the lock screen (P7 m10).',
      ],
      [
        938,
        137,
        'Actions are Open and Decline only. Nothing is approved from a notification, and there is no "Approve…" button (P7 must-fix 1, round 2 decision).',
      ],
      [
        1148,
        259,
        'The connection notification leads with the unverified name and "If you didn\'t start this, decline"; Open is not the primary button here (P2 M6).',
      ],
      [40, 270, 'Each state is a word or a number, never colour alone (P5).'],
    ],
  })

  const retryPop = `<div style="width:344px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:10px;box-shadow:0 10px 30px var(--wf-shadow);padding:10px 12px;display:flex;flex-direction:column;gap:8px">
      <b>Ask Claude to try again</b><span class="muted" style="font-size:11.5px">Send this to Claude, wherever you're talking to it:</span>
      <div style="padding:8px 10px;border-radius:6px;background:var(--wf-paper-2);border:1px solid var(--wf-line);font-size:12px;user-select:text">In Valet, "Confirm: Remove from cart (Woolworths)" was missed at 9:50 pm (call 7F2A). Please try again; I'm at the Mac now.</div>
      <div class="row">${K.primary('Copy')}<span class="faint" style="font-size:11px">Works with Universal Clipboard, or retype it on your phone.</span></div></div>`
  FRAMES.push({
    id: 'menubar-missed',
    group: 'Menu bar',
    title: 'Locked Mac, then the Missed notification',
    personas: ['P7', 'P2', 'P6'],
    desc: 'This frame runs on from the story: at 9:50 pm call 7F2A ran out. Left: the lock screen while P7 walks over. Right: at 9:51 pm the notification has been replaced, never silently taken down.',
    html: `<div class="wf-window" style="flex-direction:row">
      <div style="flex:1;background:linear-gradient(180deg,var(--wf-sel),var(--wf-paper-2));display:flex;flex-direction:column;align-items:center;padding-top:60px;gap:14px;border-right:1px solid var(--wf-line-2)">
        <span class="faint">Saturday 7 November</span><b style="font:300 64px/1 var(--f-head)">9:48</b>
        <div style="margin-top:40px">${note('Confirm: Remove from cart (Woolworths)', 'An app is waiting. Answer by 9:50 pm, or nothing is removed.', '', { when: 'now' })}</div>
        ${note('Log in to Woolworths (verification check)', 'Login window open until 10:02 pm.', '', { when: '1 min ago' })}
        <span class="faint" style="margin-top:auto;padding-bottom:30px">Touch ID or enter password</span>
      </div>
      <div style="flex:1;background:linear-gradient(160deg,var(--wf-paper-2),var(--wf-sel));display:flex;flex-direction:column">
        ${menubar(vIcon('3', 'alert'), '9:51 pm')}
        <div style="padding:20px 24px;display:flex;flex-direction:column;gap:10px;align-items:flex-end">
          <span class="faint" style="align-self:flex-start">Notification Centre, 9:51 pm</span>
          ${note('Missed: Confirm: Remove from cart (Woolworths)', 'Nobody answered by 9:50 pm, so nothing was removed. Claude Code was told it timed out.', K.primary('Open') + K.ghost('Dismiss'), { when: '1 min ago' })}
          <span class="faint" style="align-self:flex-start;font-size:11px">Open shows the missed item in Needs you, with:</span>
          ${retryPop}
          <div class="wf-card" style="width:344px"><div class="body"><b>Popover after the miss</b>
            <div class="row muted" style="font-size:11px;gap:6px">${K.dot('idle')} ${K.link('Missed (2)')} Missed: Confirm: Remove from cart (Woolworths) · 9:50 pm</div></div></div>
        </div>
      </div>
    </div>`,
    notes: [
      [
        452,
        270,
        'The lock screen shows what and by when, so P7 knows whether to run (P7 round 1, part 4). It says "An app", not the app\'s claimed name (P7 m10).',
      ],
      [
        1156,
        113,
        'The confirmation\'s notification is replaced by "Missed: {original title}". Today it is taken down and nothing remains (P7 C5.1).',
      ],
      [
        1162,
        266,
        'One retry action everywhere: "Ask Claude to try again…" shows the exact sentence with Copy, so it works when Claude is on a phone (round 2 decision, P2 M7, P6 M5).',
      ],
      [
        1148,
        339,
        'The sentence names the title, the time and the call ref, so Claude can match it to its own call (P6 M5).',
      ],
      [
        777,
        47,
        'The icon drops to 3: missed items are not counted (E11). Missed (2) includes 5C10 from 6:12 pm.',
      ],
    ],
  })
})()
