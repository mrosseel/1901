/*
The design gallery: /dev/screens, in a dev build only.

Every screen the game can be in, side by side, without creating or joining a
game. What it draws is the real page component — SeatPage, GmPage, WatchPage,
and the overlays they open — fed by states captured off a running server (see
fixtures/README.md). There is no gallery-only copy of any page anywhere in
here, because a copy would drift and then the gallery would be lying about
what a player sees.

The data comes in through one wrapper around window.fetch (stub.ts). The pages
know nothing about it: they build their own clients from their own tokens,
poll on their own timers, and open their own reviews.

The address is the state:

    /dev/screens?screen=seat&state=retreat&theme=dark&w=390&style=midnight
*/

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { FaqPage } from "../pages/FaqPage";
import { GamesPage } from "../pages/GamesPage";
import type { Route } from "../api";
import { GmPage } from "../pages/GmPage";
import { HandoverPage } from "../pages/HandoverPage";
import { JoinPage } from "../pages/JoinPage";
import { LandingPage } from "../pages/LandingPage";
import { NewGame } from "../pages/NewGame";
import { RecoverPage } from "../pages/RecoverPage";
import { SeatPage } from "../pages/SeatPage";
import { WatchPage } from "../pages/WatchPage";
import { ModalLayer } from "../components/ModalLayer";
import { RefereeGuide } from "../components/RefereeGuide";
import { refereeGuide } from "../referee";
import { dismiss, reviewKey } from "../review";
import { STYLE_KEY } from "../style";
import * as fx from "./fixtures";
import { installCapture } from "./capture";
import { installStub, type Scenario } from "./stub";
import "./gallery.css";

// --- the catalogue --------------------------------------------------------

interface Entry {
  /*
  The route this entry is the picture of. It is what makes the catalogue
  answerable to the app rather than to whoever last remembered to add a
  screen: gallery.coverage.test.ts walks the Route union and fails when a
  kind has no entry here. Eight screens went missing before it existed.
  */
  route: Route["kind"];
  screen: string;
  state: string;
  title: string;
  note: string;
  scenario: Scenario;
  render: () => ReactNode;
  /** Set on the one entry whose page must open its review by itself. */
  showReview?: boolean;
}

const VARIANT = "classical";

/* The editor carries the placement geometry no other page needs, so it is
   loaded the way the app loads it rather than pulled into this bundle. */
const MapEditorPage = lazy(() =>
  import("../mapeditor/MapEditorPage").then((module) => ({ default: module.MapEditorPage })),
);

/** The five resolved phases of the captured game, for the spectator's nav. */
function watchPhases(): Record<number, ReturnType<typeof fx.watch>> {
  const out: Record<number, ReturnType<typeof fx.watch>> = {};
  for (let i = 0; i < 5; i++) out[i] = fx.watch("watch-phase-" + i);
  return out;
}

function seatEntry(
  state: string,
  title: string,
  note: string,
  fixture: string,
  optionBook?: string,
  showReview?: boolean,
): Entry {
  const seat = fx.seat(fixture);
  return {
    route: "seat",
    screen: "seat",
    state: state,
    title: title,
    note: note,
    showReview: showReview,
    scenario: {
      variantKey: VARIANT,
      seat: seat,
      options: optionBook ? fx.options(optionBook) : {},
    },
    render: () => <SeatPage gameId={fx.gameIdOf(seat)} seatToken="fixture" />,
  };
}

function gmEntry(state: string, title: string, note: string, fixture: string): Entry {
  const gm = fx.gm(fixture);
  return {
    route: "gm",
    screen: "gm",
    state: state,
    title: title,
    note: note,
    scenario: { variantKey: VARIANT, gm: gm },
    render: () => <GmPage gameId={gm.gameId} gmToken="fixture" />,
  };
}

