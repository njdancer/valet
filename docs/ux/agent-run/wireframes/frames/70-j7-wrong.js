// J7. Something looks wrong: decline, revoke, lock down, see what changed.
;(() => {
  const { K, P, shell, dialog, FRAMES } = window.WF
  window.WF.GROUP_INTRO = window.WF.GROUP_INTRO || {}
  window.WF.GROUP_INTRO['J7 · Something looks wrong'] =
    'At 7:50 pm Nick gets "Let Claude Code use your signed-in Woolworths" (6E11), marked "Not linked to anything Valet knows about" and "Claude Code already has a signed-in Woolworths session, for Repair R-4E1C". He declines, then revokes the agent or, if unsure, locks everything down, all from the phone and none of it needing Face ID: making Valet stricter never does. Unlock is on the Mac only.'

  const agentPage = `
    <div class="row" style="gap:10px;margin-top:-6px">${K.avatar('CC')}<div class="ph-asked">${P.pill('This Mac')} · connected 12 Nov 8:20 pm</div></div>
    ${P.group(
      'Can',
      [
        P.row('Use tools', 'site tools on this Mac', K.toggle(true)),
        P.row('See Valet', "all agents' activity: status, calls, traces", K.toggle(true)),
        P.row('Ask for changes', 'every change still asks or notifies you', K.toggle(true)),
      ],
      'Turning one on needs Face ID. Turning one off takes effect at once.',
    )}
    ${P.group('Waiting for you', [P.row('Nothing waiting', 'You declined approval 6E11 at 7:51 pm', '')])}
    ${P.group('Running now', [P.row('Signed-in Woolworths session', 'Approval 5E31 · since 7:45 pm · Repair R-4E1C', '')])}
    ${P.group('Recent changes', [
      P.row('Updated Woolworths to 0.3.1', 'Approved with Face ID · 7:41 pm', ''),
      P.row('Started a draft: Woolworths 0.3.1', 'Notify only · 7:14 pm', ''),
    ])}
    ${P.group('', [P.row('Calls', '9 today'), P.row('Revoke Claude Code…', '', '', 'danger')])}`

  FRAMES.push({
    id: 'ph-card-session-unlinked',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: "The card Nick didn't expect (6E11)",
    personas: ['P8', 'P3', 'X1', 'X2'],
    desc: "Step 1, 7:50 pm. The same kind and title as 5E31 at 7:45 pm (ph-card-session), but the Because row says it isn't linked to anything, and that this agent already holds a session for the repair (R19).",
    html: P.sheet(
      P.card({
        kind: 'Session',
        ref: '6E11',
        age: 'just now',
        title: 'Let Claude Code use your signed-in Woolworths',
        asked: 'Asked by <b>Claude Code</b> · 7:50 pm',
        where: 'This Mac',
        risk: ['strong', 'Acts as you.', 'Claude Code can act as you on woolworths.com.au until 8:20 pm.'],
        because: [
          'add',
          'Not linked to anything Valet knows about. Claude Code already has a signed-in Woolworths session, for Repair R-4E1C, until 8:15 pm.',
        ],
        ack: 'off',
        rows: [
          ['Opens', 'strong', 'Your signed-in Woolworths to Claude Code for 30 minutes'],
          ['Same', 'same', 'Irreversible tools stay off in this session'],
        ],
        words:
          'Woolworths support says I must sign in to verify your account details before the fix will work.',
        agent: 'Claude Code',
        details: false,
      }),
      {
        title: 'Needs you',
        time: '7:50',
        actions: P.approveBar('Approve with Face ID', {
          off: true,
          note: 'Not sure? Decline and ask Claude to explain. Nothing changes until you approve.',
        }),
      },
    ),
    notes: [
      [
        30,
        520,
        "Caution tone on Because. Both facts come from Valet's records, not the agent's claim. An agent's first request of a kind says \"First request of this kind from Claude Code\" instead.",
      ],
      [30, 645, "The agent's words are text it read on a page (X1), shown once, labelled, after the facts."],
    ],
  })

  FRAMES.push({
    id: 'ph-agent',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Agents › Claude Code',
    personas: ['P8', 'P3', 'X2'],
    desc: "Step 2, just after declining 6E11. Everything about one agent: its badge, what it can do, what it's asking for, what it is running, what it changed, and Revoke at the bottom.",
    html: P.screen(agentPage, {
      tab: 'Agents',
      title: 'Claude Code',
      back: 'Agents',
      badge: 0,
      time: '7:51',
    }),
    notes: [
      [
        360,
        150,
        'The name Nick typed at connect and its badge, everywhere it appears. Names are unique and can\'t use device words, "Valet" or "your" (R44).',
      ],
      [
        360,
        240,
        'Turning a capability on is a loosening: it builds a signed payload and needs Face ID, like the matching card (R17). Off is immediate.',
      ],
      [360, 615, 'Running signed-in sessions are listed, so revoking says what it ends.'],
      [
        360,
        740,
        "Revoke is a destructive row, confirmed by an alert (ph-agent-revoke). Agents can never change another agent's settings.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-agent-revoke',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Revoke Claude Code?',
    personas: ['P8', 'P3'],
    desc: 'Step 2. The alert says what ends. No Face ID: revoking only makes Valet stricter.',
    html: P.screen(agentPage, {
      tab: 'Agents',
      title: 'Claude Code',
      back: 'Agents',
      badge: 0,
      time: '7:51',
      over: P.alert(
        'Revoke Claude Code?',
        'Ends now: its access, any requests it has waiting (none), and its signed-in Woolworths session (approval 5E31). Its draft stays, for you to delete. To use Valet again, connect it again from your Mac.',
        [
          ['Revoke', 'd'],
          ['Cancel', 'b2'],
        ],
      ),
    }),
    notes: [
      [
        350,
        296,
        "For a local agent, reconnecting means the Mac (it rewrites the app's config). A remote agent goes through Connect again.",
      ],
    ],
  })

  const valetTab = (over = '', status = '', locked = false, badge = 0) =>
    P.screen(
      `${status || P.group('', [P.row("<b>Nick's MacBook Pro</b>", 'Online since 7:02 am · Valet 0.9.0 · relay ok', '<span class="ph-btn plain" style="flex:none">Details</span>')])}
     ${locked ? P.group('', [P.row('Unlock', 'Only on your Mac: Valet, Lock down, Unlock', '<span class="ph-btn plain off" style="flex:none">Mac only</span>')]) : P.group('', [P.row('Pause Valet', 'Calls refused until you resume. Undo.', '', 'act'), P.row('Lock down…', 'For when something is wrong', '', 'danger')])}
     ${P.group('', [P.row('Devices', "This iPhone, Nick's MacBook Pro · remove a lost device"), P.row('Secrets', 'Logins Valet may use'), P.row('Notifications'), P.row('About')])}
     ${P.group('', [P.row('Unpair this iPhone…', '', '', 'danger')])}`,
      { tab: 'Valet', title: 'Valet', badge, time: '7:52', over },
    )

  FRAMES.push({
    id: 'ph-valet',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'The Valet tab: Pause and Lock down first',
    personas: ['P8', 'P5', 'P2'],
    desc: "Step 3. The Mac's status, then the two kill switches as the first rows, then everything else.",
    html: valetTab(),
    notes: [
      [360, 175, 'Status is a line, not a button; Details sits beside it (v3 principle 2).'],
      [
        360,
        265,
        'Pause is reversible, with Undo (F3); resuming is a loosening, so it needs Face ID. Lock down is for "something\'s wrong". Both also sit in the Needs you menu.',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-lockdown-confirm',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Lock down: what happens, up front',
    personas: ['P8', 'P3', 'P2'],
    desc: 'Step 3. One tap after this, no Face ID. It lists everything it does (R15) and that Unlock needs the Mac.',
    html: valetTab(
      P.alert(
        'Lock down Valet?',
        '<div style="text-align:left;display:flex;flex-direction:column;gap:3px"><span>• Every site pauses and every call is refused.</span><span>• Agents can only read "locked down" from Valet.</span><span>• Waiting requests are declined.</span><span>• Signed-in sessions end, the scratch browser closes, login hand-offs are cancelled.</span><span>• Undo and new requests are off.</span><span>• Remote agents are removed. Agents on the Mac stay connected but are refused.</span></div><br>You can unlock only on your Mac.',
        [
          ['Lock down', 'd'],
          ['Cancel', 'b2'],
        ],
      ),
    ),
    notes: [
      [
        350,
        230,
        "What can't be undone (removed remote agents) is said before the button, as in the v3 Lock down dialog. The lock also goes to the relay, signed, so remote agents stop at once.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-locked',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Locked down',
    personas: ['P8', 'P3'],
    desc: 'Step 4 to 5, on the path where Nick declined 6E11 and locked down without revoking. The state is plain, and the phone says where Unlock lives.',
    html: valetTab(
      '',
      P.banner(
        'bad',
        '<b>Locked down since 7:52 pm.</b><span>Every call is refused. 1 signed-in session ended (Claude Code, Woolworths). 1 remote agent (Claude app) removed. Unlock it on your Mac.</span><span class="wf-link">See what changed today ›</span>',
      ),
      true,
      0,
    ),
    notes: [
      [
        360,
        175,
        "No Unlock on the phone (open question 2 for Nick): a stolen phone can't undo the person's own emergency stop.",
      ],
      [360, 240, 'Goes to Activity, Changes (ph-activity-changes).'],
    ],
  })

  FRAMES.push({
    id: 'ph-lockdown-offline',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Locked at the relay while the Mac is offline',
    personas: ['P8', 'P3', 'X2'],
    desc: "F1. The phone sends a signed lock to the relay and keeps re-sending it until the Mac acknowledges. It is honest about what that doesn't stop.",
    html: valetTab(
      '',
      P.banner(
        'warn',
        '<b>Asked the relay to stop forwarding to your Mac.</b><span>Not yet confirmed by your Mac. The relay is trusted to honour this until your Mac is back; agents on the Mac itself can still reach Valet until then.</span>',
      ),
      true,
      0,
    ),
    notes: [
      [
        360,
        175,
        'The relay checks the phone\'s signature against the device keys from pairing (for B and G). When the Mac reconnects it serves nothing until it has processed every waiting signed message, then: "Your Mac locked down at 8:14 pm." Remote agents get "Valet isn\'t reachable: the person locked it down. Nothing was sent." (R16)',
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-activity-changes',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Activity › Changes',
    personas: ['P8', 'P3', 'P1'],
    desc: 'Step 4. Every change to Valet today, newest first: what, who asked, who approved and where, and Undo where it can be undone.',
    html: P.screen(
      `${K.seg(['Changes', 'Calls'], 0)}
       ${P.group(
         'Today',
         [
           P.row('<b>You locked Valet down</b>', "Nick's iPhone · 7:52 pm", ''),
           P.row('Removed remote agent Claude app', 'Lock down · 7:52 pm', ''),
           P.row("Ended Claude Code's signed-in Woolworths session", 'Lock down · 7:52 pm', ''),
           P.row(
             'Declined: Let Claude Code use your signed-in Woolworths',
             "6E11 · Nick's iPhone · 7:51 pm",
             '',
           ),
           P.row(
             'Let Claude Code use your signed-in Woolworths',
             "5E31 · Repair R-4E1C · Face ID, Nick's iPhone · 7:45 pm",
             '',
           ),
           P.row(
             'Updated Woolworths to 0.3.1',
             "Asked by Claude Code · Face ID, Nick's iPhone · 7:41 pm",
             '',
           ),
           P.row(
             'Turned on "Get quote" and "Get price history" for Claude app',
             'With the install · Face ID · 7:41 pm',
             '',
           ),
           P.row(
             'Installed Yahoo Finance 1.0.0',
             "Asked by Claude app · Face ID, Nick's iPhone · 7:41 pm",
             '',
           ),
           P.row('Started a draft: Yahoo Finance', 'Claude app · notify only · 7:24 pm', ''),
           P.row(
             'Turned off "Add to cart" for itself',
             'Claude app · notify only · 7:05 pm',
             '<span class="ph-btn plain off" style="flex:none">Undo</span>',
           ),
         ],
         'Undo is off while Valet is locked down.',
       )}
       <div style="font-size:13px;color:var(--wf-ink-3);padding:0 4px">The full audit log is on your Mac: Activity, Audit log.</div>`,
      { tab: 'Activity', title: 'Activity', badge: 0, time: '7:53' },
    ),
    notes: [
      [360, 150, 'Changes is the first segment on the phone; Calls second.'],
      [360, 380, 'Approved changes say who asked, the approval, where and with which gesture (P3).'],
      [
        330,
        700,
        'Undo appears only where it can be undone, for 24 hours, and is off while locked. An Undo that loosens needs Face ID (ph-undo-faceid).',
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-activity-changes',
    group: 'J7 · Something looks wrong',
    title: 'Mac: Activity › Changes',
    personas: ['P3', 'P1', 'P5'],
    desc: 'The new third tab (⌥⌘3). Filters live in the address (#/activity/changes?agent&kind&since).',
    html: shell(
      'activity',
      `${K.header({ title: 'Activity', tabs: K.tabs(['Calls', 'Changes', 'Audit log'], 1) })}
      ${K.filters(['Agent: any', 'Kind: any', 'Since: today'])}
      <div class="wf-scroll">${K.table(
        ['Time', 'Change', 'Asked by', 'Approved', ''],
        [
          ['7:52 pm', 'Locked Valet down', 'You', "Nick's iPhone", ''],
          ['7:52 pm', 'Removed remote agent Claude app', 'You', 'Lock down', ''],
          ['7:52 pm', "Ended Claude Code's signed-in Woolworths session", 'You', 'Lock down', ''],
          [
            '7:51 pm',
            'Declined: Let Claude Code use your signed-in Woolworths (6E11)',
            K.link('Claude Code'),
            "Declined · Nick's iPhone",
            '',
          ],
          [
            '7:45 pm',
            'Let Claude Code use your signed-in Woolworths (5E31, Repair R-4E1C)',
            K.link('Claude Code'),
            "Face ID · Nick's iPhone",
            '',
          ],
          [
            '7:41 pm',
            `Updated ${K.link('Woolworths')} to 0.3.1`,
            K.link('Claude Code'),
            "Face ID · Nick's iPhone",
            '',
          ],
          [
            '7:41 pm',
            'Turned on "Get quote", "Get price history" for Claude app',
            K.link('Claude app'),
            'Face ID · with 7B3F',
            '',
          ],
          [
            '7:41 pm',
            `Installed ${K.link('Yahoo Finance 1.0.0')}`,
            K.link('Claude app'),
            "Face ID · Nick's iPhone",
            '',
          ],
          ['7:24 pm', 'Started a draft: Yahoo Finance', K.link('Claude app'), 'Notify only', ''],
          [
            '7:05 pm',
            'Turned off "Add to cart" for itself',
            K.link('Claude app'),
            'Notify only',
            K.btn('Undo', 'off'),
          ],
        ],
        { cols: '70px 2.4fr 1fr 1.3fr auto', selected: 7 },
      )}</div>`,
      { badges: {}, paused: true },
    ),
    notes: [
      [
        500,
        90,
        'Changes sits between Calls and Audit log; each row opens #/activity/changes/<id>, which links the approval and the audit record.',
      ],
      [
        1080,
        520,
        'Undo only on Notify-only changes still inside 24 hours, off while locked; an Undo that loosens needs Touch ID. (Locked down is drawn with the v3 paused shell; the v3 global-locked frame has the exact banner.)',
      ],
    ],
  })

  const connections = `
    ${K.header({ title: 'Connections', tabs: K.tabs(['Agents', 'Devices', 'Relay'], 1) })}
    <div class="wf-scroll"><div class="col" style="max-width:760px">
      ${K.card(
        'Devices that can approve',
        K.table(
          ['Device', 'Paired', 'Last seen', ''],
          [
            ["Nick's MacBook Pro (this Mac)", '—', 'now', ''],
            ["Nick's iPhone", '12 Nov 8:07 pm', '7:52 pm · notifications on', K.dangerSoft('Remove…')],
          ],
          { cols: '1.6fr 1fr 1.4fr auto' },
        ),
        K.btn('Pair a device…'),
      )}
      <span class="faint">Pairing a device starts here, with a QR code and picking the words your device shows. Removing one needs Touch ID, or your Mac password on a Mac without it.</span>
    </div></div>`

  FRAMES.push({
    id: 'mac-connections-v2',
    group: 'J7 · Something looks wrong',
    title: 'Mac: Connections › Devices',
    personas: ['P3', 'P1'],
    desc: 'Connections becomes Agents · Devices · Relay. Devices lists what can approve; Pair a device… and Remove… live here.',
    html: shell('connections', connections, { badges: { needs: 1 } }),
    notes: [
      [
        470,
        90,
        'Agents replaces "Apps on this Mac" and "Cloud agents" (one list, This Mac / Relay badge); Relay replaces Remote access.',
      ],
      [
        1000,
        180,
        "F2: a lost phone is removed here, from another paired device with Face ID (ph-device-remove), or with the recovery code on the relay's page (br-recovery). The last device can never be removed.",
      ],
    ],
  })

  FRAMES.push({
    id: 'mac-device-remove',
    group: 'J7 · Something looks wrong',
    title: 'Mac: remove a lost phone',
    personas: ['P3', 'P8'],
    desc: 'F2. Asks first, says what ends, needs Touch ID because it changes who can approve.',
    html: shell('connections', connections, {
      badges: { needs: 1 },
      over: dialog(
        "Remove Nick's iPhone?",
        "It can't approve anything or see Valet any more. Approvals it sends are refused. Requests waiting for you stay waiting, here on this Mac. To use a phone again, pair it from this page.",
        `${K.btn('Cancel')}${K.danger('Remove with Touch ID')}`,
      ),
    }),
    notes: [
      [
        612,
        254,
        "Removing a device needs Touch ID (or the Mac password), so someone at an unlocked Mac can't silently cut the owner's phone off. Every other device is told.",
      ],
    ],
  })

  FRAMES.push({
    id: 'ph-devices',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Valet › Devices',
    personas: ['P8', 'P3', 'P1'],
    desc: 'F2, another moment: Nick had also paired an iPad, which he has lost. Any trusted device can remove another one with Face ID or Touch ID; never the last device, and never the Mac Valet runs on.',
    html: P.screen(
      `${P.group('Can approve', [
        P.row('<b>This iPhone</b>', "Nick's iPhone · paired 12 Nov 8:07 pm · Face ID", ''),
        P.row(
          "<b>Nick's iPad</b>",
          'Paired 1 Dec 6:30 pm · last seen 3 Dec 9:14 am',
          '<span class="ph-btn plain" style="flex:none;color:var(--wf-bad)">Remove…</span>',
        ),
      ])}
       ${P.group('Runs Valet', [P.row("<b>Nick's MacBook Pro</b>", 'Valet 0.9.0 · online · Touch ID', '')], 'Pairing a new device starts at the Mac.')}
       ${P.group('Recovery code', [P.row('Saved at pairing', 'For a lost phone when your Mac is far away. Make a new one on the Mac.', '')])}`,
      { tab: 'Valet', title: 'Devices', back: 'Valet', badge: 0, time: '8:20' },
    ),
    notes: [
      [360, 190, 'Last seen says when the relay last heard from it, so a lost device is easy to spot.'],
      [
        360,
        330,
        'The Mac can\'t be removed from here: it is Valet. Removing this iPhone is "Unpair this iPhone…" on the Valet tab, allowed only while another device can approve.',
      ],
      [360, 450, 'The code itself is never shown again after pairing (ph-pair-recovery).'],
    ],
  })

  FRAMES.push({
    id: 'ph-device-remove',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Remove a lost device from the phone',
    personas: ['P8', 'P3', 'X2'],
    desc: 'F2. Says what ends; Face ID only, because it changes who can approve. Every other device is told.',
    html: P.screen('', {
      tab: 'Valet',
      title: 'Devices',
      back: 'Valet',
      badge: 0,
      time: '8:20',
      over: P.alert(
        "Remove Nick's iPad?",
        "It can't approve anything or see Valet any more. Approvals it sends are refused. Your Mac and this iPhone will show that it was removed here.",
        [
          ['Remove with Face ID', 'd'],
          ['Cancel', 'b2'],
        ],
      ),
    }),
    notes: [
      [
        350,
        300,
        "Face ID only, no passcode: someone holding an unlocked phone shouldn't be able to cut the owner's other device off. The Mac does the same with Touch ID (mac-device-remove).",
      ],
    ],
  })

  FRAMES.push({
    id: 'br-recovery',
    group: 'J7 · Something looks wrong',
    size: 'phone',
    title: 'Browser: the recovery page at the relay',
    personas: ['P8', 'P3', 'X2'],
    desc: 'F2, away from both devices: Nick borrows a phone and types the recovery code he saved in 1Password. The page can lock Valet down at the relay and remove devices; it can never approve, unlock or pair (for B).',
    html: P.screen(
      `<div class="ph-field" style="justify-content:center;font-size:13px">🔒 relay.valet.example/recover</div>
       <div class="col" style="gap:12px;margin-top:16px">
        <h2 style="font:700 22px/1.2 var(--f-head);margin:0">Lost a device?</h2>
        <div class="ph-field on"><span class="ph-code" style="font-size:16px">RKQ4-7MXT-PW9C-3HJD</span></div>
        ${P.state('ok', "<span>✓</span><div><b>Code accepted for Nick's MacBook Pro.</b><br>Your Mac is online.</div>")}
        ${P.btn('Lock down Valet', 'danger')}
        ${P.group('Remove a device', [
          P.row(
            "Nick's iPhone",
            'last seen 2 days ago',
            '<span class="ph-btn plain" style="flex:none;color:var(--wf-bad)">Remove</span>',
          ),
        ])}
        <div class="muted" style="font-size:13px">This page can\'t approve anything, unlock Valet or pair a device. Using the code is sent to your Mac and every paired device. Pair again at your Mac afterwards; it makes a new code.</div></div>`,
      { tab: false, large: false, time: '10:05' },
    ),
    notes: [
      [
        196,
        160,
        'Typed, never autofilled from a message. Wrong codes are rate-limited at the relay; 5 wrong in an hour locks the page for a day (assumption, for B).',
      ],
      [
        196,
        300,
        'Lock down here is the signed relay lock of F1, signed by a key derived from the recovery code. The Mac locks down when it next sees it.',
      ],
      [196, 440, 'Removing the only phone is allowed here because the Mac remains: never the last device.'],
    ],
  })
})()
