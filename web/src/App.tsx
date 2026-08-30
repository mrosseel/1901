import { Suspense, lazy } from "react";
import { parseRoute } from "./api";
import { FaqPage } from "./pages/FaqPage";
import { GamesPage } from "./pages/GamesPage";
import { GmPage } from "./pages/GmPage";
import { HandoverPage } from "./pages/HandoverPage";
import { JoinPage } from "./pages/JoinPage";
import { LandingPage } from "./pages/LandingPage";
import { NewGame } from "./pages/NewGame";
import { RecoverPage } from "./pages/RecoverPage";
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
The map editor (D-030), which ships in every build but is only loaded when
somebody asks for it.

Unlike the gallery it is a real screen with a real job, so it is not behind
import.meta.env.DEV: a production build serves it, read-only, because it needs
nothing but a variant and it is the audit viewer the design asks for. What it
cannot do there is save — the /mapeditor/save endpoint is behind a build tag
on the server (mapeditor_off.go) and its button is behind the same constant
the gallery is. It is lazy because it carries the placement geometry, which no
other page needs.
*/
const MapEditor = lazy(() =>
  import("./mapeditor/MapEditorPage").then((module) => ({ default: module.MapEditorPage })),
);

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

  if (route.kind === "mapeditor") {
    return (
      <Suspense fallback={null}>
        <MapEditor />
      </Suspense>
    );
  }

  switch (route.kind) {
    case "index":
      return <LandingPage />;
    case "games":
      return <GamesPage />;
    case "faq":
      return <FaqPage />;
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