/*
Every screen the app can be in. Exported for the coverage test, which is what
keeps this list answerable to the Route union rather than to memory.
*/
export function buildCatalogue(): Entry[] {
  const live = fx.watch("watch-live");
  const waiting = fx.watch("watch-prestart");
  const phases = watchPhases();
  const retreat = fx.seat("seat-retreat");
  const guide = refereeGuide(retreat.previousPhase);

  const list: Entry[] = [
    seatEntry(
      "not-started",
      "Waiting to start, table full",
      "France, all seven claimed, the game master has not started it.",
      "seat-not-started",
    ),
    seatEntry(
      "waiting-partial",
      "Waiting to start, table filling",
      "Austria, four of seven claimed: the screen a player lands on from the code.",
      "seat-waiting-partial",
    ),
    seatEntry(
      "movement",
      "Mid-movement",
      "France, Spring 1901, three drafted orders drawn on the map.",
      "seat-movement",
    ),
    seatEntry(
      "locked",
      "Orders locked",
      "England has locked. The lock button carries the count.",
      "seat-locked",
    ),
    seatEntry(
      "retreat",
      "Retreat",
      "Austria's fleet is thrown out of Trieste and must retreat or disband.",
      "seat-retreat",
      "options-retreat",
    ),
    seatEntry(
      "adjustment-build",
      "Adjustment: builds",
      "France took Spain and Portugal: two builds owed, two home centres open.",
      "seat-adjustment-build",
      "options-build",
    ),
    seatEntry(
      "adjustment-disband",
      "Adjustment: disband",
      "Austria lost Trieste and owes one disband.",
      "seat-adjustment-disband",
      "options-disband",
    ),
    seatEntry(
      "idle",
      "Nothing to order",
      "Germany in a retreat phase with nothing dislodged.",
      "seat-idle",
    ),
    seatEntry(
      "review",
      "Review of last turn",
      "Fall 1901: Burgundy bounced, Trieste was dislodged, Turkey gave no orders.",
      "seat-retreat",
      "options-retreat",
      true,
    ),
    seatEntry(
      "illegal-draft",
      "Illegal order drafted",
      "Austria wrote Army Budapest to the Adriatic Sea: amber, dashed, private (ADR-029).",
      "seat-illegal",
    ),
    seatEntry(
      "review-illegal",
      "Review with an illegal order",
      "The misorder resolved as IllegalOrder: struck, the unit held.",
      "seat-review-illegal",
      undefined,
      true,
    ),
  ];

  if (guide) {
    list.push({
      route: "seat",
      screen: "seat",
      state: "guide",
      title: "Move the pieces",
      note: "The same Fall 1901 adjudication, as acts on a physical board.",
      scenario: { variantKey: VARIANT, seat: retreat },
      render: () => <GuideOnly />,
    });
  }

  list.push(
    gmEntry(
      "prestart",
      "Before the start",
      "The game master plays, so six seats are on offer and three are in. Invite and QR open.",
      "gm-prestart",
    ),
    gmEntry(
      "lobby-full",
      "The table is full",
      "Every power claimed and the game named. The list of powers appears only here, "
        + "when there is no join order left to read off it.",
      "gm-lobby-full",
    ),
    gmEntry(
      "midphase",
      "Mid-phase",
      "Spring 1901 running, some powers locked in, the clock counting down.",
      "gm-midphase",
    ),
    gmEntry(
      "force-armed",
      "Force armed",
      "Six of seven locked in, so the forced adjudication is live before the deadline.",
      "gm-force-armed",
    ),
    gmEntry(
      "deadline-passed",
      "Deadline passed",
      "The clock has run out with nobody locked in. Forcing writes an NMR for each.",
      "gm-deadline-passed",
    ),
    gmEntry(
      "adjustment",
      "Adjustment phase",
      "After Fall 1901, with the event log filled in.",
      "gm-adjustment",
    ),
    {
      route: "watch",
      screen: "watch",
      state: "waiting",
      title: "Waiting to start",
      note: "The spectator link opened before the game runs: the joined count and the opening position.",
      scenario: { variantKey: VARIANT, watch: waiting, phases: {} },
      render: () => <WatchPage gameId={waiting.gameId} phaseIndex={null} />,
    },
    {
      route: "watch",
      screen: "watch",
      state: "live",
      title: "Live",
      note: "The projector view of the phase being ordered. No orders are public yet.",
      scenario: { variantKey: VARIANT, watch: live, phases: phases },
      render: () => <WatchPage gameId={live.gameId} phaseIndex={null} />,
    },
    {
      route: "watch",
      screen: "watch",
      state: "historical",
      title: "Historical phase",
      note: "Fall 1901 movement, resolved: every power's orders in the outcome colours.",
      scenario: { variantKey: VARIANT, watch: live, phases: phases },
      render: () => <WatchPage gameId={live.gameId} phaseIndex={2} />,
    },
  );

  /*
  The screens with no game behind them.

  They carry no token and most of them fetch nothing, which is why they were
  easy to leave out of a gallery built around captured game states — and why
  leaving them out was wrong: they are the screens a stranger meets first, and
  the ones nobody ever looks at twice.
  */
  list.push(
    {
      route: "index",
      screen: "page",
      state: "landing",
      title: "The landing page",
      note: "The root (ADR-043): what this is, for somebody who was sent a link and nothing else.",
      scenario: { variantKey: VARIANT },
      render: () => <LandingPage />,
    },
    {
      route: "games",
      screen: "page",
      state: "games",
      title: "The game list",
      note: "Every game this server holds. No ids on the face of it: the name is the handle.",
      scenario: { variantKey: VARIANT, games: fx.gameList(waiting, live) },
      render: () => <GamesPage />,
    },
    {
      route: "games",
      screen: "page",
      state: "games-empty",
      title: "The game list, empty",
      note: "A server nobody has started a game on yet.",
      scenario: { variantKey: VARIANT, games: [] },
      render: () => <GamesPage />,
    },
    {
      route: "new",
      screen: "page",
      state: "new",
      title: "New game",
      note: "The rules above, the board gallery below. Variants come from the real server.",
      scenario: { variantKey: VARIANT },
      render: () => <NewGame />,
    },
    {
      route: "join",
      screen: "page",
      state: "join",
      title: "Join",
      note: "What the invite code opens: the rules of this table, then one button.",
      scenario: { variantKey: VARIANT, watch: waiting },
      render: () => <JoinPage gameId={waiting.gameId} inviteToken="fixture" />,
    },
    {
      route: "faq",
      screen: "page",
      state: "faq",
      title: "Questions",
      note: "What this does at a table, and what it does not do yet.",
      scenario: { variantKey: VARIANT },
      render: () => <FaqPage />,
    },
    {
      route: "handover",
      screen: "page",
      state: "handover-seat",
      title: "Handover: a power",
      note: "The page a handover code opens (ADR-041). It takes the seat only when the button is pressed.",
      scenario: { variantKey: VARIANT },
      render: () => (
        <HandoverPage gameId={live.gameId} power="Austria" epoch="1" signature="fixture" />
      ),
    },
    {
      route: "handover-gm",
      screen: "page",
      state: "handover-gm",
      title: "Handover: the game master role",
      note: "The other half of ADR-041: the rights travel and a power does not.",
      scenario: { variantKey: VARIANT },
      render: () => (
        <HandoverPage gameId={live.gameId} power={null} epoch="1" signature="fixture" />
      ),
    },
    {
      route: "mapeditor",
      screen: "page",
      state: "mapeditor",
      title: "The map editor",
      note: "The placement table for one variant (ADR-030). Read-only in a shipped build; it saves only in dev.",
      scenario: { variantKey: VARIANT },
      render: () => (
        <Suspense fallback={<p className="page muted">Loading the editor…</p>}>
          <MapEditorPage />
        </Suspense>
      ),
    },
    {
      route: "recover",
      screen: "page",
      state: "recover",
      title: "Take a game back",
      note: "The twelve words (ADR-048). The only screen in the app somebody types a secret into.",
      scenario: { variantKey: VARIANT },
      render: () => <RecoverPage gameId={live.gameId} />,
    },
  );

  return list;
}

