# Claude.ai projects adapter

Lets a Claude elsewhere (voice Claude on the phone, through the hub) talk to the person's Claude Code
projects on claude.ai, as in Nick's brief: list projects, list threads, read a project chat or a
thread after a cursor, and send a message to a project's coordinator or to one thread, optionally
waiting up to 30 seconds for the reply.

## How it reaches claude.ai

The calls are the ones claude.ai's own project pages make (seen in a signed-in browser on
2026-11-20), from a tool page on claude.ai (`/robots.txt`, so the app itself doesn't run):

| Tool                           | Calls                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `list_projects`                | `GET /v1/code/channels?scope=joined`                                                                                     |
| `list_threads`                 | `GET /v1/code/channels/:channel/threads`                                                                                 |
| `read_messages` (project chat) | `GET /v1/code/channels/:channel` (the coordinator's session), `.../timeline`, `GET /v1/code/sessions/:session` (working) |
| `read_messages` (thread)       | `GET /v1/code/channels/:channel/threads/:thread`                                                                         |
| `send_message`                 | `POST /v1/code/channels/:channel/messages`, then the reads above until the reply is done                                 |

Every `/v1/` call sends `anthropic-version: 2023-06-01`; the session cookie does the rest. Assumed,
not yet seen live: a reply in a thread is a POST with `reply_to_message_id` set to the thread's root,
as the thread composer's code sends it.

## Signing in

claude.ai signs in by an emailed link or code. For now the person signs in once in Valet's window
(the hand-off): their email, then the code from the email. The session is kept between runs. Next:
Valet signs in by itself with `openMailLink` once a mailbox is set up for it.
