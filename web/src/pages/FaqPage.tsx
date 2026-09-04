import { TopBar } from "../components/TopBar";

/*
The questions a first table asks.

Every answer here is a fact about what this server does, not a pitch. Where
something is not built yet it says so, because a player who reads "the game
master cannot see your orders" and then watches the game master see their
orders has been lied to by their own tool.
*/
export function FaqPage() {
  return (
    <>
      <TopBar here="faq" />
      <main className="page wide faq">
        <h1>Questions</h1>
        <p className="lead">
          What this does at a table, and what it does not do yet.
        </p>

        <section className="card">
          <h2>Do I need an account?</h2>
          <p>
            No. This app has no accounts, names or passwords. The game master shares one
            invite link or QR code, and scanning it deals you a random power.
          </p>
          <p>
            Your phone makes the seat's key itself and keeps it. The server holds a
            public half that opens nothing, so a copy of its database is not a set of
            seats. To play the same power on a second device, open the seat menu and use{" "}
            <strong>Back up or open this seat on another device</strong>: the key rides in the part of the
            address after the #, which no browser ever sends to a server.
          </p>
        </section>

        <section className="card">
          <h2>What happens if my phone dies?</h2>
          <p>
            Your power can be handed to another phone. Tap the icon beside your power and
            show the QR code; whoever scans it takes the seat, and yours stops working the
            moment they do.
          </p>
          <p>
            If the phone is already dead, the game master can mint the same link for any
            power from their own screen. That is logged, because a game master who can hand
            out any seat can take any seat, and the record is what keeps it visible.
          </p>
          <p className="note">
            The phone that takes the seat makes a new key. The phone that gave it away
            keeps nothing that opens the seat.
          </p>
        </section>

        <section className="card">
          <h2>What if the game master loses their link?</h2>
          <p>
            The game master's screen carries a{" "}
            <strong>Back up the game master key</strong> card. It offers twelve words,
            written on that screen and nowhere else.
          </p>
          <p>
            Typing the words at <a href="/games#recover">/games#recover</a> gives the game
            back on any device. The server holds a public half that opens nothing. It
            cannot run your game, and it cannot help anybody without the words.
          </p>
          <p className="note">
            A game whose game master never made a key has no recovery. Nothing on the
            server is the role, so nothing on the server can give it back.
          </p>
        </section>

        <section className="card">
          <h2>Can the game master read my orders?</h2>
          <p>
            Not from the server while the phase is open. Your draft stays on your phone.
            Marking ready sends an encrypted envelope. The key goes up only after every
            required power is ready, when orders become public for adjudication.
          </p>
          <p className="note">
            This protects against ordinary server-side peeking. A game master who controls
            the server could still serve altered browser code, so use a server and network
            the table trusts.
          </p>
        </section>

        <section className="card">
          <h2>Do we need the physical board?</h2>
          <p>
            No. The map on the screen is the board, and every phase has a spectator page
            with no login that can go on a shared screen or a projector.
          </p>
          <p>
            If you are playing on a real board, the game master's screen prints one line per
            act after each phase resolves, in big type, with a tick box, so whoever pushes
            the pieces can read it at a glance.
          </p>
        </section>

        <section className="card">
          <h2>Can I write an order the rules do not allow?</h2>
          <p>
            Yes, by default. The server accepts the order as entered and your device marks
            it before you declare readiness. An invalid movement order holds, an invalid
            retreat disbands, and the normal adjustment rules handle an invalid build or removal.
          </p>
        </section>

        <section className="card">
          <h2>Which variants are there?</h2>
          <p>
            Twenty-six, from Classical through Sail Ho!, in four map styles. The gallery on
            the <a href="/new">New game</a> screen shows every board. Each card says whether
            its starting positions and board art have been verified for live play.
          </p>
        </section>

        <section className="card">
          <h2>Who adjudicates?</h2>
          <p>
            <a href="https://github.com/zond/godip">godip</a>, tested here against the DATC
            corpus on every push. The score, and what it leaves out, is on{" "}
            <a href="/datc">the adjudication page</a>.
          </p>
        </section>

        <section className="card">
          <h2>How does a game end?</h2>
          <p>
            On a solo, when one power holds enough supply centres. That is
            eighteen on the classical board. On an inclusive draw, which the table agrees and the game
            master records. A proposal excluding a survivor ends only after every excluded
            survivor confirms it from their own seat. Or at an end year, if the game was
            created with one. An ended game freezes. The result and the supply centre
            counts stay on the spectator link forever.
          </p>
        </section>

        <section className="card">
          <h2>Is it free?</h2>
          <p>
            Yes. GPL-3.0, inherited from godip. Diplomacy is a trademark of Hasbro / Avalon
            Hill and the rules are their copyright; this project is not affiliated with or
            endorsed by Hasbro, ships no Hasbro artwork, and assumes you own a copy of the
            board game. The maps are community drawn and credited in-app.
          </p>
        </section>
      </main>
    </>
  );
}
