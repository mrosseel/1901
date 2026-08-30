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
      <main className="page wide">
        <h1>Questions</h1>
        <p className="lead">
          What this does at a table, and what it does not do yet.
        </p>

        <section className="card">
          <h2>Do I need an account?</h2>
          <p>
            No. There are no accounts, names or passwords anywhere in this app. The game
            master shares one invite link or QR code, scanning it deals you a random power,
            and the address in your browser is your seat.
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
        </section>

        <section className="card">
          <h2>What if the game master loses their link?</h2>
          <p>
            The game master's screen carries a <strong>If you lose this screen</strong>{" "}
            card. It shows that page's own address, to keep on a second device, and it
            offers a key: twelve words, written on this app's screen and nowhere else.
          </p>
          <p>
            Typing the words at <a href="/recover">/recover</a> gives the game back on any
            device. The server is handed a public half that opens nothing, so it cannot
            run your game and cannot help anybody who does not have the words.
          </p>
          <p className="note">
            A game whose game master never made a key has no recovery. Nothing on the
            server can give the role back, because nothing on the server is the role.
          </p>
        </section>

        <section className="card">
          <h2>Can the game master read my orders?</h2>
          <p>
            Today, yes, if they go looking: the orders are on the server and the game master
            runs the server. Nothing on any screen shows them another player's draft, but
            that is a matter of what the screens draw, not of what is possible.
          </p>
          <p className="note">
            Commit-reveal order secrecy, which would make it impossible rather than merely
            impolite, is designed and not built.
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
            act after each turn resolves, in big type, with a tick box, so whoever pushes
            the pieces can read it at a glance.
          </p>
        </section>

        <section className="card">
          <h2>Can I write an order the rules do not allow?</h2>
          <p>
            Yes, and it is on by default. Claiming you misordered is a time-honoured way to
            lie, so the server takes the order as written, marks it, and resolves it as a
            hold. Your own device warns you in amber before you lock it in.
          </p>
        </section>

        <section className="card">
          <h2>Which variants are there?</h2>
          <p>
            Twenty-six, from Classical through Sail Ho!, in four map styles. The gallery on
            the <a href="/new">New game</a> screen shows every board, and a tick marks the
            ones whose piece placement has been checked.
          </p>
        </section>

        <section className="card">
          <h2>Who adjudicates?</h2>
          <p>
            <a href="https://github.com/zond/godip">godip</a>, which has survived a decade of
            real games and is tested here against the DATC corpus on every push.
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
