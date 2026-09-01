import { useState } from "react";
import { recoverChallenge, recoverClaim } from "../api";
import { TopBar } from "../components/TopBar";
import { entropyFor, signMessage, writeStoredKey } from "../gmkey";
import { readRecentGame } from "../recent";
import { readSeatSeed } from "../seatkey";

/*
Taking the game master role back with twelve words (ADR-048).

This is the only screen in the app somebody types a secret into, and it exists
because the role is the only thing here that cannot be handed back. Everything
else has a person on the other side: a lost seat is one link from the game
master, and a game master who is merely changing device hands the role over
(ADR-041). This is for the case where there is nobody to ask.

The words never leave the browser. They rebuild the key, the key signs a
sentence the server made up, and the signature is what the server checks
against the public half it was given when the key was made. What travels is 64
bytes that prove the words without carrying them.
*/
export function RecoverPage({ gameId }: { gameId: string | null }) {
  const [id, setId] = useState(gameId || "");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = words.trim().split(/\s+/).filter(Boolean).length;
  const ready = id.trim() !== "" && typed === 12;
  const recent = readRecentGame();
  const playerId = id.trim();
  const heldSeat = playerId !== "" && Boolean(readSeatSeed(playerId));

  const recover = async () => {
    setError(null);
    const entropy = entropyFor(words);
    if (!entropy) {
      // The checksum is what catches this, and it catches it here rather
      // than after a round trip: a wrong word is a typo, not a rejection.
      setError("Those are not twelve words from the list. Check the spelling and the order.");
      return;
    }
    setBusy(true);
    try {
      const game = id.trim();
      const challenge = await recoverChallenge(game);
      const { gmUrl } = await recoverClaim(
        game,
        challenge.nonce,
        signMessage(entropy, challenge.message),
      );
      // This device now holds the key, so it can show the words again and
      // the game master is not one lost tab from doing this a second time.
      // Keyed by the game the server answered for, never by what was typed.
      writeStoredKey(challenge.gameId, entropy);
      window.location.href = gmUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Return to a game</h1>
        <p className="lead">
          Reopen a seat held on this device, use a saved backup link on a new device,
          or recover the game-master role with its twelve words.
        </p>

        {error ? <p className="error">{error}</p> : null}

        <section className="card">
          <h2>Return as a player</h2>
          {recent ? (
            <p>
              <a className="cta" href={recent.url}>
                Back to {recent.label}{recent.power ? " as " + recent.power : ""}
              </a>
            </p>
          ) : null}
          <label className="field">
            <span>Game id</span>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
            <small>The id is shown on the game list and can be copied by the game master.</small>
          </label>
          <a
            className={heldSeat ? "cta" : "cta disabled"}
            aria-disabled={!heldSeat}
            href={heldSeat ? "/game/" + encodeURIComponent(playerId) + "/seat/me" : undefined}
          >
            {heldSeat ? "Open my seat" : "No seat key for this game on this device"}
          </a>
          <p className="note">
            After a connection loss, the same seat signs itself back in automatically.
            On a replacement device, open the backup link you saved earlier. With neither
            the old device nor a backup link, ask the game master for a replacement link;
            that action is recorded and may be subject to tournament rules.
          </p>
        </section>

        <section className="card">
          <h2>Recover the game-master role</h2>
          <p>
            Type the twelve words shown when the game's recovery key was made. The words
            stay in this browser; the server receives only a signed challenge.
          </p>
          <label className="field">
            <span>The twelve words</span>
            <textarea
              rows={4}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={words}
              onChange={(event) => setWords(event.target.value)}
            />
            <small>
              {typed === 0
                ? "Separate them with spaces. Capitals do not matter."
                : typed + " of 12 words"}
            </small>
          </label>
          <button type="button" className="primary" disabled={!ready || busy} onClick={recover}>
            {busy ? "Checking…" : "Recover game-master access"}
          </button>
          <p className="note">
            This ends the game master's old address. Whoever was running the game with it
            stops being the game master, which is what makes this a recovery and not a
            second key to the same door.
          </p>
        </section>

        <section className="card">
          <h2>If there are no game-master words</h2>
          <p>
            Then there is no recovery. A game with no key is a game whose role lives only
            on the device that created it, and the server holds nothing that can give it
            back. What it can still do is carry on: the game master's screen has a{" "}
            <strong>Hand over</strong> card that moves the role to another device while
            the first one still works.
          </p>
        </section>
      </main>
    </>
  );
}
