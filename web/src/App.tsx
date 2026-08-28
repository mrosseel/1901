import { parseRoute } from "./api";
import { GmPage } from "./pages/GmPage";
import { JoinPage } from "./pages/JoinPage";
import { NewGame } from "./pages/NewGame";
import { SeatPage } from "./pages/SeatPage";
import { WatchPage } from "./pages/WatchPage";

/*
Routing is the page's own address. Every page carries its tokens in the path,
the server only ever serves this shell at the four addresses below, and nothing
in the app navigates between them, so a route table is all that is needed.
*/
export function App() {
  const route = parseRoute(window.location.pathname);

  switch (route.kind) {
    case "new":
      return <NewGame />;
    case "join":
      return <JoinPage gameId={route.gameId} inviteToken={route.inviteToken} />;
    case "gm":
      return <GmPage gameId={route.gameId} gmToken={route.gmToken} />;
    case "seat":
      return <SeatPage gameId={route.gameId} seatToken={route.seatToken} />;
    case "watch":
      return <WatchPage gameId={route.gameId} phaseIndex={route.phaseIndex} />;
    default:
      return (
        <main className="page">
          <h1>Nothing here</h1>
          <p>
            This address is not a game. <a href="/new">Start a new game</a>, or ask the
            game master for the invite link.
          </p>
        </main>
      );
  }
}
