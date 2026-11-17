# Fake HTTP API

A local HTTPS and WebSocket server for testing `http` adapters and the egress broker
(docs/adapter-kinds.md) without a real service. It serves a small JSON API, an RSS and an Atom
feed, a CalDAV and CardDAV collection, and WebSocket endpoints, plus hostile answers for the red
team: redirect loops, oversized and endless bodies, gzip bombs, header floods and socket floods.
Every request it receives is recorded, so a test can check exactly what left the broker.
