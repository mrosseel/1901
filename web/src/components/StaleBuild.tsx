import { buildIsStale } from "../build";

/*
"This app has been updated" (ADR-050).

It is drawn across the top of whatever the player is looking at, above
everything, because the alternative is that they find out by tapping something
and having it fail. It does not reload by itself: a player may be halfway
through writing orders, and a page that reloads under a hand is worse than one
that is a version behind.

Nothing about the game is wrong while this stands. The old app talks to the old
transport, which is still there — /api/v1 does not move under anybody
(ADR-050). This is a nudge, not an alarm, and it says which.
*/
export function StaleBuild({ beat }: { beat?: unknown }) {
  void beat;
  if (!buildIsStale()) return null;
  return (
    <div className="stale-build" role="status">
      <span>
        This app has been updated. Your game is fine — reload when it suits you.
      </span>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
