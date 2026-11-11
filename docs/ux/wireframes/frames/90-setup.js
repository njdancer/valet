// Setup: first run, re-entrant (P9, P2's walkthrough S8, P5's acceptance criteria).
;(() => {
  const { K, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO.Setup =
    'Setup takes the whole window: a step list on the left, one step on the right in a column of fixed width whose heading never moves between steps, Back and Continue in the same place on every step. Six action steps (1Password, Approve Woolworths, Your login, Your store, Connect Claude, Test it) sit between Welcome and Done. It ends with a real test call. A skipped step is never a dead end: it says why it waits and offers the fix, and whatever is left becomes one "Finish setup (N steps left)" item in Needs you. These frames are the evening Sam set up: Fri 6 Nov, from 8:05 pm (Woolworths approved 8:12 pm).'

  const STEPS = [
    ['Welcome', 'What Valet does'],
    ['1Password', 'Where passwords come from'],
    ['Approve Woolworths', 'What it may do'],
    ['Your login', 'Which 1Password item'],
    ['Your store', 'Where prices come from'],
    ['Connect Claude', 'Claude Desktop or Code'],
    ['Test it', 'Ask Claude one question'],
    ['Done', ''],
  ]
  // state per step: d done, c current, t to do, s skipped, b blocked. subs overrides the sub line.
  const rail = (states, subs = {}) =>
    STEPS.map(([title, sub], i) => {
      const st = states[i] || 't'
      const mark = st === 'd' ? '✓' : st === 's' ? '–' : st === 'b' ? '!' : String(i + 1)
      const markStyle =
        st === 'd'
          ? 'background:var(--wf-ok);color:#fff;border-color:var(--wf-ok)'
          : st === 'c'
            ? 'background:var(--wf-act);color:#fff;border-color:var(--wf-act)'
            : st === 'b'
              ? 'color:var(--wf-warn);border-color:var(--wf-warn)'
              : ''
      return `<div class="row" style="gap:10px;padding:7px 10px;border-radius:8px;align-items:flex-start;${st === 'c' ? 'background:var(--wf-sel);' : ''}">
        <span style="width:20px;height:20px;border-radius:50%;border:1.5px solid var(--wf-line-2);display:grid;place-items:center;font-size:10.5px;font-weight:700;flex:none;${markStyle}">${mark}</span>
        <div class="col" style="gap:0"><span style="${st === 'c' ? 'font-weight:600' : ''}">${title}</span><small class="${st === 'b' || st === 's' ? '' : 'faint'}" style="font-size:10.5px;${st === 'b' ? 'color:var(--wf-warn)' : st === 's' ? 'color:var(--wf-ink-2)' : ''}">${subs[i] || (st === 'd' ? 'Done' : st === 's' ? 'Skipped · waits in Needs you' : sub)}</small></div></div>`
    }).join('')
  const setup = ({ states, subs, body, foot, over = '' }) =>
    `<div class="wf-window">
      <div class="wf-titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="grow" style="text-align:center;color:var(--wf-ink-2)">Set up Valet</span><span style="width:60px"></span></div>
      <div class="wf-body">
        <aside class="wf-side" style="width:224px;padding:16px 10px;gap:2px">
          <div class="grp" style="padding-top:0">Set up Valet · about 5 minutes</div>
          ${rail(states, subs)}
          <div class="grow"></div>
          <div class="foot" style="flex-direction:column;align-items:flex-start;gap:2px">Valet never pays.<span class="faint">Checkout is always you, on woolworths.com.au.</span></div>
        </aside>
        <main class="wf-main">
          <div class="wf-scroll" style="padding:48px 44px 24px;gap:16px"><div class="col" style="gap:16px;max-width:760px;width:100%;margin:0 auto">${body}</div></div>
          <div class="sticky-foot" style="padding:12px 44px">${foot}</div>
        </main>
      </div>${over}</div>`
  const h = (title, lede) =>
    `<div class="col" style="gap:6px"><h2 style="font:600 24px/1.2 var(--f-head);margin:0">${title}</h2>${lede ? `<p class="muted" style="margin:0;font-size:13px;max-width:620px">${lede}</p>` : ''}</div>`
  const nav = (left, right) => `${left}<span class="grow"></span>${right}`
  const lg = (label, kind = '') => `<span class="wf-btn lg ${kind}">${label}</span>`
  const off = (label) =>
    `<span class="wf-btn lg" aria-disabled="true" style="color:var(--wf-ink-3);border-style:dashed">${label}</span>`
  const checkRow = (ok, text, extra = '') =>
    `<div class="row" style="gap:10px"><span style="width:18px;text-align:center;font-weight:700;color:var(--wf-${ok === true ? 'ok' : ok === false ? 'bad' : 'ink-3'})">${ok === true ? '✓' : ok === false ? '✕' : ok === 'no' ? '–' : '○'}</span><span class="grow">${text}</span>${extra}</div>`
  const SUBS = {
    1: 'Connected',
    2: 'Approved 0.3.0',
    3: '"Woolworths", Personal vault',
    4: 'Woolworths Town Hall',
    5: 'Claude Desktop',
    6: 'Worked at 8:16 pm',
  }
  const sub = (...keys) => Object.fromEntries(keys.map((k) => [k, SUBS[k]]))

  // 1. Welcome
  FRAMES.push({
    id: 'setup-welcome',
    group: 'Setup',
    title: 'Welcome',
    personas: ['P2', 'P5'],
    desc: "What Valet does in Sam's words, what she needs, how long it takes, and the line about money. No MCP, no adapters.",
    html: setup({
      states: ['c'],
      body:
        h(
          'Let Claude shop at Woolworths for you',
          "Valet logs in to Woolworths on this Mac, as you, when Claude asks. Anything that can't be undone waits for you to confirm.",
        ) +
        `<div class="grid3" style="margin-top:6px">
          ${K.card('', '<b>1. You ask Claude</b><span class="muted">"Add milk and bread to my cart."</span>')}
          ${K.card('', '<b>2. Valet does it on woolworths.com.au</b><span class="muted">Logged in as you, with your 1Password login. Only on Woolworths.</span>')}
          ${K.card('', '<b>3. You check and pay</b><span class="muted">Removing things asks you first. Paying is always you.</span>')}
        </div>` +
        `<div class="wf-banner ok"><div class="grow"><b>Valet never pays.</b> It can't check out or use your card. Checkout is always you, on woolworths.com.au.</div></div>` +
        `<div class="h3">What you'll need</div>
         <div class="col" style="gap:6px">
          ${checkRow(null, 'Your Woolworths email and password, ideally in 1Password')}
          ${checkRow(null, 'Claude Desktop or Claude Code on this Mac')}
          ${checkRow(null, 'About 5 minutes for six short steps. You can stop and come back: Valet remembers where you were.')}
         </div>`,
      foot: nav(K.ghost('Finish later'), lg('Get started', 'primary')),
    }),
    notes: [
      [
        1135,
        99,
        'The first sentence Sam reads has no jargon (today it has API, adapters, tools and MCP; P2 S8).',
      ],
      [1140, 198, 'Three plain steps instead of today\'s diagram with get_cart and "manifest" in it.'],
      [1105, 295, 'The money line, on the first screen and in the rail footer on every step (P2 part 4).'],
      [
        1135,
        338,
        'What you\'ll need and how long, with the same "six steps" that Finish setup counts (P2 M1). "Finish later" becomes a Needs you item.',
      ],
      [
        168,
        103,
        'The step list is a list of links (P5): done and current steps can be revisited; blocked ones say why.',
      ],
    ],
  })

  // 2. 1Password, connected
  FRAMES.push({
    id: 'setup-1password',
    group: 'Setup',
    title: '1Password, connected and checked',
    personas: ['P2', 'P1', 'P3'],
    desc: 'One button that opens 1Password and asks for Touch ID, then a check Valet runs itself and shows line by line.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Where passwords come from' },
      body:
        h(
          'Where your Woolworths password comes from',
          "Valet copies your Woolworths login from 1Password once, with your approval there, and keeps it in this Mac's Keychain so it works while 1Password is locked.",
        ) +
        K.card(
          '1Password',
          `${K.health('ok', '<b>Connected to 1Password.</b> Checked at 8:06 pm.', K.ghost('Check again'))}
           <div class="col" style="gap:6px;padding:4px 2px">
             ${checkRow(true, '1Password 8 is installed and unlocked')}
             ${checkRow(true, '"Integrate with other apps" is on')}
             ${checkRow(true, 'Valet can see 1 login for woolworths.com.au, in your Personal vault', K.link('Which one?'))}
           </div>`,
          K.badge('Connected', 'ok'),
        ) +
        `<div class="wf-card"><header><h4>Don't use 1Password?</h4><span class="grow"></span><span class="faint">▸</span></header></div>`,
      foot: nav(K.btn('Back'), lg('Continue', 'primary')),
    }),
    notes: [
      [
        1135,
        99,
        'Says where the password lives in one sentence: a Keychain copy of the 1Password item, the same model as the grant sheet and Secrets (story; P2 M3).',
      ],
      [990, 248, 'Every status says when it was checked and can be re-checked (principle 8).'],
      [
        1119,
        336,
        'The check proves the next step will work: Valet already found a Woolworths login in the Personal vault, the vault the next step lists.',
      ],
      [473, 397, "Alternatives stay folded once 1Password works, so Sam isn't asked to compare providers."],
    ],
  })

  // 3. 1Password, problem + alternatives
  FRAMES.push({
    id: 'setup-1password-problem',
    group: 'Setup',
    title: '1Password, check failed, with the fix and the alternatives',
    personas: ['P2', 'P3'],
    desc: 'The check says exactly which part failed, opens the right 1Password screen, and re-checks by itself when Valet regains focus. Only the two alternatives Sam can use are offered.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Where passwords come from' },
      body:
        h(
          'Where your Woolworths password comes from',
          'Valet copies your Woolworths login from 1Password once, with your approval there.',
        ) +
        K.card(
          '1Password',
          `${K.health('bad', '<b>Valet can\'t reach 1Password yet.</b> "Integrate with other apps" is off. Checked at 8:06 pm.', K.ghost('Check again'))}
           <div class="col" style="gap:6px;padding:4px 2px">
             ${checkRow(true, '1Password 8 is installed and unlocked')}
             ${checkRow(false, '"Integrate with other apps" is off', K.primary('Open 1Password settings'))}
             ${checkRow(null, 'Find your Woolworths login (after the step above)')}
           </div>
           <div class="faint" style="font-size:11px;padding-left:30px">In 1Password: Settings › Developer › turn on "Integrate with other apps". Valet checks again when you come back.</div>`,
          K.badge('Not connected', 'bad'),
        ) +
        K.card(
          'Or use another way',
          `<div class="col" style="gap:10px">
            ${K.radio('<b>Type your Woolworths password once</b> <span class="muted">· kept in this Mac\'s Keychain; you update it there if it changes</span>')}
            ${K.radio('<b>Skip for now</b> <span class="muted">· Claude can\'t use Woolworths until you choose a login; it waits in Needs you</span>')}
          </div>`,
        ),
      foot: nav(
        K.btn('Back'),
        `<span class="faint" style="font-size:11px">Connect 1Password or pick another way to continue</span>${off('Continue')}`,
      ),
    }),
    notes: [
      [
        318,
        230,
        "The failure names the one setting that is off, in 1Password's own words, and wraps rather than clips (P2 m11).",
      ],
      [1119, 304, 'The fix is a button that opens 1Password at that screen; Valet re-checks on focus.'],
      [
        1135,
        416,
        "Only two plain alternatives. The service account moved to Secrets for P1 and P3; it was in Sam's way (P2 S8 friction).",
      ],
      [745, 741, 'Continue stays focusable while disabled and says why next to it (P5).'],
    ],
  })

  // 4. Approve Woolworths
  FRAMES.push({
    id: 'setup-approve',
    group: 'Setup',
    title: 'Approve Woolworths, summary first, Approve here',
    personas: ['P2', 'P3', 'P4'],
    desc: 'The bundled first install: "Comes with Valet", no authoring agent. The plain-words review has the Approve button on the same screen; the full review is one link away.',
    html: setup({
      states: ['d', 'd', 'c'],
      subs: sub(1),
      body:
        h(
          'Let Claude use Woolworths?',
          'Woolworths comes with Valet. This is what it can do once you approve it. You can turn any of it off later on the Woolworths page.',
        ) +
        `<div class="grid2">
          ${K.card(
            'Claude will be able to',
            `<div class="col" style="gap:6px">
            ${checkRow(true, 'Search products and see prices')}
            ${checkRow(true, "See what's in your cart")}
            ${checkRow(true, 'Add and change items in your cart')}
            ${checkRow(true, 'Remove from cart, <b>after you confirm each time</b>')}
            ${checkRow(true, 'Choose your store')}</div>`,
          )}
          ${K.card(
            "It can't",
            `<div class="col" style="gap:6px">
            ${checkRow('no', 'Pay, check out or use your card')}
            ${checkRow('no', "Open sites other than Woolworths' own")}
            ${checkRow('no', 'Type your password anywhere but auth.woolworths.com.au')}
            ${checkRow('no', 'See your other 1Password items')}</div>`,
          )}
        </div>` +
        `<div class="row muted" style="gap:10px;font-size:11.5px">Woolworths 0.3.0 · comes with Valet<span class="grow"></span>${K.link('See every request it may make')}</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Not now')}${lg('Approve Woolworths', 'primary')}`),
    }),
    notes: [
      [
        1135,
        99,
        'The question Sam expected, as the heading, and "comes with Valet" in the first line: the bundled install has no unknown author (P2 M5).',
      ],
      [
        711,
        295,
        'Can / can\'t in plain words, in the tool titles\' own words ("Remove from cart"). "It can\'t" never claims less than the hosts allow (P3 #10).',
      ],
      [
        942,
        362,
        "The full review (hosts, paths, hash) is a link for P3 and P4; the hash is no longer on Sam's screen (P2 m2).",
      ],
      [
        893,
        715,
        'Approve is on this screen (P2 near-blocker). "Not now" has no red and leaves later steps explaining why they wait.',
      ],
    ],
  })

  // 5. Login
  const codeChoices = `<div class="col" style="gap:8px">
      ${K.radio('<b>Use the code in this 1Password item</b> <span class="muted">· if it has one</span>')}
      ${K.radio('<b>Read it from Messages</b> <span class="muted">· needs Full Disk Access</span>')}
      ${K.radio('<b>Ask me</b> <span class="muted">· Valet opens the login window and you type it</span>', true)}</div>`
  FRAMES.push({
    id: 'setup-login',
    group: 'Setup',
    title: 'Your login: choose the 1Password item',
    personas: ['P2', 'P3'],
    desc: 'Valet lists the 1Password items for woolworths.com.au in the Personal vault, best match chosen. What Valet does with it sits beside the choice. Same vault, same code choices as the grant sheet.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: sub(1, 2),
      body:
        h(
          'Which Woolworths login should Valet use?',
          'These are the logins for woolworths.com.au in your 1Password Personal vault.',
        ) +
        `<div class="grid2" style="grid-template-columns:minmax(0,1fr) 300px">
          ${K.card(
            '',
            `<div class="col" style="gap:12px">
            ${K.radio('<b>Woolworths</b> <span class="muted">· sam@example.com · Personal vault · used 3 days ago</span>', true)}
            ${K.radio('<b>Woolworths (old)</b> <span class="muted">· sam.old@example.com · Personal vault · 2023</span>')}
            <div class="row" style="gap:8px;border-top:1px solid var(--wf-line);padding-top:10px">${K.link('Choose another item…')}</div></div>`,
          )}
          ${K.card(
            'What Valet does with it',
            `<div class="col" style="gap:6px">
            ${checkRow(true, "Copies it once into this Mac's Keychain, with your OK in 1Password")}
            ${checkRow(true, 'Types it only on auth.woolworths.com.au')}
            ${checkRow('no', 'Never shows it to Claude')}
            ${checkRow('no', 'Never uses it on another site')}</div>`,
          )}
        </div>` +
        K.card('When Woolworths asks for a one-time code', codeChoices),
      foot: nav(K.btn('Back'), lg('Use this login', 'primary')),
    }),
    notes: [
      [1135, 99, 'The step says "login", never "grant" (vocabulary, P2).'],
      [
        741,
        174,
        'Personal vault, the same vault as the 1Password step and the grant sheet; Valet keeps a Keychain copy (story; P2 M3).',
      ],
      [1105, 172, "Can / can't beside the choice, in the same words as the grant sheet (one source; P3 #9)."],
      [
        1135,
        349,
        'The same three code choices with the same words as the grant sheet; "Ask me" is the default because it needs no permission (P2 M4).',
      ],
    ],
  })

  // 6. Store
  FRAMES.push({
    id: 'setup-store',
    group: 'Setup',
    title: 'Your store',
    personas: ['P2'],
    desc: 'A suburb or postcode search, answered by Woolworths itself, with the nearest stores first.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3),
      body:
        h('Which Woolworths do you shop at?', "Prices and what's in stock depend on the store.") +
        `<div class="row">${K.input('2000', '260px')}${K.btn('Find stores')}</div>` +
        K.card(
          '',
          `<div class="col" style="gap:12px">
            ${K.radio('<b>Woolworths Town Hall</b> <span class="muted">· 464-480 Kent St, Sydney · 0.4 km</span>', true)}
            ${K.radio('<b>Woolworths Metcentre</b> <span class="muted">· 273 George St, Sydney · 0.9 km</span>')}
            ${K.radio('<b>Woolworths Broadway</b> <span class="muted">· Bay St, Glebe · 2.1 km</span>')}
          </div>`,
        ) +
        `<div class="faint" style="font-size:11.5px">Found by Woolworths at 8:13 pm. You can change it any time on the Woolworths page.</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${lg('Shop at Woolworths Town Hall', 'primary')}`),
    }),
    notes: [
      [1135, 99, 'One question and one field; no "Woolworths\'s", no "tools" (P2 S8 minor).'],
      [
        687,
        168,
        'Results come from Woolworths through Valet (Find stores), so this step needs Approve first; see the blocked frame. Store names as Woolworths writes them (story).',
      ],
      [
        892,
        741,
        'The primary button names the result, the same words as the tool title "Shop at your store".',
      ],
    ],
  })

  // 7. Blocked step
  FRAMES.push({
    id: 'setup-blocked',
    group: 'Setup',
    title: 'A step that waits: Approve was skipped',
    personas: ['P2', 'P1', 'P5'],
    desc: "Instead of today's blank page with one blue line, the step says why it waits, in one sentence, and offers both ways forward.",
    html: setup({
      states: ['d', 'd', 's', 'c', 'b'],
      subs: { 1: 'Connected', 3: 'Waits for Approve Woolworths', 4: 'Waits for Approve Woolworths' },
      body:
        h('Which Woolworths login should Valet use?', '') +
        `<div class="wf-card" style="max-width:640px"><div class="body" style="padding:20px;gap:12px">
          <b style="font-size:14px">Approve Woolworths first</b>
          <span class="muted">A login is tied to the Woolworths version you approve, so Valet can't offer one until then. Approving is one screen.</span>
          <div class="row">${K.primary('Go to Approve Woolworths')}${K.btn('Skip this step too')}</div>
          <span class="faint" style="font-size:11.5px">Skipped steps wait in Needs you as one "Finish setup" item, and on the Woolworths page as "Review Woolworths before first use". Nothing is lost.</span>
        </div></div>` +
        K.card(
          "Meanwhile, what you've done",
          `<div class="col" style="gap:6px">${checkRow(true, '1Password connected, 1 Woolworths login found')}${checkRow(null, "Woolworths not approved: Claude can't use it yet")}</div>`,
        ),
      foot: nav(
        K.btn('Back'),
        `<span class="faint" style="font-size:11px">Approve Woolworths or skip this step to continue</span>${off('Continue')}`,
      ),
    }),
    notes: [
      [
        208,
        243,
        'The rail says why each waiting step waits, not just "to do" (P1: "don\'t show me steps that are dead ends").',
      ],
      [
        937,
        198,
        'One sentence of why, then the fix as the primary button (P2 S8 major: today the page is blank).',
      ],
      [
        641,
        241,
        "Skipping again is allowed and says exactly where the step will wait, with the story's first-install wording (P9, P5).",
      ],
    ],
  })

  // 8. Connect Claude
  FRAMES.push({
    id: 'setup-connect',
    group: 'Setup',
    title: 'Connect Claude',
    personas: ['P2', 'P1', 'P4'],
    desc: "Valet looks for each Claude on this Mac and puts the one it finds first. Claude Desktop is one click; Claude Code is folded because it wasn't found. Remote access is not offered here.",
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4),
      body:
        h('Which Claude do you use?', 'Valet found Claude Desktop on this Mac.') +
        K.card(
          'Claude Desktop',
          `${K.health('ok', '<b>Added.</b> Restart Claude Desktop to finish.', K.btn('Restart Claude Desktop'))}
           <span class="faint" style="font-size:11.5px">Valet added itself to Claude Desktop's settings. Claude Desktop shows "valet" under Connectors after the restart.</span>`,
          K.badge('Found on this Mac', 'ok'),
        ) +
        `<div class="wf-card"><header><h4>▸ Claude Code</h4><span class="faint">not found on this Mac · show the Terminal command</span><span class="grow"></span>${K.badge('Not found', 'idle')}</header></div>` +
        `<div class="wf-card"><header><h4>▸ Other ways to connect</h4><span class="faint">for people who set up apps by hand</span></header></div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${lg('Continue', 'primary')}`),
    }),
    notes: [
      [
        1135,
        99,
        'Asks which Claude, and answers it by detecting (P2: "Which Claude do I have?"). The found one is first and open.',
      ],
      [1109, 230, 'One click: Valet writes the config, then one Restart button (P2 S8).'],
      [723, 327, "A Claude that wasn't found is folded; the command shows only when opened (P2 m8)."],
      [
        688,
        384,
        'Remote access is no longer pushed in setup; it lives in Connections, and "Other ways" holds only manual config (P2 M8).',
      ],
    ],
  })

  // 9. Test it
  FRAMES.push({
    id: 'setup-test',
    group: 'Setup',
    title: 'Test it: the first call arrives live',
    personas: ['P2', 'P3', 'P5', 'P6'],
    desc: 'Valet gives the exact sentence to ask, then shows the call arriving step by step, ending in a link to the call in Activity.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4, 5),
      body:
        h('Try it: ask Claude one question', 'Open Claude Desktop and ask:') +
        `<div class="row" style="gap:10px"><div style="flex:1;font:500 18px/1.3 var(--f-head);padding:14px 16px;border:1px solid var(--wf-line-2);border-radius:10px;background:var(--wf-paper-2)">"What's in my Woolworths cart?"</div>${K.btn('Copy')}${K.btn('Open Claude Desktop')}</div>` +
        K.card(
          "Watching for Claude's call",
          `<div class="col" style="gap:8px">
            ${checkRow(true, '<span class="mono faint">8:16:02 pm</span> Claude Desktop connected')}
            ${checkRow(true, '<span class="mono faint">8:16:05 pm</span> Claude asked for <b>Get cart</b> on Woolworths')}
            ${checkRow(true, '<span class="mono faint">8:16:06 pm</span> Logged in to Woolworths with your login')}
            ${checkRow(true, '<span class="mono faint">8:16:09 pm</span> Sent your cart to Claude: 4 items', K.link('Open call 2D90'))}
          </div>`,
          K.badge('Live', 'info'),
        ) +
        `<div class="wf-banner ok"><div class="grow"><b>It works.</b> Claude can now use Woolworths. Every call shows up like this in Activity.</div></div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip the test')}${lg('Continue', 'primary')}`),
    }),
    notes: [
      [
        984,
        154,
        'The exact sentence to ask, copyable, and a button that opens the Claude found in the last step (P9).',
      ],
      [489, 243, 'Each step appears as it happens, in a live region that announces each line once (P5).'],
      [
        1007,
        356,
        'The link opens the real call in Activity; the test call has its own ref, 2D90, from the evening of setup (P3, P6 B1).',
      ],
      [1135, 413, 'If nothing arrives in 60 s, this card turns into the checklist in setup-test-failed.'],
    ],
  })

  // 10. Test failed
  FRAMES.push({
    id: 'setup-test-failed',
    group: 'Setup',
    title: 'Test it: nothing arrived',
    personas: ['P2', 'P1', 'P5'],
    desc: '60 seconds after "Open Claude Desktop" no call has come. The card says what Valet can see, what it can\'t, and the likely fix first.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4, 5),
      body:
        h('Try it: ask Claude one question', 'Open Claude Desktop and ask:') +
        `<div class="row" style="gap:10px"><div style="flex:1;font:500 18px/1.3 var(--f-head);padding:14px 16px;border:1px solid var(--wf-line-2);border-radius:10px;background:var(--wf-paper-2)">"What's in my Woolworths cart?"</div>${K.btn('Copy')}${K.btn('Open Claude Desktop')}</div>` +
        K.card(
          'No call from Claude yet',
          `${K.health('warn', "<b>Valet hasn't heard from Claude Desktop</b> since you added it at 8:15 pm. Waited 60 s.", K.ghost('Keep waiting'))}
           <div class="col" style="gap:8px">
            ${checkRow(true, 'Valet is ready: Woolworths approved, login and store chosen')}
            ${checkRow(true, 'Valet is listening for apps on this Mac')}
            ${checkRow(null, 'Claude Desktop was restarted after it was added', K.primary('Restart Claude Desktop'))}
            ${checkRow(null, 'Claude Desktop shows "valet" under Settings › Connectors', K.link('How to check'))}
           </div>`,
          K.badge('Waiting', 'warn'),
        ) +
        `<div class="faint" style="font-size:11.5px">Still nothing? Skip the test: Woolworths is set up, and this check waits in Needs you as "Finish setup (1 step left)".</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip the test')}${off('Continue')}`),
    }),
    notes: [
      [
        987,
        300,
        "Says what is missing in Sam's words and how long Valet waited; no spinner that never ends (P2 B1).",
      ],
      [1120, 364, 'What Valet can see is ticked, so Sam knows her side is fine.'],
      [1120, 395, 'The likeliest fix is the primary button: a restart Claude Desktop needs to load Valet.'],
      [
        1135,
        471,
        'Skipping is safe and counted: one action step left (story: Finish setup counts action steps not done).',
      ],
    ],
  })

  // 11. Done, all finished
  FRAMES.push({
    id: 'setup-done',
    group: 'Setup',
    title: "Done: you're set up",
    personas: ['P2', 'P5', 'P7'],
    desc: 'The "done" Sam asked for in round 1: what works now, what to try, where Valet lives and how it will ask for her. Finishing opens Valet on Sites (nothing waits; P8a).',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4, 5, 6),
      body:
        `<div class="row" style="gap:14px"><span style="width:44px;height:44px;border-radius:50%;background:var(--wf-ok);color:#fff;display:grid;place-items:center;font-size:22px;font-weight:700;flex:none">✓</span>${h("You're set up", 'Claude can use Woolworths. Try asking it: "Add milk and bread to my cart."')}</div>` +
        K.card(
          '',
          `<div class="col" style="gap:8px">
            ${checkRow(true, '1Password connected')}
            ${checkRow(true, 'Woolworths approved (0.3.0)')}
            ${checkRow(true, 'Login: "Woolworths", Personal vault')}
            ${checkRow(true, 'Store: Woolworths Town Hall')}
            ${checkRow(true, 'Claude Desktop connected · test call worked at 8:16 pm', K.link('Open call 2D90'))}
          </div>`,
        ) +
        `<div class="grid2">
          ${K.card('Valet lives in the menu bar', '<span class="muted">Its icon shows a number when something needs you. Click it to see what.</span>')}
          ${K.card('When Claude needs you', '<span class="muted">You get a notification. Removing things from your cart and logging in after a check always wait for you.</span>')}
        </div>`,
      foot: nav('', lg('Open Valet', 'primary')),
    }),
    notes: [
      [
        834,
        99,
        'A big tick and "You\'re set up" only when all six action steps are done (P2 B1, round 1 ask).',
      ],
      [1120, 271, 'What she set up, in her words, ending with the evidence: the test call, linked (P3).'],
      [
        716,
        327,
        "Where Valet lives and how it will interrupt her, so the first notification isn't a surprise (P2 interview).",
      ],
      [
        240,
        740,
        'Open Valet lands on Sites, since nothing waits (P8a). Focus goes to the page heading (P5).',
      ],
    ],
  })

  // 12. Done with skipped steps
  FRAMES.push({
    id: 'setup-done-partial',
    group: 'Setup',
    title: 'Done, with two steps skipped',
    personas: ['P2', 'P5', 'P7'],
    desc: 'Store and Test it were skipped. Says what works now, lists what is left, and shows the exact Needs you item those steps became. Finishing opens Valet on Needs you (P8a).',
    html: setup({
      states: ['d', 'd', 'd', 'd', 's', 'd', 's', 'c'],
      subs: sub(1, 2, 3, 5),
      body:
        h('Almost set up', 'Claude can use Woolworths. Two steps are left.') +
        K.card(
          '',
          `<div class="col" style="gap:8px">
            ${checkRow(true, '1Password connected')}
            ${checkRow(true, 'Woolworths approved (0.3.0)')}
            ${checkRow(true, 'Login: "Woolworths", Personal vault')}
            ${checkRow(true, 'Claude Desktop connected')}
            ${checkRow(null, 'Your store · skipped. Until you choose, Woolworths uses its default store.', K.btn('Do it now'))}
            ${checkRow(null, 'Test it · skipped', K.btn('Do it now'))}
          </div>`,
        ) +
        '<div class="h3">Waiting for you in Needs you and the menu bar</div>' +
        K.inbox('↻', 'Finish setup (2 steps left)', 'Your store · Test it', '', K.btn('Continue setup')),
      foot: nav('', lg('Open Valet', 'primary')),
    }),
    notes: [
      [
        200,
        289,
        'Skipped steps keep their place in the rail, and the count agrees: 2 skipped, "2 steps left" (P2 M1).',
      ],
      [1135, 99, '"Almost set up", not a tick, and what each skipped step means in practice.'],
      [1019, 278, 'Each skipped step can be done from here without going back through the list.'],
      [
        981,
        422,
        'The exact item that appears in Needs you and the menu bar, same title and button (P9, P5).',
      ],
    ],
  })

  // ===================== v3: states on the order path (design G5) and dead ends (design G8) =====================
  const pop = (x, y, w, inner) =>
    `<div style="position:absolute;z-index:4;left:${x}px;top:${y}px;width:${w}px;background:var(--wf-paper);border:1px solid var(--wf-line-2);border-radius:10px;box-shadow:0 14px 34px var(--wf-shadow);padding:14px 16px;display:flex;flex-direction:column;gap:10px">${inner}</div>`
  const scrimSheet = (title, body, footer) =>
    `<div class="wf-scrim"></div><div class="wf-sheet"><header><h3>${title}</h3><span class="grow"></span>${K.icon('✕')}</header><div class="body">${body}</div><footer>${footer}</footer></div>`
  const busy = (label) =>
    `<span class="wf-btn lg primary" aria-disabled="true" style="opacity:.85">◌ ${label}</span>`
  const opHead = h(
    'Where your Woolworths password comes from',
    "Valet copies your Woolworths login from 1Password once, with your approval there, and keeps it in this Mac's Keychain so it works while 1Password is locked.",
  )
  const loginHead = h(
    'Which Woolworths login should Valet use?',
    'These are the logins for woolworths.com.au in your 1Password Personal vault.',
  )

  // 1Password: waiting for the approval in 1Password
  FRAMES.push({
    id: 'setup-1password-waiting',
    group: 'Setup',
    title: '1Password, waiting for your OK in 1Password',
    personas: ['P2', 'P5'],
    desc: 'After "Connect 1Password": 1Password shows its own approval (Touch ID or password). Valet says where to look and what happens if it is declined, and waits without a time limit.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Waiting for 1Password' },
      body:
        opHead +
        K.card(
          '1Password',
          `${K.health('info', '<b>Approve Valet in 1Password.</b> 1Password is asking you, with Touch ID or your password, whether Valet may connect.', K.btn('Show 1Password'))}
           <div class="col" style="gap:6px;padding:4px 2px">
             ${checkRow(true, '1Password 8 is installed')}
             ${checkRow(null, '◌ Waiting for your OK in 1Password')}
             ${checkRow(null, 'Find your Woolworths login (after the step above)')}
           </div>
           <div class="faint" style="font-size:11px;padding-left:30px">If you decline in 1Password, nothing is copied and this step offers the other ways.</div>`,
          K.badge('Waiting for you', 'info'),
        ),
      foot: nav(K.btn('Back'), `${K.ghost('Cancel')}${busy('Connecting…')}`),
    }),
    notes: [
      [
        1100,
        230,
        'Names the other app and the exact thing it will ask, so Sam looks there (P2). Show 1Password brings it forward if it is hidden.',
      ],
      [
        460,
        300,
        'The waiting line is a polite live region, announced once (P5). No timer: 1Password decides.',
      ],
      [880, 741, 'The primary shows progress and is not a second Connect; Cancel stops waiting.'],
    ],
  })

  // "Which one?" popover (G8)
  FRAMES.push({
    id: 'setup-which-one',
    group: 'Setup',
    title: '1Password: "Which one?" shows the item it found',
    personas: ['P2', 'P3'],
    desc: 'The "Which one?" link on the 1Password check opens a popover naming the exact item, so Sam can tell it apart before the login step. Esc or clicking outside closes it, back on the link.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Where passwords come from' },
      body:
        opHead +
        K.card(
          '1Password',
          `${K.health('ok', '<b>Connected to 1Password.</b> Checked at 8:06 pm.', K.ghost('Check again'))}
           <div class="col" style="gap:6px;padding:4px 2px">
             ${checkRow(true, '1Password 8 is installed and unlocked')}
             ${checkRow(true, '"Integrate with other apps" is on')}
             ${checkRow(true, 'Valet can see 1 login for woolworths.com.au, in your Personal vault', `<span class="wf-link" style="outline:2px solid var(--wf-act);outline-offset:2px">Which one?</span>`)}
           </div>`,
          K.badge('Connected', 'ok'),
        ),
      foot: nav(K.btn('Back'), lg('Continue', 'primary')),
      over: pop(
        700,
        330,
        360,
        `<b>The login Valet found</b>
         ${K.kv([
           ['Item', '“Woolworths”'],
           ['Vault', 'Personal'],
           ['Username', K.value('sam@example.com')],
           ['Website', K.value('woolworths.com.au')],
           ['Last used', '3 days ago'],
         ])}
         <span class="faint" style="font-size:11px">Valet has not copied anything yet. You choose the login in the next step, and can pick another item there.</span>
         <div class="row"><span class="grow"></span>${K.btn('Open in 1Password')}</div>`,
      ),
    }),
    notes: [
      [
        1080,
        340,
        'Names the item the way 1Password does, with the username as a value, never the password (P3).',
      ],
      [1080, 520, 'Says nothing was copied yet: choosing is the next step (P2 M3).'],
    ],
  })

  // Login: 1Password locked
  FRAMES.push({
    id: 'setup-login-locked',
    group: 'Setup',
    title: 'Your login: 1Password is locked',
    personas: ['P2', 'P7'],
    desc: 'Valet needs 1Password unlocked to list items and make the copy. It says so, opens 1Password, and checks again when Valet regains focus. Earlier steps are untouched.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: sub(1, 2),
      body:
        loginHead +
        K.card(
          '',
          `${K.health('warn', '<b>1Password is locked.</b> Unlock it to see your Woolworths logins. Valet checks again when you come back.', K.primary('Unlock 1Password'))}
           <div class="col" style="gap:10px;padding-top:4px">${K.lines(2)}</div>`,
        ) +
        `<div class="faint" style="font-size:11.5px">Once Valet has its Keychain copy, calls work while 1Password is locked. Only choosing and re-syncing need it unlocked.</div>`,
      foot: nav(
        K.btn('Back'),
        `${K.ghost('Skip for now')}${off('Use this login')}<span class="faint" style="font-size:11px">Unlock 1Password first</span>`,
      ),
    }),
    notes: [
      [1100, 220, 'The only primary on the page is the fix. Valet re-checks on focus, so no Retry (P2).'],
      [
        700,
        330,
        'Says why locked matters only now, so Sam is not afraid of locking 1Password later (story: Keychain copy).',
      ],
      [880, 741, 'Use this login stays focusable while disabled and says why beside it (P5).'],
    ],
  })

  // Login: loading, then waiting for the OK in 1Password
  FRAMES.push({
    id: 'setup-login-waiting',
    group: 'Setup',
    title: 'Your login: loading items, then waiting for the copy',
    personas: ['P2', 'P5'],
    desc: 'Two moments in one frame. While Valet lists items, the list shows placeholder rows. After "Use this login", 1Password asks Sam to approve the one-time copy; the step waits for it and says what it is copying.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: { ...sub(1, 2), 3: 'Waiting for 1Password' },
      body:
        loginHead +
        `<div class="grid2">
          ${K.card('Loading (the first second)', `<div class="col" style="gap:12px">${K.lines(3)}<span class="faint" style="font-size:11px">Looking in your Personal vault…</span></div>`)}
          ${K.card('After Use this login', `<div class="col" style="gap:8px">${K.health('info', "<b>Approve the copy in 1Password.</b> Valet copies “Woolworths” (sam@example.com) into this Mac's Keychain once.", K.btn('Show 1Password'))}<span class="faint" style="font-size:11px">If you decline, nothing is copied and you stay on this step.</span></div>`)}
        </div>`,
      foot: nav(K.btn('Back'), busy('Waiting for 1Password…')),
    }),
    notes: [
      [
        380,
        230,
        'Placeholder rows, not a spinner on an empty card; the layout does not jump when items arrive (layout audit).',
      ],
      [960, 230, 'Names the item and username being copied, never the password (P3).'],
      [880, 741, 'Progress stays on the same button; Back still works (P5).'],
    ],
  })

  // Login: no matching item
  FRAMES.push({
    id: 'setup-login-none',
    group: 'Setup',
    title: 'Your login: no Woolworths login in 1Password',
    personas: ['P2'],
    desc: 'No item in the Personal vault has woolworths.com.au. Three ways on: look in all vaults, type the password once, or skip (waits in Needs you as "Give Valet your Woolworths login").',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: sub(1, 2),
      body:
        loginHead +
        K.card(
          '',
          `${K.health('warn', '<b>No login for woolworths.com.au in your Personal vault.</b> Checked at 8:13 pm.', K.ghost('Check again'))}
           <div class="col" style="gap:10px;padding-top:6px">
             ${K.radio('<b>Choose another item…</b> <span class="muted">· search every vault Valet can see</span>', true)}
             ${K.radio('<b>Type your Woolworths password once</b> <span class="muted">· kept in this Mac\'s Keychain</span>')}
             ${K.radio('<b>Skip for now</b> <span class="muted">· Claude can\'t use Woolworths until you choose; it waits in Needs you</span>')}
           </div>`,
        ),
      foot: nav(K.btn('Back'), lg('Choose another item…', 'primary')),
    }),
    notes: [
      [
        1100,
        220,
        'Says where Valet looked and when, so Sam knows to save the login in 1Password or pick another vault.',
      ],
      [1100, 330, 'The skip wording is the Needs you title word for word (story words).'],
    ],
  })

  // "Choose another item…" sheet (G8)
  FRAMES.push({
    id: 'setup-choose-item',
    group: 'Setup',
    title: 'Your login: "Choose another item…"',
    personas: ['P2', 'P3', 'P5'],
    desc: 'Opens a sheet over the login step: search every vault Valet can see. An item saved for another site says so. Cancel or Esc returns to the step with focus on the link.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: sub(1, 2),
      body: loginHead + K.card('', K.lines(4)),
      foot: nav(K.btn('Back'), lg('Use this login', 'primary')),
      over: scrimSheet(
        'Choose a 1Password item',
        `${K.search('Search 1Password')}
         <div class="col" style="gap:10px">
           ${K.radio('<b>Woolworths</b> <span class="muted">· sam@example.com · Personal</span>', true)} 
           ${K.radio('<b>Woolworths (old)</b> <span class="muted">· sam.old@example.com · Personal</span>')}
           <div class="row" style="gap:8px">${K.radio('<b>Everyday Rewards</b> <span class="muted">· sam@example.com · Shared</span>')}<span class="grow"></span>${K.badge('Another site', 'warn')}</div>
         </div>
         <span class="faint" style="font-size:11px">“Everyday Rewards” is saved for woolworthsrewards.com.au. Valet types a login only on auth.woolworths.com.au, so check it's the same account.</span>`,
        `<span class="grow"></span>${K.btn('Cancel')}${K.primary('Use “Woolworths”')}`,
      ),
    }),
    notes: [
      [790, 160, 'Same search and the same "Another site" warning as the grant sheet (one component, P3).'],
      [700, 305, 'The primary names the chosen item; Return chooses it, Esc cancels (P5).'],
    ],
  })

  // Store: searching, none, site error
  FRAMES.push({
    id: 'setup-store-states',
    group: 'Setup',
    title: 'Your store: searching, no stores, site error',
    personas: ['P2', 'P6'],
    desc: 'Three states of the same results card. Searching keeps the field and shows placeholder rows. No stores says what was searched and suggests a suburb. A Woolworths error says it is Woolworths, not Sam, and Skip stays safe.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3),
      body:
        h('Which Woolworths do you shop at?', "Prices and what's in stock depend on the store.") +
        `<div class="row">${K.input('2000', '260px')}<span class="wf-btn" aria-disabled="true">◌ Finding stores…</span></div>` +
        K.card('Searching', K.lines(3)) +
        K.card(
          'No stores',
          `${K.health('idle', '<b>Woolworths found no stores for “2999”.</b> Try a suburb name or a nearby postcode.', '')}`,
        ) +
        K.card(
          'Woolworths error',
          `${K.health('warn', "<b>Woolworths didn't answer the store search.</b> It may be busy. Valet tried at 8:13 pm.", K.btn('Try again'))}<span class="faint" style="font-size:11px">Skipping is fine: Woolworths uses its default store until you choose one on the Woolworths page.</span>`,
        ),
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${off('Shop at a store')}`),
    }),
    notes: [
      [700, 200, 'The button shows progress and the field keeps its text (P2).'],
      [
        700,
        360,
        'No stores and the error are told apart: one is the search, the other is Woolworths (P6 vocabulary: site-changed vs limiting).',
      ],
    ],
  })

  // Connect: config write failed, restart failed
  FRAMES.push({
    id: 'setup-connect-failed',
    group: 'Setup',
    title: 'Connect Claude: Valet could not add itself, or restart failed',
    personas: ['P2', 'P1'],
    desc: 'Two failures on the Claude Desktop card. If writing its settings fails, Valet says which file and offers to copy the settings to paste by hand. If the restart fails, it asks Sam to quit and reopen Claude Desktop and checks again.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4),
      body:
        h('Which Claude do you use?', 'Valet found Claude Desktop on this Mac.') +
        K.card(
          'Claude Desktop · settings',
          `${K.health('bad', "<b>Valet couldn't add itself to Claude Desktop.</b> Its settings file can't be changed.", K.primary('Try again'))}
           <div class="row" style="gap:8px">${K.value('~/Library/Application Support/Claude/claude_desktop_config.json')}</div>
           <span class="faint" style="font-size:11.5px">Or add Valet by hand: ${K.link('Copy the settings to paste')} · ${K.link('Show the file in Finder')}</span>`,
          K.badge('Not added', 'bad'),
        ) +
        K.card(
          'Claude Desktop · restart',
          `${K.health('warn', "<b>Claude Desktop didn't restart.</b> Quit it (Claude › Quit) and open it again. Valet checks when it's back.", K.btn('Open Claude Desktop'))}`,
          K.badge('Added', 'ok'),
        ),
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${off('Continue')}`),
    }),
    notes: [
      [
        1100,
        220,
        'Names the file as a selectable value and offers the manual way, so P1 can fix it and Sam can ask for help.',
      ],
      [1100, 400, 'Restart failure gives the exact menu words and re-checks by itself (P2).'],
    ],
  })

  // "See every request it may make" (G8): a page inside setup with a way back
  FRAMES.push({
    id: 'setup-approve-requests',
    group: 'Setup',
    title: 'Approve Woolworths: every request it may make',
    personas: ['P3', 'P2', 'P4'],
    desc: 'The link on the Approve step opens the full first-install review as a page inside the setup window, not the main window. The breadcrumb and "Back to setup" return to the Approve step with focus on the link.',
    html: setup({
      states: ['d', 'd', 'c'],
      subs: sub(1),
      body:
        `<div class="wf-crumbs"><span>Set up Valet</span><i>›</i><span>Approve Woolworths</span><i>›</i><span>Every request</span></div>` +
        h(
          'Every request Woolworths 0.3.0 may make',
          'Valet blocks anything not on this list and shows it in Calls.',
        ) +
        K.table(
          ['Request', 'Web address', 'Used by', 'Does'],
          [
            [K.value('GET /api/v3/ui/trolley'), 'woolworths.com.au', 'Get cart', K.badge('Reads', 'read')],
            [
              K.value('POST /api/v3/ui/trolley/update'),
              'woolworths.com.au',
              'Add, change, remove',
              K.badge('Changes cart', 'write'),
            ],
            [
              K.value('GET /apis/ui/Search/products'),
              'woolworths.com.au',
              'Search products',
              K.badge('Reads', 'read'),
            ],
            [
              K.value('GET /apis/ui/StoreLocator/Stores'),
              'woolworths.com.au',
              'Shop at your store',
              K.badge('Reads', 'read'),
            ],
            [K.value('POST /login'), 'auth.woolworths.com.au', 'Logging in', K.badge('Login', 'secret')],
          ],
          { cols: '1.6fr 1.2fr 1fr .8fr' },
        ) +
        `<div class="faint" style="font-size:11.5px">The same list is on the Woolworths page under Permissions after setup.</div>`,
      foot: nav(K.btn('‹ Back to setup'), `${lg('Approve Woolworths', 'primary')}`),
    }),
    notes: [
      [
        386,
        99,
        'A breadcrumb back to the step; Esc and ⌘[ do the same (G8). The rail stays, so Sam is never lost.',
      ],
      [700, 330, 'Requests are values; the "Does" column is the same risk badges as Permissions (P3, P4).'],
      [940, 741, 'Approve is offered here too, so reading the list is not a detour (P3).'],
    ],
  })

  // "How to check" (G8)
  FRAMES.push({
    id: 'setup-test-how',
    group: 'Setup',
    title: 'Test it: "How to check"',
    personas: ['P2'],
    desc: 'The "How to check" link on the failed test opens a popover with the three clicks in Claude Desktop, in its own menu words, and what Sam should see.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'd', 'c'],
      subs: sub(1, 2, 3, 4, 5),
      body:
        h('Try it: ask Claude one question', 'Open Claude Desktop and ask:') +
        K.card(
          'No call from Claude yet',
          `${K.health('warn', "<b>Valet hasn't heard from Claude Desktop</b> since you added it at 8:15 pm. Waited 60 s.", K.ghost('Keep waiting'))}
           <div class="col" style="gap:8px">
            ${checkRow(true, 'Valet is ready: Woolworths approved, login and store chosen')}
            ${checkRow(null, 'Claude Desktop shows "valet" under Settings › Connectors', `<span class="wf-link" style="outline:2px solid var(--wf-act);outline-offset:2px">How to check</span>`)}
           </div>`,
          K.badge('Waiting', 'warn'),
        ),
      foot: nav(K.btn('Back'), `${K.ghost('Skip the test')}${off('Continue')}`),
      over: pop(
        690,
        300,
        380,
        `<b>Check Claude Desktop has Valet</b>
         <div class="col" style="gap:4px">
           <span>1. In Claude Desktop, open <b>Settings</b> (⌘,).</span>
           <span>2. Choose <b>Connectors</b>.</span>
           <span>3. Look for <b>valet</b> with a green dot.</span>
         </div>
         <span class="faint" style="font-size:11px">Not there? Restart Claude Desktop. Red dot? ${K.link('Copy the details for help')}</span>
         <div class="row"><span class="grow"></span>${K.btn('Open Claude Desktop')}</div>`,
      ),
    }),
    notes: [[1080, 320, "Steps in Claude Desktop's own words, and the one thing to look for (P2)."]],
  })
})()
