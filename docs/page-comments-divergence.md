# Where this came from

Copied on 2026-09-04 from
`/home/mike/dev/0x20/hexagonia/packages/page-comments`, the owner's own
component (MIT). It is not published anywhere, so it is vendored rather than
installed, and imported by relative path the way hexagonia imports it.

Everything in this directory stays generic. It imports nothing from this
repository, names nothing in it, and every addition is off unless a host asks
for it, so the whole directory can be copied back over the source above.

## To backport

1. **The host can say more about a clicked element.** `ElementNote` gains an
   optional `components: string[]`, and `PageComments` an optional
   `annotate(element)` property. What `annotate` returns is merged over the
   note the component reads for itself, so a host that knows its own page —
   the React components that drew the element, a better path — says so without
   this component having to know how. The collector keeps
   `element.components`, and the command line tool prints it as `drawn by`.
   Without the property nothing changes.

2. **A push channel, so a program need not poll.** The collector serves
   `GET /__comments/events` as server sent events: the whole store as one
   `store` event on connect, then one event per change — `comment`, `reply`,
   `propose`, `resolve`, `remove` — and `store` again when the file changes
   under the server, which is how a change made by the command line tool
   arrives. `curl -N` can read it. The command line tool gains `--watch`,
   which opens the channel and prints every new or changed comment as one line
   of JSON, and `--server` for the address (default `http://localhost:5173`).

3. **The middleware answers under `/__comments` as well as `/__feedback`.**
   It guarded on the `/__feedback` prefix alone, so the screen shot route it
   already had, `/__comments/shots/<id>.jpg`, was unreachable. The events
   route needed the same door.

4. **Review mode: the page reloads when the reviewer says so.** An agent that
   fixes what a comment asked for saves source, and the dev server pushes it
   at the browser mid-sentence — the screen the person was writing about is
   gone. Three parts, all off by default:
   - The plugin takes `holdReloads`. While it is on, `handleHotUpdate` returns
     `[]` for every file, so nothing is pushed, and announces `changed` with
     the changed path on the events channel instead.
   - The plugin also drops its own store from the module graph, whatever the
     setting: `handleHotUpdate` returns `[]` for anything under its folder,
     and a `config` hook adds that folder to `server.watch.ignored`. Writing a
     comment used to look like a source change.
   - `PageComments` takes `reviewMode`, `eventsUrl` and `reviewReload`. In
     review mode it opens the events channel and counts the fixes proposed
     since the page loaded, and also, live, how many comments are working —
     see the pickup signal below. Both land as small corner badges on the
     round count circle beside the button, each hidden at zero: a green one
     on the top-right corner, the number ready to review, and an orange one
     on the top-left, the number being worked on. Clicking the green badge
     writes every one of those ids into the fix-off store and reloads, so
     the old look is what appears and each fix is switched on by hand — the
     same click the badge always offered. Clicking the orange badge opens
     the list narrowed to the working comments, with a "Show all" button to
     drop the filter. `reviewReload="top"` reloads the window above, for a
     tool inside a frame.

5. **A "Go" button, so a comment from another page can be reached.**
   `StoredComment` gains `url`, the address the comment was made at — the
   collector already wrote it, the type just hadn't caught up. A comment
   whose address is not the current one gets a small "Go" button beside its
   selector; it navigates to that address with the comment's id set on the
   hash (`#comment=c006`). `PageComments` takes `navigateReload` (`self` |
   `top`, default `self`), naming the window that navigates, the same way
   `reviewReload` names the one that reloads. It also takes `navigateTo`, a
   function from the comment's hashed address to the one actually loaded —
   a host inside a frame strips whatever names the frame there, so the
   address that loads is the one a person would type. On load, a hash
   naming a comment opens the list, scrolls to that comment and outlines it
   and its pin for a few seconds, so the "Go" button lands somewhere the
   reader can see. The panel header also counts comments made elsewhere,
   next to the count still waiting on a fix.

6. **A pickup signal, so the person can see a worker is on it.** A comment
   gains a fourth status, `working`, between `open` and `proposed`, and a
   `worker` field naming who — `sonnet`, `opus`, and the like. The command
   line tool's `--pickup <id> <worker>` posts to a new collector endpoint,
   `POST /__feedback/api/pickup { id, worker }`, which sets the status, the
   worker and `pickedUpAt`, and announces `pickup` on the events channel the
   way it does `comment`, `reply`, `propose` and `resolve` — `--watch` prints
   it like any other change. `--propose` leaves `worker` on the record, so
   the same name follows the comment to its fix. In the page, a working
   comment shows a small pulsing-dot line, "being worked on by sonnet",
   replaced once a fix lands by "fixed by sonnet" in place of "Claude
   proposes"; a reply posted with `--reply` while a comment is working
   already shows under it, since the reply thread renders for every status.
   The default listing, in the tool and on the command line, shows working
   comments beside open and proposed ones, with the worker's name. In review
   mode, the orange corner badge on the count circle carries their number
   live, from the same events channel the green "ready to review" badge
   reads, so the person sees a fix is under way before it lands.

