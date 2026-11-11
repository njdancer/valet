// Sites: the list, one page per site with its tabs, the review page, and the sheets and dialog that
// open over a site (P2, P3, E1, E6, principles 2, 4 and 5).
;(() => {
  const { K, shell, sheet, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Sites =
    "One page per site (P2), reached from the sidebar's Sites place, the site rows under it, the menu bar and every link to the site. Overview is the page most people use (P2 Sam), so everything with a next step shows that step there as a named button beside its status (E1). Tools, Permissions and Versions hold the detail; Calls is a link to Activity filtered to this site, not a copy. Review update is a full page inside the site, with the sidebar kept and a breadcrumb back (P3)."

  // ---------- shared pieces ----------
  const WOW_HASH = '9f3c…e0f1'
  const NEXT_HASH = '4b7e…a83c'
  const TABS = ['Overview', 'Tools', 'Permissions', 'Versions', 'Calls ↗']
  const mono = (s) => `<span class="mono">${s}</span>`
  const sites = (wow = 'ok', yahoo = 'ok') => [
    ['W', 'Woolworths', wow],
    ['Y', 'Yahoo Finance', yahoo],
    ['W', 'Wikipedia', 'ok'],
  ]
  // A tinted row for something new or wider (review additions).
  const added = (tone, html) =>
    `<div class="row" style="padding:8px 10px;border-radius:6px;background:var(--wf-tint-${tone});box-shadow:inset 3px 0 0 var(--wf-${tone})">${html}</div>`
  const diffLine = (kind, no, text) => {
    const bg = kind === '+' ? 'var(--wf-tint-ok)' : kind === '-' ? 'var(--wf-tint-bad)' : 'transparent'
    return `<div class="mono" style="display:flex;gap:10px;padding:1px 8px;background:${bg};white-space:pre"><span class="faint" style="width:26px;text-align:right">${no}</span><span class="faint">${kind}</span><span>${text}</span></div>`
  }

  /** The one site header: breadcrumb, name, status + its button, adapter id/version, tabs. */
  const siteHead = ({
    status = '',
    actions = '',
    tab = 0,
    version = '0.3.0',
    hash = WOW_HASH,
    approved = 'approved Fri 6 Nov',
  } = {}) =>
    K.header({
      crumbs: ['Sites', 'Woolworths'],
      title: `<span class="row" style="gap:10px">${K.avatar('W')}Woolworths</span>`,
      status,
      actions: actions + K.btn('Open my trolley') + K.icon('⋯'),
      sub: `<span class="row" style="gap:6px">${mono(`woolworths ${version}`)} ${K.value(hash)} <span class="faint">· ${approved}</span></span>`,
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
      chosen ? K.btn('Change store…') : K.primary('Choose store…'),
    )
  const loginCard = (given = true) =>
    K.card(
      'Login',
      given
        ? K.kv([
            ['Valet may use', `${K.link('Woolworths')} <span class="faint">from 1Password</span>`],
            ['Filled only on', K.value('auth.woolworths.com.au')],
            [
              'Session',
              `${K.badge('Logged in', 'ok')} <span class="faint">checked 9:40 pm</span> ${K.ghost('Check now')}`,
            ],
          ])
        : `<span class="muted">Valet has no Woolworths login yet. Search works; anything with your cart waits for one.</span>`,
      given ? K.btn('Change login…') : K.primary('Choose login…'),
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
        : `<div class="row" style="gap:18px"><span class="big">${K.link('37')}</span><span class="muted">calls</span>${K.link('2 failed')}${K.link('12 requests blocked')}<span class="grow"></span>${K.spark()}</div>
           <div class="muted">Last call 9:47 pm · ${K.link('Get cart')} · call ${K.link('7F2A')}</div>
           <div class="row" style="gap:8px;border-top:1px solid var(--wf-line);padding-top:8px"><span class="muted">Called by</span>${K.link('Claude Code')}<span class="faint">31</span>${K.link('Claude Desktop')}<span class="faint">6</span>${K.link('Cursor')}<span class="faint">0</span></div>`,
      K.ghost('All calls'),
    )
  const canReachCard = (version = '0.3.0') =>
    K.card(
      'Can reach',
      `<div class="col" style="gap:4px">
        <div>${K.link('3 web addresses')} <span class="faint">www.woolworths.com.au, cdn0.woolworths.media, acs.woolworths.com.au</span></div>
        <div>${K.link('1 login')} <span class="faint">filled only on auth.woolworths.com.au</span></div>
        <div>${K.link('6 tools')} <span class="faint">3 read · 3 change your cart · 0 can't be undone</span></div>
        <div>${K.link('3 apps')} <span class="faint">and no cloud agents can call it</span></div></div>
       <div class="faint">Worked out from ${version} · checked 9:41 pm ${K.ghost('Check now')}</div>`,
      K.ghost('Open'),
    )

  const overview = ({ top = '', store = true, login = true, today = false }) => `
    <div class="wf-scroll" style="gap:12px;padding-top:16px">
      ${top}
      <div class="grid2" style="gap:12px">
        <div class="col" style="gap:12px">${storeCard(store)}${loginCard(login)}${canDoCard()}</div>
        <div class="col" style="gap:12px">${todayCard(today)}${canReachCard()}</div>
      </div>
    </div>`

  // ---------- Sites list ----------
  const siteRow = (av, name, ver, health, extra) =>
    `<div class="wf-inbox" style="align-items:flex-start">${K.avatar(av)}<div class="grow" style="gap:8px">
       <div class="row"><b style="font-size:13px">${name}</b>${mono(ver)}<span class="grow"></span>${extra}</div>${health}</div></div>`
  const list = `
    ${K.header({ title: 'Sites', status: K.badge('3 sites', 'idle'), actions: K.ghost('Check all now') + K.btn('Add a site…') })}
    <div class="wf-scroll" style="gap:10px">
      ${siteRow(
        'W',
        'Woolworths',
        'woolworths 0.3.0',
        K.health(
          'warn',
          '<b>0.4.0 is waiting for your review.</b> Calls use 0.3.0 until you approve it.',
          K.primary('Review update'),
        ),
        `<span class="muted">${K.link('37 calls today')} · logged in · Town Hall</span>`,
      )}
      ${siteRow(
        'Y',
        'Yahoo Finance',
        'yahoo-finance 1.2.0',
        K.health(
          'warn',
          'Yahoo Finance is limiting requests · calls resume at 9:52 pm · checked 9:44 pm',
          K.btn('Try now') + K.ghost('Pause site'),
        ),
        `<span class="muted">${K.link('9 calls today')} · no login needed</span>`,
      )}
      ${siteRow(
        'W',
        'Wikipedia',
        'wikipedia 0.9.3',
        K.health('ok', 'Ready · checked 9:40 pm', K.ghost('Pause site')),
        `<span class="muted">${K.link('4 calls today')} · no login needed</span>`,
      )}
      <p class="faint" style="margin:4px 0 0">Sites are added by Claude's authoring agent or from a file. Each one asks for your review before it runs.</p>
    </div>`
  FRAMES.push({
    id: 'sites-list',
    group: 'Sites',
    title: 'Sites list',
    personas: ['P1', 'P2', 'P3'],
    desc: "One row per site: name, adapter id and version, today in numbers, and its health line with that state's own action.",
    html: shell('sites', list, { sites: sites('warn', 'warn') }),
    notes: [
      [
        292,
        128,
        'The whole row opens the site (Overview). Name and version sit together so P4 can see which build is live without opening it.',
      ],
      [
        1020,
        168,
        'An update waiting is a sentence plus a real "Review update" button that goes straight to the review page (E1, Nick\'s complaint). The same button is on Overview, Versions, Needs you and the menu bar.',
      ],
      [
        966,
        280,
        'A limited site gets Try now and Pause site in place (E6, P1). Try now warns that it may make the site wait longer.',
      ],
      [925, 131, 'Numbers are doors: "37 calls today" opens Calls filtered to this site (E7).'],
      [
        1058,
        56,
        '"Add a site…" explains the two ways in (authoring agent, file). Assumption: the IA has no add-site flow yet, see gaps.',
      ],
    ],
  })

  const empty = `
    ${K.header({ title: 'Sites', actions: K.btn('Add a site…') })}
    <div class="wf-scroll">
      ${K.empty('No sites yet', 'A site lets Claude use a website as you, in a browser on this Mac. Valet shows you what each one can do before it runs.', `<div class="row" style="margin-top:8px">${K.primary('Continue setup')}${K.btn('How sites are added')}</div>`)}
    </div>`
  FRAMES.push({
    id: 'sites-empty',
    group: 'Sites',
    title: 'Sites list, empty',
    personas: ['P2', 'P5'],
    desc: 'Only before setup installs the first site, or after the last is removed.',
    html: shell('sites', empty, { sites: [], badges: { needs: 1 } }),
    notes: [
      [358, 170, "Says what a site is in one sentence, in Sam's words (P2, E8)."],
      [
        568,
        200,
        '"Continue setup" re-enters setup at its site step, the same as the "Finish setup" Needs you item (P9).',
      ],
      [
        196,
        226,
        'The sidebar keeps its shape: the Sites group stays with no rows rather than disappearing (principle 6).',
      ],
    ],
  })

  // ---------- Overview states ----------
  const readyTop = K.health(
    'ok',
    '<b>Ready.</b> Logged in · store Town Hall · checked 9:40 pm',
    K.ghost('Check now') + K.ghost('Pause site'),
  )
  FRAMES.push({
    id: 'site-overview',
    group: 'Sites',
    title: 'Site Overview, ready',
    personas: ['P2', 'P3', 'P1'],
    desc: "Everything Sam needs on one tab: health, store, login, trolley, what it can and can't do, today, who calls it and what it can reach.",
    html: shell('sites', siteHead({ status: K.badge('Ready', 'ok') }) + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: { needs: 1 },
    }),
    notes: [
      [
        396,
        85,
        'Header: breadcrumb, name, one status badge (never a button), then the adapter id, version and hash P4 asked for. The hash is a value: selectable, with copy (E3).',
      ],
      [
        624,
        184,
        'Tabs are a real tablist; each tab has its own URL and changes the heading (P5). "Calls ↗" is a link to Activity filtered to Woolworths, not a copy.',
      ],
      [
        1000,
        80,
        '"Open my trolley" opens the site\'s cart in Valet\'s browser on this Mac (P2). The ⋯ menu holds Pause site and Remove site….',
      ],
      [
        567,
        289,
        'Every card with a setting has its change button in the header, named by what it changes (principle 2). Store and login are on Overview because P1, P2, P3 and P4 all looked here (T5).',
      ],
      [
        718,
        466,
        'Can reach (P3): web addresses, logins, tools and callers, each a link, with when it was worked out and Check now (principle 8).',
      ],
      [262, 668, 'Plain words first; the full list is the Permissions tab (E8).'],
    ],
  })

  const updateBanner = K.banner(
    'warn',
    'Woolworths 0.4.0 is waiting for your review.',
    'It adds 1 web address and 1 tool that only reads (Everyday Rewards balance). Calls keep using 0.3.0 until you approve. From the authoring agent, 28 min ago.',
    K.primary('Review update') + K.ghost('Compare'),
  )
  FRAMES.push({
    id: 'site-overview-update',
    group: 'Sites',
    title: 'Site Overview, update waiting',
    personas: ['P1', 'P2', 'P4', 'P5'],
    desc: "Nick's original complaint: he was on this page and could not find the review. Now it is in the header and in a banner, both as a real button.",
    html: shell(
      'sites',
      siteHead({
        status: K.badge('0.4.0 waiting for review', 'warn'),
        actions: K.primary('Review Woolworths update'),
      }) + overview({ top: updateBanner + readyTop }),
      { site: 0, sites: sites('warn'), badges: { needs: 1 } },
    ),
    notes: [
      [
        400,
        72,
        'The header says it, beside the version (P1: "not only in a banner I\'ve learned to ignore"). The badge is status only; the button beside it acts (E1).',
      ],
      [
        800,
        80,
        '"Review Woolworths update" names the object (principle 2) and opens #/sites/woolworths/versions/4b7e…/review in this window. Keyboard: it is the first button after the heading.',
      ],
      [
        258,
        232,
        'The banner says what changes in plain words and what happens meanwhile, then repeats the same button. "Compare" opens Versions with 0.3.0 and 0.4.0 chosen.',
      ],
      [
        196,
        262,
        'Same title and same button as the Needs you item and the menu bar row (principle 1). The sidebar dot turns amber; the Needs you count includes it.',
      ],
      [
        272,
        302,
        'The health line stays green: 0.3.0 is still working. An update waiting is not a fault. IA gap: the IA vocabulary row says "its tools are off until then"; this frame follows the Needs you frame (calls use 0.3.0).',
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
    desc: 'Approved, but no login given yet. The Needs you item "Give Valet your Woolworths login" points here and to the same sheet.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Needs a login', 'warn') }) +
        overview({ top: loginTop, login: false, today: true }),
      { site: 0, sites: sites('warn'), badges: { needs: 1 } },
    ),
    notes: [
      [
        1030,
        232,
        '"Choose login…" opens the grant sheet over this page (principle 5); Escape comes back here with focus on this button.',
      ],
      [
        272,
        229,
        'The line says which tools wait, so Sam knows search still works. Assumption: the adapter marks which tools need the login; the IA does not say.',
      ],
      [
        568,
        419,
        'The Login card repeats the action in place (principle 4). Both buttons open the same sheet.',
      ],
      [
        400,
        85,
        'The header badge, the health line, the Needs you item and the tool result all use the same words: "Give Valet your Woolworths login" (section 7).',
      ],
    ],
  })

  const limitTop =
    K.health(
      'warn',
      '<b>Woolworths is limiting requests.</b> Calls resume at 9:52 pm · checked 9:44 pm',
      K.btn('Try now') + K.btn('Pause site'),
    ) +
    `<div class="row faint" style="margin-top:-6px;padding:0 10px">▸ Details: call ${K.link('7F2A')} got "too many requests" at 9:22 pm. Valet waits 30 min, up to 6 h if it happens again. Try now may make Woolworths wait longer.</div>`
  FRAMES.push({
    id: 'site-overview-limited',
    group: 'Sites',
    title: 'Site Overview, limited by the site',
    personas: ['P1', 'P3', 'P7'],
    desc: 'Woolworths is pushing back. The health line says until when, and offers Try now and Pause site where the problem is noticed.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Limited until 9:52 pm', 'warn') }) + overview({ top: limitTop }),
      { site: 0, sites: sites('warn'), badges: { needs: 1 } },
    ),
    notes: [
      [
        272,
        235,
        'Clock time, not a countdown: this can be hours (E5). Same sentence as the tool result Claude gets (section 7).',
      ],
      [
        981,
        229,
        'Try now (P1) runs one check now. It warns inline that it may make the site wait longer; it is not a confirmation dialog.',
      ],
      [1057, 229, 'Pause site is reversible, so it acts at once with an Undo toast (E4).'],
      [
        245,
        282,
        'Details names the call that tripped it and the wait rule, so P3 can see why and P1 can see when. Valet\'s own cap uses the other sentence: "Valet is limiting its requests to Woolworths until 10:00 pm".',
      ],
    ],
  })

  const pausedTop = K.health(
    '',
    '<b>Woolworths is paused.</b> Calls are refused and nothing is sent · paused by you at 9:30 pm',
    K.primary('Resume Woolworths'),
  )
  FRAMES.push({
    id: 'site-overview-paused',
    group: 'Sites',
    title: 'Site Overview, site paused',
    personas: ['P1', 'P3'],
    desc: 'Only this site is paused; the others keep working. Pausing all of Valet is the titlebar button.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Paused', 'idle') }) +
        overview({ top: pausedTop }) +
        K.toast('Woolworths paused. Calls are refused until you resume.', K.btn('Undo  ⌘Z')),
      { site: 0, sites: sites('idle'), badges: { needs: 1 } },
    ),
    notes: [
      [998, 230, 'The one next step is the primary button: "Resume Woolworths" (principle 2).'],
      [272, 235, 'Says who paused and when, and that nothing was sent, so P3 can trust it (principle 8).'],
      [
        824,
        721,
        'The toast offers Undo and ⌘Z (P1). It stays until focus leaves it, so Jordan can reach it (P5).',
      ],
      [
        196,
        262,
        'The sidebar dot turns grey. Assumption: a paused site is not a Needs you item, since the person chose it.',
      ],
    ],
  })

  const firstTop = K.banner(
    'info',
    "Woolworths isn't approved yet.",
    'Nothing runs until you review what it can do. It will ask for your Woolworths login and a store next.',
    K.primary('Review Woolworths'),
  )
  const firstPage = `
    ${siteHead({ status: K.badge('Not approved yet', 'info'), actions: '', approved: 'added 9:31 pm by the authoring agent' }).replace(K.btn('Open my trolley'), '')}
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
    desc: 'A new site the authoring agent (or a file) added. The page already says what it would do; the review is one click away.',
    html: shell('sites', firstPage, { site: 0, sites: sites('info'), badges: { needs: 1 } }),
    notes: [
      [
        1001,
        234,
        '"Review Woolworths" opens the first-install review (summary first). Assumption: the Needs you title is "Review Woolworths before first use"; the IA table has no first-install row.',
      ],
      [
        454,
        124,
        'No "Open my trolley" until approved: the site has no session yet. The header shows who added it and when.',
      ],
      [
        261,
        479,
        'Store and Login say they come after approval instead of showing disabled buttons, so nothing looks broken.',
      ],
      [718, 304, 'Can reach is shown before approval: P3 sees the blast radius before saying yes.'],
    ],
  })

  // ---------- Tools tab ----------
  const toolRow = (title, name, does, effect, calls, remote) => [
    `<span class="col" style="gap:0"><b>${title}</b>${mono(name)}</span>`,
    `<span class="muted">${does}</span>`,
    effect,
    calls ? K.link(calls) : '<span class="faint">none</span>',
    remote,
  ]
  const tools = `
    ${siteHead({ tab: 1 })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="row"><span class="muted">6 tools. Apps on this Mac can call all of them; you choose which cloud agents may.</span><span class="grow"></span>${K.link('Calls for all tools')}</div>
      ${K.table(
        ['Tool', 'What it does', 'Effect', 'Calls · 7 days', 'Cloud agents'],
        [
          toolRow(
            'Search products',
            'search_products',
            'Prices, cup prices, specials and stock at your store.',
            K.badge('Reads', 'read'),
            '54',
            K.toggle(true),
          ),
          toolRow(
            'Product details',
            'product_details',
            'Ingredients, allergens and nutrition for one product.',
            K.badge('Reads', 'read'),
            '19',
            K.toggle(true),
          ),
          toolRow(
            'Get cart',
            'get_cart',
            "What's in your cart, with totals and savings.",
            K.badge('Reads', 'read'),
            '27',
            K.toggle(true),
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
    html: shell('sites', tools, { site: 0, sites: sites('warn'), badges: { needs: 1 } }),
    notes: [
      [
        256,
        296,
        "Plain title first, tool name in mono underneath: Sam reads the first, Alex greps the second (P4, E8). Clicking a row opens its calls; the description is the adapter's, shown as data.",
      ],
      [
        749,
        450,
        'Effect badges in words: Reads, Changes your cart, Asks you first. Badges are never buttons (E1).',
      ],
      [959, 304, 'The count is a door: Calls filtered to this site and tool for 7 days (E7).'],
      [
        1050,
        247,
        'The cloud-agent switch acts at once with an Undo toast. Apps on this Mac use the per-app list on their Connections page. Assumption: tool scoping is per cloud agent there and this column is the default for new ones.',
      ],
      [616, 607, 'A pending tool shows where it will appear, with the same Review update button (P4).'],
    ],
  })

  // ---------- Permissions tab ----------
  const perms = `
    ${siteHead({ tab: 2 })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      <div class="grid2" style="gap:12px">
        ${K.card(
          'What Woolworths can do',
          `
          <div class="col" style="gap:6px">
            <div class="row">${K.dot('ok')}<span>Open pages on woolworths.com.au and its login page</span></div>
            <div class="row">${K.dot('ok')}<span>Fill your Woolworths login, only on auth.woolworths.com.au</span></div>
            <div class="row">${K.dot('ok')}<span>Read and change your cart, through 4 kinds of request</span></div>
            <div class="row">${K.dot('ok')}<span>At most 6 requests a call, 10 s apart; waits 30 min if limited</span></div>
          </div>`,
        )}
        ${K.card(
          "What it can't do",
          `
          <div class="col" style="gap:6px">
            <div class="row">${K.dot('bad')}<span>Pay or check out</span></div>
            <div class="row">${K.dot('bad')}<span>Contact any other web address. Valet blocks it and shows it in Calls (${K.link('12 blocked today')})</span></div>
            <div class="row">${K.dot('bad')}<span>Use any login but the one you gave it</span></div>
            <div class="row">${K.dot('bad')}<span>See other sites' sessions or cookies</span></div>
          </div>`,
        )}
      </div>
      ${K.card(
        'Details',
        `
        ${K.kv([
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
        ])}`,
        `<span class="faint">from 0.3.0 · ${WOW_HASH}</span> ${K.ghost('Hide')}`,
      )}
    </div>`
  FRAMES.push({
    id: 'site-permissions',
    group: 'Sites',
    title: 'Permissions tab',
    personas: ['P2', 'P3', 'P1'],
    desc: 'Plain sentences first: what it can and can\'t do. The technical declaration is under Details, open here as it is for anyone with "Show technical details" on.',
    html: shell('sites', perms, { site: 0, sites: sites(), badges: { needs: 1 } }),
    notes: [
      [
        261,
        268,
        'Four plain sentences Sam can read (P2 wanted this on Overview too: the short form is there).',
      ],
      [
        719,
        290,
        '"Can\'t" is as explicit as "can", and the blocked count is a door to Calls filtered to blocked requests (E7, P3).',
      ],
      [
        261,
        409,
        'Details holds the words we keep out of the main UI (egress, partitions, selectors). Open by default with Settings › General › "Show technical details" (P1).',
      ],
      [415, 453, 'Every host, origin and selector is a value: selectable, copyable (E3).'],
      [930, 412, 'Says which version it describes; Versions › Compare shows how it changes.'],
    ],
  })

  // ---------- Versions tab ----------
  const versions = `
    ${siteHead({ tab: 3, status: K.badge('0.4.0 waiting for review', 'warn'), actions: K.primary('Review Woolworths update') })}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.banner('warn', '0.4.0 · waiting for your review', `${K.value(NEXT_HASH)} · from the authoring agent in ${K.link('Claude Code')}, 28 min ago · adds 1 web address, 1 read tool · same login`, K.primary('Review update'))}
      <div class="row"><span class="h3">Adapter versions</span><span class="grow"></span>Compare ${K.input('0.3.0 (live) ▾', '130px')} with ${K.input('0.4.0 (waiting) ▾', '140px')} ${K.btn('Compare')}</div>
      ${K.table(
        ['Version', 'Content hash', 'From', 'Approved', 'Login', 'Calls', ''],
        [
          [
            `<b>0.3.0</b> ${K.badge('Live', 'ok')}`,
            K.value(WOW_HASH),
            'Authoring agent',
            'Fri 6 Nov, 7:54 pm',
            `${K.badge('login', 'secret')} ${K.link('Woolworths')}`,
            `${K.link('128')} <span class="faint">2 failed</span>`,
            K.ghost('Compare'),
          ],
          [
            '<b>0.2.1</b>',
            K.value('a1d0…3b77'),
            'Authoring agent',
            'Fri 30 Oct',
            `${K.badge('login', 'secret')} ${K.link('Woolworths')}`,
            `${K.link('412')} <span class="faint">31 failed</span>`,
            K.ghost('Compare') + K.btn('Restore…'),
          ],
          [
            '<b>0.2.0</b>',
            K.value('6e2f…91c4'),
            'Authoring agent',
            'Sat 24 Oct',
            `${K.badge('login', 'secret')} ${K.link('Woolworths&nbsp;(old)')}`,
            `${K.link('96')} <span class="faint">4 failed</span>`,
            K.ghost('Compare') + K.btn('Restore…'),
          ],
          [
            '<b>0.1.0</b>',
            K.value('0c9b…d218'),
            'From a file',
            'Tue 20 Oct',
            '<span class="faint">none given</span>',
            K.link('15'),
            K.ghost('Compare') + K.btn('Restore…'),
          ],
        ],
        { cols: '100px 120px 110px 120px 1fr 110px 170px' },
      )}
      <p class="faint" style="margin:0">Restoring a version asks you to approve it again, like an update. A login given to one version is offered to the restored one only if the login part is identical.</p>
    </div>`
  FRAMES.push({
    id: 'site-versions',
    group: 'Sites',
    title: 'Versions tab',
    personas: ['P4', 'P1', 'P3'],
    desc: 'The only tab that says "adapter". Pending update on top, then every approved version with where it came from, its login and its calls.',
    html: shell('sites', versions, { site: 0, sites: sites('warn'), badges: { needs: 1 } }),
    notes: [
      [
        1030,
        233,
        'The pending update leads, with the same "Review update" button. Several dev builds of one adapter collapse into the newest, so P4 never approves a stale hash.',
      ],
      [
        1074,
        288,
        'Compare any two versions (P4), not only waiting vs live. It opens the same permission-first diff as the review, read-only.',
      ],
      [
        726,
        328,
        'Login per version (P4): grants are tied to a content hash, so each row says which login it had. Each links to its grant page.',
      ],
      [
        866,
        372,
        "Calls per version link to Calls filtered by version, so P4 can see whether 0.4.0 fails where 0.3.0 didn't (E7).",
      ],
      [
        1066,
        407,
        '"Restore…" uses the approval gesture (a review page in restore mode). Assumption: restore is a review, not a one-click switch, because it changes what can be reached.',
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
      `From the authoring agent in ${K.link('Claude Code')}, 28 min ago · adapter ${mono('woolworths')} ${mono('0.3.0')} ${K.value(WOW_HASH)} → ${mono('0.4.0')} ${K.value(NEXT_HASH)}`,
    )}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.card(
        "What's new",
        `
        ${added('warn', `${K.badge('New web address', 'warn')} Woolworths may contact ${K.value('api.woolworthsrewards.com.au')} <span class="grow"></span><span class="faint">a different site from woolworths.com.au</span>`)}
        ${added('info', `${K.badge('New tool', 'info')} <b>Everyday Rewards balance</b> ${mono('get_rewards_balance')} ${K.badge('Reads', 'read')}<span class="grow"></span><span class="faint">callable by ${K.link('Claude Code')}, ${K.link('Claude Desktop')}, ${K.link('Cursor')}</span>`)}
        ${added('info', `${K.badge('New request', 'info')} ${mono('GET /api/v1/rewards/balance')} ${K.badge('read', 'read')}`)}
        <div class="row faint">Unchanged: login pages, the login and where it's filled, the 6 tools, limits, cookies. ${K.ghost('Show everything ▸')}</div>`,
        '<span class="faint">3 additions · nothing removed</span>',
      )}
      <div class="grid2" style="gap:12px">
        ${K.card('Login', `${K.check('Keep using your Woolworths login (1Password item "Woolworths") for 0.4.0', true)}<span class="faint">Ticked because the login, where it's filled and the login pages are identical to 0.3.0.</span>`)}
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
    <div class="sticky-foot">${K.btn('Reject update…')}${K.ghost('Decide later')}<span class="grow"></span>${K.check("I've read the new web address", true)}${K.primary('Approve 0.4.0  ⏎')}</div>`
  FRAMES.push({
    id: 'site-review-update',
    group: 'Sites',
    title: 'Review update, 0.3.0 → 0.4.0',
    personas: ['P4', 'P1', 'P3', 'P5'],
    desc: 'A full page inside the site (P3): sidebar kept, breadcrumb back to Versions, Escape returns to wherever you came from. Additions lead, highlighted by how much they widen access.',
    html: shell('sites', review, { site: 0, sites: sites('warn'), badges: { needs: 1 } }),
    notes: [
      [
        370,
        56,
        'Breadcrumb Sites › Woolworths › Versions › Review 0.4.0; the route is #/sites/woolworths/versions/4b7e…/review. Focus lands on the h1 (P5).',
      ],
      [796, 90, 'Calls keep using 0.3.0 until a decision, said in the header so nobody approves in a hurry.'],
      [
        271,
        220,
        'Additions first, each tinted: amber for anything that reaches somewhere new, blue for the rest. P3 sees who will be able to call the new tool.',
      ],
      [1068, 437, '"Open diff" opens the real code diff for the file (P4), over this page.'],
      [
        261,
        443,
        'The login is pre-ticked to carry over only when the login block is identical; otherwise unticked with the reason (P4).',
      ],
      [
        826,
        739,
        'The acknowledgement sits next to Approve and only appears because a new web address is added (P1). Return approves when it is ticked; Approve stays focusable while disabled and says why (P5). Reject is not red and asks for a reason (P2, P4).',
      ],
    ],
  })

  // ---------- Code diff viewer (over the review page) ----------
  const fileRow = (path, badge, counts, on) =>
    `<div class="row" style="padding:7px 10px;border-radius:6px;${on ? 'background:var(--wf-sel);font-weight:600' : ''}">${mono(path)}<span class="grow"></span><span class="faint">${counts}</span></div><div style="padding:0 10px 4px">${badge}</div>`
  const diffSheet = sheet(
    `Code changes · Woolworths 0.3.0 → 0.4.0`,
    `<div style="display:grid;grid-template-columns:210px minmax(0,1fr);gap:14px;min-height:0">
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
           ${diffLine('+', 1, "import { defineTool } from '@valet/adapter-kit'")}
           ${diffLine('+', 2, "import { REWARDS_API } from '../hosts'")}
           ${diffLine('+', 3, '')}
           ${diffLine('+', 4, 'export const getRewardsBalance = defineTool({')}
           ${diffLine('+', 5, "  name: 'get_rewards_balance',")}
           ${diffLine('+', 6, "  title: 'Everyday Rewards balance',")}
           ${diffLine('+', 7, "  sideEffect: 'read',")}
           ${diffLine('+', 8, '  async run({ page }) {')}
           ${diffLine('+', 9, '    const res = await page.request.get(REWARDS_API + BALANCE_PATH)')}
           ${diffLine('+', 10, "    if (!res.ok()) throw new SiteChanged('rewards balance')")}
           ${diffLine('+', 11, '    const { pointsBalance, dollarValue } = await res.json()')}
           ${diffLine('+', 12, '    return { points: pointsBalance, worth: dollarValue }')}
           ${diffLine('+', 13, '  },')}
           ${diffLine('+', 14, '})')}
           <div class="faint" style="padding:4px 44px">50 more lines · scrolls</div>
         </div>
       </div>
     </div>`,
    `<span class="faint">${K.kbd('↑')} ${K.kbd('↓')} files · ${K.kbd('Esc')} back to the review</span><span class="grow"></span>${K.btn('Previous file')}${K.btn('Next file')}${K.primary('Back to review')}`,
    'wide',
  )
  FRAMES.push({
    id: 'site-review-diff',
    group: 'Sites',
    title: 'Code diff viewer, over the review',
    personas: ['P4', 'P3', 'P5'],
    desc: 'Opened by "Open diff" on a code file row of the review. A wide sheet over the review page: files on the left, the unified diff on the right. Esc returns to the review with focus on the row that opened it.',
    html: shell('sites', review, { site: 0, sites: sites('warn'), badges: { needs: 1 }, over: diffSheet }),
    notes: [
      [
        510,
        64,
        'Sheet, not a new window: it opens over the review page (principle 5), so the decision footer is one Esc away.',
      ],
      [
        190,
        148,
        'Every changed file, with its counts; ↑ ↓ move between files without leaving the keyboard (P4). The file the person clicked opens first.',
      ],
      [
        862,
        112,
        'Unified by default; Split is remembered per viewer. Copy takes the whole file at this version.',
      ],
      [
        400,
        200,
        'The diff is a value: selectable and copyable (E3). Line numbers and +/− are in text too, not only colour (P5).',
      ],
      [
        855,
        478,
        'Esc or "Back to review" returns to the review with focus on the "Open diff" row that opened it (P5).',
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
      sub: `Added by the authoring agent in ${K.link('Claude Code')} at 9:31 pm · adapter ${mono('woolworths 0.3.0')} ${K.value(WOW_HASH)}`,
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
    desc: 'The same page as an update review, with the summary first and every section folded (P3, P2).',
    html: shell('sites', firstReview, { site: 0, sites: sites('info'), badges: { needs: 1 } }),
    notes: [
      [
        261,
        175,
        'One sentence Sam can say yes to (P2: "It can search and change your trolley. It can\'t pay or check out.").',
      ],
      [261, 225, "Can, can't, will need, in the same plain words as Overview and Permissions (E8)."],
      [
        1140,
        390,
        'Each section folds open to the technical list; with "Show technical details" on, they start open (P1). Folds are buttons with aria-expanded (P5).',
      ],
      [
        992,
        733,
        'After Approve, the page goes to Overview and opens the grant sheet; skipping it leaves "Give Valet your Woolworths login" in Needs you (P9).',
      ],
      [
        246,
        733,
        '"Don\'t install…" is not red and not as strong as Approve (P2); it asks whether to remove the files too.',
      ],
    ],
  })

  // ---------- Quick review for a code-only dev build ----------
  const quick = `
    ${reviewHead(
      'Review 0.4.1-dev',
      'Quick review: Woolworths 0.4.1-dev',
      K.badge('Code only', 'ok'),
      `From the authoring agent in ${K.link('Claude Code')}, 1 min ago · for repair ticket ${K.link('#12')} · ${mono('0.4.0')} ${K.value(NEXT_HASH)} → ${mono('0.4.1-dev')} ${K.value('c81d…07b2')} · replaces 2 older dev builds`,
    )}
    <div class="wf-scroll" style="gap:12px;padding-top:14px">
      ${K.banner('ok', 'Nothing it can reach changes.', "Same web addresses, same login and where it's filled, same tools, no new step that can't be undone. Checked against 0.4.0 at 10:12 pm.", K.ghost('Show full review'))}
      <div class="wf-card flush"><header><h4>Code</h4><span class="faint">2 files · +9 −3</span><span class="grow"></span>${K.ghost('Previous file  ↑')}${K.ghost('Next file  ↓')}</header><div class="body">
        <div class="row" style="padding:6px 12px;border-bottom:1px solid var(--wf-line)">${mono('src/tools/cart.ts')} ${K.badge('changed', 'warn')} <span class="faint">+7 −3</span></div>
        <div style="padding:6px 0">
          ${diffLine(' ', 41, '  const rows = await page.locator(SEL.cartRow).all()')}
          ${diffLine('-', 42, '  const qty = Number(await row.locator(".qty").innerText())')}
          ${diffLine('+', 42, '  const qtyText = await row.locator("[data-testid=qty-input]").inputValue()')}
          ${diffLine('+', 43, '  const qty = Number.parseInt(qtyText, 10)')}
          ${diffLine('+', 44, '  if (Number.isNaN(qty)) throw new SiteChanged("cart quantity")')}
          ${diffLine(' ', 45, '  lines.push({ stockcode, qty, total })')}
        </div>
        <div class="row" style="padding:6px 12px;border-top:1px solid var(--wf-line)">${mono('test/cart.test.ts')} ${K.badge('changed', 'warn')} <span class="faint">+2 −0</span><span class="grow"></span>${K.ghost('Open ▸')}</div>
      </div></div>
      ${K.check('Keep using your Woolworths login for 0.4.1-dev (identical login part)', true)}
    </div>
    <div class="sticky-foot">${K.btn('Reject')}<span class="grow"></span><span class="faint">Return approves</span>${K.primary('Approve 0.4.1-dev  ⏎')}</div>`
  FRAMES.push({
    id: 'site-review-quick',
    group: 'Sites',
    title: 'Quick review, code-only dev build',
    personas: ['P4', 'P1'],
    desc: 'Open question 4 in the IA: when an update widens nothing, the review is one screen and Return approves. Anything that widens access gets the full review.',
    html: shell('sites', quick, { site: 0, sites: sites('warn'), badges: { needs: 1 } }),
    notes: [
      [
        590,
        88,
        '"Quick review" is in the title so it is never mistaken for the full one. Assumption: dev builds carry a "-dev" version and a repair ticket link.',
      ],
      [
        259,
        173,
        "Valet works this out, it is not the agent's claim: same hosts, origins, fills, tools and side effects. The check time is shown (principle 8).",
      ],
      [1051, 239, 'The real diff, inline, with ↑ ↓ between files (P4: "file rows that open a real diff").'],
      [
        246,
        497,
        'Keep login is pre-ticked because the login part is byte-identical (P4: no re-grant on every dev build).',
      ],
      [
        1007,
        733,
        'Focus starts on Approve; Return approves, no acknowledgement needed. Reject needs no confirm (P4).',
      ],
    ],
  })

  // ---------- Grant sheet ----------
  const grant = sheet(
    'Give Valet your Woolworths login',
    `<p class="muted" style="margin:0">Woolworths asks for a username and password. Valet fills them only on ${K.value('auth.woolworths.com.au')} and never shows them to Claude.</p>
     <div class="row">${K.search('Search 1Password')}<span class="faint">vault "Valet"</span></div>
     <div class="wf-card flush"><div class="body">${K.table(
       [],
       [
         [
           K.radio('<b>Woolworths</b>', true),
           '<span class="faint">saved for auth.woolworths.com.au</span>',
           K.badge('Best match', 'ok'),
         ],
         [K.radio('Woolworths Rewards'), '<span class="faint">saved for woolworthsrewards.com.au</span>', ''],
         [K.radio('Woolworths (old)'), '<span class="faint">edited 2024</span>', ''],
       ],
       { cols: '1fr 1fr 100px', selected: 0 },
     )}</div></div>
     <div class="col" style="gap:6px"><span class="h3">If Woolworths asks for a one-time code</span>
       <div class="row" style="gap:16px">${K.radio('Use the code in this 1Password item', true)}${K.radio('Read it from Messages')}${K.radio('Ask me')}</div></div>
     <p class="faint" style="margin:0">This login is for Woolworths 0.3.0 (${WOW_HASH}). A new version asks again unless its login part is identical.</p>`,
    `${K.ghost('Use a Keychain copy instead')}<span class="grow"></span>${K.btn('Cancel')}${K.primary('Use this login')}`,
  )
  FRAMES.push({
    id: 'site-grant-sheet',
    group: 'Sites',
    title: 'Grant sheet: Give Valet your Woolworths login',
    personas: ['P2', 'P3', 'P4', 'P5'],
    desc: 'Opened by "Choose login…" on Overview, the Needs you item, or setup. It slides over the site page; Escape returns there with focus on the button that opened it.',
    html: shell(
      'sites',
      siteHead({ status: K.badge('Needs a login', 'warn') }) +
        overview({ top: loginTop, login: false, today: true }),
      { site: 0, sites: sites('warn'), badges: { needs: 1 }, over: grant },
    ),
    notes: [
      [555, 64, 'Title is the Needs you title word for word (principle 1).'],
      [880, 118, 'Says where it is filled and that Claude never sees it, before asking anything (P2, P3).'],
      [
        860,
        214,
        'Items are ranked by how well their saved address matches the login page; the best is pre-selected but named, never silent.',
      ],
      [
        301,
        330,
        'One-time codes are part of the same choice, so a code check later does not surprise anyone (P6).',
      ],
      [880, 388, 'Ties the login to the version, in plain words, which P4 needs and Sam can skip.'],
      [765, 441, '"Use this login" stays focusable while nothing is chosen and says why (P5).'],
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
    html: shell('sites', siteHead({ status: K.badge('Ready', 'ok') }) + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: { needs: 1 },
      over: store,
    }),
    notes: [
      [
        540,
        64,
        'The sheet and the Needs you item share one plain title, "Choose your Woolworths store" (principle 1, P2).',
      ],
      [
        683,
        150,
        "Search runs on the site in Valet's browser; results take a few seconds and say so in a live region (P5).",
      ],
      [862, 202, 'The current store is marked, so changing it is a deliberate choice.'],
      [690, 320, 'The button names the store it will use (principle 2).'],
    ],
  })

  // ---------- Remove site dialog ----------
  const remove = dialog(
    'Remove Woolworths?',
    `<div>Claude Code, Claude Desktop and Cursor lose its 6 tools at once.</div>
     <div>Valet forgets the login it may use (your 1Password item stays), the store, and signs this Mac out of Woolworths in Valet's browser.</div>
     <div>Its calls and audit records stay. Adding it back means a new review.</div>
     <div class="row faint">Want it back later? ${K.link('Pause Woolworths instead')}</div>`,
    `${K.btn('Cancel')}${K.danger('Remove Woolworths')}`,
  )
  FRAMES.push({
    id: 'site-remove-dialog',
    group: 'Sites',
    title: 'Remove site dialog',
    personas: ['P3', 'P1', 'P2'],
    desc: 'From the ⋯ menu on the site header. Destructive, so it confirms with the consequences named (E4).',
    html: shell('sites', siteHead({ status: K.badge('Ready', 'ok') }) + overview({ top: readyTop }), {
      site: 0,
      sites: sites(),
      badges: { needs: 1 },
      over: remove,
    }),
    notes: [
      [372, 326, 'Names who loses what, by app name (E4).'],
      [372, 356, 'Says what is forgotten and what is kept: the 1Password item is never deleted.'],
      [372, 392, 'Evidence stays: calls and audit records outlive the site (P3).'],
      [668, 414, 'Offers the reversible option in the dialog (P1).'],
      [790, 465, 'Focus starts on Cancel; the red button names the site. Return does not remove.'],
    ],
  })
})()
