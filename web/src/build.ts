/*
Whether this tab is still running the app the server is serving (ADR-050).

A phone at a table has been on one page for forty minutes. A deploy replaces
the server under it, and nothing tells the tab: it goes on running the
JavaScript it was sent, against a server that has moved on. The failure then
lands wherever the player next touches, which is the worst possible moment and
the least useful message.

So every state answer carries the build the server is serving, this remembers
the first one it saw, and a change means this tab is stale. It never reloads on
its own — a player may be halfway through writing orders, and a page that
reloads itself under a hand is worse than one that is a version behind. It says
so and offers the button.
*/

let seen: string | null = null;
let stale = false;

/*
Note the build an answer carried. The first one is what this tab is running,
because the shell and its JavaScript came from the same build.
*/
export function noteBuild(build: string | null | undefined): void {
  if (!build) return;
  if (seen === null) {
    seen = build;
    return;
  }
  if (build !== seen) stale = true;
}

/** True once the server has answered with a build this tab is not running. */
export function buildIsStale(): boolean {
  return stale;
}

/** For tests, and for nothing else. */
export function forgetBuild(): void {
  seen = null;
  stale = false;
}
