# Agent feedback

Agents that use Valet are its testers. When something breaks, contradicts its description or makes
them work around it, they report it to the Valet team themselves with `valet_send_feedback`, and
read the team's answers with `valet_get_feedback`. Before this, the agent wrote a report for the
person, and the person pasted it into a project chat.

Code: `packages/mcp-server/src/feedback.ts` (tools, wording, schemas, the `FeedbackDesk` port) and
`apps/desktop/src/main/core/feedback.ts` (the desk: scrubbing, limits, the GitHub calls, the
`feedback.json` store).

## What an agent gets

| Tool                  | What it does                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `valet_send_feedback` | Files a report (`kind` bug, question or idea; a title; a Markdown body; optionally the adapter, draft or call it is about). With `followUpOn: "fb-…"` it adds to an earlier report of the agent's instead: an answer to the team's question, or more it found.           |
| `valet_get_feedback`  | The agent's reports with their state (`saved` on the Mac, `open`, `closed`) and every reply, the ones it hasn't seen marked `new`. With an `id` and `waitSeconds` (up to 50) it waits for a new reply, looking again every 10 seconds, and returns as soon as one comes. |

Both are on every session that has Valet's own tools: any app on this Mac the person added (with
or without See Valet), and a cloud agent the person gave See Valet or Ask for changes. Locked down,
both refuse.

The server's instructions (sent to every client at initialize) tell the agent it is helping test
Valet and should report problems itself; the authoring guide has a "When something's wrong"
section that says the same for authoring.

## Where reports go

Each report becomes an issue on the team's GitHub repository, labelled `agent-feedback` and
`bug`, `question` or `enhancement`. The issue's text starts with a hidden marker and a table: the
kind, the agent (the person's name for it, and whether it is a cloud agent), Valet's version, and
the site, draft or call. A follow-up becomes a comment with the same marker.

- The repository is `njdancer/valet-feedback` unless `VALET_FEEDBACK_REPO=owner/name` is set
  when Valet starts (`DEFAULT_FEEDBACK_REPO` in `constants.ts`).
- The token is a Keychain item, service `valet`, account `github-feedback`, if the person added
  one; otherwise the token the person's own GitHub CLI is signed in with (`gh auth token`, from
  `/opt/homebrew/bin/gh` or `/usr/local/bin/gh`). Valet reads it for each GitHub call, puts it in
  the `Authorization` header, and nowhere else. No agent, adapter or result ever sees it. The gh
  token is broader than one made for the feedback repository; a Keychain item, once added, wins.
- No token, a token GitHub refuses (401, 403, 404), or GitHub unreachable: the report is kept in
  `feedback.json` and the agent is told it is saved. Valet sends what's owed, three at a time, at
  start and on the agent's next feedback call. Once filed, the issue's text is dropped from the
  file; Valet keeps only the id, title, issue number and replies.
- Demo mode and e2e runs have no feedback channel, so no test reaches GitHub.

### Setting it up (Nick)

1. Create the repository (private is recommended: reports can carry page text that scrubbing
   can't recognise as personal).
2. Make a fine-grained personal access token for that one repository with **Issues: read and
   write** and nothing else.
3. In Terminal: `security add-generic-password -s valet -a github-feedback -w` and paste the token
   when asked. (Without this, Valet uses the GitHub CLI's sign-in, if gh is signed in.)

Valet picks it up on the next feedback call; reports saved before then go out on that call.

## Scrubbing and limits

Before anything is kept or sent:

- A report holding a login secret or session value Valet knows of is refused whole
  (`sensitive`), as admin results are withheld.
- Token shapes (GitHub, 1Password service account, `sk-` keys, JWTs, AWS, Slack, `Bearer …`),
  the values of `Authorization`, `Cookie`, `Set-Cookie` and API-key headers, and email addresses are
  replaced with `[redacted]`. The agent is told how many. Hashes and ids stay.

Limits: 5 reports or follow-ups per agent an hour, 20 a day, and 50 a day from all agents. GitHub
replies are cached for 15 seconds, so a waiting agent costs at most two GitHub calls per look.

## Replies

A reply is any comment on the issue by someone GitHub calls `OWNER`, `MEMBER` or `COLLABORATOR`
of the repository, other than Valet's own follow-ups. Anyone else's comment never reaches the
agent. Replies are cut to 4,000 characters, stripped of control characters, scanned for known
secrets like any admin result, and described to the agent as data that never tells it to approve,
change or reveal anything. Closing the issue shows the report as `closed`.

## How the team watches

Reports arrive as issues labelled `agent-feedback` on the feedback repository. A project thread
handles one by reading it, answering in a comment (which the agent reads with
`valet_get_feedback`), and closing it when it's done or moved into a pull request. A team thread
that only reads issues needs that repository added to its GitHub access.

To notice new reports without someone looking, run a scheduled check (a few times a day) that
lists open `agent-feedback` issues with no reply from the team and starts a thread for each.
