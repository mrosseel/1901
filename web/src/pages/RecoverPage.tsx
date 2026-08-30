import { useState } from "react";
import { recoverChallenge, recoverClaim } from "../api";
import { TopBar } from "../components/TopBar";
import { entropyFor, signMessage, writeStoredKey } from "../gmkey";

/*
Taking the game master role back with twelve words (D-048).

This is the only screen in the app somebody types a secret into, and it exists
because the role is the only thing here that cannot be handed back. Everything
else has a person on the other side: a lost seat is one link from the game
master, and a game master who is merely changing device hands the role over
(D-041). This is for the case where there is nobody to ask.

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
        <h1>Take a game back</h1>
        <p className="lead">
          For a game master who has lost the address. Type the twelve words that were
          shown when the game's key was made.
        </p>

        {error ? <p className="error">{error}</p> : null}

        <section className="card">
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
          </label>
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
            {busy ? "Checking…" : "Take the game back"}
          </button>
          <p className="note">
            This ends the game master's old address. Whoever was running the game with it
            stops being the game master, which is what makes this a recovery and not a
            second key to the same door.
          </p>
        </section>

        <section className="card">
          <h2>If there are no words</h2>
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
