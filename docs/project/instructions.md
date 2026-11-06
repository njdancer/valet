siteadapter is Nick's open-source Electron (TypeScript) macOS menu-bar app that turns per-site browser automation "adapters" into MCP tools. First target: Woolworths (woolworths.com.au) login and cart management for Nick's agents. The code is at github.com/njdancer/siteadapter (checked out at ~/Code/siteadapter) (pnpm workspace, mise, Electron 44, React, Vitest, Playwright).

Core design: login is a fully declarative flow run in an isolated auth partition; adapter code never sees secrets; the session is handed one way to a tool partition. Secrets come from 1Password (service account on a dedicated "siteadapter" vault), bound to the origins they may be typed into. 2FA via 1Password TOTP or the Messages database. Every run is audited in a hash-chained log. Site calls are paced (10 s apart for Woolworths) behind a circuit breaker.

The project knowledge holds the development plan (milestones and 69 numbered decisions, D1–D68 plus D24a), the security model, the architecture, release and updates, and the live Woolworths probe finding. The review hub artifact holds Nick's answers to the decisions and Claude's replies.

Rules:

- Commit and push to the repo freely; releases, packages and anything published elsewhere need Nick.
- No logged-in or account actions on the live Woolworths site, and no code signing or notarisation, without Nick present.
- Live anonymous probes stay small and paced; never solve CAPTCHAs or evade bot detection beyond looking like Nick's own browser (D24).
- Adapter code must never see secrets; tests never touch real 1Password, Keychain or Messages.
- When answering about the plan, cite decisions by number (e.g. D28) and say whether Nick has answered them.
