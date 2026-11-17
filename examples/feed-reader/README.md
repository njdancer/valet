# News and releases (example)

An example of an `http` adapter that reads feeds: BBC News's RSS sections from feeds.bbci.co.uk and a
GitHub project's releases from its Atom feed on github.com, each one request, parsed with
`parseFeed` from `@valet/core`.

What it shows: two egress hosts, request patterns with a parameter in the middle
(`/news/:section/rss.xml`), RSS and Atom turned into one plain-text shape, a page that isn't a feed
failing as `unexpected-shape`, and `.xml` fixtures.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "feed-reader"`).
