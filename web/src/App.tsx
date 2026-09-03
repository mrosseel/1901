import { Suspense, lazy } from "react";
import { parseRoute } from "./api";
import { DatcPage } from "./pages/DatcPage";
import { FaqPage } from "./pages/FaqPage";
import { GamesPage } from "./pages/GamesPage";
import { GmPage } from "./pages/GmPage";
import { HandoverPage } from "./pages/HandoverPage";
import { JoinPage } from "./pages/JoinPage";
import { LandingPage } from "./pages/LandingPage";
import { NewGame } from "./pages/NewGame";
import { RecoverPage } from "./pages/RecoverPage";
import { SandboxPage } from "./pages/SandboxPage";
import { SeatPage } from "./pages/SeatPage";
import { VariantsPage } from "./pages/VariantsPage";
import { WatchPage } from "./pages/WatchPage";

/*
The design gallery, and which builds carry it.

Three shapes, one flag:

  development       always has it
  the hosted site   has it: SCREENS=1 at build time
  a release build   does not: the flag is absent, the branch is `false ? … :
                    null`, and nothing under src/dev — the gallery, its
                    fixtures, the fetch stub — enters the module graph at all

A phone pays nothing in any of them. Both constants are replaced with literals
at build time, and where the branch survives it is a lazy import: the gallery
is its own chunk, fetched only by a browser that actually opens /dev/screens.
No player ever does.
*/
const DevGallery =
  import.meta.env.DEV || import.meta.env.VITE_SCREENS
    ? lazy(() => import("./dev/Gallery").then((module) => ({ default: module.Gallery })))
    : null;

/*
Routing is the page's own address. Every page carries its tokens in the path,
the server only ever serves this shell at the addresses below, and nothing
in the app navigates between them, so a route table is all that is needed.
*/
export function App() {
  if (DevGallery && window.location.pathname === "/dev/screens") {
    return (
      <Suspense fallback={null}>
        <DevGallery />
      </Suspense>
    );
  }

  const route = parseRoute(window.location.pathname);

  switch (route.kind) {
    case "index":
      return <LandingPage />;
    case "games":
      return <GamesPage />;
    case "faq":
      return <FaqPage />;
    case "variants":
      return <VariantsPage />;
    case "datc":
      return <DatcPage />;
    case "recover":
      return <RecoverPage gameId={route.gameId} />;
    case "handover":
      return (
        <HandoverPage
          gameId={route.gameId}
          power={route.power}
          epoch={route.epoch}
          signature={route.signature}
        />
      );
    case "handover-gm":
      return (
        <HandoverPage
          gameId={route.gameId}
          power={null}
          epoch={route.epoch}
          signature={route.signature}
        />
      );
    case "new":
      return <NewGame sandbox={route.sandbox} />;
    case "sandbox":
      return <SandboxPage gameId={route.gameId} sandboxToken={route.sandboxToken} />;
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
