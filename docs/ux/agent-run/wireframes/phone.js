// Phone kit for the agent-run wireframes. P.phone() draws an iPhone screen; P.card() the approval
// card from docs/ux/agent-run/approval-cards.md, in its anatomy order. Mac frames use the v3 kit.
/* eslint-disable */
;(() => {
  const { K } = window.WF
  const TABS = ['Needs you', 'Activity', 'Sites', 'Agents', 'Valet']
  const tabbar = (active, badge) =>
    `<div class="tabbar">${TABS.map(
      (t) =>
        `<span class="${t === active ? 'on' : ''}"><i></i>${t}${t === 'Needs you' && badge ? `<em>${badge}</em>` : ''}</span>`,
    ).join('')}</div>`
  const sbar = (time = '7:40') =>
    `<div class="sbar"><span>${time}</span><span class="island"></span><span>▮▮▮ ◔</span></div>`
  const nbar = ({ title, large = true, back = '', right = '' }) =>
    `<div class="nbar"><div class="ntop">${back ? `<span>‹ ${back}</span>` : '<span></span>'}<b>${large ? '' : title || ''}</b><span>${right}</span></div>${large && title ? `<h1>${title}</h1>` : ''}</div>`

  const P = {
    /** A tab screen. opts: tab, badge, title, large, back, right, time, over (overlay html). */
    screen: (content, o = {}) =>
      `<div class="wf-phone">${sbar(o.time)}${nbar(o)}<div class="content">${content}</div>${o.tab === false ? '' : tabbar(o.tab || 'Needs you', o.badge === undefined ? 2 : o.badge)}<span class="home"></span>${o.over || ''}</div>`,
    /** A page sheet over the tabs (cards, pairing): grabber, its own top bar, sticky actions. */
    sheet: (content, o = {}) =>
      `<div class="wf-phone sheet">${sbar(o.time)}<div class="sheetbody"><div class="grabber"></div>${nbar({ title: o.title || '', large: false, back: o.back || '', right: o.right || '' })}<div class="content">${content}</div>${o.actions ? `<div class="ph-actions">${o.actions}</div>` : ''}</div><span class="home"></span>${o.over || ''}</div>`,
    lock: (content, o = {}) =>
      `<div class="wf-phone lock">${sbar(o.time)}<div class="ph-clock">${o.clock || '7:40'}</div><div class="ph-date">${o.date || 'Thursday 19 November'}</div><div class="content" style="margin-top:28px">${content}</div><span class="home"></span>${o.over || ''}</div>`,
    btn: (label, kind = '') => `<span class="ph-btn ${kind}">${label}</span>`,
    group: (head, rows, foot = '') =>
      `<div class="ph-group">${head ? `<div class="h">${head}</div>` : ''}<div class="ph-list">${rows.join('')}</div>${foot ? `<div class="f">${foot}</div>` : ''}</div>`,
    row: (main, sub = '', right = '<span class="chev">›</span>', cls = '') =>
      `<div class="ph-row ${cls}"><div class="grow">${main}${sub ? `<small>${sub}</small>` : ''}</div>${right}</div>`,
    pill: (t) => `<span class="ph-pill">${t}</span>`,
    host: (sub, reg) => `<span class="ph-host">${sub}<b>${reg}</b></span>`,
    banner: (tone, html) => `<div class="ph-banner ${tone}">${html}</div>`,
    state: (tone, html) => `<div class="ph-state ${tone}">${html}</div>`,
    faceid: (label = 'Face ID') => `<div class="ph-scrim"></div><div class="ph-faceid"><i></i>${label}</div>`,
    alert: (title, body, buttons) =>
      `<div class="ph-scrim"></div><div class="ph-alert"><div class="b"><h3>${title}</h3><div>${body}</div></div><div class="btns">${buttons.map(([t, c]) => `<span class="${c || ''}">${t}</span>`).join('')}</div></div>`,
    notif: (title, body, meta = 'now') =>
      `<div class="ph-notif"><span class="app"></span><div><div class="meta"><span>VALET</span><span>${meta}</span></div><b>${title}</b><span>${body}</span></div></div>`,
    /** Inbox row on the phone's Needs you. */
    item: (kind, title, sub, right = '<span class="chev">›</span>') =>
      `<div class="ph-row"><span class="wf-kind">${kind}</span><div class="grow"><b style="font-weight:600">${title}</b><small>${sub}</small></div>${right}</div>`,
    /**
     * The approval card, in anatomy order (approval-cards.md section 2). c: kind, ref, age, title,
     * asked, where, risk [tone, word, text], rows [[marker, cls, text]], checks [], follow [[label,on]],
     * words, agent, details (bool), footer.
     */
    card: (c) => {
      const risk = c.risk
        ? `<div class="ph-risk ${c.risk[0]}"><b>${c.risk[1]}</b><span>${c.risk[2]}</span></div>`
        : ''
      const rows = c.rows
        ? `<div class="ph-sec">What changes</div><div class="ph-rows">${c.rows.map(([m, cls, t]) => `<div><b class="${cls}">${m}</b><span>${t}</span></div>`).join('')}</div>${c.more ? `<span class="wf-link" style="font-size:14px">${c.more}</span>` : ''}`
        : ''
      const checks = c.checks
        ? `<div class="ph-sec">Checks Valet ran</div>${c.checks.map((x) => `<div style="font-size:14px">${x}</div>`).join('')}`
        : ''
      const because = c.because
        ? `<div class="ph-rows"><div><b class="${c.because[0] || 'same'}">Because</b><span>${c.because[1]}</span></div></div>`
        : ''
      const tests = c.tests ? `<div style="font-size:13.5px;color:var(--wf-ink-2)">${c.tests}</div>` : ''
      const ack = c.ack
        ? `<div style="font-size:14px">${K.check("I've read what this does", c.ack === 'on')}</div>`
        : ''
      const follow = c.follow
        ? `<div class="ph-sec">Also asked</div>${c.follow.map(([l, on]) => `<div style="font-size:14px">${K.check(l, on)}</div>`).join('')}`
        : ''
      const words = c.words
        ? `<div class="ph-sec">In ${c.agent || 'Claude app'}'s words</div><div class="ph-words">"${c.words}"</div>`
        : ''
      const details =
        c.details === false
          ? ''
          : `<div class="ph-sec">Details</div>${P.group(
              '',
              (c.detailRows || ['See code changes', 'References it read', 'Fingerprint and request']).map(
                (r) => P.row(r),
              ),
            )}`
      return `<div class="ph-card"><div class="ph-kind"><span class="k">${c.kind}</span><span>${c.ref ? `approval ${c.ref}` : ''}</span><span class="grow"></span><span>${c.age || ''}</span></div>
        <h2 class="ph-title">${c.title}</h2>
        <div class="ph-asked">${c.asked || 'Asked by <b>Claude app</b> · 7:38 pm'} ${P.pill(c.where || 'Through the relay')}</div>
        ${risk}${c.extra || ''}${rows}${because}${checks}${tests}${follow}${words}${ack}</div>${details}${c.after || ''}
        <div style="font-size:12.5px;color:var(--wf-ink-3);padding:0 4px">${c.footer || "Expires Fri 20 Nov, 7:38 pm if nobody answers. Only you can approve this. Claude can't approve its own requests."}</div>`
    },
    approveBar: (label = 'Approve with Face ID', opts = {}) =>
      `<div class="row">${P.btn('Decline')}${P.btn(label, `primary ${opts.off ? 'off' : ''}`)}</div>${opts.note ? `<small>${opts.note}</small>` : ''}`,
  }
  window.WF.P = P
})()
