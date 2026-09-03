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
export function TopBar({
  here,
}: {
  here?: "games" | "faq" | "new" | "sandbox" | "variants" | "datc";
}) {
  const game = readRecentGame();

  /* The same links the landing page carries, in the same order, so the bar
     reads as one thing wherever it is met. */
  const link = (page: typeof here, href: string, label: string) => (
    <a className={here === page ? "here" : undefined} href={href}>
      {label}
    </a>
  );

  return (
    <nav className="topbar">
      <a className="topbar-mark" href="/">
        1901
      </a>
      {link("variants", "/variants", "Variants")}
      {link("sandbox", "/sandbox", "Sandbox")}
      {link("games", "/games", "Games")}
      <a href="/recover">Return to a game</a>
      {link("faq", "/faq", "Questions")}
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
