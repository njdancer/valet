# Round 1 test: P2, Sam (first-time non-technical installer)

Simulated persona test, 2026-11-11, following `protocol-round1.md`. These answers stay consistent
with `interviews/P2-sam.md`. Researcher notes are marked **R:**. Everything else is Sam speaking.

Confidence: **sure**, **unsure**, **lost**. Some tasks are ones I'd never do myself. I'd ask Nick.
For those I still say where I'd look if I were made to.

## Part 1. Tree test

**R:** Order effect: Sam learned the trees as they went. By IA-C they knew calls were "somewhere
under a what-happened section" and that Connections and Secrets existed. That flatters IA-C a bit on
T3, T6, T8 and T10.

| Task                                           | IA-A                                                                                  | IA-B                                                   | IA-C                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| T1 Approve Woolworths 0.4.0                    | Needs you (**sure**). Second guess: Sites > Woolworths > Versions                     | Needs you (**sure**)                                   | Home (**sure**: "it's the thing waiting for me")                     |
| T2 Why last get_cart failed                    | Activity > Calls (**unsure**: "get_cart" means nothing to me; I'd look for "trolley") | Calls (**unsure**; "Calls" sounds like phone calls)    | History > Calls (**sure**: "something went wrong earlier = history") |
| T3 Revoke Claude Code _(I wouldn't)_           | Connections (**unsure**)                                                              | Connections (**unsure**)                               | Access > Connections (**unsure**, one more click)                    |
| T4 Remote access _(I wouldn't)_                | Connections > Remote access settings (**unsure**). Second guess: Settings             | Connections (**unsure**)                               | Access > Connections (**lost** at first; I tried Settings)           |
| T5 Change the store                            | Sites > Woolworths > Overview (**sure**)                                              | same (**sure**)                                        | Sites > Woolworths (**sure**)                                        |
| T6 Calls that used the password _(I wouldn't)_ | Secrets > Grants (**lost**); second guess Activity                                    | Secrets (**lost**)                                     | Access > Secrets (**unsure**)                                        |
| T7 Audit log tampering _(I wouldn't)_          | Activity > Audit log (**unsure**: what's an audit log?)                               | Audit log (**sure**, only because it's the only match) | History > Audit log (**unsure**)                                     |
| T8 SMS codes from Messages                     | Settings (**unsure**), then Secrets > One-time codes                                  | Settings, then Secrets (**unsure**)                    | Access > Secrets (**unsure**)                                        |
| T9 Woolworths blocking, until when             | Sites > Woolworths (**sure**)                                                         | same (**sure**)                                        | Home: each site's health is there (**sure**, one click)              |
| T10 What Claude Desktop can call               | Connections > Apps on this Mac (**unsure**)                                           | same (**unsure**)                                      | Access > Connections (**unsure**)                                    |
| T11 How long traces are kept                   | Settings > Data and privacy (**unsure**: what's a trace?)                             | same                                                   | same                                                                 |
| T12 Cloud agent waiting with a code            | Needs you (**sure**, _if_ it's there)                                                 | Needs you                                              | Home                                                                 |

My counts: IA-A 4 sure, 7 unsure, 1 lost. IA-B 5 sure, 6 unsure, 1 lost (helped by learning). IA-C 6
sure, 5 unsure, 1 lost.

**My winner: IA-C**, with two changes. "Home" is what I want to see first, and "History" is a word I
use. But "Access" is a bad box: I'd never think my 1Password logins live under "Access", and
"Secrets" sounds like something I'm hiding. I'd split Access back into **Connected apps** and
**Passwords**, which gives me what I sketched in my interview:
Home · Sites · History · Connected apps · Passwords · Settings.

IA-B is the worst for me. Two top-level things ("Calls", "Audit log") for stuff I never look at
pushes my things down the list.

## Part 2. Label preference

- **Sites**, not Adapters. Woolworths is a website. An adapter is a plug.
- **Connected apps**, then Connections. Not Clients: a client is a customer. "Connected apps" tells
  me Claude Desktop goes there.
- **Passwords**, then Credentials. Not Secrets. "Secrets" sounds sneaky, and I'd worry Valet has its
  own secrets from me. Passwords is the word 1Password uses. (I know one-time codes aren't quite
  passwords. "Passwords and codes" is fine.)
- **History**, not Activity. Activity sounds like it's happening now. History is what happened.
- **Needs you**, not Inbox or Waiting. "Needs you" tells me it's _me_ it needs. Inbox sounds like
  messages and Waiting sounds like _it_ is busy.

## Part 3. Hypothesis feedback

**E1, accept.** A real button that says "Review update" is what I looked for in the interview. I'd
have found the review with **E1**, not E1b. With E1b I'd still have to guess that a coloured
lozenge with a tiny arrow is a button. Everything else in the app is a coloured lozenge. Change:
the button says what happens, like "Review update", not "Open" or "Details".

**E2, refine.** Links are fine, but please don't make every host name and hash blue. A page full of
blue text is a page full of things I might accidentally click. Make links for things I'd want
(Woolworths, Claude Desktop, a call), and leave the technical ones plain, in Details.

**E3, accept.** I only noticed text selection when a double-click turned a pill blue. Labels that
can't be selected feel like an app. A copy button on the address is nicer than selecting it.

**E4, accept.** "Claude Code can't call any tool until you add it again" is exactly what I want to
read before a scary button. Keep the dialog short, and make the safe choice the big one.

**E5, accept, refine.** "1:42 left, until 9:50 pm" is good. Also say what happens at zero: "If you
don't answer, nothing is removed." A countdown with no ending reads like a bomb.

**E6, accept, my favourite.** "Woolworths is limiting us, calls resume at 9:52 pm" fixes my
"open means closed" confusion. Change: also say whether I should do anything ("Nothing to do").

**E7, refine.** Fine for Nick. For me, clicking "12 blocked requests" and landing on red rows makes
it worse. If a number opens a list, the list needs a first line saying whether that's normal.

**E8, accept.** Yes, as long as "Details" really is folded away by default and the plain line comes
first everywhere, including the confirmation window and setup.

**E9, accept.** I won't notice headings, but I noticed the clipped Needs you list and the half-empty
windows. "Nothing is clipped" matters to me.

**E10, accept.** One "Pause Valet" I can always find is the button I'd hit when nervous. Show
clearly when it's paused, with the same word in Claude: "Paused (Resume in Valet)".

**E11, accept.** On day one I had orange badges on Adapters and on Remote sign-in and thought two
things were broken. A badge should mean "you need to do this", nothing else.

**P1, accept.** A Needs you page is the centre of the app for me. Change: each item gets one
sentence and one button in my words ("Log in to Woolworths", "Remove bananas?"). A "Missed" section
is good if it says what happened ("Nothing was removed").

**P2, accept, refine.** One page per site, yes. Five tabs is a lot. I'd only use Overview. Put the
store, the login, "Open my trolley" and "what it can and can't do" on Overview, and make the update
banner obvious there. Name the Permissions tab something like "What it can do".

**P3, accept.** A review that stays in the window with a Back is less alarming than a new window
popping up. For the first install, the "summary first" is essential: "It can search and change your
trolley. It can't pay or check out." Then Approve. Reject should not be red and level with Approve.

**P4, neutral.** Not mine. As long as History's Calls list reads in sentences, like today's
Activity list does, I'm fine.

**P5, accept.** One place for the Claude apps. Change: call it Connected apps, put Claude Desktop
first, and give each app a "Test it" button that tells me it's working.

**P6, refine.** One page is right, but name it Passwords, and lead with "Where your logins come
from: 1Password ✓". The grant list with calls that used it is Nick's business; put it lower down.

**P7, accept.** Settings on its own, with Cmd-comma, like every Mac app. The Clients/Settings
mash-up was confusing.

**P8, pick P8b (Home).** When I open Valet I want one page that answers "is it working and does it
need me": Needs you on top, then "Woolworths: Ready". P8a changes the first page depending on state,
and I'd think I was in a different app each time. P8c drops me on a list of sites and hides what
needs me behind a number. Change: if nothing is waiting, Home says "Nothing needs you" in words,
not just an empty space.

**P9, accept, strongly.** This is my biggest ask. The test at the end ("Ask Claude: what's in my
Woolworths trolley?") with a tick when Claude's first call arrives is the "done" I wanted. Skipped
steps turning into Needs you items is much better than blank pages. Also fix the 1Password step: a
"Connect 1Password" button, not an account-name box.

**P10, accept.** "Remove Cavendish Bananas from your trolley?" with "Remove" and "Don't remove" is
perfect. Don't put "Not verified by Valet" over that sentence. Put it in small print under the
buttons if it has to be said, and say it kindly ("Woolworths' plug-in wrote this description").

**P11, accept.** Needs you first, scrolling, then "Woolworths: Ready" rows I can click. Change:
rename "Check out on woolworths.com.au" to "Open my trolley on woolworths.com.au". I won't click
anything that sounds like it pays.

**Vocabulary table, accept with tweaks.**

- "Log in to Woolworths", "Choose your Woolworths store", "Needs you": all good.
- "Confirm: Remove Cavendish Bananas": good, but drop "Confirm:". The question itself is enough.
- "Connect your Woolworths login": good, better than any "grant".
- "Review the Woolworths update (0.4.0)": OK. I'd drop the number or put it last.
- "Approve a connection (code ABCD-1234)": I'd want "Only approve if you just started this" right
  next to it.
- "Woolworths is limiting requests; calls resume at 9:52 pm": add "Nothing to do".

## Part 4. What the hypotheses missed

My biggest worry if all of this shipped: **money**. Nothing in the hypotheses says, in one place I
always see, that Valet never pays and never checks out. I'd want that sentence on Home, on the
first-install review and in the confirmation window: "Valet can't pay. Checkout is always you, on
woolworths.com.au."

Smaller gaps:

- **The 1Password step in setup** isn't covered by any hypothesis, and it's where I'd get stuck
  first without Nick.
- **Which Claude do I have?** Setup should ask, or detect it, instead of showing Claude Code first.
- **Undoing my mistakes.** If I click Reject on the first install, or skip a step, how do I get
  back? "Run setup again" sounds like starting over. P9's Needs you items help, but a "Finish
  setup (2 steps left)" item on Home would be clearer.
- **Notifications.** E5 and P1 cover the in-app list, but my first contact is a Mac notification.
  It should use the same sentence as the Needs you item and open that exact item.
