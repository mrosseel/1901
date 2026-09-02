---
status: accepted
---

# ADR-051 — The download is one file, and the release is a button

ADR-006 says one static binary with the frontend and the map assets embedded.
The binary did not do that. Three directories were read from the working
directory at start-up:

    web/dist              the vite build          SPADIR
    variants/generated    75 files, 24 MB         GENERATED_VARIANTS
    placements            the approved tables     PLACEMENTS

A game master who downloads that file and runs it gets "the frontend is not
built yet, run npm install", in a venue, with seven people waiting. So the
promise of ADR-018's LAN mode was never deliverable from a release page. This
records what a release is instead.

## One file, everything inside, seven of them

`-tags standalone` compiles the three directories into the binary. Nothing else
distinguishes a release build. The tag exists because `web/dist` is generated
and not checked in, so an unconditional `go:embed` would break `go build ./...`
on a fresh clone and in the `go` job of CI. A normal build still reads the three
directories from disk, which is what a development session wants: edit the
frontend, reload, no recompile.

The environment variables still win when they are set, in either build. A test
that points `GENERATED_VARIANTS` at a temporary directory keeps working, and a
packaged install can still be handed its own files.

All twelve generated variants go in, not classical alone. The saving is 23 MB
on a file nobody pays bandwidth for, and the cost is a second artifact per
platform and a question on the download page about which one to take.

Seven platforms build from one Linux runner with `CGO_ENABLED=0`, because
`modernc.org/sqlite` is Go and there is no cgo anywhere in the tree:

    linux/amd64   linux/arm64   linux/arm
    darwin/amd64  darwin/arm64
    windows/amd64 windows/arm64

`linux/arm64` and `linux/arm` are the Raspberry Pi. The venue box is the
deployment I trust most, and it costs one more line of the matrix.

## The release is a button

`.github/workflows/release.yml` runs on `workflow_dispatch`, with the version as
its one input. A maintainer clicks Run workflow, types `0.1.0`, and gets a
GitHub release with seven archives, `SHA256SUMS`, and notes. The frontend is
built once and passed to the seven builds as an artifact, so npm runs once and
the seven binaries carry byte-identical assets. The workflow creates the tag
itself; there is no separate tagging step to forget.

`-trimpath` and `-ldflags "-s -w -X .../internal/server.version=..."` on every build. The
version is in the start-up log, so a bug report from a table can name the build
it came from.

## Not signed, and said out loud

The binaries are unsigned. macOS quarantines them and Windows SmartScreen warns
about them. Signing means an Apple developer account with notarisation and a
Windows certificate, both paid and both yearly, and neither is worth buying
before somebody has played a game from a download.

`SHA256SUMS` is what ships instead. It proves the file came from this build; it
does nothing about the dialog.

Two things the release notes must say, above everything else, because they
decide whether the evening works:

- Windows raises a firewall prompt on the first run. Private networks must be
  allowed, or no phone reaches the server.
- macOS refuses a quarantined binary from Finder. The archive carries
  `1901.command` so a double click opens Terminal in the right place.

## Consequences

- `loadPlacements` and `loadGeneratedVariants` read an `fs.FS`, not the disk.
  The seam is `assets.go` with `assets_disk.go` and `assets_embed.go` behind
  the build tag, which is the shape `mapeditor_dev.go` already uses.
- The build stamp of ADR-050 hashes `index.html` through the same `fs.FS`, so a
  standalone build stamps the assets it carries rather than falling back to its
  start time.
- The database stays `1901.db` in the working directory, and no release ships
  one. Windows starts a double-clicked exe in the folder that holds it, and
  `1901.command` changes to its own folder first, so a game master who never
  opens a terminal finds the file beside the download. A terminal user gets it
  where they are. An executable-relative path would have been the same answer
  in the first case and a surprise in the second. When the folder is read-only
  the server now says which directory it failed in and names DB, because the
  sqlite error alone does not.
- The referee lobby withholds a loopback invite QR and says to set `BASE_URL`.
  Startup logs separate the local address from phone-link status, and the
  operator guide requires a real-phone scan before the table is seated.
- M5's acceptance test now has an artifact to run: take the release file to a
  machine with no internet and play a game.


## Revisions

- **2026-09-02** — The placements directory is gone, and so is the code that
  read it. This decision moved a variant's approved table into
  variants/generated/<key>/ and moved map authoring to dipmap, which left the
  directory with nothing in it and nothing looking for it. The embed directive
  outlived the directory and broke every release build until CI said so; only
  `-tags standalone` compiles that file, so nothing anybody ran noticed.
