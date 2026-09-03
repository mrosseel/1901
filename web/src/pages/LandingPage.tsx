import type { CSSProperties } from "react";

import { classicalMapUrl } from "../variants";

/*
The front door (ADR-043).

Everything else in this app is a working screen behind a token. This is the
one page a stranger meets, so it answers the two questions a stranger has —
what is this, and what do I press — and then gets out of the way. The game
list it used to stand on moved to /games, and this page links there twice.

The art is the Classical board, served from the same address the gallery and
the seat page ask for. Nothing here is a new asset: the hero and the closing
band wash the map behind the words, and the phone shows a crop of it at full
strength, because the map is the product and a drawing of one is not.
*/

/* Where the map is cropped for the phone, in the art's own coordinates. The
   board is 1524 by 1357; this window runs from the English Channel to
   Vienna, which is the part of the map a first game happens in. */
const CROP = { x: 180, y: 480, w: 850, h: 473 };

/* The width the phone screen is drawn at, and what that makes the scale. */
const SCREEN = 316;
const SCALE = SCREEN / CROP.w;

/* Four home units of the 1901 start position, at the anchors the board reads
   from the variant's own placement table (variants/generated/classical), in
   the colours the board paints them. A round piece is an army and a square
   one a fleet, as everywhere else, which is why London is square. */
const PIECES = [
  { power: "France", color: "#4fa3e0", x: 408.1, y: 899.94, fleet: false },
  { power: "England", color: "#7c5cd6", x: 396.63, y: 724.08, fleet: true },
  { power: "Germany", color: "#8d8d8d", x: 715.11, y: 702.77, fleet: false },
  { power: "Austria", color: "#e05252", x: 790.47, y: 876.82, fleet: false },
];

/* The sandbox panel's power list, in the same colours the board paints. The
   counts are what a driver sees: how many orders each power has in so far. */
const SANDBOX_POWERS = [
  { power: "Austria", color: "#e05252", orders: "3 in" },
  { power: "England", color: "#7c5cd6", orders: "3 in" },
  { power: "France", color: "#4fa3e0", orders: "2 in" },
  { power: "Germany", color: "#8d8d8d", orders: "none yet" },
];

function pieceStyle(piece: (typeof PIECES)[number]): CSSProperties {
  return {
    left: (piece.x - CROP.x) * SCALE - 11,
    top: (piece.y - CROP.y) * SCALE - 11,
    background: piece.color,
    borderRadius: piece.fleet ? 4 : "50%",
  };
}

