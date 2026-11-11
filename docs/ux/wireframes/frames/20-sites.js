// Sites: the list, one page per site with its tabs, the review pages, and the sheets and dialog that
// open over a site (P2, P3, E1, E6, principles 2, 4 and 5). Facts follow ../story.md: Saturday
// 7 November 2026, 9:48 pm, 4 things waiting, unless a frame's first note names another moment.
;(() => {
  const { K, shell, sheet, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Sites =
    'One page per site (P2), reached from the sidebar\'s Sites place, the site rows under it, the menu bar and every link to the site. Overview is the page most people use (P2 Sam), so everything with a next step shows that step there as a named button beside its status (E1). Tools, Permissions and Versions are real tabs; "All calls" is a header link to Activity filtered to the site, not a tab. Review update, Compare and Restore are full pages inside the site, with the sidebar kept and a breadcrumb back (P3).'

  // ---------- shared pieces ----------
  const WOW_HASH = '9f3c…e0f1'
  const NEXT_HASH = '4b7e…a83c'
  const DEV_HASH = 'c81d…07b2'
  const TABS = ['Overview', 'Tools', 'Permissions', 'Versions']
  const NEEDS = { needs: 4 } // story: 4 waiting at 9:48 pm
  const mono = (s) => `<span class="mono">${s}</span>`
  const sites = (wow = 'warn', yahoo = 'warn') => [
    ['W', 'Woolworths', wow],
    ['Y', 'Yahoo Finance', yahoo],
    ['W', 'Wikipedia', 'ok'],
  ]
  const WOW = {
    name: 'Woolworths',
    av: 'W',
    id: 'woolworths',
    version: '0.3.0',
    hash: WOW_HASH,
    origin: 'comes with Valet · approved Fri 6 Nov, 8:12 pm',
    trolley: true,
  }
  const YAHOO = {
    name: 'Yahoo Finance',
    av: 'Y',
    id: 'yahoo-finance',
    version: '1.2.0',
    hash: '2c8a…41d7',
    origin: 'comes with Valet · approved Fri 6 Nov, 8:12 pm',
    trolley: false,
  }
  const focusRing = 'outline:2px solid var(--wf-act);outline-offset:3px;border-radius:4px'
  // A tinted row for something new or wider (review additions).
  const added = (tone, html) =>
    `<div class="col" style="gap:4px;padding:8px 10px;border-radius:6px;background:var(--wf-tint-${tone});box-shadow:inset 3px 0 0 var(--wf-${tone})">${html}</div>`
  const diffLine = (kind, no, text) => {
    const bg = kind === '+' ? 'var(--wf-tint-ok)' : kind === '-' ? 'var(--wf-tint-bad)' : 'transparent'
    return `<div class="mono" style="display:flex;gap:10px;padding:1px 8px;background:${bg};white-space:pre"><span class="faint" style="width:26px;text-align:right">${no}</span><span class="faint">${kind}</span><span>${text}</span></div>`
  }

  /** The one site header: breadcrumb, name, status + its button, adapter id/version, tabs. */
  const siteHead = ({
    site = WOW,
    status = '',
    actions = '',
    tab = 0,
    extra = '',
    focus = false,
    version,
    hash,
    origin,
  } = {}) =>
    K.header({
      crumbs: ['Sites', site.name],
      title: `<span class="row" style="gap:10px;${focus ? focusRing : ''}">${K.avatar(site.av)}${site.name}</span>`,
      status,
      actions: actions + K.link('All calls') + (site.trolley ? K.btn('Open my trolley') : '') + K.icon('⋯'),
      sub: `<span class="row" style="gap:6px">${mono(`${site.id} ${version || site.version}`)} ${K.value(hash || site.hash)} <span class="faint">· ${origin || site.origin}</span>${extra}</span>`,
      tabs: K.tabs(TABS, tab),
    })

  // Overview cards, each a function so states can swap one card.
  const storeCard = (chosen = true) =>
    K.card(
      'Store',
      chosen
        ? K.kv([
            ['Shops at', `<b>Woolworths Town Hall</b>`],
            ['Address', `<span class="muted">Cnr Park &amp; George Streets, Sydney 2000</span>`],
          ])
        : `<span class="muted">No store chosen. Prices and stock need one.</span>`,
      chosen ? K.btn('Change store…') : K.btn('Choose store…'),
    )
  const loginCard = (given = true) =>
    K.card(
      'Login',
      given
        ? K.kv([
            [
              'Valet may use',
              `${K.link('Woolworths')} <span class="faint">Personal vault, Keychain copy</span>`,
            ],
            ['Filled only on', K.value('auth.woolworths.com.au')],
            ['Session', `${K.badge('Signed out', 'warn')} <span class="faint">check waiting, 9:47 pm</span>`],
          ])
        : `<span class="muted">Valet has no Woolworths login yet. Search works; anything with your cart waits for one.</span>`,
      given ? K.btn('Change login…') : K.btn('Choose login…'),
    )
  const canDoCard = () =>
    K.card(
      "What it can and can't do",
      `<div><b>Can</b> <span class="muted">search products, read your cart, change your cart (asks you before removing anything).</span></div>
       <div><b>Can't</b> <span class="muted">pay, check out, or use any site but Woolworths.</span></div>`,
      K.ghost('Permissions'),
    )
  const todayCard = (zero = false) =>
    K.card(
      'Today',
      zero
        ? `<span class="muted">No calls yet.</span>`
        : `<div class="row" style="gap:18px"><span class="big">${K.link('21')}</span><span class="muted">calls</span>${K.link('1 failed')}${K.link('2 requests blocked')}</div>
           <div class="muted">Last call 9:48 pm · ${K.link('Remove from cart')} · call ${K.link('7F2A')} · waiting for you</div>
           <div class="row" style="gap:8px;border-top:1px solid var(--wf-line);padding-top:8px"><span class="muted">Called by</span>${K.link('Claude Code')}<span class="faint">15</span>${K.link('Claude Desktop')}<span class="faint">6</span></div>`,
    )
  const canReachCard = (version = '0.3.0') =>
    K.card(
      'Can reach',
      `<div class="col" style="gap:4px">
        <div>${K.link('3 web addresses')} <span class="faint">www.woolworths.com.au, cdn0.woolworths.media, acs.woolworths.com.au</span></div>
        <div>${K.link('1 login')} <span class="faint">filled only on auth.woolworths.com.au</span></div>
        <div>${K.link('6 tools')} <span class="faint">3 read · 3 change your cart · 0 can't be undone</span></div>
        <div>${K.link('2 apps')} <span class="faint">and no cloud agents can call it</span></div></div>
       <div class="faint">Worked out from ${version} · checked 9:41 pm ${K.ghost('Check now')}</div>`,
      K.ghost('Open'),
    )

  const overview = ({ top = '', store = true, login = true, today = false, cando = true }) => `
    <div class="wf-scroll" style="gap:12px;padding-top:16px">
      ${top}
      <div class="grid2" style="gap:12px">
        <div class="col" style="gap:12px">${storeCard(store)}${loginCard(login)}${cando ? canDoCard() : ''}</div>
        <div class="col" style="gap:12px">${todayCard(today)}${canReachCard()}</div>
      </div>
    </div>`

  // ---------- Sites list ----------
  const siteRow = (av, name, ver, health, extra) =>
    `<div class="wf-inbox" style="align-items:flex-start">${K.avatar(av)}<div class="grow" style="gap:8px">
       <div class="row"><b style="font-size:13px">${K.link(name)}</b>${mono(ver)}<span class="grow"></span>${extra}</div>${health}</div></div>`
  const list = `
    ${K.header({ title: 'Sites', status: K.badge('3 sites', 'idle'), actions: K.ghost('Check all now') })}
    <div class="wf-scroll" style="gap:10px">
      ${siteRow(
        'W',
        'Woolworths',
        'woolworths 0.3.0',
        K.health(
          'warn',
          '<b>Woolworths 0.4.0 is waiting for your review.</b> Calls use 0.3.0 until you approve it.',
          K.primary('Review update'),
        ),
        `<span class="muted">${K.link('21 calls today')} · login check waiting</span>`,
      )}
      ${siteRow(
        'Y',
        'Yahoo Finance',
        'yahoo-finance 1.2.0',
        K.health(
          'warn',
          'Yahoo Finance is limiting requests · calls resume at 9:52 pm',
          K.ghost('Try now') + K.ghost('Pause site'),
        ),
        `<span class="muted">${K.link('12 calls today')} · no login needed</span>`,
      )}
      ${siteRow(
        'W',
        'Wikipedia',
        'wikipedia 0.2.1',
        K.health('ok', 'Ready · checked 9:40 pm', K.ghost('Pause site')),
        `<span class="muted">${K.link('4 calls today')} · no login needed</span>`,
      )}
      <p class="faint" style="margin:0">Sites come with Valet or from Claude's authoring agent in your IDE. A new one appears here as "Not approved yet" with a Review button.</p>
    </div>`
  FRAMES.push({
    id: 'sites-list',
    group: 'Sites',
    title: 'Sites list',
    personas: ['P1', 'P2', 'P3', 'P5'],
    desc: "One row per site: name, adapter id and version, today in numbers, and its health line with that state's own action.",
    html: shell('sites', list, { sites: sites(), badges: NEEDS }),
    notes: [
      [
        293,
        138,
        'The site name is the link to its page; the row itself is not a target, because it holds its own buttons (P5 M3). Name and version sit together so P4 sees which build is live.',
      ],
      [
        1005,
        175,
        'An update waiting is a sentence plus a real "Review update" button that goes straight to the review page (E1). The same button is on Overview, Versions, Needs you and the menu bar.',
      ],
      [
        954,
        286,
        'A limited site gets Try now and Pause site in place (E6, P1), both quiet: waiting is the obvious choice (P2).',
      ],
      [
        926,
        139,
        'Numbers are doors: "21 calls today" opens Calls filtered to Woolworths (E7). 21 + 12 + 4 = the 37 on Needs you.',
      ],
      [
        246,
        458,
        'No "Add a site…" dead end (out of scope, IA section 10): the list says where sites come from instead. An unapproved site\'s row shows "Not approved yet" in its health line with a "Review Woolworths" button, the same as its Overview.',
      ],
    ],
  })

  const empty = `
    ${K.header({ title: 'Sites' })}
    <div class="wf-scroll">
      ${K.empty('No sites yet', "A site lets Claude use a website as you, in a browser on this Mac. Sites come with Valet or from Claude's authoring agent in your IDE, and each one is reviewed before it runs.", `<div class="row" style="margin-top:8px">${K.primary('Continue setup')}</div>`)}
    </div>`
  FRAMES.push({
    id: 'sites-empty',
    group: 'Sites',
    title: 'Sites list, empty',
    personas: ['P2', 'P5'],
    desc: 'A different moment: setup was quit before approving the first site. Its Needs you item is "Finish setup (5 steps left)".',
    html: shell('sites', empty, { sites: [], badges: { needs: 1 } }),
    notes: [
      [274, 171, "Says what a site is in one sentence, in Sam's words (P2, E8)."],
      [
        637,
        217,
        '"Continue setup" re-enters setup at "Approve Woolworths", the same as the "Finish setup" Needs you item (P9).',
      ],
      [
        235,
        228,
        'The sidebar keeps its shape: the Sites group stays with no rows rather than disappearing (principle 6).',
      ],
    ],
  })

  // ---------- Overview states ----------
  // At 9:48 pm Woolworths' session waits on a verification check (call 9A71), so that is its health line.
  const readyTop = K.health(
    'warn',
    '<b>Needs you: Log in to Woolworths (verification check).</b> Login window open until 10:02 pm · raised by call ' +
      K.link('9A71'),
    K.primary('Show login window') + K.ghost('Pause site'),
  )
  const readyTopQuiet = readyTop.replace(K.primary('Show login window'), K.btn('Show login window'))
  FRAMES.push({
    id: 'site-overview',
    group: 'Sites',
    title: 'Site Overview',
    personas: ['P2', 'P3', 'P1', 'P5'],
    desc: "The story moment, with the update banner left out to show the base page (it is drawn next): health, store, login, trolley, what it can and can't do, today, who calls it and what it can reach.",
    html: shell('sites', siteHead() + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: NEEDS,
    }),
    notes: [
      [
        362,
        128,
        'Header: breadcrumb, name, then the adapter id, version and hash P4 asked for, and where it came from. The hash is a value: selectable, with copy (E3).',
      ],
      [
        475,
        177,
        'Tabs are a real tablist with only tabs in it (P5 M1). "All calls" is a link in the header to Activity filtered to Woolworths, not a copy.',
      ],
      [
        1007,
        70,
        '"Open my trolley" (Woolworths\' own word for its page) opens the cart in Valet\'s browser on this Mac (P2). The ⋯ menu holds Pause site and Remove site….',
      ],
      [
        561,
        300,
        'Every card with a setting has its change button in the header, named by what it changes (principle 2).',
      ],
      [
        904,
        237,
        'The health line is the story\'s state: call 9A71 hit a verification check, so "Show login window" is here as well as in Needs you, with the same title (principles 1, 4). No separate "Ready" badge: it would be heard twice (P5 m3).',
      ],
      [
        712,
        338,
        "Today counts only Woolworths (21 of the day's 37) and only connected apps; revoked Cursor appears only in history (story). No sparkline (P1 m5).",
      ],
      [
        712,
        465,
        'Can reach (P3): web addresses, logins, tools and callers, each a link, with when it was worked out and Check now (principle 8).',
      ],
    ],
  })

  const updateBanner = K.banner(
    'warn',
    'Woolworths 0.4.0 is waiting for your review.',
    'It adds 1 web address and 1 tool that only reads (Everyday Rewards balance). Calls keep using 0.3.0 until you approve. Made by the authoring agent (IDE) at 9:20 pm.',
    K.primary('Review update'),
  )
  FRAMES.push({
    id: 'site-overview-update',
    group: 'Sites',
    title: 'Site Overview, update waiting',
    personas: ['P1', 'P2', 'P4', 'P5'],
    desc: "Nick's original complaint: he was on this page and could not find the review. Now it is a header button and a banner, both real buttons, and nothing else (P1 M6).",
    html: shell(
      'sites',
      siteHead({
        actions: K.btn('Review Woolworths update'),
        extra: ` <span class="faint">· 0.4.0 waiting</span>`,
      }) + overview({ top: updateBanner + readyTopQuiet, cando: false }),
      { site: 0, sites: sites(), badges: NEEDS },
    ),
    notes: [
      [
        752,
        114,
        'The version line says "0.4.0 waiting" in plain text; there is no badge any more, so there are exactly two ways in, not three (P1 M6).',
      ],
      [
        745,
        86,
        '"Review Woolworths update" names the object (principle 2) and opens #/sites/woolworths/versions/4b7e…/review in this window. Keyboard: it is the first button after the heading (P5).',
      ],
      [
        259,
        238,
        'The banner holds the one primary button on the page; the header button and "Show login window" are secondary. The banner says what changes, who made it and what happens meanwhile. "Compare" is gone from here; it lives on Versions (P1 M6).',
      ],
      [
        235,
        259,
        'Same title as the Needs you item "Review the Woolworths update (0.4.0)" and the menu bar row (principle 1). The sidebar dot is amber; the Needs you count of 4 includes it.',
      ],
      [
        273,
        302,
        'The health line is about the session, not the update: 0.3.0 keeps working while 0.4.0 waits, so the waiting login check stays its own line. The "What it can and can\'t do" card is below, one scroll down.',
      ],
    ],
  })

  const loginTop = K.health(
    'warn',
    '<b>Needs you:</b> give Valet your Woolworths login. Search works now; Get cart, Add to cart, Update cart line and Remove from cart wait for it.',
    K.primary('Choose login…'),
  )
  FRAMES.push({
    id: 'site-overview-needs-login',
    group: 'Sites',
    title: 'Site Overview, needs a login',
    personas: ['P2', 'P6', 'P1'],
    desc: 'A different moment: Fri 6 Nov, 8:20 pm, setup finished with the login step skipped. The Needs you item "Give Valet your Woolworths login" points here and to the same sheet.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Needs a login', 'warn') }) +
        overview({ top: loginTop, login: false, today: true }),
      {
        site: 0,
        sites: sites('warn', 'ok'),
        badges: { needs: 1 },
      },
    ),
    notes: [
      [
        1018,
        237,
        '"Choose login…" opens the grant sheet over this page (principle 5); Escape comes back here with focus on this button.',
      ],
      [
        273,
        235,
        'The line says which tools wait, so Sam knows search still works. Assumption: the adapter marks which tools need the login.',
      ],
      [
        562,
        427,
        'The Login card repeats the action in place (principle 4). Both buttons open the same sheet.',
      ],
      [
        396,
        91,
        'The badge, the health line, the Needs you item and the tool result all use the same words: "Give Valet your Woolworths login" (IA section 7).',
      ],
    ],
  })

  // Yahoo Finance is the limited site in the story (call 4C21).
  const limitTop =
    K.health(
      'warn',
      '<b>Yahoo Finance is limiting requests · calls resume at 9:52 pm.</b> Nothing to do: calls start again by themselves.',
      K.ghost('Try now…') + K.ghost('Pause site'),
    ) +
    `<div class="row faint" style="margin-top:-6px;padding:0 10px">▸ Details: call ${K.link('4C21')} (Get quote, Claude Desktop) got "too many requests" at 9:22 pm. Valet waits 30 min, up to 6 h if it happens again.</div>`
  const yahooPage = `
    ${siteHead({ site: YAHOO, status: K.badge('Limited until 9:52 pm', 'warn') })}
    <div class="wf-scroll" style="gap:12px;padding-top:16px">
      ${limitTop}
      <div class="grid2" style="gap:12px">
        <div class="col" style="gap:12px">
          ${K.card("What it can and can't do", `<div><b>Can</b> <span class="muted">get quotes, price history and search for symbols.</span></div><div><b>Can't</b> <span class="muted">log in, trade, or use any site but Yahoo Finance.</span></div>`, K.ghost('Permissions'))}
          ${K.card('Login', '<span class="muted">Yahoo Finance needs no login. Valet never signs in here.</span>')}
        </div>
        <div class="col" style="gap:12px">
          ${K.card(
            'Today',
            `<div class="row" style="gap:18px"><span class="big">${K.link('12')}</span><span class="muted">calls</span>${K.link('1 limited')}</div>
            <div class="muted">Last call 9:22 pm · ${K.link('Get quote')} · call ${K.link('4C21')} · limited by site</div>
            <div class="row" style="gap:8px;border-top:1px solid var(--wf-line);padding-top:8px"><span class="muted">Called by</span>${K.link('Claude Desktop')}<span class="faint">9</span>${K.link('Claude Code')}<span class="faint">3</span></div>`,
          )}
          ${K.card('Can reach', `<div>${K.link('2 web addresses')} <span class="faint">finance.yahoo.com, query1.finance.yahoo.com</span></div><div>${K.link('3 tools')} <span class="faint">all read</span> · no login</div><div>${K.link('2 apps')} <span class="faint">and no cloud agents can call it</span></div><div class="faint">Worked out from 1.2.0 · checked 9:41 pm</div>`, K.ghost('Open'))}
        </div>
      </div>
    </div>`
  FRAMES.push({
    id: 'site-overview-limited',
    group: 'Sites',
    title: 'Site Overview, limited by the site (Yahoo Finance)',
    personas: ['P1', 'P2', 'P3', 'P7'],
    desc: 'Yahoo Finance is pushing back. The health line says until when and that nothing needs doing; Try now and Pause site are there for those who want them.',
    html: shell('sites', yahooPage, { site: 1, sites: sites(), badges: NEEDS }),
    notes: [
      [
        273,
        242,
        'Clock time, not a countdown: this can be hours (E5). Same sentence as the tool result Claude gets (story words), then "Nothing to do" for Sam (P2).',
      ],
      [
        959,
        236,
        'Try now (P1) is quiet, not primary, and its "…" opens a one-line warning that it may make Yahoo Finance wait longer.',
      ],
      [
        1045,
        236,
        'Pause site is reversible, so it acts at once with an Undo toast (E4). Same label everywhere (P1 m4).',
      ],
      [
        246,
        280,
        'Details names the call that tripped it (4C21) and the wait rule (P3, P1). Valet\'s own cap uses the other sentence: "Valet is limiting its requests to Yahoo Finance until 10:00 pm".',
      ],
      [261, 487, 'A site with no login or store shows only the cards that apply; no empty Store card.'],
    ],
  })

  const pausedTop = K.health(
    '',
    '<b>Woolworths is paused.</b> Calls are refused and nothing is sent · paused by you at 9:49 pm',
    K.primary('Resume Woolworths'),
  )
  FRAMES.push({
    id: 'site-overview-paused',
    group: 'Sites',
    title: 'Site Overview, site paused',
    personas: ['P1', 'P3'],
    desc: 'A minute after the story moment: Woolworths paused at 9:49 pm from the ⋯ menu. The other sites keep working; pausing all of Valet is the titlebar button.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Paused', 'idle') }) +
        overview({ top: pausedTop }) +
        K.toast('Woolworths paused. Calls are refused until you resume.', K.btn('Undo  ⌘Z')),
      { site: 0, sites: sites('idle'), badges: NEEDS },
    ),
    notes: [
      [986, 236, 'The one next step is the primary button: "Resume Woolworths" (principle 2).'],
      [273, 242, 'Says who paused and when, and that nothing was sent, so P3 can trust it (principle 8).'],
      [
        818,
        725,
        'The toast offers Undo and ⌘Z (P1). It stays until focus leaves it, so Jordan can reach it (P5).',
      ],
      [
        235,
        259,
        'The sidebar dot turns grey. A paused site is not a Needs you item: the person chose it (IA).',
      ],
    ],
  })

  const firstTop = K.banner(
    'info',
    "Woolworths isn't approved yet.",
    'It comes with Valet, but nothing runs until you review what it can do. It will ask for your Woolworths login and a store next.',
    K.primary('Review Woolworths'),
  )
  const firstPage = `
    ${siteHead({ site: { ...WOW, trolley: false }, status: K.badge('Not approved yet', 'info'), origin: 'comes with Valet' })}
    <div class="wf-scroll" style="gap:12px;padding-top:16px">
      ${firstTop}
      <div class="grid2" style="gap:12px">
        <div class="col" style="gap:12px">${canDoCard()}
          ${K.card('Store', '<span class="faint">You choose a store after approving.</span>')}
          ${K.card('Login', '<span class="faint">You choose a login after approving. Valet fills it only on auth.woolworths.com.au.</span>')}</div>
        <div class="col" style="gap:12px">${canReachCard()}
          ${K.card('Today', '<span class="faint">Claude can\'t call Woolworths until it is approved. It is told: "Woolworths is waiting for review in Valet".</span>')}</div>
      </div>
    </div>`
  FRAMES.push({
    id: 'site-overview-first-install',
    group: 'Sites',
    title: 'Site Overview, first install not approved',
    personas: ['P2', 'P3', 'P4'],
    desc: 'A different moment: Fri 6 Nov, 8:10 pm, setup left before "Approve Woolworths". The page already says what it would do; the review is one click away.',
    html: shell('sites', firstPage, { site: 0, sites: sites('info', 'ok'), badges: { needs: 1 } }),
    notes: [
      [
        989,
        239,
        '"Review Woolworths" opens the first-install review (summary first). Its Needs you item is "Review Woolworths before first use".',
      ],
      [
        454,
        130,
        'Says it comes with Valet, the same as setup (P2 M5). No "Open my trolley" until approved: the site has no session yet.',
      ],
      [
        261,
        487,
        'Store and Login say they come after approval instead of showing disabled buttons, so nothing looks broken.',
      ],
      [712, 311, 'Can reach is shown before approval: P3 sees the blast radius before saying yes.'],
    ],
  })

  // ---------- After approving 0.4.0 ----------
  const approvedPage = `
    ${siteHead({ focus: true, version: '0.4.0', hash: NEXT_HASH, origin: 'by the authoring agent (IDE) · approved Sat 7 Nov, 9:50 pm' })}
    <div class="wf-scroll" style="gap:12px;padding-top:16px">
      ${readyTop}
      <div class="grid2" style="gap:12px">
        <div class="col" style="gap:12px">${storeCard()}${loginCard()}</div>
        <div class="col" style="gap:12px">${todayCard()}${K.card(
          'Can reach',
          `<div>${K.link('4 web addresses')} <span class="faint">adds api.woolworthsrewards.com.au</span> ${K.badge('New', 'warn')}</div>
           <div>${K.link('7 tools')} <span class="faint">adds Everyday Rewards balance (reads)</span> ${K.badge('New', 'info')}</div>
           <div>${K.link('1 login')} · ${K.link('2 apps')}</div>
           <div class="faint">Worked out from 0.4.0 · checked 9:50 pm</div>`,
          K.ghost('Open'),
        )}</div>
      </div>
    </div>
    ${K.toast('Woolworths 0.4.0 approved; the next call uses it.', K.btn('Show in Versions'))}`
  FRAMES.push({
    id: 'site-approved',
    group: 'Sites',
    title: 'After approving 0.4.0',
    personas: ['P4', 'P5', 'P1'],
    desc: 'Sat 7 Nov, 9:50 pm, just after Approve on the review (the login was kept). The review page closes back to Overview, which now shows 0.4.0.',
    html: shell('sites', approvedPage, { site: 0, sites: sites(), badges: { needs: 3 } }),
    notes: [
      [
        246,
        84,
        'Focus moves to the page heading "Woolworths" and the window title updates; the result is announced from the toast\'s live region (P5).',
      ],
      [
        246,
        130,
        'The version line now reads woolworths 0.4.0 with its hash and approval time, so P4 knows which hash the next call runs (P4 A4).',
      ],
      [
        475,
        717,
        'Toast: "Woolworths 0.4.0 approved; the next call uses it." No Undo: going back is a Restore, which is a review (decision). It stays until focus leaves it.',
      ],
      [
        813,
        511,
        'Can reach marks what grew, so the change is visible after the fact too (P3). The login was kept on the review, so the health line is still the 9A71 login check, unchanged by the update.',
      ],
      [
        176,
        58,
        'Needs you drops to 3: the review item is gone from the window, the menu bar and the sidebar together (principle 1).',
      ],
    ],
  })

  // ---------- Tools tab ----------
  const toolRow = (title, name, does, effect, calls, remote) => [
    `<span class="col" style="gap:0"><b>${K.link(title)}</b>${mono(name)}</span>`,
    `<span class="muted">${does}</span>`,
    effect,
    calls ? K.link(calls) : '<span class="faint">none</span>',
    remote,
  ]
  const tools = `
    ${siteHead({ tab: 1 })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="row"><span class="muted">6 tools. Apps on this Mac can call all of them. Cloud agents can call none until you switch one on.</span></div>
      ${K.table(
        ['Tool', 'What it does', 'Effect', 'Calls · 7 days', 'Cloud agents'],
        [
          toolRow(
            'Search products',
            'search_products',
            'Prices, cup prices, specials and stock at your store.',
            K.badge('Reads', 'read'),
            '54',
            K.toggle(false),
          ),
          toolRow(
            'Product details',
            'product_details',
            'Ingredients, allergens and nutrition for one product.',
            K.badge('Reads', 'read'),
            '19',
            K.toggle(false),
          ),
          toolRow(
            'Get cart',
            'get_cart',
            "What's in your cart, with totals and savings.",
            K.badge('Reads', 'read'),
            '27',
            K.toggle(false),
          ),
          toolRow(
            'Add to cart',
            'add_to_cart',
            'Adds a product to your cart.',
            K.badge('Changes your cart', 'write'),
            '14',
            K.toggle(false),
          ),
          toolRow(
            'Update cart line',
            'update_cart_line',
            'Sets how many of a product are in your cart.',
            K.badge('Changes your cart', 'write'),
            '11',
            K.toggle(false),
          ),
          toolRow(
            'Remove from cart',
            'remove_from_cart',
            'Removes a product from your cart.',
            K.badge('Changes your cart', 'write') + K.badge('Asks you first', 'info'),
            '3',
            K.toggle(false),
          ),
        ],
        { cols: '200px 1fr 210px 100px 100px' },
      )}
      <div class="row faint" style="padding:6px 10px;border:1px dashed var(--wf-line-2);border-radius:8px"><b class="muted">Everyday Rewards balance</b> ${mono('get_rewards_balance')} ${K.badge('Reads', 'read')} <span>arrives with 0.4.0, waiting for your review</span><span class="grow"></span>${K.btn('Review update')}</div>
    </div>`
  FRAMES.push({
    id: 'site-tools',
    group: 'Sites',
    title: 'Tools tab',
    personas: ['P4', 'P3', 'P2'],
    desc: 'Each tool: the plain sentence, its tool name, what it can change, how often it ran, and whether cloud agents may call it.',
    html: shell('sites', tools, { site: 0, sites: sites(), badges: NEEDS }),
    notes: [
      [
        256,
        302,
        "Plain title first (the link to the tool's calls), tool name in mono underneath: Sam reads the first, Alex greps the second (P4, E8). The row itself is not a target.",
      ],
      [
        737,
        456,
        'Effect badges in words: Reads, Changes your cart, Asks you first. Badges are never buttons (E1).',
      ],
      [947, 310, 'The count is a door: Calls filtered to this site and tool for 7 days (E7).'],
      [
        246,
        225,
        "Remote tools are off by default, per tool (security model). A switch acts at once with an Undo toast; per-agent choices are on each cloud agent's Connections page.",
      ],
      [616, 614, 'A pending tool shows where it will appear, with the same Review update button (P4).'],
    ],
  })

  // ---------- Permissions tab ----------
  const perms = `
    ${siteHead({ tab: 2 })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="grid2" style="gap:12px">
        ${K.card(
          'What Woolworths can do',
          `<div class="col" style="gap:6px">
            <div class="row">${K.dot('ok')}<span>Contact 3 web addresses: www.woolworths.com.au, cdn0.woolworths.media, acs.woolworths.com.au</span></div>
            <div class="row">${K.dot('ok')}<span>Open its login page and fill your Woolworths login there only (auth.woolworths.com.au)</span></div>
            <div class="row">${K.dot('ok')}<span>Read and change your cart, through 4 kinds of request</span></div>
            <div class="row">${K.dot('ok')}<span>At most 6 requests a call, 10 s apart; waits 30 min if limited</span></div>
          </div>`,
        )}
        ${K.card(
          "What it can't do",
          `<div class="col" style="gap:6px">
            <div class="row">${K.dot('bad')}<span>Pay or check out: no tool or request for it is declared</span></div>
            <div class="row">${K.dot('bad')}<span>Contact any other web address. Valet blocks it and shows it in Calls (${K.link('2 blocked today')})</span></div>
            <div class="row">${K.dot('bad')}<span>Use any login but the one you gave it</span></div>
            <div class="row">${K.dot('bad')}<span>See other sites' sessions or cookies</span></div>
          </div>`,
          '<span class="faint">worked out by Valet from the declaration</span>',
        )}
      </div>
      ${K.card(
        'Details',
        K.kv([
          [
            'Hosts (egress)',
            `${K.value('www.woolworths.com.au')} ${K.value('cdn0.woolworths.media')} ${K.value('acs.woolworths.com.au')}`,
          ],
          [
            'Navigation',
            `${K.value('https://www.woolworths.com.au')} ${K.value('https://auth.woolworths.com.au')}`,
          ],
          [
            'Login fills',
            `${K.value('input[name=username]')} ← login.username · ${K.value('input#password')} ← login.password`,
          ],
          [
            'Requests',
            `${mono('POST /apis/ui/Search/products')} · ${mono('GET /apis/ui/product/detail/:stockcode')} · ${mono('GET /apis/ui/Trolley')} · ${mono('POST /api/v3/ui/trolley/update')} ${K.badge('write', 'write')}`,
          ],
          ['Cookies', `${K.value('woolworths.com.au')} ${K.value('www.woolworths.com.au')}`],
          ['Partitions', `${K.value('persist:auth:woolworths')} ${K.value('persist:tool:woolworths')}`],
          ['Limits', mono('requestsPerRun 6 · minGap 10 s · cooldown 1800 s · max 21600 s')],
        ]),
        `<span class="faint">from 0.3.0 · ${WOW_HASH}</span> ${K.ghost('Hide')}`,
      )}
    </div>`
  FRAMES.push({
    id: 'site-permissions',
    group: 'Sites',
    title: 'Permissions tab',
    personas: ['P2', 'P3', 'P1'],
    desc: 'Plain sentences first: what it can and can\'t do. The technical declaration is under Details, open here as it is for anyone with "Show technical details" on.',
    html: shell('sites', perms, { site: 0, sites: sites(), badges: NEEDS }),
    notes: [
      [
        277,
        274,
        'The plain summary is never narrower than the truth: it names all three web addresses, including cdn0.woolworths.media (P3 m10).',
      ],
      [
        892,
        236,
        '"Can\'t" is labelled as worked out by Valet from the declaration, not a claim by the site (P3). The blocked count is a door to Calls filtered to blocked requests (E7).',
      ],
      [
        261,
        432,
        'Details holds the words we keep out of the main UI (egress, partitions, selectors). Open by default with Settings › General › "Show technical details" (P1).',
      ],
      [261, 478, 'Every host, origin and selector is a value: selectable, copyable (E3).'],
      [937, 432, 'Says which version it describes; Versions › Compare shows how it changes.'],
    ],
  })

  // ---------- Versions tab ----------
  const versions = `
    ${siteHead({ tab: 3, actions: K.btn('Review Woolworths update'), extra: ` <span class="faint">· 0.4.0 waiting</span>` })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="row"><span class="h3">Adapter versions</span><span class="grow"></span>Compare ${K.input('0.3.0 (live) ▾', '130px')} with ${K.input('0.4.0 (waiting) ▾', '140px')} ${K.btn('Compare')}</div>
      ${K.table(
        ['Version', 'Content hash', 'From', 'Approved', 'Login', 'Calls', ''],
        [
          [
            `<b>0.4.0</b> ${K.badge('Waiting', 'warn')}`,
            K.value(NEXT_HASH),
            'Authoring agent (IDE), 9:20 pm',
            '<span class="faint">not yet</span>',
            '<span class="faint">asks on approve</span>',
            '<span class="faint">none</span>',
            K.btn('Review update'),
          ],
          [
            `<b>0.3.0</b> ${K.badge('Live', 'ok')}`,
            K.value(WOW_HASH),
            'Comes with Valet',
            'Fri 6 Nov, 8:12 pm',
            `${K.badge('login', 'secret')} ${K.link('Woolworths')}`,
            `${K.link('128')} <span class="faint">1 failed</span>`,
            '',
          ],
          [
            `<b>0.3.1-dev</b> ${K.badge('Rejected', 'idle')}`,
            K.value('7a20…c3e9'),
            'Authoring agent (IDE), 4:02 pm',
            '<span class="faint">rejected 4:10 pm</span>',
            '<span class="faint">none</span>',
            '<span class="faint">none</span>',
            K.ghost('Compare with 0.3.0'),
          ],
        ],
        { cols: '170px 120px 1fr 120px 140px 100px 150px', cls: 'compact' },
      )}
      <p class="faint" style="margin:0">Restore… appears on any approved version that isn't live; drawn in "Restore a version". A login given to one version is offered to another only if its login part is identical and nothing widens.</p>
    </div>`
  FRAMES.push({
    id: 'site-versions',
    group: 'Sites',
    title: 'Versions tab',
    personas: ['P4', 'P1', 'P3'],
    desc: 'The only tab that says "adapter". The waiting update is the top row, so the table and the Compare pickers agree; then every version with where it came from, its login and its calls.',
    html: shell('sites', versions, { site: 0, sites: sites(), badges: NEEDS }),
    notes: [
      [
        1062,
        225,
        'Compare any two versions (P4), not only waiting vs live; it opens "Compare 0.3.0 and 0.4.0", the same permission-first diff as the review, read-only.',
      ],
      [
        313,
        297,
        '0.4.0 is a row marked Waiting, with its Review update button (P4). Several dev builds of one adapter collapse into the newest, so P4 never approves a stale hash.',
      ],
      [
        536,
        353,
        'Where each version came from, in one model: "Comes with Valet" or "Authoring agent (IDE)", never an app from Connections (P4, story).',
      ],
      [
        777,
        299,
        'Login per version (P4): grants are tied to a content hash. 0.4.0 widens reach, so it asks again on approve.',
      ],
      [
        897,
        366,
        "Calls per version link to Calls filtered by version, so P4 can see whether 0.4.0 fails where 0.3.0 didn't (E7).",
      ],
      [997, 411, 'A row\'s Compare says what with: "Compare with 0.3.0", the live version (P4 minor).'],
    ],
  })

  // ---------- Compare result ----------
  const compare = `
    ${K.header({
      crumbs: ['Sites', 'Woolworths', 'Versions', 'Compare'],
      title: 'Compare Woolworths 0.3.0 and 0.4.0',
      actions: K.ghost('Swap') + K.primary('Review update') + K.ghost('Close  Esc'),
      sub: `<span class="row" style="gap:6px">${K.input('0.3.0 (live) ▾', '130px')} ${mono(WOW_HASH)} → ${K.input('0.4.0 (waiting) ▾', '140px')} ${mono(NEXT_HASH)} <span class="faint">· read-only</span></span>`,
    })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.card(
        'Reach',
        `${added('warn', `<div class="row">${K.badge('Added', 'warn')} web address ${K.value('api.woolworthsrewards.com.au')}</div>`)}
         ${added('info', `<div class="row">${K.badge('Added', 'info')} tool <b>Everyday Rewards balance</b> ${mono('get_rewards_balance')} ${K.badge('Reads', 'read')}</div>`)}
         ${added('info', `<div class="row">${K.badge('Added', 'info')} request ${mono('GET /api/v1/rewards/balance')} ${K.badge('Reads', 'read')}</div>`)}
         <div class="faint">Removed: nothing.</div>`,
        '<span class="faint">3 added · 0 removed</span>',
      )}
      ${K.card(
        'The same in both',
        K.table(
          [],
          [
            [
              '<b>Login</b>',
              '<span class="muted">username and password, filled only on auth.woolworths.com.au</span>',
              K.badge('Same', 'idle'),
            ],
            [
              '<b>6 tools</b>',
              '<span class="muted">3 read, 3 change your cart</span>',
              K.badge('Same', 'idle'),
            ],
            [
              '<b>Limits</b>',
              '<span class="muted">6 requests a call, 10 s apart</span>',
              K.badge('Same', 'idle'),
            ],
            [
              '<b>Cookies</b>',
              '<span class="muted">woolworths.com.au, www.woolworths.com.au</span>',
              K.badge('Same', 'idle'),
            ],
          ],
          { cls: 'compact', cols: '140px 1fr 80px' },
        ),
        '',
        'flush',
      )}
      ${K.card(
        'Code',
        K.table(
          [],
          [
            [
              mono('src/tools/rewards.ts'),
              K.badge('added', 'ok'),
              '<span class="faint">+64</span>',
              K.ghost('Open diff'),
            ],
            [
              mono('src/manifest.ts'),
              K.badge('changed', 'warn'),
              '<span class="faint">+12 −1</span>',
              K.ghost('Open diff'),
            ],
            [
              mono('test/rewards.test.ts'),
              K.badge('added', 'ok'),
              '<span class="faint">+88</span>',
              K.ghost('Open diff'),
            ],
          ],
          { cls: 'compact', cols: '1fr 84px 64px 90px' },
        ),
        `<span class="faint">3 files · ${K.link('Calls on 0.3.0')} · calls on 0.4.0: none</span>`,
        'flush',
      )}
    </div>`
  FRAMES.push({
    id: 'site-compare',
    group: 'Sites',
    title: 'Compare two versions (result)',
    personas: ['P4', 'P3'],
    desc: 'From Versions › Compare. A full page in the site, read-only: the same permission-first diff as the review, for any two versions, with no decision footer.',
    html: shell('sites', compare, { site: 0, sites: sites(), badges: NEEDS }),
    notes: [
      [
        246,
        124,
        'The pickers stay in the header, so changing either side re-draws in place; the route is #/sites/woolworths/versions/compare?a=9f3c…&b=4b7e… (principle 7).',
      ],
      [
        261,
        202,
        'Reach first, as in the review: additions tinted by how far they widen, removals listed even when there are none (P3).',
      ],
      [261, 422, 'What is identical is said, not hidden, so P4 can trust a short diff.'],
      [
        1056,
        624,
        'Code files open the same diff viewer as the review (P4). Calls per side link to Calls filtered by version.',
      ],
      [
        942,
        84,
        'Read-only: no Approve here. Because one side is waiting, "Review update" is offered as the way to decide.',
      ],
    ],
  })

  // ---------- Review update (full page) ----------
  const reviewHead = (crumb, title, status, sub) =>
    K.header({
      crumbs: ['Sites', 'Woolworths', 'Versions', crumb],
      title,
      status,
      sub,
      actions: K.ghost('Close  Esc'),
    })
  const review = `
    ${reviewHead(
      'Review 0.4.0',
      'Review the Woolworths update (0.4.0)',
      K.badge('Calls use 0.3.0 until you decide', 'info'),
      `Made by the authoring agent (IDE) at 9:20 pm · adapter ${mono('woolworths')} ${mono('0.3.0')} ${K.value(WOW_HASH)} → ${mono('0.4.0')} ${K.value(NEXT_HASH)}`,
    )}
    <div class="wf-scroll" style="gap:10px;padding-top:12px">
      <div class="row muted" style="gap:14px">${K.badge('Repro check passed', 'ok')}<span>on the 0.3.0 and 0.4.0 bundles in the IDE, 9:19 pm</span><span class="faint">· 2 recordings · lint: no findings</span><span class="grow"></span>${K.ghost('How it was made ▸')}</div>
      ${K.card(
        "What's new",
        `${added('warn', `<div class="row">${K.badge('New web address', 'warn')} Woolworths may contact ${K.value('api.woolworthsrewards.com.au')} <span class="faint">a different site from woolworths.com.au</span></div><div class="muted">Tool pages may send requests here, including your Woolworths session cookies.</div>`)}
         ${added('info', `<div class="row">${K.badge('New tool', 'info')} <b>Everyday Rewards balance</b> ${mono('get_rewards_balance')} ${K.badge('Reads', 'read')}<span class="grow"></span><span class="faint">callable by ${K.link('Claude Code')}, ${K.link('Claude Desktop')}; cloud agents off</span></div>`)}
         ${added('info', `<div class="row">${K.badge('New request', 'info')} ${mono('GET /api/v1/rewards/balance')} ${K.badge('Reads', 'read')}</div>`)}
         <div class="row faint">Unchanged: login pages, the login and where it's filled, the 6 tools, limits, cookies. ${K.ghost('Show everything ▸')}</div>`,
        '<span class="faint">3 additions · nothing removed</span>',
      )}
      <div class="grid2" style="gap:12px">
        ${K.card('Login', `${K.check('Keep using your Woolworths login for 0.4.0', false)}<span class="faint">Not ticked: 0.4.0 can send your session to a new web address. Tick it only if you trust that address; otherwise cart tools ask for your login again.</span>`)}
        ${K.card(
          'Code',
          K.table(
            [],
            [
              [
                mono('src/tools/rewards.ts'),
                K.badge('added', 'ok'),
                '<span class="faint">+64</span>',
                K.ghost('Open diff'),
              ],
              [
                mono('src/manifest.ts'),
                K.badge('changed', 'warn'),
                '<span class="faint">+12 −1</span>',
                K.ghost('Open diff'),
              ],
              [
                mono('test/rewards.test.ts'),
                K.badge('added', 'ok'),
                '<span class="faint">+88</span>',
                K.ghost('Open diff'),
              ],
            ],
            { cls: 'compact', cols: '1fr 84px 64px 90px' },
          ),
          '<span class="faint">3 files</span>',
          'flush',
        )}
      </div>
    </div>
    <div class="sticky-foot">${K.btn('Reject update…')}${K.ghost('Decide later')}<span class="grow"></span>${K.check("I've read the 3 additions", true)}${K.primary('Approve 0.4.0  ⏎')}</div>`
  FRAMES.push({
    id: 'site-review-update',
    group: 'Sites',
    title: 'Review update, 0.3.0 → 0.4.0',
    personas: ['P4', 'P1', 'P3', 'P5'],
    desc: 'A full page inside the site (P3): sidebar kept, breadcrumb back to Versions, Escape returns to wherever you came from. Additions lead, highlighted by how much they widen access.',
    html: shell('sites', review, { site: 0, sites: sites(), badges: NEEDS }),
    notes: [
      [
        370,
        62,
        'Breadcrumb Sites › Woolworths › Versions › Review 0.4.0; the route is #/sites/woolworths/versions/4b7e…/review. Focus lands on the h1 (P5).',
      ],
      [
        246,
        124,
        'The author is "the authoring agent (IDE)", plain text, never a link to an app in Connections: the caller and the author are different things (P4).',
      ],
      [
        246,
        173,
        'Provenance first: the IDE\'s repro check on both bundles, recordings and lint, with the full record under "How it was made" (P4).',
      ],
      [
        271,
        266,
        'The new web address says the consequence: your session cookies may go there (P3 blocker). Amber for anything that reaches somewhere new, blue for the rest.',
      ],
      [778, 330, 'Callers listed are connected apps only; revoked Cursor never appears (story).'],
      [
        261,
        509,
        'Keep login is unticked because reach widens (decision); the reason is right under it. Ticked by default only when nothing widens.',
      ],
      [
        851,
        744,
        'The acknowledgement covers all additions and sits next to Approve (P1, P3). Return approves only when focus is in this footer, never from "Open diff" or a link (P5 M8). Reject is not red and asks for a reason.',
      ],
    ],
  })

  // ---------- Code diff viewer (over the review page) ----------
  const fileRow = (path, badge, counts, on) =>
    `<div class="row" style="padding:7px 10px;border-radius:6px;${on ? 'background:var(--wf-sel);font-weight:600' : ''}">${mono(path)}<span class="grow"></span><span class="faint">${counts}</span></div><div style="padding:0 10px 4px">${badge}</div>`
  const diffSheet = sheet(
    `Code changes · Woolworths 0.3.0 → 0.4.0`,
    `<div style="display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;min-height:0">
       <div class="col" style="gap:2px;border-right:1px solid var(--wf-line);padding-right:10px">
         <span class="faint" style="padding:0 10px 4px">3 files · +164 −1</span>
         ${fileRow('src/tools/rewards.ts', K.badge('added', 'ok'), '+64', true)}
         ${fileRow('src/manifest.ts', K.badge('changed', 'warn'), '+12 −1', false)}
         ${fileRow('test/rewards.test.ts', K.badge('added', 'ok'), '+88', false)}
       </div>
       <div class="col" style="gap:6px;min-width:0">
         <div class="row">${mono('src/tools/rewards.ts')} ${K.badge('added', 'ok')}<span class="grow"></span>${K.seg(['Unified', 'Split'], 0)}${K.icon('⧉')}</div>
         <div style="border:1px solid var(--wf-line);border-radius:6px;padding:4px 0;overflow:hidden;user-select:text">
           ${diffLine('', '@@', '@@ -0,0 +1,64 @@')}
           ${diffLine('+', 1, "import { defineTool, SiteChanged } from '@valet/adapter-kit'")}
           ${diffLine('+', 2, "import { REWARDS_API, BALANCE_PATH } from '../hosts'")}
           ${diffLine('+', 3, '')}
           ${diffLine('+', 4, '/** Everyday Rewards points and what they are worth, read-only. */')}
           ${diffLine('+', 5, 'export const getRewardsBalance = defineTool({')}
           ${diffLine('+', 6, "  name: 'get_rewards_balance',")}
           ${diffLine('+', 7, "  title: 'Everyday Rewards balance',")}
           ${diffLine('+', 8, "  sideEffect: 'read',")}
           ${diffLine('+', 9, '  input: {},')}
           ${diffLine('+', 10, '  async run({ page }) {')}
           ${diffLine('+', 11, '    const res = await page.request.get(REWARDS_API + BALANCE_PATH)')}
           ${diffLine('+', 12, '    if (res.status() === 401) return { needsLogin: true }')}
           ${diffLine('+', 13, "    if (!res.ok()) throw new SiteChanged('rewards balance')")}
           ${diffLine('+', 14, '    const body = await res.json()')}
           ${diffLine('+', 15, '    const points = Number(body.pointsBalance)')}
           ${diffLine('+', 16, '    const worth = Number(body.dollarValue)')}
           ${diffLine('+', 17, "    if (!Number.isFinite(points)) throw new SiteChanged('points')")}
           ${diffLine('+', 18, '    return { points, worth, asOf: body.asAtDate }')}
           ${diffLine('+', 19, '  },')}
           ${diffLine('+', 20, '})')}
           <div class="faint" style="padding:4px 44px">44 more lines · scrolls</div>
         </div>
       </div>
     </div>`,
    `<span class="faint">${K.kbd('↑')} ${K.kbd('↓')} files · ${K.kbd('Esc')} back to the review</span><span class="grow"></span>${K.btn('Previous file')}${K.btn('Next file')}${K.primary('Back to review')}`,
    'wide',
  ).replace('class="wf-sheet wide"', 'class="wf-sheet wide" style="width:1120px"')
  FRAMES.push({
    id: 'site-review-diff',
    group: 'Sites',
    title: 'Code diff viewer, over the review',
    personas: ['P4', 'P3', 'P5'],
    desc: 'Opened by "Open diff" on a code file row of the review. A sheet as wide as the window over the review page: files on the left, the unified diff on the right. Esc returns to the review with focus on the row that opened it.',
    html: shell('sites', review, { site: 0, sites: sites(), badges: NEEDS, over: diffSheet }),
    notes: [
      [
        29,
        63,
        'Sheet, not a new window: it opens over the review page (principle 5), so the decision footer is one Esc away. Nearly window-wide so code is not cramped (P4).',
      ],
      [
        39,
        148,
        'Every changed file, with its counts; ↑ ↓ move between files without leaving the keyboard (P4). The file the person clicked opens first.',
      ],
      [
        969,
        121,
        'Unified by default; Split is remembered per viewer. Copy takes the whole file at this version.',
      ],
      [
        328,
        160,
        'The diff is a value: selectable and copyable (E3). Line numbers and +/− are in text too, not only colour (P5).',
      ],
      [
        1007,
        585,
        'Esc or "Back to review" returns to the review with focus on the "Open diff" row that opened it (P5).',
      ],
    ],
  })

  // ---------- Restore a version ----------
  const restore = `
    ${reviewHead(
      'Restore 0.3.0',
      'Restore Woolworths 0.3.0',
      K.badge('Calls use 0.4.0 until you decide', 'info'),
      `0.4.0 ${K.value(NEXT_HASH)} live since Sat 7 Nov, 9:50 pm → 0.3.0 ${K.value(WOW_HASH)} comes with Valet, approved Fri 6 Nov`,
    )}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.banner('idle', 'Restoring narrows what Woolworths can reach.', 'Nothing is added, so there is nothing new to read. It takes effect on the next call.', '')}
      ${K.card(
        'What goes away',
        `${added('idle', `<div class="row">${K.badge('Removed', 'idle')} web address ${K.value('api.woolworthsrewards.com.au')}</div>`)}
         ${added('idle', `<div class="row">${K.badge('Removed', 'idle')} tool <b>Everyday Rewards balance</b> ${mono('get_rewards_balance')}</div><div class="muted">Claude Code and Claude Desktop lose it; a call to it is told "Woolworths has no tool called get_rewards_balance".</div>`)}
         <div class="faint">The same: login and where it's filled, the 6 other tools, limits, store.</div>`,
        `<span class="faint">2 removed · ${K.link('Compare 0.4.0 and 0.3.0')}</span>`,
      )}
      <div class="grid2" style="gap:12px">
        ${K.card('Login', `${K.check('Use your Woolworths login for 0.3.0', true)}<span class="faint">Ticked: 0.3.0 used this login before and reaches less than 0.4.0.</span>`)}
        ${K.card('Why (optional)', `${K.input('e.g. rewards balance shows the wrong points', '100%')}<span class="faint">Saved in the audit log with the restore.</span>`)}
      </div>
    </div>
    <div class="sticky-foot">${K.btn('Cancel')}<span class="grow"></span>${K.primary('Restore 0.3.0  ⏎')}</div>`
  FRAMES.push({
    id: 'site-review-restore',
    group: 'Sites',
    title: 'Restore a version (review in restore mode)',
    personas: ['P4', 'P3', 'P5'],
    desc: 'A different moment: Wed 11 Nov, 9:30 pm, 0.4.0 has been live since Saturday. "Restore…" on the 0.3.0 row opens the review page in restore mode.',
    html: shell('sites', restore, { site: 0, sites: sites('ok', 'ok'), badges: { needs: 0 } }),
    notes: [
      [
        370,
        62,
        'The same page and gesture as a review (decision): breadcrumb, h1 focus, decision footer. Its title says Restore, so it is never mistaken for an update.',
      ],
      [
        259,
        181,
        'States the direction first: restoring narrows reach. If a restore would widen reach compared with the live version, it gets the full review and the acknowledgement instead.',
      ],
      [261, 231, 'What goes away is listed with its effect on callers, in the words a tool result will use.'],
      [
        261,
        466,
        'The login is ticked because 0.3.0 had it and reaches less; the rule is the same one the review uses.',
      ],
      [
        712,
        428,
        'A reason is optional and goes to the audit log, so P3 can read later why the version changed.',
      ],
      [
        246,
        737,
        "Return restores only from this footer; Cancel returns to Versions with focus on the row's Restore… button (P5).",
      ],
    ],
  })

  // ---------- First-install review ----------
  const fact = (dot, text) =>
    `<div class="row" style="align-items:flex-start">${K.dot(dot)}<span>${text}</span></div>`
  const firstReview = `
    ${K.header({
      crumbs: ['Sites', 'Woolworths', 'Review'],
      title: 'Review Woolworths before first use',
      status: K.badge('Not approved yet', 'info'),
      actions: K.ghost('Close  Esc'),
      sub: `Comes with Valet · adapter ${mono('woolworths 0.3.0')} ${K.value(WOW_HASH)}`,
    })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="wf-card"><div class="body" style="gap:10px">
        <div class="big" style="font-size:17px">Woolworths lets Claude search products and read and change your Woolworths cart. It can't pay or check out.</div>
        <div class="grid3" style="gap:12px">
          <div class="col" style="gap:6px"><span class="h3">It can</span>${fact('ok', 'Search products and read product details')}${fact('ok', 'Read your cart')}${fact('ok', 'Add, change and remove cart items (asks you before removing)')}</div>
          <div class="col" style="gap:6px"><span class="h3">It can't</span>${fact('bad', 'Pay or check out')}${fact('bad', 'Contact anything but 3 Woolworths web addresses')}${fact('bad', 'Use any login but the one you choose')}</div>
          <div class="col" style="gap:6px"><span class="h3">It will need</span>${fact('info', 'Your Woolworths login, filled only on auth.woolworths.com.au')}${fact('info', 'A store, for prices and stock')}</div>
        </div>
      </div></div>
      ${K.card(
        'The details',
        K.table(
          [],
          [
            [
              '<b>6 tools</b>',
              '<span class="muted">3 read, 3 change your cart, none that can\'t be undone</span>',
              K.ghost('Show ▸'),
            ],
            [
              '<b>Web addresses</b>',
              '<span class="muted">www.woolworths.com.au, cdn0.woolworths.media, acs.woolworths.com.au</span>',
              K.ghost('Show ▸'),
            ],
            [
              '<b>Login</b>',
              '<span class="muted">username and password, on auth.woolworths.com.au only</span>',
              K.ghost('Show ▸'),
            ],
            ['<b>Limits</b>', '<span class="muted">6 requests a call, 10 s apart</span>', K.ghost('Show ▸')],
            ['<b>Code</b>', '<span class="muted">14 files</span>', K.ghost('Show ▸')],
          ],
          { cls: 'compact', cols: '140px 1fr 90px' },
        ),
        '',
        'flush',
      )}
    </div>
    <div class="sticky-foot">${K.btn("Don't install…")}<span class="grow"></span><span class="faint">Next: choose a login and a store</span>${K.primary('Approve Woolworths  ⏎')}</div>`
  FRAMES.push({
    id: 'site-review-first-install',
    group: 'Sites',
    title: 'Review, first install (summary first)',
    personas: ['P2', 'P3', 'P5'],
    desc: 'A different moment: Fri 6 Nov, 8:11 pm, during setup. The same page as an update review, with the summary first and every section folded (P3, P2).',
    html: shell('sites', firstReview, { site: 0, sites: sites('info', 'ok'), badges: { needs: 1 } }),
    notes: [
      [
        261,
        183,
        'One sentence Sam can say yes to (P2). The header says it comes with Valet, as setup does (P2 M5).',
      ],
      [261, 183, "Can, can't, will need, in the same plain words as Overview and Permissions (E8)."],
      [
        1056,
        398,
        'Each section folds open to the technical list; with "Show technical details" on, they start open (P1). Folds are buttons with aria-expanded (P5).',
      ],
      [
        980,
        737,
        'After Approve, the page goes to Overview and opens the grant sheet; skipping it leaves "Give Valet your Woolworths login" in Needs you (P9).',
      ],
      [
        246,
        737,
        '"Don\'t install…" is not red and not as strong as Approve (P2); it asks whether to remove the files too.',
      ],
    ],
  })

  // ---------- Quick review for a code-only dev build ----------
  const quick = `
    ${reviewHead(
      'Review 0.3.1-dev',
      'Quick review: Woolworths 0.3.1-dev',
      K.badge('Code only', 'ok'),
      `Made by the authoring agent (IDE) at 9:12 pm for repair ticket ${K.link('#12')} (call ${K.link('6B3E')}, site changed) · ${mono('0.3.0')} ${K.value(WOW_HASH)} → ${mono('0.3.1-dev')} ${K.value(DEV_HASH)} · replaces 2 older dev builds`,
    )}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.banner('ok', 'Nothing it can reach changes.', "Compared with 0.3.0, the live approved version: same web addresses, same login and where it's filled, same tools, nothing new that can't be undone. Repro check passed in the IDE, 9:11 pm.", K.ghost('Show full review'))}
      <div class="wf-card flush"><header><h4>Code</h4><span class="faint">2 files · +9 −3</span><span class="grow"></span>${K.ghost('Previous file  ↑')}${K.ghost('Next file  ↓')}</header><div class="body">
        <div class="row" style="padding:6px 12px;border-bottom:1px solid var(--wf-line)">${mono('src/tools/search.ts')} ${K.badge('changed', 'warn')} <span class="faint">+7 −3</span></div>
        <div style="padding:6px 0">
          ${diffLine(' ', 41, '  const tiles = await page.locator(SEL.productTile).all()')}
          ${diffLine('-', 42, '  const price = await tile.locator(".price-dollars").innerText()')}
          ${diffLine('+', 42, '  const priceText = await tile.locator("[data-testid=product-price]").innerText()')}
          ${diffLine('+', 43, '  const price = Number.parseFloat(priceText.replace("$", ""))')}
          ${diffLine('+', 44, '  if (Number.isNaN(price)) throw new SiteChanged("product price")')}
          ${diffLine(' ', 45, '  results.push({ stockcode, name, price, cupPrice })')}
        </div>
        <div class="row" style="padding:6px 12px;border-top:1px solid var(--wf-line)">${mono('test/search.test.ts')} ${K.badge('changed', 'warn')} <span class="faint">+2 −0</span><span class="grow"></span>${K.ghost('Open ▸')}</div>
      </div></div>
      ${K.check('Keep using your Woolworths login for 0.3.1-dev (identical login part, nothing widens)', true)}
    </div>
    <div class="sticky-foot">${K.btn('Reject')}<span class="grow"></span><span class="faint">${K.kbd('⌘')} ${K.kbd('Return')} approves</span>${K.primary('Approve 0.3.1-dev')}</div>`
  FRAMES.push({
    id: 'site-review-quick',
    group: 'Sites',
    title: 'Quick review, code-only dev build',
    personas: ['P4', 'P1', 'P5'],
    desc: 'A different moment: Sat 7 Nov, 9:13 pm, before 0.4.0 arrived. A repair for call 6B3E that widens nothing gets one screen; anything that widens access gets the full review (IA open question 4).',
    html: shell('sites', quick, { site: 0, sites: sites('warn', 'ok'), badges: { needs: 1 } }),
    notes: [
      [
        246,
        87,
        '"Quick review" is in the title so it is never mistaken for the full one. Dev builds carry "-dev" and their repair ticket; older waiting dev builds collapse into this one.',
      ],
      [
        259,
        197,
        'Compared with the live approved version (0.3.0), never a waiting one (P1 B1, P4). While another update waits (0.4.0 from 9:20 pm), quick review is off and this build gets the full review, which says why.',
      ],
      [
        1008,
        198,
        "Valet works this out from the declarations, not the agent's claim; the repro check is shown beside it (P4).",
      ],
      [1039, 263, 'The real diff, inline, with ↑ ↓ between files (P4).'],
      [246, 525, 'Keep login is ticked because the login part is identical and nothing widens (decision).'],
      [
        1011,
        737,
        'Focus lands on the h1 like every page; ⌘Return approves, so a screen-reader user pressing Return to read never approves (P5 M7). Reject needs no confirm (P4).',
      ],
    ],
  })

  // ---------- Grant sheet ----------
  const grant = sheet(
    'Give Valet your Woolworths login',
    `<p class="muted" style="margin:0">Woolworths asks for a username and password. Valet keeps a Keychain copy of the 1Password item you choose, fills it only on ${K.value('auth.woolworths.com.au')}, and never shows it to Claude.</p>
     <div class="row">${K.search('Search 1Password')}<span class="faint">Personal vault</span></div>
     <div class="wf-card flush"><div class="body">${K.table(
       [],
       [
         [
           K.radio('<b>Woolworths</b>', true),
           '<span class="faint">saved for auth.woolworths.com.au</span>',
           K.badge('Matches', 'ok'),
         ],
         [
           K.radio('Woolworths Rewards'),
           '<span class="faint">saved for woolworthsrewards.com.au</span>',
           K.badge('Another site', 'warn'),
         ],
         [
           K.radio('Woolworths (old)'),
           '<span class="faint">saved for www.woolworths.com.au · edited 2024</span>',
           '',
         ],
       ],
       { cols: '1fr 1.3fr 110px', selected: 0 },
     )}</div></div>
     <div class="grid2" style="gap:12px;padding:10px 12px;border:1px solid var(--wf-line);border-radius:8px">
       <div class="col" style="gap:4px"><span class="h3">With this login, it can</span><span class="muted">sign in on auth.woolworths.com.au, then read and change your cart.</span></div>
       <div class="col" style="gap:4px"><span class="h3">It can't</span><span class="muted">show the password to Claude, use it on any other site, pay or check out.</span></div>
     </div>
     <div class="col" style="gap:6px"><span class="h3">If Woolworths asks for a one-time code</span>
       <div class="row" style="gap:16px">${K.radio('Use the code in this 1Password item', true)}${K.radio('Read it from Messages')}${K.radio('Ask me')}</div></div>
     <p class="faint" style="margin:0">For Woolworths 0.3.0 (${WOW_HASH}). A new version asks again unless its login part is identical and nothing widens.</p>`,
    `<span class="grow"></span>${K.btn('Cancel')}${K.primary('Use this login')}`,
  )
  FRAMES.push({
    id: 'site-grant-sheet',
    group: 'Sites',
    title: 'Grant sheet: Give Valet your Woolworths login',
    personas: ['P2', 'P3', 'P4', 'P5'],
    desc: 'Same moment as "needs a login" (Fri 6 Nov, 8:20 pm). Opened by "Choose login…" on Overview, the Needs you item, or setup; Escape returns with focus on the button that opened it.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Needs a login', 'warn') }) +
        overview({ top: loginTop, login: false, today: true }),
      {
        site: 0,
        sites: sites('warn', 'ok'),
        badges: { needs: 1 },
        over: grant,
      },
    ),
    notes: [
      [
        289,
        63,
        'Title is the Needs you title word for word (principle 1). The ✕ is named "Close" for VoiceOver (P5 m4).',
      ],
      [
        575,
        171,
        'Same vault and words as setup: a Keychain copy of an item in the Personal vault (D6, P2 M3).',
      ],
      [752, 250, 'An item saved for another site is marked "Another site" before anyone picks it (P3).'],
      [
        302,
        352,
        'It can / It can\'t, for this login, before "Use this login": the consequence statement P3 asked to bring back.',
      ],
      [
        289,
        427,
        'One-time codes are part of the same choice, with the same three options as setup (P2 M4, P6).',
      ],
      [753, 539, '"Use this login" stays focusable while nothing is chosen and says why (P5).'],
    ],
  })

  // ---------- Store sheet ----------
  const store = sheet(
    'Choose your Woolworths store',
    `<p class="muted" style="margin:0">Prices, specials and what's in stock are the store's. Claude shops at the store you choose.</p>
     <div class="row">${K.input('2000', '160px')}${K.btn('Search')}<span class="faint">postcode or suburb</span></div>
     <div class="wf-card flush"><div class="body">${K.table(
       [],
       [
         [
           K.radio('<b>Woolworths Town Hall</b>', true),
           '<span class="muted">Cnr Park &amp; George Streets, Sydney, NSW, 2000</span>',
           K.badge('Current', 'idle'),
         ],
         [
           K.radio('Woolworths Metro Wynyard'),
           '<span class="muted">301 George Street, Sydney, NSW, 2000</span>',
           '',
         ],
       ],
       { cols: '220px 1fr 80px', selected: 0 },
     )}</div></div>
     <p class="faint" style="margin:0">2 stores for 2000 · the list comes from woolworths.com.au, so the names are the site's.</p>`,
    `<span class="grow"></span>${K.btn('Cancel')}${K.primary('Use Woolworths Town Hall')}`,
  )
  FRAMES.push({
    id: 'site-store-sheet',
    group: 'Sites',
    title: 'Store sheet',
    personas: ['P2', 'P1'],
    desc: 'From "Change store…" on Overview or the "Choose your Woolworths store" Needs you item, which has the same title.',
    html: shell('sites', siteHead() + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: NEEDS,
      over: store,
    }),
    notes: [
      [
        289,
        63,
        'The sheet and the Needs you item share one plain title, "Choose your Woolworths store" (principle 1, P2).',
      ],
      [
        545,
        153,
        "Search runs on the site in Valet's browser; results take a few seconds and say so in a live region (P5).",
      ],
      [782, 204, 'The current store is marked, so changing it is a deliberate choice.'],
      [678, 330, 'The button names the store it will use (principle 2).'],
    ],
  })

  // ---------- Remove site dialog ----------
  const remove = dialog(
    'Remove Woolworths?',
    `<div>Claude Code and Claude Desktop lose its 6 tools at once. The confirmation waiting for call 7F2A is declined.</div>
     <div>Valet forgets the login it may use (your 1Password item stays), the store, and signs this Mac out of Woolworths in Valet's browser.</div>
     <div>Its calls and audit records stay. Adding it back means a new review.</div>
     <div class="row faint">Want it back later? ${K.link('Pause site instead')}</div>`,
    `${K.btn('Cancel')}${K.danger('Remove Woolworths')}`,
  )
  FRAMES.push({
    id: 'site-remove-dialog',
    group: 'Sites',
    title: 'Remove site dialog',
    personas: ['P3', 'P1', 'P2'],
    desc: 'From the ⋯ menu on the site header. Destructive, so it confirms with the consequences named (E4).',
    html: shell('sites', siteHead() + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: NEEDS,
      over: remove,
    }),
    notes: [
      [379, 316, 'Names who loses what, by app name, and what happens to anything waiting (E4).'],
      [379, 357, 'Says what is forgotten and what is kept: the 1Password item is never deleted.'],
      [379, 397, 'Evidence stays: calls and audit records outlive the site (P3).'],
      [492, 421, 'Offers the reversible option, with the same label as everywhere: "Pause site" (P1).'],
      [623, 465, 'Focus starts on Cancel; the red button names the site. Return does not remove.'],
    ],
  })
})()
