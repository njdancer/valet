# Woolworths shopping-site terms on automated access (for D25)

Read 2026-11-07, about 15:20 UTC, for [D25](../plan.md#d25-adapter-legal-posture) (whether the
project can publish adapters for sites whose terms prohibit automated access). Nothing here is
legal advice. D25's recommendation, a short Australian legal opinion before M8, stands.

## How it was read

- Page: `https://www.woolworths.com.au/shop/services/terms-and-conditions`, loaded anonymously
  three times through a web-fetch tool on Anthropic's infrastructure, not from Nick's IP and not
  from this repo's code. The container's own proxy refused a direct `curl` to the site.
- The page shows no "last updated" date. Its front-end build identifier was `20261103.1`.
- The fetch tool only returns quotes of up to 125 characters, so two long sub-clauses below are
  put together from two quoted halves (marked). Check them by eye on the page before relying on
  the exact wording.

## The clauses that matter

**1.4(b), "Your obligations"**, opens with "You must not:" and lists fifteen items. The relevant ones:

- **(viii)** "use any robot, spider, site search and retrieval application or other mechanism to
  retrieve or index any portion of the Site;" _(two quoted halves)_
- **(vi)** "tamper with or hinder the operation of the Site;"
- **(ix)** "modify, reformat, adapt or reverse engineer any portion of the Site;"
- **(xi)** "create accounts by automated means or under false or fraudulent pretences;"
- **(xiii)** "take any action that imposes or that would, in our reasonable opinion, result in an
  unreasonable or disproportionately large load on our infrastructure" _(two quoted halves)_
- **(xiv)** "use the Site other than in accordance with these terms and conditions; or"
- **(xv)** "attempt any of the above acts or engage or permit another person to do any of the
  above acts."

**Accounts and whoever uses them:**

- **1.3(b)** "You may not have more than one active account, and your account is
  non-transferable." It also says there may be no more than two accounts per delivery address.
- **1.3(d)** "You must ensure that your LoginID and password that is used to access the Site" and
  "the details of your account are kept in a safe and secure manner."
- **1.4(a)(iv)** You "are responsible and liable for any person that uses your LoginID and
  password to order Product(s) through the Site;"
- **1.4(b)(iv)** "use another person's details without their permission or impersonate another
  person when using the Site;"

**Personal use.** There is no general "personal, non-commercial use only" clause. The nearest are:

- **3.2(b)** "You are not permitted to purchase any items for resale to a third party or for trade
  purposes."
- **5.2(b)(ii)**, which lets you print content for "the sole purpose of viewing and purchasing
  Products but not for any other use, including commercial use."
- **5.2(a)(iii)**: you "must not modify, copy, adapt, store in a retrieval system, reproduce" site
  material without consent.

**Agents and AI.** The terms don't mention software agents, assistants or third-party tools
ordering or using the site for a customer. **1.10** ("AI features") is about Woolworths' own AI
features: it says some content may come from "agentic, generative or other forms of AI", and
1.10(07) says you must not try to "manipulate, 'break' or 'trick'" them. Neither covers a
customer's own tools.

**Robots.txt** was not read. The queue allowed one page load, and this read already took three.

## What this means for D25 (not legal advice)

- **The shopping site has its own clause, so the corporate site's doesn't need to stand in.** The
  shopping site's 1.4(b)(viii) uses nearly the same words as the Woolworths Group corporate site's
  1.3(b)(v) ("any robot, spider, site search and retrieval application or other mechanism"). The
  corporate clause only governs `woolworthsgroup.com.au`, but the shopping site now has its own
  clause numbered 1.4(b)(viii). registry-and-sandbox.md's _verify_ note can point at that clause.
- **Read plainly, 1.4(b)(viii) covers what Valet does.** "Other mechanism to retrieve … any
  portion of the Site" is wide, and there's no exception for a customer automating their own
  account. Whether "retrieve or index" means bulk collection or crawling, rather than one person's
  cart and searches at human pace, is the question for the legal opinion.
- **(xv) reaches the customer's tools too.** "permit another person to do any of the above"
  doesn't excuse the customer when software acts for them, and 1.4(a)(iv) makes them liable for
  anyone using their login.
- **(xiii) is the clause Valet's design already answers.** The pacing (10 s between calls), the
  per-site budget and the circuit breaker exist so that use never comes near an "unreasonable or
  disproportionately large load". The per-client remote cap adds to that.
- **(xi) and 1.3(b) rule out anything that creates accounts or shares them.** Valet does neither:
  one person, their own existing account.
- For publishing (M8, [D26](../plan.md#d26-where-the-woolworths-adapter-lives-at-release)), this
  supports the plan's default: keep the Woolworths adapter out of the framework's repository, ship
  only a fake-site reference adapter there, and say plainly in the adapter's README that the
  site's terms prohibit automated retrieval and that using it is the person's own decision.
