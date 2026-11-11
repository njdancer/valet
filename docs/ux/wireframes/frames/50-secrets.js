// Secrets: passwords and one-time codes (P6). One page for where they come from and which logins
// Valet may use, and one page per login with its calls and what it can reach.
;(() => {
  const { K, shell, sheet, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Secrets =
    'Passwords and one-time codes. Where Valet gets them (1Password, a Keychain copy, Messages), and every login Valet may use, each with its own page: which site and version, where it may be typed, the calls that used it and what can cause it to be typed. Search finds this page for "passwords" too (IA labels).'

  // ---- local helpers ----
  const mono = (t) => `<span class="mono">${t}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  const ver = (v) => `<span class="wf-link mono">${v}</span>`
  const kvn = (rows, w = 120) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)
  // Table built from divs: the kit's .wf-table styles every nested span as a cell.
  const grid = (head, rows, o = {}) => {
    const pad = o.compact ? '5px 12px' : '8px 12px'
    const cell = (x, bg) =>
      `<div style="padding:${pad};border-bottom:1px solid var(--wf-line);display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;${bg}">${x}</div>`
    const th = head
      .map(
        (x) =>
          `<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--wf-ink-3);padding:6px 12px;border-bottom:1px solid var(--wf-line);white-space:nowrap">${x}</div>`,
      )
      .join('')
    const tr = rows
      .map((r, i) => {
        const bg = i === o.hover ? 'background:var(--wf-paper-2);' : ''
        const fade = o.faded?.includes(i) ? 'color:var(--wf-ink-2);' : ''
        return r.map((x) => cell(x, bg + fade)).join('')
      })
      .join('')
    return `<div role="table" style="display:grid;grid-template-columns:${o.cols}">${th}${tr}</div>`
  }
  // A source row: state dot, name and sentence, its status with when it was checked, its action.
  const source = (tone, name, sentence, status, actions) =>
    `<div class="row" style="align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--wf-line)">
      <span style="padding-top:4px">${K.dot(tone)}</span>
      <div class="col grow" style="gap:2px"><b>${name}</b><span class="muted">${sentence}</span><span class="faint">${status}</span></div>
      <div class="row" style="flex:none">${actions}</div></div>`

  // ---------------------------------------------------------------- Overview
  const passwords = K.card(
    'Where passwords come from',
    source(
      'ok',
      '1Password service account',
      'Reads the “Valet” vault. Works while your Mac is locked or 1Password is closed.',
      'Connected · 0 logins · checked 9:46 pm',
      K.ghost('Check now') + K.btn('Change…'),
    ) +
      source(
        'ok',
        '1Password app',
        `Asks for Touch ID when 1Password is locked. Uses ${mono('/opt/homebrew/bin/op')}, signed by 1Password.`,
        'Found · 0 logins · checked 9:46 pm',
        K.btn('Choose…'),
      ) +
      source(
        'ok',
        'Copy in your Keychain',
        "Copied once from your 1Password item, with your approval in 1Password. Works while you're away.",
        'Account my.1password.com · 1 login · copied 3 Nov',
        K.btn('Re-sync all'),
      ),
    '',
    'flush',
  )
  const codes = K.card(
    'One-time codes',
    source(
      'ok',
      'From 1Password',
      "Used when a login's 1Password item has a one-time password field.",
      'Woolworths login: no one-time password field',
      '',
    ) +
      source(
        'warn',
        'From Messages',
        'Reads codes that arrive by SMS, only from the sender you approve for each site.',
        `Off · needs Full Disk Access for Valet Messages Helper · checked 9:46 pm`,
        K.primary('Turn on…'),
      ),
    '',
    'flush',
  )
  const loginRows = [
    [
      `${K.avatar('W')}<b>Woolworths</b>`,
      `${K.link('Woolworths login')}`,
      'Keychain copy of “Woolworths”',
      mono('auth.woolworths.com.au'),
      ver('0.3.0'),
      K.link('9:47 pm'),
      K.btn('Open'),
    ],
    [
      `${K.avatar('W')}<b>Woolworths</b>`,
      `<span>login for ${ver('0.4.0')}</span>`,
      '<span class="faint">Not given yet</span>',
      mono('auth.woolworths.com.au'),
      ver('0.4.0'),
      '—',
      K.btn('Review update'),
    ],
  ]
  const overview = (over = '') => `
    ${K.header({
      title: 'Secrets',
      sub: 'Passwords and one-time codes Valet may type for you. Valet never shows them, stores them in traces or sends them to Claude.',
    })}
    <div class="wf-scroll">
      <div class="grid2" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">${passwords}${codes}</div>
      ${K.card(
        'Logins Valet may use',
        grid(['Site', 'Login', 'From', 'Typed only at', 'Version', 'Last used', ''], loginRows, {
          cols: '130px minmax(0,1fr) 196px 170px 62px 76px 124px',
          faded: [1],
          hover: 0,
        }) +
          `<div class="faint" style="padding:8px 12px">A login is given per site version. Logins are given from the site's page; Yahoo Finance and Wikipedia need none.</div>`,
        '',
        'flush',
      )}
    </div>${over}`

  FRAMES.push({
    id: 'secrets',
    group: 'Secrets',
    title: 'Secrets overview',
    personas: ['P1', 'P2', 'P3', 'P6'],
    desc: '#/secrets (⌘5). Where passwords come from, where one-time codes come from, and every login Valet may use. Each source says its state and when it was checked.',
    html: shell('secrets', overview()),
    notes: [
      [
        250,
        156,
        'Sources first, each with its state and when it was checked (principle 8, P2: "where my passwords come from").',
      ],
      [
        718,
        392,
        'A Keychain copy can go stale when the password changes in 1Password, so Re-sync sits right here and on each login page.',
      ],
      [
        758,
        291,
        'One-time codes from Messages live here, not in Settings (P1 T8, P3). Full Disk Access says its state and check time; "Turn on…" opens the steps.',
      ],
      [
        805,
        526,
        'Each login shows where it can be typed (origin) and which site version it belongs to (P3, P4).',
      ],
      [1018, 560, '"Last used" is a door: it opens Calls filtered to this login (E7, P3).'],
      [
        1153,
        607,
        'Logins are tied to a version: the waiting 0.4.0 shows "Not given yet" with its next step beside it (E1).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Login page
  const usedRows = [
    [
      ref('9A71'),
      '9:47 pm',
      tool('get_cart'),
      K.link('Claude Code'),
      'username, password',
      K.badge('Waiting for you', 'warn'),
    ],
    [
      ref('8F2E'),
      '9:31 pm',
      tool('update_cart_line'),
      K.link('Claude Code'),
      'username, password',
      K.badge('ok, 2 blocked', 'info'),
    ],
    [
      ref('3D19'),
      'Mon 6:20 pm',
      tool('remove_from_cart'),
      K.link('Claude Code'),
      'username, password',
      K.badge('Declined by you', 'idle'),
    ],
    [
      ref('0E4B'),
      'Sun 7:12 pm',
      tool('get_cart'),
      K.link('Claude Desktop'),
      'username, password',
      K.badge('ok', 'ok'),
    ],
  ]
  const loginPage = (over = '', opts = {}) => `
    ${K.header({
      crumbs: ['Secrets', 'Logins Valet may use'],
      title: 'Woolworths login',
      status: K.badge('Ready', 'ok'),
      actions: K.btn('Re-sync from 1Password') + K.danger('Revoke…'),
    })}
    <div class="wf-scroll">
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="col" style="gap:16px">
          ${K.card(
            'What it is',
            kvn(
              [
                ['Site', `${K.link('Woolworths')} · version ${ver('0.3.0')} ${K.value('9f3c1a7e…e0f1')}`],
                ['Fields', 'username, password'],
                ['From', 'Copy in your Keychain of 1Password item “Woolworths”'],
                ['Copied', `3 Nov, 8:02 pm · ${opts.synced || 'from my.1password.com'}`],
                ['Given', `6 Nov, 8:02 pm · ${K.link('audit record 4433')}`],
              ],
              76,
            ) +
              `<div class="faint">If you change the password in 1Password, re-sync it here. The update to ${ver('0.4.0')} asks you to keep this login or choose again.</div>`,
          )}
          ${K.card(
            'Where it can be typed',
            `<div class="row">${K.value('https://auth.woolworths.com.au')}<span class="muted">only</span></div>
             <div class="muted">Before each field, Valet checks the page's frame is this origin, the field is the right type and the form submits to an allowed origin, then types it as paced keystrokes.</div>`,
          )}
        </div>
        <div class="col" style="gap:16px">
          ${K.card(
            'Can reach',
            `<div class="muted">What can cause Valet to type this login:</div>
             ${kvn(
               [
                 ['Tools', `All 6 ${K.link('Woolworths')} tools, when the site is logged out`],
                 ['Apps', `${K.link('Claude Code')}, ${K.link('Claude Desktop')}`],
                 ['Cloud agents', 'None (remote access is off)'],
               ],
               92,
             )}`,
          )}
          ${K.card(
            'Calls that used it',
            grid(
              [],
              usedRows.map(([r, t, tl, , , o]) => [r, t, tl, o]),
              { cols: '50px 84px minmax(0,1fr) auto', compact: true },
            ) +
              `<div class="row" style="padding:8px 12px">${K.link('All 5 calls in 7 days')}<span class="grow"></span>${K.link('Login use in the audit log')}</div>`,
            '',
            'flush',
          )}
        </div>
      </div>
    </div>${over}`

  FRAMES.push({
    id: 'secrets-login',
    group: 'Secrets',
    title: 'Login page: Woolworths login',
    personas: ['P1', 'P3', 'P4', 'P2'],
    desc: '#/secrets/woolworths/login. Which site and version it belongs to, where it can be typed, what can cause it to be typed, and the calls that used it.',
    html: shell('secrets', loginPage()),
    notes: [
      [
        640,
        198,
        'Site, version and the exact adapter hash the login is tied to; the hash copies in full (P4, E3).',
      ],
      [
        888,
        91,
        'Re-sync and Revoke in the header. Revoke confirms with what stops working: Woolworths calls that need a login will ask you instead (E4).',
      ],
      [520, 422, 'Where it can be typed, and the checks before every field (P3).'],
      [
        710,
        196,
        'What can cause it to be typed: tools, apps and cloud agents (P3 Can reach, P6 "can be triggered by").',
      ],
      [
        840,
        482,
        "Calls that used it, and all of them in Activity, filtered (P1 T6). The audit log's login use is the second route.",
      ],
      [562, 288, 'When it was given links to its audit record (link matrix).'],
    ],
  })

  // ---------------------------------------------------------------- Messages codes sheet
  const step = (n, done, title, body) =>
    `<div class="row" style="align-items:flex-start;gap:10px"><span class="wf-av" style="${done ? 'background:var(--wf-ok)' : ''}">${done ? '✓' : n}</span><div class="col grow" style="gap:4px"><b>${title}</b>${body}</div></div>`
  const messagesSheet = sheet(
    'Read one-time codes from Messages',
    `<p class="muted" style="margin:0">When a site texts you a code, Valet can read it from Messages and type it, so a login can finish while you're away. It reads only codes from the sender you approve for each site.</p>
     ${step(1, false, 'Give Valet Messages Helper Full Disk Access', `<span class="muted">macOS keeps Messages private. In System Settings › Privacy & Security › Full Disk Access, turn on “Valet Messages Helper”.</span><div class="row">${K.primary('Open System Settings')}<span class="faint">Not given yet · checked 9:46 pm</span>${K.ghost('Check again')}</div>`)}
     ${step(2, false, 'Choose the sender for each site', `<div class="row">${K.avatar('W')}<b>Woolworths</b>${K.input('Sender, e.g. Woolworths or a short number', '260px')}</div>`)}
     <div class="faint">Turn it off any time here. Valet never reads other messages and never keeps the codes.</div>`,
    `<span class="grow"></span>${K.btn('Cancel')}${K.primary('Turn on')}`,
  )

  FRAMES.push({
    id: 'secrets-messages',
    group: 'Secrets',
    title: 'Turn on codes from Messages (sheet)',
    personas: ['P1', 'P2', 'P5'],
    desc: 'Opens over Secrets from "Turn on…". The Full Disk Access step says its state, when it was checked and how to re-check, instead of failing later.',
    html: shell('secrets', overview(), { over: messagesSheet }),
    notes: [
      [
        750,
        224,
        'Full Disk Access is a step with its state and when it was checked; Check again re-checks (principle 8). Today it fails silently later.',
      ],
      [728, 282, 'Codes are read only from the sender approved for each site.'],
      [790, 348, 'Turn on stays focusable but says why it is unavailable until access is given (P5).'],
      [290, 319, 'Says in plain words what it never does (P2).'],
    ],
  })
})()
