// Setup: first run, re-entrant (P9, P2's walkthrough S8, P5's acceptance criteria).
;(function () {
  const { K, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['Setup'] =
    'Setup takes the whole window: a step list on the left, one step on the right in a column of fixed width whose heading never moves between steps, Back and Continue in the same place on every step. It ends with a real test call. A skipped step is never a dead end: it says why it waits and offers the fix, and whatever is left becomes one "Finish setup" item in Needs you.'

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
  const setup = ({ states, subs, body, foot }) =>
    `<div class="wf-window">
      <div class="wf-titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="grow" style="text-align:center;color:var(--wf-ink-2)">Set up Valet</span><span style="width:60px"></span></div>
      <div class="wf-body">
        <aside class="wf-side" style="width:240px;padding:16px 10px;gap:2px">
          <div class="grp" style="padding-top:0">Set up Valet · about 5 minutes</div>
          ${rail(states, subs)}
          <div class="grow"></div>
          <div class="foot" style="flex-direction:column;align-items:flex-start;gap:2px">Valet never pays.<span class="faint">Checkout is always you, on woolworths.com.au.</span></div>
        </aside>
        <main class="wf-main">
          <div class="wf-scroll" style="padding:48px 44px 24px;gap:16px"><div class="col" style="gap:16px;max-width:820px;width:100%;margin:0 auto">${body}</div></div>
          <div class="sticky-foot" style="padding:12px 44px">${foot}</div>
        </main>
      </div></div>`
  const h = (title, lede) =>
    `<div class="col" style="gap:6px"><h2 style="font:600 24px/1.2 var(--f-head);margin:0">${title}</h2>${lede ? `<p class="muted" style="margin:0;font-size:13px;max-width:620px">${lede}</p>` : ''}</div>`
  const nav = (left, right) => `${left}<span class="grow"></span>${right}`
  const lg = (label, kind = '') => `<span class="wf-btn lg ${kind}">${label}</span>`
  const checkRow = (ok, text, extra = '') =>
    `<div class="row" style="gap:10px"><span style="width:18px;text-align:center;font-weight:700;color:var(--wf-${ok === true ? 'ok' : ok === false ? 'bad' : 'ink-3'})">${ok === true ? '✓' : ok === false ? '✕' : '○'}</span><span class="grow">${text}</span>${extra}</div>`

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
          ${K.card('', '<b>1. You ask Claude</b><span class="muted">"Add milk and bread to my trolley."</span>')}
          ${K.card('', '<b>2. Valet does it on woolworths.com.au</b><span class="muted">Logged in as you, with your 1Password login. Only on Woolworths.</span>')}
          ${K.card('', '<b>3. You check and pay</b><span class="muted">Removing things asks you first. Paying is always you.</span>')}
        </div>` +
        `<div class="wf-banner ok"><div class="grow"><b>Valet never pays.</b> It can't check out or use your card. Checkout is always you, on woolworths.com.au.</div></div>` +
        `<div class="h3">What you'll need</div>
         <div class="col" style="gap:6px">
          ${checkRow(null, 'Your Woolworths email and password, ideally in 1Password')}
          ${checkRow(null, 'Claude Desktop or Claude Code on this Mac')}
          ${checkRow(null, 'About 5 minutes. You can stop and come back: Valet remembers where you were.')}
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
        'What you\'ll need and how long, which Sam expected first (P2 S8). "Finish later" becomes a Needs you item, not a skipped setup.',
      ],
      [
        168,
        103,
        'The step list is a list of links (P5): done and current steps can be revisited; blocked ones say why (see the blocked frame).',
      ],
    ],
  })

  // 2. 1Password, connected
  FRAMES.push({
    id: 'setup-1password',
    group: 'Setup',
    title: '1Password, connected and checked',
    personas: ['P2', 'P1'],
    desc: 'One button that opens 1Password and asks for Touch ID, then a check Valet runs itself and shows line by line.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Where passwords come from' },
      body:
        h(
          'Where your Woolworths password comes from',
          "Valet asks 1Password for your login each time it needs to log in. It doesn't keep a copy unless you choose to.",
        ) +
        K.card(
          '1Password',
          `${K.health('ok', '<b>Connected to 1Password.</b> Checked at 9:41 pm.', K.ghost('Check again'))}
           <div class="col" style="gap:6px;padding:4px 2px">
             ${checkRow(true, '1Password 8 is installed and unlocked')}
             ${checkRow(true, '"Integrate with other apps" is on')}
             ${checkRow(true, 'Valet can see 1 login for woolworths.com.au', K.link('Which one?'))}
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
        'Today this step is an empty "account name" box Sam can\'t fill (P2 S8, blocker). Now: one "Connect 1Password" button, then this result.',
      ],
      [990, 247, 'Every status says when it was checked and can be re-checked (principle 8).'],
      [
        688,
        334,
        'The check proves the next step will work: Valet already found a Woolworths login, so "Your login" won\'t be empty.',
      ],
      [
        473,
        395,
        "Alternatives stay folded once 1Password works, so Sam isn't asked to compare four providers (today's grant sheet opens on three radios).",
      ],
    ],
  })

  // 3. 1Password, problem + alternatives
  FRAMES.push({
    id: 'setup-1password-problem',
    group: 'Setup',
    title: '1Password, check failed, with the fix and the alternatives',
    personas: ['P2', 'P3'],
    desc: 'The check says exactly which part failed, opens the right 1Password screen, and re-checks by itself when Valet regains focus.',
    html: setup({
      states: ['d', 'c'],
      subs: { 1: 'Where passwords come from' },
      body:
        h(
          'Where your Woolworths password comes from',
          'Valet asks 1Password for your login each time it needs to log in.',
        ) +
        K.card(
          '1Password',
          `${K.health('bad', '<b>Valet can\'t reach 1Password yet.</b> "Integrate with other apps" is off. Checked at 9:41 pm.', K.ghost('Check again'))}
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
            ${K.radio('<b>Keep a copy in this Mac\'s Keychain</b> <span class="muted">· type your Woolworths password once; works while 1Password is locked</span>')}
            ${K.radio('<b>1Password service account</b> <span class="muted">· for a vault called "Valet"; set up at 1password.com</span>')}
            ${K.radio('<b>Skip for now</b> <span class="muted">· Valet asks for your login the first time Claude needs it</span>')}
          </div>`,
        ),
      foot: nav(
        K.btn('Back'),
        `<span class="faint" style="font-size:11px">Connect 1Password or pick another way to continue</span>${lg('Continue', 'primary" style="opacity:.45')}`,
      ),
    }),
    notes: [
      [
        551,
        229,
        'The failure names the one setting that is off, in 1Password\'s own words (P2: "I\'ve never opened Developer settings").',
      ],
      [
        1119,
        301,
        "The fix is a button that opens 1Password at that screen (assumption: 1Password's settings deep link); Valet re-checks on focus.",
      ],
      [
        1135,
        412,
        'Alternatives in plain words with the trade-off stated; Skip is honest about what happens later (P3 wants the trade-off visible).',
      ],
      [745, 742, 'Continue stays focusable while disabled and says why next to it (P5).'],
    ],
  })

  // 4. Approve Woolworths
  FRAMES.push({
    id: 'setup-approve',
    group: 'Setup',
    title: 'Approve Woolworths, summary first, Approve here',
    personas: ['P2', 'P3', 'P4'],
    desc: 'The plain-words review with the Approve button on the same screen. The full review is one link away for those who want it.',
    html: setup({
      states: ['d', 'd', 'c'],
      subs: { 1: 'Connected' },
      body:
        h(
          'Let Claude use Woolworths?',
          "This is what Valet's Woolworths adapter can do once you approve it. You can turn any of it off later on the Woolworths page.",
        ) +
        `<div class="grid2">
          ${K.card(
            'Claude will be able to',
            `<div class="col" style="gap:6px">
            ${checkRow(true, 'Search products and see prices')}
            ${checkRow(true, "See what's in your trolley")}
            ${checkRow(true, 'Add and change items in your trolley')}
            ${checkRow(true, 'Remove items, <b>after you confirm each time</b>')}
            ${checkRow(true, 'Choose your store')}</div>`,
          )}
          ${K.card(
            "It can't",
            `<div class="col" style="gap:6px">
            ${checkRow(false, 'Pay, check out or use your card')}
            ${checkRow(false, 'Visit any site except woolworths.com.au')}
            ${checkRow(false, 'Type your password anywhere but auth.woolworths.com.au')}
            ${checkRow(false, 'See your other 1Password items')}</div>`,
          )}
        </div>` +
        `<div class="row muted" style="gap:10px;font-size:11.5px">Woolworths adapter 0.3.0 · comes with Valet · ${K.value('9f3c1a7e…e0f1')} <span class="grow"></span>${K.link('See every request it may make')}</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Not now')}${lg('Approve Woolworths', 'primary')}`),
    }),
    notes: [
      [
        1135,
        99,
        'The question Sam expected, as the heading (P2 S8: "Allow Claude to use Woolworths? It can search and change your trolley. It can\'t pay.").',
      ],
      [
        1105,
        172,
        "Can / can't in plain words: the grant sheet's best idea, moved up to the first approval (P2). Confirmed removals are said here.",
      ],
      [
        942,
        363,
        'The full review page (hosts, paths, secrets) is a link for P3 and P4, never a second screen Sam must pass through.',
      ],
      [
        1150,
        720,
        'Approve is on this screen (today it sits on a second screen, P2 near-blocker). "Not now" has no red and leaves later steps explaining why they wait.',
      ],
    ],
  })

  // 5. Login
  FRAMES.push({
    id: 'setup-login',
    group: 'Setup',
    title: 'Your login: choose the 1Password item',
    personas: ['P2', 'P3'],
    desc: 'Valet lists the 1Password items that match woolworths.com.au; the best match is chosen. What Valet may and may not do with it sits beside the choice.',
    html: setup({
      states: ['d', 'd', 'd', 'c'],
      subs: { 1: 'Connected', 2: 'Approved 0.3.0' },
      body:
        h(
          'Which Woolworths login should Valet use?',
          'These are the logins in your 1Password for woolworths.com.au.',
        ) +
        `<div class="grid2" style="grid-template-columns:minmax(0,1fr) 300px">
          ${K.card(
            '',
            `<div class="col" style="gap:12px">
            ${K.radio('<b>Woolworths</b> <span class="muted">· sam@example.com · Personal vault · used 3 days ago</span>', true)}
            ${K.radio('<b>Woolworths (old)</b> <span class="muted">· sam.old@example.com · Personal vault · 2023</span>')}
            <div class="row" style="gap:8px;border-top:1px solid var(--wf-line);padding-top:10px">${K.link('Choose another item…')}<span class="faint">·</span>${K.link('Type it instead (kept in Keychain)')}</div></div>`,
          )}
          ${K.card(
            'What Valet does with it',
            `<div class="col" style="gap:6px">
            ${checkRow(true, 'Types it only on auth.woolworths.com.au')}
            ${checkRow(true, 'Asks 1Password each time')}
            ${checkRow(false, 'Never shows it to Claude')}
            ${checkRow(false, 'Never uses it on another site')}</div>`,
          )}
        </div>` +
        K.card(
          'Codes Woolworths texts you',
          `<div class="row" style="gap:10px"><span class="grow muted">Woolworths sometimes asks for a code sent to your phone. Valet can read it from Messages, or ask you to type it.</span>${K.btn('Read codes from Messages…')}${K.radio("I'll type them", true)}</div>`,
        ),
      foot: nav(K.btn('Back'), lg('Use this login', 'primary')),
    }),
    notes: [
      [1135, 99, 'The step title says "login", never "grant" (vocabulary: "Never in the UI: grant", P2).'],
      [
        741,
        174,
        'Found for her, best match first, with the details that tell two items apart (email, vault, last used).',
      ],
      [
        1120,
        336,
        "Can / can't beside the choice, in the same words as the Approve step and the grant sheet (one source).",
      ],
      [
        819,
        379,
        "One-time codes asked about here, so the code hand-off later isn't a surprise; the default is the no-permission option.",
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
      subs: { 1: 'Connected', 2: 'Approved 0.3.0', 3: 'Woolworths (sam@…)' },
      body:
        h(
          'Which Woolworths do you shop at?',
          "Prices and what's in stock depend on the store. Woolworths delivers or you pick up from here.",
        ) +
        `<div class="row">${K.input('2000', '260px')}${K.btn('Find stores')}</div>` +
        K.card(
          '',
          `<div class="col" style="gap:12px">
            ${K.radio('<b>Town Hall</b> <span class="muted">· 464-480 Kent St, Sydney · 0.4 km</span>', true)}
            ${K.radio('<b>Metcentre</b> <span class="muted">· 273 George St, Sydney · 0.9 km</span>')}
            ${K.radio('<b>Broadway</b> <span class="muted">· Bay St, Glebe · 2.1 km</span>')}
          </div>`,
        ) +
        `<div class="faint" style="font-size:11.5px">Found by Woolworths at 9:44 pm. You can change it any time on the Woolworths page.</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${lg('Shop at Town Hall', 'primary')}`),
    }),
    notes: [
      [1135, 99, 'No "Woolworths\'s", no "tools" (P2 S8 minor): one question and one field.'],
      [
        687,
        167,
        'Results come from Woolworths through Valet (find_stores), so this step needs Approve first; see the blocked frame.',
      ],
      [
        969,
        742,
        'The primary button names the result ("Shop at Town Hall"), the same words as the tool title "Shop at your store".',
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
          <span class="faint" style="font-size:11.5px">Skipped steps wait in Needs you as "Finish setup", and on the Woolworths page as "Approve Woolworths". Nothing is lost.</span>
        </div></div>` +
        K.card(
          "Meanwhile, what you've done",
          `<div class="col" style="gap:6px">${checkRow(true, '1Password connected, 1 Woolworths login found')}${checkRow(null, "Woolworths not approved: Claude can't use it yet")}</div>`,
        ),
      foot: nav(
        K.btn('Back'),
        `<span class="faint" style="font-size:11px">Approve Woolworths or skip this step to continue</span>${lg('Continue', 'primary" style="opacity:.45')}`,
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
        240,
        'Skipping again is allowed and says exactly where the step will wait (P9, P5: same wording in Needs you).',
      ],
    ],
  })

  // 8. Connect Claude
  FRAMES.push({
    id: 'setup-connect',
    group: 'Setup',
    title: 'Connect Claude',
    personas: ['P2', 'P1', 'P4'],
    desc: 'Valet looks for each Claude on this Mac and puts the one it finds first. Claude Desktop is one click; Claude Code is one command to copy.',
    html: setup({
      states: ['d', 'd', 'd', 'd', 'd', 'c'],
      subs: { 1: 'Connected', 2: 'Approved 0.3.0', 3: 'Woolworths (sam@…)', 4: 'Town Hall' },
      body:
        h('Which Claude do you use?', 'Valet found Claude Desktop on this Mac. You can connect both.') +
        `<div class="grid2">
          ${K.card(
            'Claude Desktop',
            `
            ${K.health('ok', '<b>Added.</b> Restart Claude Desktop to finish.', K.primary('Restart Claude Desktop'))}
            <span class="faint" style="font-size:11.5px">Valet added itself to Claude Desktop's settings. Claude Desktop shows "valet" under Connectors after the restart.</span>`,
            K.badge('Found on this Mac', 'ok'),
          )}
          ${K.card(
            'Claude Code',
            `
            <span class="muted">Run this once in Terminal:</span>
            <div class="wf-value" style="display:block;white-space:pre;padding:8px;line-height:1.5">claude mcp add valet -- \\
  /Applications/Valet.app/Contents/MacOS/valet-bridge \\
  '~/Library/Application Support/valet/client-configs/…json'</div>
            <div class="row">${K.btn('Copy command')}<span class="faint" style="font-size:11.5px">Shows "Connected" here after its first call.</span></div>`,
            K.badge('Not found', 'idle'),
          )}
        </div>` +
        `<div class="faint" style="font-size:11.5px">Using Claude in a browser or on your phone? ${K.link('Set up remote access')} later, from Connections.</div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip for now')}${lg('Continue', 'primary')}`),
    }),
    notes: [
      [
        1135,
        99,
        'Asks which Claude, and answers it by detecting (P2: "Which Claude do I have?"). The found one is first.',
      ],
      [
        691,
        232,
        'One click: Valet writes the config, then one Restart button. Today it is two near-identical buttons, a JSON snippet and "Quit and reopen" (P2 S8).',
      ],
      [570, 174, 'Badges say what Valet found; the actions are the buttons beside them (E1).'],
      [
        682,
        372,
        'Remote access is a pointer, not a step; Sam said "cloud agents" sounds like something she shouldn\'t turn on (P2 card sort).',
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
      subs: {
        1: 'Connected',
        2: 'Approved 0.3.0',
        3: 'Woolworths (sam@…)',
        4: 'Town Hall',
        5: 'Claude Desktop',
      },
      body:
        h('Try it: ask Claude one question', 'Open Claude Desktop and ask:') +
        `<div class="row" style="gap:10px"><div style="flex:1;font:500 18px/1.3 var(--f-head);padding:14px 16px;border:1px solid var(--wf-line-2);border-radius:10px;background:var(--wf-paper-2)">"What's in my Woolworths trolley?"</div>${K.btn('Copy')}${K.primary('Open Claude Desktop')}</div>` +
        K.card(
          "Watching for Claude's call",
          `<div class="col" style="gap:8px">
            ${checkRow(true, '<span class="mono faint">9:53:02 pm</span> Claude Desktop connected')}
            ${checkRow(true, '<span class="mono faint">9:53:05 pm</span> Claude asked for <b>Get cart</b> on Woolworths')}
            ${checkRow(true, '<span class="mono faint">9:53:06 pm</span> Logged in to Woolworths with your 1Password login')}
            ${checkRow(true, '<span class="mono faint">9:53:09 pm</span> Sent your trolley to Claude: 4 items', K.link('Open call 7F2A'))}
          </div>`,
          K.badge('Live', 'info'),
        ) +
        `<div class="wf-banner ok"><div class="grow"><b>It works.</b> Claude can now use Woolworths. Every call shows up like this in Activity.</div></div>`,
      foot: nav(K.btn('Back'), `${K.ghost('Skip the test')}${lg('Continue', 'primary')}`),
    }),
    notes: [
      [
        902,
        180,
        'The exact sentence to ask, copyable, and a button that opens the Claude found in the last step (P9, P2 "the done I wanted").',
      ],
      [489, 243, 'Each step appears as it happens, in a live region that announces each line once (P5).'],
      [
        1008,
        356,
        'The link opens the real call in Activity, so the evidence loop is visible on day one (P3).',
      ],
      [
        1135,
        413,
        'If nothing arrives in 60 s, this card says what to check (Restart Claude Desktop, the endpoint is on) instead of spinning (assumption).',
      ],
    ],
  })

  // 10. Done with skipped steps
  const finishItem = K.inbox(
    '↻',
    'Finish setup (2 steps left)',
    'Your store · Connect Claude',
    '',
    K.primary('Continue setup'),
  )
  FRAMES.push({
    id: 'setup-done',
    group: 'Setup',
    title: 'Done, with two steps skipped',
    personas: ['P2', 'P5', 'P7'],
    desc: 'Says what works now, lists what is left, and shows the exact Needs you item those steps became. Finishing opens Valet on Needs you (P8a).',
    html: setup({
      states: ['d', 'd', 'd', 'd', 's', 's', 's', 'c'],
      subs: { 1: 'Connected', 2: 'Approved 0.3.0', 3: 'Woolworths (sam@…)', 6: 'Needs Claude connected' },
      body:
        h(
          'Almost set up',
          'Woolworths is approved and has your login. Two steps are left before Claude can use it.',
        ) +
        K.card(
          '',
          `<div class="col" style="gap:8px">
            ${checkRow(true, '1Password connected')}
            ${checkRow(true, 'Woolworths approved (0.3.0)')}
            ${checkRow(true, 'Login: Woolworths (sam@example.com)')}
            ${checkRow(null, 'Your store · skipped', K.btn('Do it now'))}
            ${checkRow(null, 'Connect Claude · skipped', K.btn('Do it now'))}
          </div>`,
        ) +
        `<div class="h3">Waiting for you in Needs you and the menu bar</div>` +
        finishItem +
        `<div class="muted">Valet lives in the menu bar. Its icon shows a number when something needs you.</div>`,
      foot: nav('', lg('Open Valet', 'primary')),
    }),
    notes: [
      [183, 382, 'Skipped steps keep their place in the rail, so the list matches the Needs you item.'],
      [
        1135,
        99,
        'Honest heading: "Almost set up", not a tick, when Claude can\'t yet call (P2: done means Claude can use it).',
      ],
      [1019, 253, 'Each skipped step can be done from here without going back through the list.'],
      [
        981,
        393,
        'The exact item that appears in Needs you and the menu bar, same title and button (P9, P5 AC, Needs you table "Setup unfinished").',
      ],
    ],
  })
})()
