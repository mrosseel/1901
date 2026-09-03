import { readRecentGame } from "../recent";

/*
The bar every ordinary page wears.

Without it each screen is an island: the app is a set of addresses somebody
handed you, so a player who leaves their seat to read the rules or look at the
list has no way back that is not the browser's own history. The bar is the way
back, in both directions — out to the things that are the same for everybody,
and in to the one game this device is playing.

Two screens do not get it. The spectator view is a board on a beamer and the
room is not going to navigate it, and the seat page is a map fighting a phone
for every pixel; that one carries the same links inside the seat menu instead,
which is one tap away and costs no height.
*/
export function TopBar({ here }: { here?: "games" | "faq" | "new" | "datc" | "variants" }) {
  const game = readRecentGame();

  return (
    <nav className="topbar">
      <a className="topbar-mark" href="/">
        1901
      </a>
      <a className={here === "games" ? "here" : undefined} href="/games">
        Games
      </a>
      <a className={here === "variants" ? "here" : undefined} href="/variants">
        Variants
      </a>
      <a className={here === "faq" ? "here" : undefined} href="/faq">
        Questions
      </a>
      {/* The way back in. It names the game rather than saying "your game",
          because a phone that has been at two tables this weekend should be
          told which one it is about to open. */}
      {game ? (
        <a className="topbar-back" href={game.url}>
          Back to {game.label}
          {game.power ? " · " + game.power : ""}
        </a>
      ) : (
        <a className={here === "new" ? "here" : undefined} href="/new">
          New game
        </a>
      )}
    </nav>
  );
}
