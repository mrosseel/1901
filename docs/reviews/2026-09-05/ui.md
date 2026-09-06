# UI review and alternate designs — 5 September 2026

Open `designs.html` in a browser, or visit http://127.0.0.1:5188/designs.html while the review server is running. It is self-contained, including the existing Classical map artwork, and makes no network requests. Use the direction buttons, screen/state menus and phone/desktop selector. These are visual proposals with illustrative interactions, not replacements for the production components.

## Recommendation

Use **Table companion** as the default player experience: show the complete order list, the current phase and the next action together. Use **The atlas** for desktop play and sandbox work, where spatial context matters most. Borrow **The dispatch** typography and restrained paper treatment for the landing page, spectator history and results. Keep one shared language for readiness, warnings and irreversible actions across all three.

| Direction | Structural difference | Suited to | Cost |
|---|---|---|---|
| Table companion | Orders precede the compact board on phones; clear task cards and one primary action | Physical tables, phone ordering, joining and recovery | Less immediate map context |
| The atlas | Large board on the left, orders on the right; dark surrounding UI | Desktop play, sandbox, shared screens | Needs an order drawer/action dock on phones |
| The dispatch | Wide board strip followed by a readable phase record; serif headings, thin rules, paper tones | Spectators, phase reviews, game results and public pages | More scrolling; less compact for repeated input |

## Current UI observations

The existing UI has useful foundations: persistent power/phase identification, readable prose order notation, a genuine board, separate spectator access, and many explicit game states. The proposals preserve those.

1. **The main player task is below a large map.** At 390 px, the movement screen initially exposes the map and readiness button, with most orders farther down the lower scrolling panel. An order-first option makes checking all three orders easier before committing. Put appearance controls in a view menu and keep selection/zoom controls near the map.
2. **GM actions are separated by a long page.** Readiness appears near the top; the clock extension controls come after backup/invite/rules sections. Place readiness and the clock together. Use separate secondary panels for rules, transfers, exports and the event log. Keep force adjudication unavailable until the existing server rules permit it.
3. **Creation offers settings before board selection.** The current create screen includes a long map catalogue after the settings and exposes more than one creation action. A three-step board → rules → review flow gives the final decision one clear location. A compact advanced-settings disclosure can keep expert setup fast.
4. **Access recovery competes with the game list.** The gallery's recovery entry renders a game list plus several return/recovery sections. Separate “return to my seat,” “restore a seat link,” and “recover the GM role” with short, role-specific entry points.
5. **Review should identify consequences, not merely invalidity.** Keep “invalid order — the unit held” next to the order. Distinguish invalid, bounced, dislodged, and successful outcomes with both words and visual treatment. Do not block intentionally invalid orders when the game allows them.
6. **Public pages can say less before showing the product.** Let the board and a short three-step explanation carry the landing page. Use visible names, current phase and role-aware return actions in the games list; keep public watching separate from entering a seat.

## Coverage of all 43 gallery entries

The browser visited every catalogue entry at `/dev/screens` at 390 px. Rendered text was recorded in `gallery-observations.json`; representative player, GM, creation, landing, message and spectator screens were captured and visually inspected. This is not a claim that every possible viewport, modal interaction or accessibility requirement was tested.

| Current gallery entries | Proposed treatment |
|---|---|
| Seat: not-started, waiting-partial | Assigned-power confirmation, claim progress, optional access backup; no order controls before play |
| Seat: movement, locked, sealed-locked | Stable phase header, complete order list, explicit draft/ready/sealed status; editing only where the current phase permits it |
| Seat: retreat | Only dislodged units and retreat choices; prominent remaining count and consequence of not retreating |
| Seat: adjustment-build, adjustment-disband | Build/remove count, eligible locations/units, clear confirmation language |
| Seat: idle | “Nothing to order” and automatic readiness where applicable; avoid an apparently required empty action |
| Seat: review, review-illegal | Phase result first, each order with its outcome, then board view and next-phase action |
| Seat: illegal-draft | Inline explanation of expected failure; keep the user's allowed choice |
| Seat: keep-seat | Short private-access explanation, deliberate copy action, optional details; avoid permanently displaying credentials |
| Seat: press-list, press-room | Inbox and conversation layouts; visible writing window; separate unreadable history from an empty conversation |
| Seat: ended | Result replaces timer and input; final board, centres and history remain available |
| Seat: guide | Large physical-piece checklist grouped into moves, removals and placements; retain checkmarks through the task |
| Sandbox: movement, adjudicated | Persistent “all powers are yours” label, active-power selector, order workspace and separate resolution review |
| GM: prestart, lobby-full | Seating and invitation are primary; start action becomes available when the table is full |
| GM: midphase, force-armed, deadline-passed, adjustment | Clock and readiness together; explicit deadline/grace state; show force consequences before confirmation |
| GM: ended | Final result and exports first; administrative history remains secondary |
| Watch: waiting, live, historical, ended | Waiting progress, live board, visibly historical phase, or final result; persistent phase navigation |
| Page: landing | Host/find actions, genuine map preview, short explanation of one turn |
| Page: games, games-empty | Return to held seats above public games; inviting empty state |
| Page: new | Board, rules, final review; one creation action |
| Page: variants | Search/player-count filters, consistent preview size, notes on demand |
| Page: join | Table/rules summary, claim progress, one claim action; fully claimed state offers recovery/transfer paths |
| Page: faq, datc | Expandable questions; adjudication result first, case details below |
| Page: handover-seat, handover-gm | Exact target role and consequence before acceptance; access changes only on deliberate confirmation |
| Page: admin-login, admin-games | Simple credential entry; game identity and an explicit destructive confirmation for deletion |
| Page: recover | Dedicated role recovery flow, instead of placing it below the full game list |

The interactive study groups these into 13 screen families and 39 illustrative states, rendered in each of the three directions (117 combinations). It does not reproduce every production modal or implement the game engine. The piece-moving checklist and detailed reveal/transfer subflows are specified above rather than implemented in the study.

## Gallery issues to resolve before a redesign implementation

- `seat/press-room`, labelled “One conversation,” rendered an unreadable previous-holder conversation and a closed state during this review. The nominal healthy conversation needs a separate reliable fixture. This is a gallery observation, not a reproduced live-message failure.
- Gallery entries share browser storage: synthetic held games such as `gallery-seat` appeared in the recovery/game-list flow. Reset or namespace scenario storage so inspecting one entry does not alter the next entry's baseline.
- The landing-page sample says 26 variants, while the live catalogue exposed 40 in creation. Use the catalogue count or omit the number.
- The illegal-review sample shows “invalid order — the unit held” in its overlay while the underlying last-phase listing includes an “OK” label for the same origin. Review the distinction between a unit's adjudication outcome and the validity of its submitted order before reusing a generic status badge.

## Implementation and validation notes

Retain actual API behavior and phase constraints. Build new layouts around the existing page state/hooks and board component rather than copying fixture-only logic into production. The gallery can expose a layout switch for side-by-side evaluation during implementation.

Use at least 44 px targets, visible focus, textual state labels alongside power colors, semantic buttons, and announcement of readiness/error changes. Check 320/390/768/1440 px layouts, large text and keyboard-only use. Validate actual contrast before selecting final colors. Persist map preferences without placing all their controls in the main task area.

The proposal was browser-rendered across all 117 direction/state combinations with no rendering exception, and inspected visually in all three directions. Ready-order and creation-step transitions were checked. A 390 px viewport produced a 390 px document width, with no horizontal page overflow in the checked creation state. The captured PNGs show representative player layouts. These checks are not a full accessibility or responsive-layout audit.
