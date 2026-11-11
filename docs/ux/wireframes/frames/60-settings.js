// Settings: its own place, ⌘, (P7). How the app behaves; nothing security-relevant lives only here.
;(() => {
  const { K, shell, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Settings =
    'How the app behaves, reached by ⌘, like every Mac app (P7). One URL per section (#/settings/general …) and a sub-navigation inside the page. Anything about who can reach what lives in Connections or Secrets, and Settings links there rather than repeating it (P3).'

  const SECTIONS = [
    ['general', 'General'],
    ['notifications', 'Notifications'],
    ['data', 'Data and privacy'],
    ['updates', 'Updates'],
    ['reset', 'Reset and uninstall'],
  ]
  const subnav = (active) =>
    `<nav style="width:188px;flex:none;border-right:1px solid var(--wf-line);padding:16px 10px;display:flex;flex-direction:column;gap:2px">
      ${SECTIONS.map(
        ([id, label]) =>
          `<div style="padding:6px 10px;border-radius:6px;${id === active ? 'background:var(--wf-sel);font-weight:600' : 'color:var(--wf-ink-2)'}">${label}</div>`,
      ).join('')}
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--wf-ink-3);padding:16px 10px 4px">Elsewhere</div>
      <div style="padding:4px 10px">${K.link('Passwords and codes')}<div class="faint">in Secrets</div></div>
      <div style="padding:4px 10px">${K.link('Endpoint and apps')}<div class="faint">in Connections</div></div>
    </nav>`
  // One setting: label and help on the left, the control on the right.
  const row = (label, help, control) =>
    `<div class="row" style="align-items:flex-start;gap:16px;padding:12px 0;border-bottom:1px solid var(--wf-line)">
      <div class="col grow" style="gap:2px"><b>${label}</b>${help ? `<span class="muted">${help}</span>` : ''}</div>
      <div class="row" style="flex:none">${control}</div></div>`
  const group = (title, rows) =>
    `<section class="col" style="gap:0"><h3 class="h3" style="font-size:14px;margin:0 0 2px">${title}</h3>${rows.join('')}</section>`
  const page = (active, body, over = '') => {
    const label = SECTIONS.find(([id]) => id === active)[1]
    return `
    ${K.header({ crumbs: ['Settings'], title: label })}
    <div style="display:flex;flex:1;min-height:0">
      ${subnav(active)}
      <div class="wf-scroll" style="max-width:700px;gap:22px">${body}</div>
    </div>${over}`
  }

  // ---------------------------------------------------------------- General
  const general = page(
    'general',
    group('Start', [
      row(
        'Open Valet when you log in',
        'Valet sits in the menu bar. The window opens only when you ask or when something needs you.',
        K.toggle(true),
      ),
      row(
        'When the window opens',
        'Shows Needs you when something is waiting, otherwise Sites.',
        K.check('Reopen where I was if closed in the last 5 minutes', true),
      ),
    ]) +
      group('Reading', [
        row(
          'Show technical details',
          'Shows tool ids, stages, error classes and record kinds inline instead of under Details.',
          K.toggle(false),
        ),
        row(
          'Text size',
          'Also follows the text size you set in macOS. Every page reflows; nothing is clipped.',
          K.seg(['Smaller', 'Default', 'Larger', 'Largest'], 1),
        ),
      ]) +
      group('Keyboard', [
        row(
          'Shortcuts',
          `${K.kbd('⌘1')}–${K.kbd('⌘5')} places · ${K.kbd('⇧⌘3')} Audit log · ${K.kbd('⌘K')} search · ${K.kbd('⇧⌘P')} Pause Valet`,
          K.btn('Show all shortcuts'),
        ),
      ]),
  )
  FRAMES.push({
    id: 'settings-general',
    group: 'Settings',
    title: 'Settings: General',
    personas: ['P1', 'P5', 'P4', 'P2'],
    desc: '#/settings/general (⌘,). Start, reading and keyboard. Each setting is a sentence with its help under it and one control.',
    html: shell('settings', general),
    notes: [
      [
        330,
        90,
        'Sub-navigation is a list of links with aria-current; each section has its own URL and h1, and ⌘, opens the last one used (P5, P7).',
      ],
      [
        420,
        290,
        'Settings links to Secrets and Connections instead of repeating them: nothing security-relevant lives only here (P3).',
      ],
      [
        1100,
        332,
        'Show technical details expands Details everywhere: tool ids, stages, record kinds (P1, P4, E8).',
      ],
      [
        900,
        391,
        'Text size on top of the macOS setting; every page has a defined form at 200% (principle 12, P5).',
      ],
      [830, 232, "P4's refinement of P8a: reopen where you were if the window closed in the last 5 minutes."],
      [1010, 512, 'All shortcuts in one place, including ⇧⌘3 for the Audit log (P1, P5).'],
    ],
  })

  // ---------------------------------------------------------------- Notifications
  const notifications = page(
    'notifications',
    `<div class="wf-health ok">${K.dot('ok')}<span class="grow">macOS allows Valet's notifications · banners · checked 9:46 pm</span>${K.ghost('Open System Settings')}</div>` +
      group('Tell me when', [
        row(
          'Something needs me',
          'Confirmations, logins, connections to approve and updates to review. The notification uses the same title as Needs you and opens that item.',
          K.toggle(true),
        ),
        row(
          'Something I missed',
          'Replaces the first notification with “Missed: …” when nobody answered in time.',
          K.toggle(true),
        ),
        row(
          'A site has a problem',
          'A site is limiting requests, changed, or needs the adapter to be repaired.',
          K.toggle(true),
        ),
        row(
          'Valet blocked requests',
          "When a call worked but Valet refused requests the adapter didn't declare.",
          K.toggle(false),
        ),
      ]) +
      group('How', [
        row('Play a sound for confirmations', 'They have a 2 minute deadline.', K.toggle(true)),
        row('Nothing is approved from a notification', 'Clicking one only opens Valet at that item.', ''),
      ]),
  )
  FRAMES.push({
    id: 'settings-notifications',
    group: 'Settings',
    title: 'Settings: Notifications',
    personas: ['P7', 'P2', 'P4'],
    desc: '#/settings/notifications. Grouped by what happened, not by internal event; the macOS permission says its state and when it was checked.',
    html: shell('settings', notifications),
    notes: [
      [470, 158, 'The macOS permission with its state, when checked, and a way to fix it (principle 8).'],
      [
        1100,
        240,
        'Grouped by what happened. A notification uses the Needs you title and opens that item (principle 1).',
      ],
      [
        1100,
        316,
        'Missed replaces the first notification, so coming back from the phone tells the truth (P7).',
      ],
      [1100, 435, 'Opt-in for authors: blocked requests on a call that worked (P4 drift).'],
      [
        445,
        594,
        'Nothing is answered from a notification: confirmations are only accepted from their own window.',
      ],
    ],
  })

  // ---------------------------------------------------------------- Data and privacy
  const data = page(
    'data',
    group('Call traces', [
      row(
        'Keep call traces and screenshots for',
        'Older ones are deleted each night. The audit log is always kept.',
        `<span class="wf-input" style="min-width:110px">14 days ▾</span>`,
      ),
      row(
        'Delete all call traces now',
        '214 traces · 38 MB on this Mac. Calls stay in the audit log.',
        K.btn('Delete traces…'),
      ),
    ]) +
      group('Audit log', [
        row(
          'Export the audit log',
          '4,815 records as JSON Lines, with the newest hash, so you can check it elsewhere.',
          K.btn('Export…'),
        ),
        row(
          'Check the audit log',
          `Checks out · verified 9:48 pm. ${K.link('Open the Audit log')}`,
          K.btn('Check now'),
        ),
      ]) +
      group('Site sessions', [
        row(
          'Log out of every site',
          'Clears the browser sessions Valet keeps for Woolworths, Yahoo Finance and Wikipedia. Your logins stay; Valet logs in again on the next call.',
          K.btn('Log out of all sites…'),
        ),
      ]) +
      `<div class="faint">Everything stays on this Mac in ${'<span class="mono">~/Library/Application Support/valet</span>'}. Valet sends nothing to Anthropic or anyone else except the sites your tools call.</div>`,
  )
  FRAMES.push({
    id: 'settings-data',
    group: 'Settings',
    title: 'Settings: Data and privacy',
    personas: ['P3', 'P1', 'P2', 'P4'],
    desc: '#/settings/data. Trace retention, deleting traces, exporting and checking the audit log, and clearing site sessions.',
    html: shell('settings', data),
    notes: [
      [
        1009,
        176,
        'Retention, also linked from Calls (P4 T11). Plain words: "call traces and screenshots" (P2).',
      ],
      [1028, 236, 'Deleting traces confirms with the count and says the audit log is kept.'],
      [1067, 336, 'Export writes JSON Lines with the newest hash so P3 can check it elsewhere.'],
      [748, 410, 'Status with when it was checked, and links to the Audit log tab (principle 8).'],
      [1000, 496, 'Log out of every site: clears site sessions, keeps logins.'],
      [445, 577, 'What stays on this Mac and what leaves it, in one sentence (P2).'],
    ],
  })

  // ---------------------------------------------------------------- Updates
  const updates = page(
    'updates',
    `<div class="wf-health ok">${K.dot('ok')}<span class="grow"><b>Valet 0.1.0 is up to date</b> · checked 8:12 pm</span>${K.btn('Check now')}</div>` +
      group('Valet app', [
        row(
          'Install updates automatically',
          'Valet checks the update is signed by its developer before installing. It installs when no call is running.',
          K.toggle(true),
        ),
        row('Channel', 'Beta gets new features first.', K.seg(['Stable', 'Beta'], 0)),
        row("What's new in 0.1.0", '', K.ghost('Release notes')),
      ]) +
      group('Site adapters', [
        row(
          'Adapter updates are reviewed per site',
          `They never install by themselves. Woolworths 0.4.0 is waiting for your review.`,
          K.btn('Review the Woolworths update'),
        ),
      ]),
  )
  FRAMES.push({
    id: 'settings-updates',
    group: 'Settings',
    title: 'Settings: Updates',
    personas: ['P1', 'P4', 'P2'],
    desc: "#/settings/updates. The app's own updates, kept apart from site adapter updates, which are reviewed on each site.",
    html: shell('settings', updates),
    notes: [
      [712, 158, 'Up to date, when checked, Check now beside it (principle 8, E1).'],
      [1100, 240, 'Says what Valet checks before installing, and that it waits for running calls.'],
      [
        937,
        457,
        'App updates and site adapter updates are kept apart: adapter updates are reviewed on each site and link there (P4).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Reset and uninstall (with dialog)
  const reset = page(
    'reset',
    group('Start again', [
      row(
        'Run setup again',
        'Walks through 1Password, sites, logins and apps. Keeps what you have.',
        K.btn('Run setup'),
      ),
    ]) +
      group('Erase', [
        row(
          'Reset Valet',
          'Removes sites, logins Valet may use, Keychain copies, apps and their tokens, traces and settings. Keeps the audit log.',
          K.danger('Reset Valet…'),
        ),
        row(
          'Uninstall Valet',
          'Does a reset, removes the audit log and Valet Messages Helper, then moves Valet to the Bin.',
          K.danger('Uninstall…'),
        ),
      ]),
  )
  const resetDialog = dialog(
    'Reset Valet?',
    `<div>Everything below is removed from this Mac. Claude can't use any site until you set Valet up again.</div>
     <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px">
       <li>3 sites and their site sessions</li>
       <li>1 login Valet may use, and its Keychain copy</li>
       <li>2 apps and their tokens (Claude Code, Claude Desktop)</li>
       <li>214 call traces and your settings</li>
     </ul>
     <div>The audit log is kept. ${K.link('Export it first')}</div>
     <div>This can't be undone. Your 1Password items aren't touched.</div>`,
    `<span class="grow"></span>${K.btn('Cancel')}<span class="wf-btn" style="background:var(--wf-bad);color:#fff;border-color:var(--wf-bad)">Reset Valet</span>`,
  )
  FRAMES.push({
    id: 'settings-reset',
    group: 'Settings',
    title: 'Settings: Reset and uninstall, with the reset dialog',
    personas: ['P2', 'P3', 'P5'],
    desc: '#/settings/reset. Both erase actions are red and confirm with a list of exactly what goes and what stays.',
    html: shell('settings', reset, { over: resetDialog }),
    notes: [
      [362, 270, 'Lists exactly what goes and what stays, with real counts (E4).'],
      [597, 421, 'The audit log is kept on reset, with a link to export it first (P3).'],
      [608, 488, 'Initial focus on Cancel; the destructive button is red and named by its verb (P5, E4).'],
      [1054, 352, 'Uninstall confirms the same way, with its own list.'],
    ],
  })
})()