/*
The referee guide on its own.

It is a thing a player opens over the board, and on the seat page it is behind
a button and a review. Here it is the screen, mounted the way the pages mount
it — the same ModalLayer, the same component, fed by refereeGuide() reading the
same fixture.
*/
function GuideOnly() {
  const guide = useMemo(() => refereeGuide(fx.seat("seat-retreat").previousPhase), []);
  const [open, setOpen] = useState(true);
  if (!guide) return null;
  return open ? (
    <ModalLayer onClose={() => setOpen(false)}>
      <RefereeGuide guide={guide} onClose={() => setOpen(false)} />
    </ModalLayer>
  ) : (
    <main className="page">
      <button type="button" onClick={() => setOpen(true)}>
        Open the guide again
      </button>
    </main>
  );
}

// --- the chrome -----------------------------------------------------------

const WIDTHS = [
  { key: "390", label: "Phone 390", width: 390, height: 780 },
  { key: "844", label: "Landscape 844", width: 844, height: 390 },
  { key: "full", label: "Desktop", width: 0, height: 0 },
];

const STYLES = ["", "parchment", "midnight", "print", "flat"];

interface Controls {
  screen: string;
  state: string;
  theme: string;
  w: string;
  style: string;
}

function readControls(list: Entry[]): Controls {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get("screen") || list[0].screen;
  const wanted = params.get("state");
  const found =
    list.find((one) => one.screen === screen && one.state === wanted) ||
    list.find((one) => one.screen === screen) ||
    list[0];
  return {
    screen: found.screen,
    state: found.state,
    theme: params.get("theme") === "light" ? "light" : "dark",
    w: WIDTHS.some((one) => one.key === params.get("w")) ? params.get("w")! : "full",
    style: STYLES.includes(params.get("style") || "") ? params.get("style") || "" : "",
  };
}

function addressOf(controls: Controls, framed: boolean): string {
  const params = new URLSearchParams({
    screen: controls.screen,
    state: controls.state,
    theme: controls.theme,
    w: controls.w,
  });
  if (controls.style) params.set("style", controls.style);
  if (framed) params.set("frame", "1");
  return "/dev/screens?" + params.toString();
}

