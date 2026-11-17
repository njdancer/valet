# Hacker News (example)

An example of an `http` adapter (docs/adapter-kinds.md): no browser, no login, plain JSON from
Hacker News's public API at hacker-news.firebaseio.com.

- `list_stories` reads one of the lists (top, new, best, ask, show, jobs), then each story on it.
- `get_story` reads one story and up to ten of its top-level comments, as plain text.

What it shows: a manifest with `runtime: "http"`, exact `egress` and two request patterns that are
everything it can ask for; `ctx.http.fetch` and JSON parsing; skipping deleted and dead items; HTML
in comments turned into text (`src/text.ts`); and cases with fixtures and inline answers, including
JSON `null` for an id with nothing behind it.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "hacker-news"`).
