import { Suspense, lazy } from "react";
import { parseRoute } from "./api";
import { GamesPage } from "./pages/GamesPage";
import { GmPage } from "./pages/GmPage";
import { JoinPage } from "./pages/JoinPage";
import { NewGame } from "./pages/NewGame";
import { SeatPage } from "./pages/SeatPage";
import { WatchPage } from "./pages/WatchPage";

/*
The design gallery, and how it stays out of the shipped app.

import.meta.env.DEV is replaced with a literal at build time, so in a
production build this is `false ? … : null`: the branch is dead, the dynamic
import inside it is never reached, and nothing under src/dev — the gallery, its
fixtures, the fetch stub — enters the module graph. The route below is guarded
by the same constant, so /dev/screens in production falls through to the same
"nothing here" page as any other unknown address.
*/
const DevGallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery").then((module) => ({ default: module.Gallery })))
  : null;

/*
Routing is the page's own address. Every page carries its tokens in the path,
the server only ever serves this shell at the addresses below, and nothing
in the app navigates between them, so a route table is all that is needed.
*/
export function App() {
  if (import.meta.env.DEV && DevGallery && window.location.pathname === "/dev/screens") {
    return (
      <Suspense fallback={null}>
        <DevGallery />
      </Suspense>
    );
  }

  const route = parseRoute(window.location.pathname);

  switch (route.kind) {
    case "index":
      return <GamesPage />;
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