/*
The page itself, in an iframe.

A div with a width on it is not a phone: media queries, 100vh and every
position:fixed sheet in the app answer to the viewport, not to a box drawn
inside it. So the frame is a real one, loading this same route with frame=1,
and inside it the page believes it is 390 points wide because it is. That is
also why the frame is the only honest way to look at the layout the players
will actually hold.
*/
function Frame({ controls }: { controls: Controls }) {
  const size = WIDTHS.find((one) => one.key === controls.w) || WIDTHS[2];
  const src = addressOf(controls, true);
  return (
    <div className={size.width ? "gallery-stage framed" : "gallery-stage"}>
      <iframe
        key={src}
        className="gallery-frame"
        title={controls.screen + " " + controls.state}
        src={src}
        style={
          size.width ? { width: size.width + "px", height: size.height + "px" } : undefined
        }
      />
    </div>
  );
}

export function Gallery() {
  const catalogue = useMemo(buildCatalogue, []);
  const [controls, setControls] = useState<Controls>(() => readControls(catalogue));
  const framed = new URLSearchParams(window.location.search).get("frame") === "1";

  const entry =
    catalogue.find((one) => one.screen === controls.screen && one.state === controls.state) ||
    catalogue[0];

  useEffect(() => {
    if (!framed) window.history.replaceState(null, "", addressOf(controls, false));
  }, [controls, framed]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", controls.theme);
    return () => document.documentElement.removeAttribute("data-theme");
  }, [controls.theme]);

  useEffect(() => installCapture(), []);

  /*
  The style is a device preference the pages read out of localStorage
  themselves (style.ts). The control writes it there, which is exactly what a
  player's own picker does, and the frame is reloaded on the new address.
  */
  useEffect(() => {
    try {
      if (controls.style) window.localStorage.setItem(STYLE_KEY, controls.style);
      else window.localStorage.removeItem(STYLE_KEY);
    } catch {
      // A locked-down browser draws the server's default. Nothing else breaks.
    }
  }, [controls.style]);

  // Inside the frame there is no chrome: the page is the whole document.
  if (framed) return <Screen entry={entry} />;

  return (
    <div className="gallery">
      <nav className="gallery-rail">
        <h1>Screens</h1>
        <ul className="gallery-list">
          {catalogue.map((one) => (
            <li key={one.screen + "/" + one.state}>
              <button
                type="button"
                className={one === entry ? "gallery-pick on" : "gallery-pick"}
                onClick={() =>
                  setControls((now) => ({ ...now, screen: one.screen, state: one.state }))
                }
              >
                <span className="gallery-screen">{one.screen}</span>
                <span className="gallery-title">{one.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="gallery-main">
        <header className="gallery-bar">
          <div className="gallery-what">
            <strong>
              {entry.screen} · {entry.state}
            </strong>
            <span>{entry.note}</span>
          </div>
          <div className="gallery-controls">
            <label>
              Theme
              <select
                value={controls.theme}
                onChange={(e) => setControls((now) => ({ ...now, theme: e.target.value }))}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label>
              Width
              <select
                value={controls.w}
                onChange={(e) => setControls((now) => ({ ...now, w: e.target.value }))}
              >
                {WIDTHS.map((one) => (
                  <option key={one.key} value={one.key}>
                    {one.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Map style
              <select
                value={controls.style}
                onChange={(e) => setControls((now) => ({ ...now, style: e.target.value }))}
              >
                <option value="">Server default</option>
                {STYLES.filter(Boolean).map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <Frame controls={controls} />
      </div>
    </div>
  );
}

/*
One screen, with the fixture wired in behind it.

The stub is installed before the page mounts and taken down when it unmounts,
so switching screens never leaves a wrapper behind. The review's own dismissal
is set or cleared here too: that is how a player's device decides whether the
review opens, so the gallery sets it and lets the page decide for itself.
*/
function Screen({ entry }: { entry: Entry }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const seat = entry.scenario.seat;
    const gm = entry.scenario.gm;
    const previous = seat?.previousPhase || gm?.previousPhase;
    const gameId = fx.gameIdOf(seat || gm);
    if (previous) {
      const mark = reviewKey(gameId, previous);
      if (entry.showReview) {
        try {
          window.localStorage.removeItem(mark);
        } catch {
          // Then it opens anyway, which is what this screen wanted.
        }
      } else {
        dismiss(mark);
      }
    }
    const remove = installStub(entry.scenario);
    setReady(true);
    return () => {
      setReady(false);
      remove();
    };
  }, [entry]);

  return ready ? <>{entry.render()}</> : null;
}
