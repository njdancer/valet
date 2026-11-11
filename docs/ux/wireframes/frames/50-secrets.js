// Secrets: passwords and one-time codes (P6). v2: story.md world (Sat 7 Nov, 9:48 pm), round 2
// fixes (login revoke dialog).
;(() => {
  const WF = window.WF
  const { K, sheet, dialog, FRAMES } = WF
  WF.GROUP_INTRO = WF.GROUP_INTRO || {}
  WF.GROUP_INTRO.Secrets =
    'Passwords and one-time codes. Where Valet gets them (1Password, a Keychain copy, Messages), and every login Valet may use, each with its own page: which site and version, where it may be typed, the calls that used it and what can cause it to be typed. Search finds this page for "passwords" too (IA labels).'

  const SITES = [
    ['W', 'Woolworths', 'warn'],
    ['Y', 'Yahoo Finance', 'warn'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const shell = (a, p, o = {}) => WF.shell(a, p, { badges: { needs: 4 }, sites: SITES, ...o })

  // ---- local helpers ----
  const mono = (t) => `<span class="mono">${t}</span>`
  const ref = (r) => `<span class="wf-link mono" style="font-weight:600">${r}</span>`
  const tool = (t) => `<span class="wf-link mono">${t}</span>`
  const ver = (v) => `<span class="wf-link mono">${v}</span>`
  const kvn = (rows, w = 120) =>
    K.kv(rows).replace('class="wf-kv"', `class="wf-kv" style="grid-template-columns:${w}px minmax(0,1fr)"`)
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
      'Copy in your Keychain',
      "Copied from your 1Password item, with your approval in 1Password. Works while you're away.",
      'Account my.1password.com · Personal vault · 1 login · re-synced Fri 6 Nov',
      K.btn('Re-sync all'),
    ) +
      source(
        'ok',
        '1Password app',
        `Asks for Touch ID when 1Password is locked. Uses ${mono('/opt/homebrew/bin/op')}, signed by 1Password.`,
        'Found · 0 logins · checked 9:46 pm',
        K.btn('Choose…'),
      ) +
      source(
        'idle',
        '1Password service account',
        'For a vault shared with Valet. Works while your Mac is locked. For people who manage 1Password for a team.',
        'Not set up',
        K.btn('Set up…'),
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
        'Off · needs Full Disk Access for Valet Messages Helper · checked 9:46 pm',
        K.primary('Turn on…'),
      ),
    '',
    'flush',
  )
  const loginRows = [
    [
      `${K.avatar('W')}<b>Woolworths</b>`,
      K.link('Woolworths login'),
      'Keychain copy of “Woolworths”',
      mono('auth.woolworths.com.au'),
      ver('0.3.0'),
      K.link('9:47 pm'),
      K.btn('Open'),
    ],
    [
      `${K.avatar('W')}<b>Woolworths</b>`,
      `<span>login for ${ver('0.4.0')}</span>`,
      K.badge('Not given yet', 'idle'),
      mono('auth.woolworths.com.au'),
      ver('0.4.0'),
      '—',
      K.btn('Review update'),
    ],
  ]
  const overview = () => `
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
          `<div class="faint" style="padding:8px 12px">A login is given per site version, from the site's page. Yahoo Finance and Wikipedia need none.</div>`,
        '',
        'flush',
      )}
    </div>`

  FRAMES.push({
    id: 'secrets',
    group: 'Secrets',
    title: 'Secrets overview',
    personas: ['P1', 'P2', 'P3', 'P6'],
    desc: '#/secrets (⌘5). Where passwords come from (the Keychain copy in use first), where one-time codes come from, and every login Valet may use.',
    html: shell('secrets', overview()),
    notes: [
      [
        262,
        156,
        'Sources first: the Keychain copy in use, from the Personal vault, as in setup and the grant sheet (story, P2 M3). Each says its state and when checked.',
      ],
      [730, 193, 'Re-sync sits beside the copy that can go stale.'],
      [
        770,
        291,
        'One-time codes from Messages live here, not in Settings (P1 T8, P3). "Turn on…" opens the steps.',
      ],
      [817, 540, 'Each login shows where it can be typed and which site version it belongs to (P3, P4).'],
      [1018, 577, '"Last used" is a door to Calls filtered to this login (E7).'],
      [
        1153,
        622,
        'Logins are tied to a version: 0.4.0 shows "Not given yet" with Review update beside it (E1, story words).',
      ],
    ],
  })

  // ---------------------------------------------------------------- Login page
  const usedRows = [
    [ref('9A71'), 'Sat 9:47 pm', tool('get_cart'), K.badge('Needs you · login', 'warn')],
    [ref('8F2E'), 'Sat 9:31 pm', tool('update_cart_line'), K.badge('ok, 2 blocked', 'info')],
    [ref('2D07'), 'Fri 8:20 pm', tool('get_cart'), K.badge('ok', 'ok')],
  ]
  const loginPage = () => `
    ${K.header({
      crumbs: ['Secrets', 'Logins Valet may use'],
      title: 'Woolworths login',
      status: K.badge('Ready', 'ok'),
      actions: K.btn('Re-sync from 1Password') + K.dangerSoft('Revoke…'),
    })}
    <div class="wf-scroll">
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="col" style="gap:16px">
          ${K.card(
            'What it is',
            kvn(
              [
                ['Site', `${K.link('Woolworths')} · version ${ver('0.3.0')} ${K.value('9f3c…e0f1')}`],
                ['Fields', 'username, password'],
                ['From', 'Keychain copy of 1Password item “Woolworths” (Personal vault)'],
                ['Re-synced', 'Fri 6 Nov, 8:14 pm · from my.1password.com'],
                ['Given', `Fri 6 Nov, 8:14 pm · ${K.link('audit record 4433')}`],
              ],
              76,
            ) +
              `<div class="faint">If you change the password in 1Password, re-sync it here. The update to ${ver('0.4.0')} adds a host, so it asks you to choose the login again.</div>`,
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
            `<div class="muted">What can cause Valet to type this login (9:48 pm):</div>
             ${kvn(
               [
                 ['Tools', `All 6 ${K.link('Woolworths')} tools, when the site is logged out`],
                 ['Apps', `${K.link('Claude Code')}, ${K.link('Claude Desktop')}`],
                 ['Cloud agents', 'None approved yet (1 asking to connect)'],
               ],
               92,
             )}`,
          )}
          ${K.card(
            'Calls that used it',
            grid([], usedRows, { cols: '50px 90px minmax(0,1fr) auto', compact: true }) +
              `<div class="row" style="padding:8px 12px">${K.link('All 3 calls since Fri 6 Nov')}<span class="grow"></span>${K.link('Login use in the audit log')}</div>`,
            '',
            'flush',
          )}
        </div>
      </div>
    </div>`

  FRAMES.push({
    id: 'secrets-login',
    group: 'Secrets',
    title: 'Login page: Woolworths login',
    personas: ['P1', 'P3', 'P4', 'P2'],
    desc: '#/secrets/woolworths/login. Which site and version it belongs to, where it can be typed, what can cause it to be typed, and the calls that used it.',
    html: shell('secrets', loginPage()),
    notes: [
      [624, 198, 'Site, version and adapter hash per story (9f3c…e0f1); the hash copies in full (P4, E3).'],
      [888, 91, 'Re-sync and Revoke… in the header; Revoke asks first (secrets-revoke-login).'],
      [514, 438, 'Where it can be typed, and the checks before every field (P3).'],
      [
        722,
        196,
        'What can cause it to be typed: tools, connected apps, cloud agents (P3, P6). Cursor is not counted.',
      ],
      [872, 452, 'Calls that used it per story, and all 3 in Activity (P1 T6).'],
      [588, 303, 'When it was given links to its audit record.'],
    ],
  })

  // ---------------------------------------------------------------- Revoke login dialog
  const revokeLogin = dialog(
    'Revoke the Woolworths login?',
    `<div>Valet stops typing your Woolworths login and deletes its Keychain copy. Your 1Password item isn't touched.</div>
     <div style="background:var(--wf-paper-2);border:1px solid var(--wf-line);border-radius:8px;padding:8px 10px" class="col">
       <span><b style="color:var(--wf-ink)">Used by</b> ${K.link('3 calls since Fri 6 Nov')}, last at 9:47 pm (${ref('9A71')})</span>
       <span>Can be typed by all 6 Woolworths tools, for Claude Code and Claude Desktop</span>
     </div>
     <div>Next time Woolworths logs Valet out, calls stop with “Give Valet your Woolworths login” in Needs you until you choose one again.</div>
     ${K.check('Also log Valet out of Woolworths now', true)}
     <div>The waiting call 9A71 is declined. This can't be undone.</div>`,
    `<span class="grow"></span>${K.btn('Cancel')}${K.danger('Revoke login')}`,
  )

  FRAMES.push({
    id: 'secrets-revoke-login',
    group: 'Secrets',
    title: 'Revoke a login (dialog)',
    personas: ['P3', 'P2', 'P5'],
    desc: 'Opens over the login page from Revoke…. Says what stops, what it was used for, and offers to end the site session too, since revoking the login alone leaves Valet logged in.',
    html: shell('secrets', loginPage(), { over: revokeLogin }),
    notes: [
      [380, 278, 'Says what stops and what is not touched (the 1Password item) (E4, P2).'],
      [462, 326, 'Evidence: what used it and what could use it (P3).'],
      [
        380,
        401,
        'What Claude and Needs you will say next time, in the shared words ("Give Valet your Woolworths login").',
      ],
      [
        380,
        441,
        'Revoking a login leaves Valet logged in, so ending the site session is offered and ticked (P3).',
      ],
      [600, 509, 'Initial focus on Cancel; the red button names the verb (P5).'],
    ],
  })

  // ---------------------------------------------------------------- Messages codes sheet
  const step = (n, done, title, body) =>
    `<div class="row" style="align-items:flex-start;gap:10px"><span class="wf-av" style="${done ? 'background:var(--wf-ok)' : ''}">${done ? '✓' : n}</span><div class="col grow" style="gap:4px"><b>${title}</b>${body}</div></div>`
  const messagesSheet = sheet(
    'Read one-time codes from Messages',
    `<p class="muted" style="margin:0">When a site texts you a code, Valet can read it from Messages and type it, so a login can finish while you're away. It reads only codes from the sender you approve for each site.</p>
     ${step(1, false, 'Give Valet Messages Helper Full Disk Access', `<span class="muted">macOS keeps Messages private. In System Settings › Privacy &amp; Security › Full Disk Access, turn on “Valet Messages Helper”.</span><div class="row">${K.primary('Open System Settings')}<span class="faint">Not given yet · checked 9:46 pm</span>${K.ghost('Check again')}</div>`)}
     ${step(2, false, 'Choose the sender for each site', `<div class="row">${K.avatar('W')}<b>Woolworths</b>${K.input('Sender, e.g. Woolworths or a short number', '260px')}</div>`)}
     <div class="faint">Turn it off any time here. Valet never reads other messages and never keeps the codes.</div>`,
    `<span class="grow"></span>${K.btn('Cancel')}<span class="wf-btn" style="color:var(--wf-ink-3)" aria-disabled="true">Turn on</span>`,
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
        'Full Disk Access is a step with its state and when checked; Check again re-checks (principle 8).',
      ],
      [728, 282, 'Codes are read only from the sender approved for each site.'],
      [790, 348, 'Turn on stays focusable but says why it is unavailable until access is given (P5).'],
      [290, 319, 'Says in plain words what it never does (P2).'],
    ],
  })
})()