export function LandingPage() {
  const map = classicalMapUrl();
  return (
    <main className="landing">
      <header className="lp-bar">
        <span className="lp-mark">1901</span>
        <span className="lp-tag">Diplomacy at a table</span>
        <nav className="lp-nav">
          <a href="#turn">How a turn runs</a>
          <a href="/variants">Variants</a>
          <a href="/sandbox">Sandbox</a>
          <a href="/games">Games</a>
          <a href="/recover">Return to a game</a>
          <a href="/faq">Questions</a>
          <a className="cta" href="/new">
            Create a game
          </a>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-wash" style={{ backgroundImage: "url(" + map + ")" }} />
        <div className="lp-hero-body">
          <div className="lp-hero-words">
            <p className="lp-eyebrow">Free and open source</p>
            <h1 className="lp-title">
              Wage diplomacy
              <br />
              face-to-face.
            </h1>
            <p className="lp-tagline">Face-to-face or gunboat play.</p>
            <p className="lp-lead">
              Everyone at the table enters orders on their own phone, at the same time.
              The server resolves the phase and prints the list of pieces to push.
            </p>
            <div className="lp-actions">
              <a className="lp-primary" href="/new">
                Create a game
              </a>
              <a className="lp-secondary" href="/games">
                Watch a game
              </a>
            </div>
            <p className="note">No accounts. No app to install. One QR code seats the table.</p>
          </div>

          <div className="lp-phone" aria-hidden="true">
            <div className="lp-screen">
              <div className="lp-screen-map">
                <img
                  src={map}
                  alt=""
                  style={{
                    /* Both sides are given: the served art sizes itself to
                       its box, so a width alone leaves the height to a
                       guess and the crop lands somewhere else. */
                    width: 1524 * SCALE,
                    height: 1357 * SCALE,
                    left: -CROP.x * SCALE,
                    top: -CROP.y * SCALE,
                  }}
                />
                {PIECES.map((piece) => (
                  <span key={piece.power} className="lp-piece" style={pieceStyle(piece)} />
                ))}
              </div>
              <div className="lp-screen-body">
                <div className="you-are" style={{ "--power": "#4fa3e0" } as CSSProperties}>
                  <div className="you-are-piece" />
                  <div>
                    <p className="you-are-label">You are</p>
                    <p className="lp-screen-power">France</p>
                  </div>
                </div>
                <p className="lp-screen-phase">
                  <span className="phase-season is-spring">Spring</span> 1901
                  <br />
                  <span className="phase-type is-movement sn-spring">Movement</span>
                </p>
                <ul className="lp-screen-orders">
                  <li>A Par &rarr; Bur</li>
                  <li>A Mar S A Par &rarr; Bur</li>
                  <li>F Bre &rarr; MAO</li>
                </ul>
                <div className="lp-screen-lock">
                  <span className="lock-main">Mark orders ready</span>
                  <span className="lock-sub">4 of 7 players ready</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-facts">
        <div>
          <p className="lp-fact">26</p>
          <p className="note">variants, Classical through Sail Ho!</p>
        </div>
        <div>
          <p className="lp-fact">4</p>
          <p className="note">map styles, including print and parchment</p>
        </div>
        <div>
          <p className="lp-fact">0</p>
          <p className="note">accounts, names or passwords</p>
        </div>
        <div>
          <p className="lp-fact">185/185</p>
          <p className="note">
            <a href="/datc">DATC cases</a>, run on every push
          </p>
        </div>
      </section>

      <section className="lp-section" id="turn">
        <h2 className="lp-head">How a turn runs</h2>
        <div className="lp-cards three">
          <article className="lp-card">
            <QrIcon />
            <p className="lp-card-head">One QR code seats the table</p>
            <p className="note">
              The game master shares a single code. Scanning it deals a random power.
              Nobody types a name or a password.
            </p>
          </article>
          <article className="lp-card">
            <TapIcon />
            <p className="lp-card-head">Tap the unit, tap the target</p>
            <p className="note">
              Supports and convoys build the same way. You see your own orders and
              nobody else's, on the map you are already looking at.
            </p>
          </article>
          <article className="lp-card">
            <ResolveIcon />
            <p className="lp-card-head">Everyone is ready, the phase resolves</p>
            <p className="note">
              A review screen shows every order, with the failures struck out and the
              reason beside them.
            </p>
          </article>
        </div>
      </section>

      <section className="lp-section lp-split">
        <div>
          <h2 className="lp-head small">A list for whoever pushes the pieces</h2>
          <p className="lp-body">
            Playing with a physical board is optional. If you do, whoever keeps it gets
            one line per act after the phase resolves, in big type, with a tick box. Read
            it, move it, tick it. The pieces that stay put are listed too, quietly, so
            none of them gets missed.
          </p>
          <p className="note">
            Without a board, the map on the screen is the board. Every phase also has a
            login-free spectator page for the beamer at the back of the room, and those
            links never expire.
          </p>
        </div>
        <div className="lp-sheet">
          <p className="lp-sheet-head">Move the pieces &middot; Spring 1901</p>
          <ul className="lp-sheet-list">
            <li>
              <span className="lp-tick" />
              <span className="dot" style={{ background: "#4fa3e0" }} />
              <span>Army Paris to Burgundy</span>
            </li>
            <li>
              <span className="lp-tick" />
              <span className="dot" style={{ background: "#e05252" }} />
              <span>Fleet Trieste to Albania</span>
            </li>
            <li>
              <span className="lp-tick" />
              <span className="dot" style={{ background: "#e8e8e8" }} />
              <span>Army Moscow to Ukraine</span>
            </li>
            <li className="failed">
              <span className="lp-tick" />
              <span className="dot" style={{ background: "#8d8d8d" }} />
              <span>Army Munich to Burgundy</span>
              <span className="lp-why">bounced</span>
            </li>
          </ul>
          <p className="note">Everything else holds.</p>
        </div>
      </section>

      <section className="lp-section lp-split">
        <div>
          <h2 className="lp-head small">A board you can play on your own</h2>
          <p className="lp-body">
            A sandbox is a game with no players. You hold one link, you order every
            power, and you press adjudicate. No seats, no clock, nobody to wait for.
          </p>
          <p className="note">
            Work through an opening. Check what a convoy really does. Type in a
            tournament board and hand somebody the link. The game id on its own is
            the same public, permanent spectator page every played game gets, so a
            sandbox can be cited and read by anyone, forever.
          </p>
          <div className="lp-actions">
            <a className="lp-primary" href="/sandbox">
              Open a sandbox
            </a>
          </div>
        </div>
        <div className="lp-sheet">
          <p className="lp-sheet-head">Ordering as</p>
          <ul className="lp-sheet-list">
            {SANDBOX_POWERS.map((one) => (
              <li key={one.power}>
                <span className="dot" style={{ background: one.color }} />
                <span>{one.power}</span>
                <span className="lp-why">{one.orders}</span>
              </li>
            ))}
          </ul>
          <p className="note">Every power is yours. Tap one and order it.</p>
        </div>
      </section>

      <section className="lp-section lp-band">
        <h2 className="lp-head small">Built for any room</h2>
        <div className="lp-cards two">
          <article className="lp-card">
            <p className="lp-card-head">Orders are accepted as entered</p>
            <p className="note">
              The server can accept an invalid order instead of blocking entry. Your own
              device marks it and says what the rules will do before you are ready.
            </p>
          </article>
          <article className="lp-card">
            <p className="lp-card-head">It runs on venue wifi, or none</p>
            <p className="note">
              One binary and a SQLite file on a laptop. Phones reach it over the room's
              own network. Nothing calls home.
            </p>
          </article>
          <article className="lp-card">
            <p className="lp-card-head">A spectator URL for every phase</p>
            <p className="note">
              No login, no expiry. Put it on the beamer, or hand it to the player who was
              knocked out in 1904.
            </p>
          </article>
          <article className="lp-card">
            <p className="lp-card-head">The game master cannot peek</p>
            <p className="note">
              Your orders never reach the server unsealed. Locking sends them encrypted
              under a key your phone keeps, and the key goes up only once every power has
              ready. A game master who also plays holds the encrypted envelopes and no key
              to any of them while ordering remains open.
            </p>
          </article>
        </div>
      </section>

      <section className="lp-close">
        <div className="lp-wash" style={{ backgroundImage: "url(" + map + ")" }} />
        <div className="lp-close-body">
          <h2 className="lp-head">Seven players. One QR code.</h2>
          <p className="lp-body">
            Set the deadline, share the code, and start the spring of 1901.
          </p>
          <a className="lp-primary" href="/new">
            Create a game
          </a>
        </div>
      </section>

      <footer className="lp-foot">
        <span className="lp-mark">1901</span>
        <a href="/games">Games</a>
        <a href="/new">New game</a>
        <a href="/variants">Variants</a>
        <a href="/sandbox">Sandbox</a>
        <a href="/faq">Questions</a>
        <span className="note">
          GPL-3.0. Adjudication by godip. Diplomacy is a trademark of Hasbro / Avalon
          Hill. This project is not affiliated with or endorsed by Hasbro, and ships no
          Hasbro artwork. Maps are community drawn and credited in-app.
        </span>
      </footer>
    </main>
  );
}

/* The three marks above the steps. Drawn rather than lettered: they sit at
   28px, where a glyph from a font would be soft and an emoji would be
   somebody else's drawing. */

function QrIcon() {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3z" />
      <path d="M20 14v3M17 20h4" />
    </svg>
  );
}

function TapIcon() {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 11V9.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M15 11v-1a1.5 1.5 0 0 1 3 0v5.5a5.5 5.5 0 0 1-5.5 5.5H11a5 5 0 0 1-4.3-2.5L4.5 15a1.5 1.5 0 0 1 2.4-1.7L9 15" />
    </svg>
  );
}

function ResolveIcon() {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.2" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M19 3v3.5h-3.5" />
      <path d="M5 21v-3.5h3.5" />
    </svg>
  );
}
