// Everywhere: the command palette, kill switches, the app menu and the window's limits
// (principles 7, 10, 11, 12; E4, E9, E10; P1, P3, P5).
;(() => {
  const { K, shell, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Everywhere =
    'Things that work the same on every page: ⌘K, Pause and Lock down (and Unlock), the app menu and its shortcuts, and the two limits every layout must survive (the 880 x 560 minimum window and 200% text). Story moment: 9:48 pm, 4 waiting.'

  // ---- shared pages ----
  const siteHeader = (actions) =>
    K.header({
      crumbs: ['Sites', 'Woolworths'],
      title: 'Woolworths',
      status: K.badge('0.3.0 · approved Fri 6 Nov', 'idle'),
      actions,
      tabs: `<div class="row" style="gap:0">${K.tabs(['Overview', 'Tools', 'Permissions', 'Versions'])}<span class="grow"></span><span style="padding:7px 4px">${K.link('All calls')}</span></div>`,
    })
  const siteMain = `
    ${K.banner('info', 'Review the Woolworths update (0.4.0).', 'Adds 1 host and 1 read tool. Calls use 0.3.0 until you approve.', K.primary('Review update'))}
    ${K.health('warn', '<b>Needs you: Log in (verification check)</b> · login window open until 10:02 pm', K.btn('Show login window'))}
    <div class="grid2">
      ${K.card('Login', `<span>${K.link('Woolworths')} · Keychain copy of your 1Password item (Personal vault)</span><span class="faint">Typed only on auth.woolworths.com.au · re-synced Fri 6 Nov</span>`, K.btn('Change…'))}
      ${K.card('Store', '<span>Woolworths Town Hall</span>', K.btn('Change…'))}
      ${K.card('Today', `<span>${K.link('21 calls')} · ${K.link('1 failed')} · ${K.link('2 requests blocked')}</span>`)}
      ${K.card('Called by', `<span>${K.link('Claude Code')} · ${K.link('Claude Desktop')}</span>`)}
    </div>`
  const siteActions = K.btn('Open my trolley…') + K.btn('Pause Woolworths')

  // 1. Command palette
  const palette = `<div class="wf-scrim"></div>
    <div style="position:absolute;z-index:4;top:90px;left:50%;transform:translateX(-50%);width:600px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:12px;box-shadow:0 20px 40px var(--wf-shadow);display:flex;flex-direction:column">
      <div class="row" style="padding:12px 14px;border-bottom:1px solid var(--wf-line);font-size:15px">⌕ <span>wool</span><span style="width:1px;height:18px;background:var(--wf-ink)"></span><span class="grow"></span><span class="faint" style="font-size:11px">9 results</span>${K.kbd('esc')}</div>
      <div style="padding:6px">
        ${[
          [
            'Needs you',
            [
              ['?', 'Confirm: Remove from cart (Woolworths)', 'until 9:50 pm', '', true],
              ['→', 'Log in to Woolworths (verification check)', 'until 10:02 pm', ''],
              ['↑', 'Review the Woolworths update (0.4.0)', 'no deadline', ''],
            ],
          ],
          ['Sites', [['W', 'Woolworths', 'Overview · Tools · Permissions · Versions', '']]],
          [
            'Actions',
            [
              ['‖', 'Pause Woolworths', 'Its calls are refused until you resume it', ''],
              ['↗', 'Open my trolley on woolworths.com.au', 'In your browser', ''],
              ['⊘', 'Lock down…', 'Stops calls and cuts off apps', '⌥⇧⌘L'],
            ],
          ],
          [
            'Calls',
            [
              [
                '#',
                'Call 7F2A · remove_from_cart · Woolworths',
                'Claude Code · 9:48 pm · waiting for you',
                '',
              ],
            ],
          ],
          ['Secrets', [['⚿', 'Woolworths login', 'Keychain copy from 1Password · Personal vault', '']]],
        ]
          .map(
            ([g, rows]) =>
              `<div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px">${g}</div>` +
              rows
                .map(
                  ([ic, t, s, kb, on]) =>
                    `<div class="row" style="padding:6px 10px;border-radius:6px;gap:10px;${on ? 'background:var(--wf-sel)' : ''}"><span class="wf-kind" style="width:22px;height:22px;font-size:11px">${ic}</span><span class="grow"><b style="font-weight:${on ? 600 : 500}">${t}</b> <span class="faint">· ${s}</span></span>${kb ? `<span class="faint" style="font-size:11px">${kb}</span>` : ''}</div>`,
                )
                .join(''),
          )
          .join('')}
      </div>
      <div class="row faint" style="padding:8px 14px;border-top:1px solid var(--wf-line);font-size:11px;gap:14px">${K.kbd('↑↓')} move ${K.kbd('↵')} open <span class="grow"></span>Type a call ref (7F2A), a site, a setting or an action</div>
    </div>`
  FRAMES.push({
    id: 'global-palette',
    group: 'Everywhere',
    title: '⌘K command palette',
    personas: ['P1', 'P4', 'P5', 'P3'],
    desc: 'One search for places, sites, calls by ref, apps, secrets, settings and actions. Results are grouped, and waiting items come first.',
    html: shell('sites', siteHeader(siteActions) + `<div class="wf-scroll">${siteMain}</div>`, {
      badges: { needs: 4 },
      site: 0,
      over: palette,
    }),
    notes: [
      [
        783,
        105,
        'Opens from the titlebar search field or ⌘K anywhere; Escape closes and returns focus where it was (principle 5, P5). The count is announced.',
      ],
      [
        660,
        214,
        'Waiting items rank first, with the same titles as Needs you, so "wool" finds all three Woolworths items at once (principle 1).',
      ],
      [823, 447, 'Actions are first-class results, including Lock down with its shortcut (P3 #12, P1).'],
      [
        818,
        508,
        "Calls by ref, with the story's refs: 7F2A is the remove_from_cart waiting for you (P6 B1).",
      ],
      [259, 612, 'Every result is one URL, so ↵ lands where a click would (principle 7).'],
    ],
  })

  // 2. Lock down dialog
  const lockdown = dialog(
    'Lock down Valet?',
    `<span>Use this if something looks wrong: a password you think leaked, or an app you don't recognise. Lock down does all of this now:</span>
     <div class="col" style="gap:5px;color:var(--wf-ink)">
       <span>• Pauses every site. Calls in progress stop before their next request.</span>
       <span>• Declines what is waiting: Confirm: Remove from cart (Woolworths), and closes the Woolworths login window</span>
       <span>• Refuses every call from Claude Code and Claude Desktop; they are told "Valet is locked down"</span>
       <span>• Turns off remote access and <b>declines the waiting connection</b></span>
     </div>
     <div class="col" style="gap:6px;padding:8px 10px;border-radius:8px;background:var(--wf-tint-bad);color:var(--wf-ink)">
       <b>Can't be undone</b>
       <span>Declined items are gone; Claude must ask again after you unlock.</span>
       ${K.check('Also reset access for apps on this Mac (add them again)', false)}
       ${K.check('Also forget every login Valet may use (choose them again)', false)}
     </div>
     <span class="faint" style="font-size:11px">Unlock turns sites back on and lets apps call again. Everything is written to the audit log.</span>`,
    `<span class="wf-btn" style="outline:2px solid var(--wf-act);outline-offset:2px">Cancel</span>${K.danger('Lock down')}`,
  )
  FRAMES.push({
    id: 'global-lockdown',
    group: 'Everywhere',
    title: 'Lock down dialog',
    personas: ['P3', 'P1', 'P6'],
    desc: "The second kill switch, a visible row in the menu bar, an item in the titlebar Pause menu, the app menu and ⌥⇧⌘L. It says what happens now, including to calls in progress and to what is waiting, and separately what can't be undone.",
    html: shell('sites', siteHeader(siteActions) + `<div class="wf-scroll">${siteMain}</div>`, {
      badges: { needs: 4 },
      site: 0,
      over: lockdown,
    }),
    notes: [
      [767, 299, 'Says what happens to calls in flight and to each waiting item, by its title (P3 #7).'],
      [
        767,
        337,
        'The endpoint stays up and refuses every call with "Valet is locked down by the person", so Claude can tell the person why (P6 B3, IA §7). Assumption recorded for Nick.',
      ],
      [777, 398, "What can't be undone is its own box; the optional extras are off by default."],
      [
        607,
        577,
        'Cancel has focus and Return; Lock down is the danger button and needs a click or Tab (P5, E4).',
      ],
    ],
  })

  // 3. Locked down state
  const lockedPage = `
    ${K.header({ title: 'Needs you', status: K.badge('Locked down', 'bad') })}
    <div class="wf-scroll">
      ${K.card(
        'What Lock down did at 9:49 pm',
        `<div class="col" style="gap:6px">
          <span>✓ Paused Woolworths, Yahoo Finance and Wikipedia</span>
          <span>✓ Declined Confirm: Remove from cart (Woolworths), call ${K.link('7F2A')}</span>
          <span>✓ Closed the Woolworths login window, call ${K.link('9A71')}</span>
          <span>✓ Declined Approve a connection ("Claude (claude.ai)", 203.0.113.24) and turned remote access off</span>
          <span>✓ Refused ${K.link('2 calls')} since then</span>
        </div>`,
        K.link('See in the audit log'),
      )}
      ${K.card(
        'Unlock will',
        `<span>Turn the three sites back on and let Claude Code and Claude Desktop call again. Remote access stays off. Declined items don't come back: Claude asks again.</span>`,
      )}
      ${K.inbox('↑', 'Review the Woolworths update (0.4.0)', 'Still waiting; reviewing is allowed while locked down', '', K.btn('Review update'))}
    </div>`
  const lockedShell = shell('needs', lockedPage, {
    badges: { needs: 1 },
    paused: true,
    sites: [
      ['W', 'Woolworths', 'idle'],
      ['Y', 'Yahoo Finance', 'idle'],
      ['W', 'Wikipedia', 'idle'],
    ],
  })
    .replace(K.primary('Resume Valet'), K.primary('Unlock…'))
    .replace('Paused · calls refused', 'Locked down · calls refused')
    .replace(
      '<b>Valet is paused.</b> Calls are refused and nothing reaches any site.',
      '<b>Valet is locked down since 9:49 pm.</b> Every call is refused; apps are told "Valet is locked down by the person".',
    )
    .replace(`${K.btn('Resume')}</div>`, `${K.btn('Unlock…')}</div>`)
  FRAMES.push({
    id: 'global-locked',
    group: 'Everywhere',
    title: 'Locked down, with Unlock',
    personas: ['P3', 'P1', 'P7'],
    desc: "Right after Lock down at 9:49 pm. The window opens on Needs you and says what was done, with evidence links, what Unlock will and won't restore, and Unlock in the titlebar.",
    html: lockedShell,
    notes: [
      [
        1074,
        14,
        'The titlebar button becomes "Unlock…" (it asks, unlike Resume); the sidebar footer says Locked down; the menu bar icon reads "Locked" (P3).',
      ],
      [
        476,
        173,
        'A record of what Lock down did, each line linked to the call or the audit record (P3 evidence).',
      ],
      [1160, 357, 'Unlock says up front what it restores and what stays gone (IA §10).'],
      [
        1028,
        487,
        "The review is still answerable: reading and approving an update can't call a site (assumption).",
      ],
    ],
  })

  // 4. Pause with Undo toast
  const sitesPaused = `
    ${K.header({ title: 'Sites', status: K.badge('Valet paused', 'warn') })}
    <div class="wf-scroll">
      ${K.table(
        ['Site', 'Health', 'Version', 'Today'],
        [
          [
            `${K.avatar('W')} ${K.link('Woolworths')}`,
            `${K.dot('idle')} Paused with Valet`,
            '0.3.0 · 0.4.0 waiting',
            K.link('21 calls'),
          ],
          [
            `${K.avatar('Y')} ${K.link('Yahoo Finance')}`,
            `${K.dot('idle')} Paused with Valet`,
            '1.2.0',
            K.link('11 calls'),
          ],
          [
            `${K.avatar('W')} ${K.link('Wikipedia')}`,
            `${K.dot('idle')} Paused with Valet`,
            '0.2.1',
            K.link('5 calls'),
          ],
        ],
        { cols: '1.4fr 1.4fr 1fr .8fr' },
      )}
      <div class="row muted" style="font-size:11.5px;gap:4px">Paused by you at 9:48 pm from the menu bar · ${K.link('Pause and Lock down in the audit log')}</div>
    </div>
    ${K.toast('Valet paused. Calls are refused until you resume.', K.btn('Undo ⌘Z'))}`
  FRAMES.push({
    id: 'global-pause-undo',
    group: 'Everywhere',
    title: 'Pause Valet, with Undo',
    personas: ['P1', 'P2', 'P5'],
    desc: 'Pause is reversible, so it acts at once and offers Undo instead of asking. The titlebar button turns into Resume. Today: Woolworths 21, Yahoo Finance 11, Wikipedia 5 (37 in all).',
    html: shell('sites', sitesPaused, {
      badges: {},
      paused: true,
      sites: [
        ['W', 'Woolworths', 'idle'],
        ['Y', 'Yahoo Finance', 'idle'],
        ['W', 'Wikipedia', 'idle'],
      ],
    }),
    notes: [
      [
        1069,
        0,
        'The same button, now "Resume Valet" and primary; ⇧⌘P toggles it (E10). Its ▾ menu holds Lock down….',
      ],
      [
        237,
        749,
        "The status strip under the titlebar and the sidebar footer say Paused in words on every page, instead of a banner per page (principle 6). Both open Needs you's status block.",
      ],
      [
        1161,
        199,
        'Per-site counts add up to the 37 shown everywhere (P1 M2, story). No "Add a site…": adding a site is out of scope (IA §10, P1 M5).',
      ],
      [
        898,
        733,
        "One toast rule (the library's): a toast lasts 10 s, the timer stops while it is hovered or focused, Alt+T moves focus to it, and while an Undo toast shows ⌘Z undoes (P5 M5, design M15).",
      ],
    ],
  })

  // 5. App menu
  const menuCol = (left, items) =>
    `<div style="position:absolute;top:24px;left:${left}px;z-index:6;min-width:260px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:8px;box-shadow:0 10px 30px var(--wf-shadow);padding:4px">
      ${items
        .map((it) =>
          it === '-'
            ? '<div style="border-top:1px solid var(--wf-line);margin:4px 0"></div>'
            : `<div class="row" style="padding:4px 10px;border-radius:4px;${it[2] ? 'background:var(--wf-act);color:var(--wf-on-act)' : ''}"><span class="grow">${it[0]}</span><span style="font-size:11px;${it[2] ? '' : 'color:var(--wf-ink-3)'}">${it[1] || ''}</span></div>`,
        )
        .join('')}</div>`
  const appMenuBar = `<div class="row" style="height:24px;flex:none;padding:0 14px;gap:18px;font-size:12px;background:var(--wf-paper-2);border-bottom:1px solid var(--wf-line)"><b></b><b style="padding:1px 6px;border-radius:4px;background:var(--wf-sel)">Valet</b><span>Edit</span><span style="padding:1px 6px;border-radius:4px;background:var(--wf-sel)">Go</span><span>View</span><span>Window</span><span>Help</span><span class="grow"></span><span>Sat 7 Nov 9:48 pm</span></div>`
  FRAMES.push({
    id: 'global-app-menu',
    group: 'Everywhere',
    title: 'App menu: Valet and Go',
    personas: ['P1', 'P5', 'P2', 'P3'],
    desc: "Both menus drawn open at once for review only (one opens at a time). Every place has a shortcut, and the kill switches sit in the Valet menu like any Mac app's Quit.",
    html: `<div class="wf-window" style="background:linear-gradient(160deg,var(--wf-paper-2),var(--wf-sel))">${appMenuBar}
      <div style="zoom:.82;margin:20px 0 0 100px;width:1180px;height:780px">${shell('needs', K.header({ title: 'Needs you', status: '<span class="muted">4 waiting</span>' }) + `<div class="wf-scroll">${K.inbox('?', 'Confirm: Remove from cart (Woolworths)', 'Asked by Claude Code at 9:48 pm', K.countdown('2 min', '9:50 pm'), K.primary('Answer…'), 'urgent')}</div>`, { badges: { needs: 4 } })}</div>
      ${menuCol(22, [['About Valet'], '-', ['Settings…', '⌘,'], ['Check for Updates…'], ['Run Setup Again…'], '-', ['Pause Valet', '⇧⌘P', true], ['Lock Down…', '⌥⇧⌘L'], '-', ['Hide Valet', '⌘H'], ['Quit Valet', '⌘Q']])}
      ${menuCol(310, [['Needs you', '⌘1'], ['Sites', '⌘2'], ['Activity: Calls', '⌘3'], ['Activity: Audit log', '⇧⌘3'], ['Connections', '⌘4'], ['Secrets', '⌘5'], ['Settings', '⌘6'], '-', ['Back', '⌘['], ['Forward', '⌘]'], '-', ['Search…', '⌘K'], '-', ['Open my trolley on woolworths.com.au…']])}
    </div>`,
    notes: [
      [
        16,
        172,
        'Pause and Lock down live in the Valet menu, beside Quit, as kill switches should (principle 10, P3). While locked, Lock Down… reads Unlock….',
      ],
      [6, 115, '"Run Setup Again…" once setup is done; "Continue Setup…" while it isn\'t (P2).'],
      [
        304,
        106,
        'Place names are written as in the sidebar ("Needs you", "Audit log"), not title-cased (P1 m2). ⌘1 to ⌘5 follow the sidebar; Audit log gets ⇧⌘3.',
      ],
      [304, 236, 'Back and Forward work on every page because state lives in the URL (principle 7).'],
      [
        93,
        0,
        "Edit › Copy works on selectable values only; interface text isn't selectable (principle 11, E3).",
      ],
    ],
  })

  // 6. Minimum window, 880 x 560
  const siteNarrow = `
    ${siteHeader(K.btn('Open my trolley…') + `<span class="wf-btn icon" title="More actions">⋯</span>`)}
    <div class="wf-scroll" style="padding:14px 16px;gap:10px">
      ${K.banner('info', 'Review the Woolworths update (0.4.0).', 'Calls use 0.3.0 until you approve.', K.primary('Review update'))}
      ${K.health('warn', '<b>Needs you: Log in (verification check)</b> · until 10:02 pm', K.btn('Show login window'))}
      ${K.card('Login', `<span>${K.link('Woolworths')} · Keychain copy from 1Password</span>`, K.btn('Change…'))}
      ${K.card('Store', '<span>Woolworths Town Hall</span>', K.btn('Change…'))}
      <div class="wf-card"><header><h4>▸ Can reach</h4><span class="faint">2 sites · 1 login · 9 tools</span></header></div>
    </div>
    <div style="position:absolute;right:3px;top:150px;width:5px;height:120px;border-radius:3px;background:var(--wf-line-2)"></div>`
  FRAMES.push({
    id: 'global-min-window',
    group: 'Everywhere',
    size: 'min',
    title: 'The window at its 880 x 560 minimum',
    personas: ['P1', 'P5', 'P2'],
    desc: 'Woolworths\' Overview at the smallest size. The side column ("Can reach") folds into a section at the end, two-up cards stack, secondary header actions move into ⋯, and the page scrolls.',
    html: shell('sites', siteNarrow, { badges: { needs: 4 }, site: 0, cls: 'min' }),
    notes: [
      [237, 206, 'Sidebar keeps its width and order at the minimum (principle 6); only the page reflows.'],
      [
        675,
        92,
        '"Pause Woolworths" moves into ⋯ (named "More actions" for VoiceOver, P5 m4); the page\'s main action never does.',
      ],
      [861, 141, '"All calls" is a link beside the tabs, not a fifth tab that navigates away (P5 M1).'],
      [
        699,
        270,
        "The review and the login stay above the fold (today's remote page put Approve below it at 560 px, P7 C3.3).",
      ],
      [487, 529, 'Can reach becomes a folded section with a summary, never clipped (principle 12, P3).'],
    ],
  })

  // 7. 200% text
  const big = `<div style="zoom:2;width:590px;height:390px;display:flex;flex-direction:column;background:var(--wf-paper);overflow:hidden;border-radius:5px">
      <div class="wf-titlebar" style="height:30px;padding:0 8px;gap:6px"><span class="lights"><i></i><i></i><i></i></span><span class="wf-btn icon" title="Show sidebar">☰</span><span class="wf-hist">‹ ›</span><b class="grow" style="font-size:12px">Woolworths</b><span class="wf-btn icon" title="Search">⌕</span>${K.btn('Pause')}</div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative">
        <div style="padding:10px 14px 0;border-bottom:1px solid var(--wf-line);display:flex;flex-direction:column;gap:6px">
          <div class="wf-crumbs"><span>Sites</span><i>›</i><span>Woolworths</span></div>
          <div class="row" style="flex-wrap:wrap"><h2 style="font:600 19px var(--f-head);margin:0">Woolworths</h2>${K.badge('0.3.0', 'idle')}</div>
          <div class="row" style="flex-wrap:wrap">${K.btn('Open my trolley…')}${K.btn('Pause Woolworths')}${K.link('All calls')}</div>
          <div class="wf-tabs" style="flex-wrap:wrap"><span class="on">Overview</span><span>Tools</span><span>Permissions</span><span>Versions</span></div>
        </div>
        <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">
          <div class="wf-banner info" style="flex-direction:column;align-items:flex-start;gap:6px"><div><b>Review the Woolworths update (0.4.0).</b> Calls use 0.3.0 until you approve.</div>${K.primary('Review update')}</div>
          ${K.health('warn', '<b>Needs you: Log in (verification check)</b>')}
          ${K.card('Login', `<span>${K.link('Woolworths')} · Keychain copy</span>`, K.btn('Change…'))}
        </div>
        <div style="position:absolute;right:2px;top:60px;width:4px;height:70px;border-radius:2px;background:var(--wf-line-2)"></div>
      </div>
    </div>`
  FRAMES.push({
    id: 'global-200-text',
    group: 'Everywhere',
    title: 'Woolworths Overview at 200% text (1180 x 780 window)',
    personas: ['P5'],
    desc: 'Same page, same window, text doubled (Settings › General › Text size, or ⌘+). One column, everything wraps; nothing clips sideways and the page scrolls down.',
    html: `<div class="wf-window" style="border:0">${big}</div>`,
    notes: [
      [
        174,
        21,
        'At 200% the sidebar folds behind a button named "Show sidebar" (View › Show Sidebar, ⌃⌘S): the one exception to principle 6 (IA §10; P5 m4 names).',
      ],
      [
        953,
        21,
        'The search field becomes a button named "Search" that opens the palette; Pause keeps its word.',
      ],
      [
        653,
        204,
        'Header actions and tabs wrap onto new lines; "All calls" is a link, so the tablist holds only real tabs (P5 M1).',
      ],
      [898, 371, 'Banners stack the button under the sentence; the button keeps its name, "Review update".'],
      [1156, 531, 'The page scrolls vertically only, with a visible indicator (principle 12).'],
    ],
  })
})()
