---
status: accepted
---

# ADR-036 — Text responses are served compressed, and the maps only once

**Status:** accepted, r27.
Every text response is gzipped for a client that offered gzip. The map art is
compressed once per style and cached, not once per request.

A board is the largest thing this server sends by two orders of magnitude:
classical's parchment map is 1.8 MB of SVG and gzips to 976 KB.

1. A client that did not offer gzip never gets it, and `gzip;q=0` counts as
   not offering.
2. Only text is compressed: `text/*`, JSON, SVG, JS, and any `+json` or `+xml`
   suffix. A PNG is already compressed and deflate over it adds bytes.
3. A body under a kilobyte is sent as it is.
4. `Vary: Accept-Encoding` goes on every response that COULD be compressed,
   not only the ones that were. A cache that stores one answer per URL and
   ignores Vary would hand a gzip body to a client that cannot read it.
5. `Content-Length` is dropped when the body is compressed, and a request
   carrying `Range` passes through untouched: a range names bytes of a
   representation whose numbering compression would change.
6. The map art is compressed once and kept. Deflating classical's parchment
   map takes 63 ms, longer than composing the styled map, and it would be paid
   on every board load. The composed bytes are already cached for the life of
   the process, so the compressed copy is cached beside them.
7. Both routes that serve a board go through one function, so the gallery and
   a game table cannot disagree about the bytes or the headers.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r27, 2026-08-30** — ADR-036: text responses are gzipped for clients that offer it, with `Vary: Accept-Encoding` on everything compressible; the map art is compressed once per style and cached beside the composed bytes, 64% off the wire.