7. **A pin gets out of the way of the thing it marks.** Three changes, all
   off unless a host's data or its person reaches for them:
   - A pin fades to a quarter its usual opacity while the pointer sits over
     it, or over the element its comment was made on — found again by the
     comment's own `element.selector` — and returns the moment the pointer
     leaves either one. A look under the pin needs no click.
   - A pin can be pulled, with the existing `useDraggable` hook — now taking
     an optional second argument, `onDragEnd`, so a caller with its own
     place to keep the point reads it there instead of under a
     `localStorage` key. Only the drawn position moves: the click and the
     element it was made on stay as recorded. The move is kept as
     `pinOffset: { dx, dy }` on the comment, sent to a new collector
     endpoint, `POST /__feedback/api/pin { id, dx, dy }`, which announces
     `pin` on the events channel like any other change.
   - A "Hide pins" button in the list panel, and the `h` key outside a text
     field, hide every pin until switched back, remembered per site under
     `<storagePrefix>.hidePins`.

8. **The green corner badge counts, live, instead of sitting empty.** The
   round count button used to carry a plain dot, with no number, whenever
   any comment was proposed — and in review mode a separate badge counted
   only fixes proposed since the page loaded, so a proposal already on the
   page when it opened never showed at all. Both are now one badge: how many
   comments carry a fix waiting on a check, right now, from the events
   channel when review mode holds one open and from the polled comments
   otherwise. Hidden at zero, sized and set like the orange "being worked
   on" badge beside it. Clicking it still starts the reviewer's reload in
   review mode; elsewhere it opens the list.

9. **A "Go" button and a screen name on every comment, not only the ones
   made elsewhere.** A comment from the page open now scrolls to its pin and
   outlines it, the same outline a hashed address gives; a comment from
   another page still navigates there as before. Every row also names the
   screen the comment was made on, beside the button, so where it leads is
   readable before it is clicked. The list groups by that screen, the one
   open first, when more than one is present — a person who comments across
   many screens can otherwise lose track of which fix belongs where.

10. **One number for a comment's whole life, and resolved ones out of the
    way.** A pin and its list row used to disagree the moment a comment
    resolved: the pin numbered itself by its place in the fetched array, the
    row by its place in a filtered, sorted copy of the same array, and
    resolving one comment shrank both arrays and shifted every number after
    it — differently on each side. Both now read one shared map,
    `commentNumbers`, built from every comment's id when the collector
    numbers ids that way (`c007` -> 7) or, failing that, its place in the
    store by creation time; a comment keeps its number for as long as it
    exists, resolved or not. The list also fetches `status=all` rather than
    `active`, so a resolved comment still has a row.
    That row sits apart: resolved comments are pulled out of the main list
    into a collapsed section at the very bottom, behind a "Resolved (N)"
    header that opens on click, remembered per site under
    `<storagePrefix>.resolvedOpen`. Open, working and proposed comments keep
    the full row and the by-screen grouping; a resolved one collapses to a
    single compact line — its number, its screen, the first ~60 characters
    of its text and a Go button — that expands on click to the same full
    text, selector and, when Claude proposed the fix that was accepted, that
    note. A comment named in the address bar opens its own section first if
    it needs one.
    The main list's own order changed too: instead of grouping only by
    screen, it now bands by what a comment still needs — ready to review
    first, then open and working — with the screen grouping, current screen
    first, kept as the order inside each band, and comment number breaking
    any tie.
    Separately, the scroll to a named comment's row used to repeat itself:
    the effect that finds the row and scrolls to it depended on the whole
    comment list, so every poll or store push while that comment stayed
    highlighted re-ran it and dragged the reader back down. The scroll now
    answers only to the comment being named and the list being open, not to
    the list's own refreshes, and it retries for a few seconds on its own —
    not through that dependency — since the row, or the section holding it,
    may still be on its way in.

11. **A resolved comment's number marker carries its own colour, not the
    open one's red.** `ResolvedRow` adds `is-resolved` to its
    `feedback-index` span, and a new `--fb-resolved` token (default
    `#a78bfa`) colours that marker and tints the collapsed row's border and
    background, so open, working, proposed and resolved read as four
    distinct colours rather than resolved inheriting open's red.

12. **A "Dismiss" control, so a comment can be dropped without ever needing
    a fix.** The collector already had `DELETE /__feedback/api/comments/<id>`
    and the `remove` event on the events channel; nothing there changed.
    Every list row — open, working and proposed alike, through the one
    `feedback-where` div they share — and each compact resolved row now
    carries a small "Dismiss" button beside "Go", muted text rather than a
    bordered one (`fb-dismiss`), so it never reads as the main action. A
    first click turns it into "Really?" for three seconds; a second click
    while it still reads that way sends the DELETE and drops the row and its
    pin from this browser's own state at once, rather than waiting for the
    `remove` event to come back round. `PageComments` gained `dismiss(id)`
    for this, and `DismissButton`, the small component both places share.
    The pin's own editor box — `feedback-box`, open while a new comment is
    being written — carries the same control beside Cancel and Save. Since
    that box holds a draft with no id yet, its Dismiss has nothing to send a
    DELETE for; it just closes the box, the same as Cancel. A host
    that lets a draft carry an id before it is saved should send the DELETE
    from there too.

## The loop, for an agent

1. `npm run feedback -- --watch` and wait. Every comment the person writes
   arrives on standard output as one line of JSON: what they said, the path
   and the components of the thing they clicked, the screen, the point.
2. Make the change. If it changes what the person sees, register the comment
   id in the host's fixes file first, and wrap the change so that OFF gives
   back the old look (see `src/fixes.ts`).
3. `npm run feedback -- --propose c001 "what was done" --toggle`. The comment
   turns up in the page as a proposal, with the switch beside it.
4. The person accepts it, which resolves the comment, or answers it, which
   sends it back to open. Either arrives on the same watch.
