// Everywhere: the command palette, kill switches, the app menu and the window's limits
// (principles 7, 10, 11, 12; E4, E9, E10; P1, P3, P5).
;(() => {
  const { K, shell, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Everywhere =
    'Things that work the same on every page: ⌘K, Pause and Lock down, the app menu and its shortcuts, and the two limits every layout must survive (the 880 x 560 minimum window and 200% text).'

  // ---- shared pages ----
  const _canReach = `
    ${K.kv([
      ['Sites it may open', `${K.value('woolworths.com.au')} ${K.value('auth.woolworths.com.au')}`],
      ['Logins it may fill', K.link('Woolworths (1Password)')],
      ['Tools', `${K.link('9 tools')} · 5 read, 4 change your trolley`],
      ['Asks you first', 'Remove from cart'],
    ])}`
  const siteHeader = (actions) =>
    K.header({
      crumbs: ['Sites', 'Woolworths'],
      title: 'Woolworths',
      status: K.badge('Ready', 'ok'),
      actions,
      tabs: K.tabs(['Overview', 'Tools', 'Permissions', 'Versions', 'Calls ↗']),
    })
  const siteMain = `
    ${K.banner('info', '0.4.0 is waiting for your review.', 'Adds 1 host and 1 read tool. Calls use 0.3.0 until you approve.', K.primary('Review Woolworths update'))}
    ${K.health('ok', '<b>Ready</b> · logged in, checked 9:40 pm', K.ghost('Check now') + K.ghost('Pause site'))}
    <div class="grid2">
      ${K.card('Login', `<span>${K.link('Woolworths')} from 1Password · sam@example.com</span><span class="faint">Typed only on auth.woolworths.com.au</span>`, K.btn('Change…'))}
      ${K.card('Store', '<span>Town Hall · 464-480 Kent St, Sydney</span><span class="faint">Chosen 2 Nov</span>', K.btn('Change…'))}
      ${K.card('Today', `<span>${K.link('12 calls')} · ${K.link('1 failed')} · ${K.link('3 blocked')}</span>`)}
      ${K.card('Called by', `<span>${K.link('Claude Code')} · ${K.link('Claude Desktop')}</span>`)}
    </div>`
  const siteActions = K.btn('Open my trolley…') + K.btn('Pause site')

  // 1. Command palette
  const palette = `<div class="wf-scrim"></div>
    <div style="position:absolute;z-index:4;top:90px;left:50%;transform:translateX(-50%);width:620px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:12px;box-shadow:0 20px 40px var(--wf-shadow);display:flex;flex-direction:column">
      <div class="row" style="padding:12px 14px;border-bottom:1px solid var(--wf-line);font-size:15px">⌕ <span>wool</span><span style="width:1px;height:18px;background:var(--wf-ink)"></span><span class="grow"></span>${K.kbd('esc')}</div>
      <div style="padding:6px">
        ${[
          ['Needs you', [['↑', 'Review the Woolworths update (0.4.0)', 'Opens the review page', '', true]]],
          ['Sites', [['W', 'Woolworths', 'Overview · Tools · Permissions · Versions', '⌘2 then ↓']]],
          [
            'Actions',
            [
              ['⏸', 'Pause Woolworths', 'Its calls are refused until you resume it', ''],
              ['↗', 'Open my trolley on woolworths.com.au', 'In your browser', ''],
              ['⊘', 'Pause Valet', 'Every site', '⇧⌘P'],
            ],
          ],
          ['Calls', [['#', 'Call 7F2A · Get cart · Woolworths', 'Claude Code · 9:53 pm · ok', '']]],
          ['Secrets', [['🔑', 'Woolworths login', 'From 1Password · used by 12 calls today', '']]],
        ]
          .map(
            ([g, rows]) =>
              `<div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px 4px">${g}</div>` +
              rows
                .map(
                  ([ic, t, sub, kb, on]) =>
                    `<div class="row" style="padding:7px 10px;border-radius:6px;gap:10px;${on ? 'background:var(--wf-sel)' : ''}"><span class="wf-kind" style="width:22px;height:22px;font-size:11px">${ic}</span><span class="grow"><b style="font-weight:${on ? 600 : 500}">${t}</b> <span class="faint">· ${sub}</span></span>${kb ? `<span class="faint" style="font-size:11px">${kb}</span>` : ''}</div>`,
                )
                .join(''),
          )
          .join('')}
      </div>
      <div class="row faint" style="padding:8px 14px;border-top:1px solid var(--wf-line);font-size:11px;gap:14px">${K.kbd('↑↓')} move ${K.kbd('↵')} open ${K.kbd('⌘↵')} open in Activity <span class="grow"></span>Type a call ref (7F2A), a site, a setting or an action</div>
    </div>`
  FRAMES.push({
    id: 'global-palette',
    group: 'Everywhere',
    title: '⌘K command palette',
    personas: ['P1', 'P4', 'P5'],
    desc: 'One search for places, sites, calls by ref, apps, secrets, settings and actions. Results are grouped, and waiting items come first.',
    html: shell('sites', `${siteHeader(siteActions)}<div class="wf-scroll">${siteMain}</div>`, {
      badges: { needs: 1 },
      site: 0,
      over: palette,
    }),
    notes: [
      [
        585,
        98,
        'Opens from the titlebar search field or ⌘K anywhere, focus in the field; Escape closes and returns focus where it was (principle 5, P5).',
      ],
      [
        900,
        152,
        'Waiting items rank first, with the same title as Needs you, so "wool" finds the review at once (principle 1).',
      ],
      [
        900,
        250,
        'Actions are first-class results: Pause, Lock down, Open trolley, Check audit log now (P1 "the biggest remaining gap").',
      ],
      [
        900,
        372,
        'Calls by short ref and logins by site; "passwords" also finds Secrets (IA labels decision).',
      ],
      [
        905,
        438,
        'Every result is a link to one URL, so ↵ lands on the same place a click would (principle 7). Results are a listbox with an announced count (P5).',
      ],
    ],
  })

  // 2. Lock down dialog
  const lockdown = dialog(
    'Lock down Valet?',
    `<span>Use this if something looks wrong: a password you think leaked, or an app you don't recognise. Lock down does all of this now:</span>
     <div class="col" style="gap:5px;color:var(--wf-ink)">
       <span>• Pauses every site</span>
       <span>• Turns off this Mac's endpoint: Claude Code and Claude Desktop can't call any tool</span>
       <span>• Turns off remote access and <b>removes 1 cloud agent</b> (claude.ai)</span>
     </div>
     <div class="col" style="gap:6px;padding:8px 10px;border-radius:8px;background:var(--wf-tint-bad);color:var(--wf-ink)">
       <b>Can't be undone</b>
       <span>The cloud agent must connect and be approved again.</span>
       ${K.check('Also reset access for apps on this Mac (add them again)', false)}
       ${K.check('Also forget every login Valet may use (choose them again)', false)}
     </div>
     <span class="faint" style="font-size:11px">Unlock turns sites and the endpoint back on. Everything is written to the audit log.</span>`,
    `${K.btn('Cancel', '" style="outline:2px solid var(--wf-act);outline-offset:2px')}${K.danger('Lock down')}`,
  )
  FRAMES.push({
    id: 'global-lockdown',
    group: 'Everywhere',
    title: 'Lock down dialog',
    personas: ['P3', 'P1', 'P2'],
    desc: "The second kill switch, from the Pause button's menu, the menu bar, the app menu and ⌥⇧⌘L. It says what it does now and, separately, what can't be undone.",
    html: shell('sites', `${siteHeader(siteActions)}<div class="wf-scroll">${siteMain}</div>`, {
      badges: { needs: 1 },
      site: 0,
      over: lockdown,
    }),
    notes: [
      [800, 236, "Names what stops working, by app name (E4, P3's list)."],
      [
        800,
        380,
        "What can't be undone is its own box, so it can't be skimmed past; the optional extras are off by default.",
      ],
      [
        800,
        470,
        'Unlock is one action (in the same places as Lock down); the audit log records both (P3 evidence).',
      ],
      [
        600,
        520,
        'Cancel has focus and Return; Lock down is the danger button and needs a click or Tab (P5, E4).',
      ],
    ],
  })

  // 3. Pause with Undo toast
  const sitesPaused = `
    ${K.header({ title: 'Sites', status: K.badge('Valet paused', 'warn'), actions: K.btn('Add a site…') })}
    <div class="wf-scroll">
      ${K.banner('warn', 'Valet is paused.', 'Claude is told "Valet is paused, nothing was sent" and to ask you to resume.', K.primary('Resume Valet'))}
      ${K.table(
        ['Site', 'Health', 'Version', 'Today'],
        [
          [
            `${K.avatar('W')} ${K.link('Woolworths')}`,
            `${K.dot('idle')} Paused with Valet`,
            '0.3.0 · 0.4.0 waiting',
            K.link('12 calls'),
          ],
          [
            `${K.avatar('Y')} ${K.link('Yahoo Finance')}`,
            `${K.dot('idle')} Paused with Valet`,
            '1.1.0',
            K.link('20 calls'),
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
      <div class="row muted" style="font-size:11.5px">Paused by you at 9:41 pm from the menu bar · ${K.link('5 calls refused since')} · ${K.link('Pause and Lock down in the audit log')}</div>
    </div>
    ${K.toast('Valet paused. Calls are refused until you resume.', K.btn('Undo'))}`
  FRAMES.push({
    id: 'global-pause-undo',
    group: 'Everywhere',
    title: 'Pause Valet, with Undo',
    personas: ['P1', 'P2', 'P5'],
    desc: 'Pause is reversible, so it acts at once and offers Undo instead of asking. The titlebar button turns into Resume.',
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
        1160,
        34,
        'The same button, now "Resume Valet" and primary; ⇧⌘P toggles it (E10). Its ▾ menu keeps Lock down….',
      ],
      [160, 742, 'The sidebar footer says Paused in words, everywhere in the window (principle 6).'],
      [
        880,
        124,
        'A banner on every page while paused, with Resume beside it (E1): never only a colour change.',
      ],
      [
        892,
        738,
        'The toast stays 8 s, longer while hovered or focused, is reachable with F6 and is announced politely (P5: "a toast that disappears before I reach it").',
      ],
    ],
  })

  // 4. App menu
  const menuCol = (left, _title, items) =>
    `<div style="position:absolute;top:24px;left:${left}px;z-index:6;min-width:250px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:8px;box-shadow:0 10px 30px var(--wf-shadow);padding:4px">
      ${items
        .map((it) =>
          it === '-'
            ? '<div style="border-top:1px solid var(--wf-line);margin:4px 0"></div>'
            : `<div class="row" style="padding:4px 10px;border-radius:4px;${it[2] ? 'background:var(--wf-act);color:var(--wf-on-act)' : ''}"><span class="grow">${it[0]}</span><span style="font-size:11px;${it[2] ? '' : 'color:var(--wf-ink-3)'}">${it[1] || ''}</span></div>`,
        )
        .join('')}</div>`
  const appMenuBar = `<div class="row" style="height:24px;flex:none;padding:0 14px;gap:18px;font-size:12px;background:var(--wf-paper-2);border-bottom:1px solid var(--wf-line)"><b></b><b style="padding:1px 6px;border-radius:4px;background:var(--wf-sel)">Valet</b><span>Edit</span><span style="padding:1px 6px;border-radius:4px;background:var(--wf-sel)">Go</span><span>Window</span><span>Help</span><span class="grow"></span><span>Wed 11 Nov 9:48 pm</span></div>`
  FRAMES.push({
    id: 'global-app-menu',
    group: 'Everywhere',
    title: 'App menu: Valet and Go',
    personas: ['P1', 'P5', 'P2'],
    desc: "Both menus drawn open at once for review. Every place has a shortcut, and the kill switches are in the Valet menu like any Mac app's Quit.",
    html: `<div class="wf-window" style="background:linear-gradient(160deg,var(--wf-paper-2),var(--wf-sel))">${appMenuBar}
      <div style="zoom:.82;margin:20px 0 0 100px;width:1180px;height:780px">${shell('needs', `${K.header({ title: 'Needs you', status: K.badge('1 waiting', 'warn') })}<div class="wf-scroll">${K.inbox('↑', 'Review the Woolworths update (0.4.0)', 'Adds 1 host, 1 read tool · calls use 0.3.0 until you approve', '', K.primary('Review update'))}</div>`, { badges: { needs: 1 } })}</div>
      ${menuCol(22, 'Valet', [['About Valet'], '-', ['Settings…', '⌘,'], ['Check for Updates…'], ['Continue Setup…'], '-', ['Pause Valet', '⇧⌘P', true], ['Lock Down…', '⌥⇧⌘L'], '-', ['Hide Valet', '⌘H'], ['Quit Valet', '⌘Q']])}
      ${menuCol(300, 'Go', [['Needs You', '⌘1'], ['Sites', '⌘2'], ['Activity: Calls', '⌘3'], ['Activity: Audit Log', '⇧⌘3'], ['Connections', '⌘4'], ['Secrets', '⌘5'], ['Settings', '⌘6'], '-', ['Back', '⌘['], ['Forward', '⌘]'], '-', ['Search…', '⌘K'], '-', ['Open My Trolley on woolworths.com.au…']])}
    </div>`,
    notes: [
      [
        276,
        152,
        'Pause and Lock down live in the Valet menu, beside Quit, as kill switches should (principle 10, P3).',
      ],
      [
        276,
        106,
        '"Continue Setup…" appears while setup is unfinished; once done it reads "Run Setup Again…" (P2: "how do I get back?").',
      ],
      [
        574,
        30,
        '⌘1 to ⌘5 follow the sidebar order; Audit log gets ⇧⌘3 as its own tab (IA decision 2). ⌘, and ⌘6 both open Settings.',
      ],
      [574, 240, 'Back and Forward work on every page because state lives in the URL (principle 7).'],
      [
        76,
        3,
        "Edit › Copy works on selectable values only; interface text isn't selectable (principle 11, E3).",
      ],
    ],
  })

  // 5. Minimum window, 880 x 560
  const siteNarrow = `
    ${siteHeader(K.btn('Open my trolley…') + K.icon('⋯'))}
    <div class="wf-scroll" style="padding:14px 16px;gap:10px">
      ${K.banner('info', '0.4.0 is waiting for your review.', 'Calls use 0.3.0 until you approve.', K.primary('Review Woolworths update'))}
      ${K.health('ok', '<b>Ready</b> · logged in, checked 9:40 pm', K.ghost('Check now'))}
      ${K.card('Login', `<span>${K.link('Woolworths')} from 1Password · sam@example.com</span>`, K.btn('Change…'))}
      ${K.card('Store', '<span>Town Hall · 464-480 Kent St, Sydney</span>', K.btn('Change…'))}
      <div class="wf-card"><header><h4>▸ Can reach</h4><span class="faint">2 sites · 1 login · 9 tools</span></header></div>
    </div>
    <div style="position:absolute;right:3px;top:150px;width:5px;height:120px;border-radius:3px;background:var(--wf-line-2)"></div>`
  FRAMES.push({
    id: 'global-min-window',
    group: 'Everywhere',
    size: 'min',
    title: 'The window at its 880 x 560 minimum',
    personas: ['P1', 'P5', 'P2'],
    desc: 'Woolworths\'s Overview at the smallest size. The side column ("Can reach") folds into a section at the end, two-up cards stack, secondary header actions move into ⋯, and the page scrolls.',
    html: shell('sites', siteNarrow, { badges: { needs: 1 }, site: 0, cls: 'min' }),
    notes: [
      [190, 6, 'Sidebar keeps its width and order at the minimum (principle 6); only the page reflows.'],
      [830, 92, 'Pause site moves into ⋯ with its shortcut; the primary action of the page never does.'],
      [
        640,
        196,
        "The review button stays in view above the fold: today's remote page put Approve below it at 560 px (P7 C3.3).",
      ],
      [640, 476, 'Can reach becomes a folded section with a summary, never clipped (principle 12, P3).'],
      [850, 214, 'A visible scroll indicator: every pane scrolls and says so (E9).'],
    ],
  })

  // 6. 200% text
  const big = `<div style="zoom:2;width:590px;height:390px;display:flex;flex-direction:column;background:var(--wf-paper);overflow:hidden;border-radius:5px">
      <div class="wf-titlebar" style="height:30px;padding:0 8px;gap:6px"><span class="lights"><i></i><i></i><i></i></span>${K.icon('☰')}<span class="wf-hist">‹ ›</span><b class="grow" style="font-size:12px">Woolworths</b>${K.icon('⌕')}${K.btn('Pause')}</div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative">
        <div style="padding:10px 14px 0;border-bottom:1px solid var(--wf-line);display:flex;flex-direction:column;gap:6px">
          <div class="wf-crumbs">${'<span>Sites</span><i>›</i><span>Woolworths</span>'}</div>
          <div class="row" style="flex-wrap:wrap"><h2 style="font:600 19px var(--f-head);margin:0">Woolworths</h2>${K.badge('Ready', 'ok')}</div>
          <div class="row" style="flex-wrap:wrap">${K.btn('Open my trolley…')}${K.btn('Pause site')}</div>
          <div class="wf-tabs" style="flex-wrap:wrap"><span class="on">Overview</span><span>Tools</span><span>Permissions</span><span>Versions</span><span>Calls ↗</span></div>
        </div>
        <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">
          <div class="wf-banner info" style="flex-direction:column;align-items:flex-start;gap:6px"><div><b>0.4.0 is waiting for your review.</b> Calls use 0.3.0 until you approve.</div>${K.primary('Review Woolworths update')}</div>
          ${K.health('ok', '<b>Ready</b> · logged in, checked 9:40 pm')}
          ${K.card('Login', `<span>${K.link('Woolworths')} from 1Password</span>`, K.btn('Change…'))}
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
        176,
        40,
        'At 200% the sidebar folds behind a ☰ button (View › Show Sidebar, ⌃⌘S) so the page keeps a readable width. Assumption: this is the one exception to "the sidebar never changes shape".',
      ],
      [960, 40, 'The search field becomes a button that opens the ⌘K palette; Pause keeps its word.'],
      [
        770,
        292,
        'Header actions and tabs wrap onto new lines rather than scroll sideways; tabs stay a real tablist (P5).',
      ],
      [
        420,
        445,
        'Banners stack the button under the sentence; the button keeps its full name ("Review Woolworths update").',
      ],
      [
        1150,
        250,
        'The page scrolls vertically only, with a visible indicator (principle 12, P5 AC "no clipped controls at 200%").',
      ],
    ],
  })
})()
