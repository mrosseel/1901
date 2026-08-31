import { useState } from "react";
import type { GmClient } from "../api";
import { copyText } from "../clipboard";
import { gmPublicKey, makeEntropy, readStoredKey, wordsFor, writeStoredKey } from "../gmkey";

/*
The twelve words, on the game master's own screen (ADR-048).

The role is the one thing in this app that cannot be handed back to you. A
player who loses their phone gets a new link from the game master; the game
master has nobody to ask. So this browser makes a key, the server keeps the
public half, and the words are the copy that outlives the device.

Nothing here is compulsory. A game master at a tournament, three minutes before
the round, may skip it and run the game exactly as before — with no way back if
the laptop dies. The card says which of those two states the game is in and
never nags.

The words are a secret on a screen that is often the one on the beamer, so they
are drawn only when somebody asks for them, and the asking is a button press
and not a page load.
*/
export function GmKeyCard({
  gameId,
  client,
  hasKey,
  onMade,
}: {
  gameId: string;
  client: GmClient;
  /** What the server says: whether this game has a public half at all. */
  hasKey: boolean;
  /** Called after a key is registered, so the page rereads its state. */
  onMade: () => void;
}) {
  const [entropy, setEntropy] = useState<Uint8Array | null>(() => readStoredKey(gameId));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const words = entropy ? wordsFor(entropy) : null;

  const make = async () => {
    setError(null);
    setBusy(true);
    try {
      const fresh = makeEntropy();
      // The server first. If it refuses, this device must not be left
      // holding a key the game does not know about.
      await client.setKey(gmPublicKey(fresh));
      writeStoredKey(gameId, fresh);
      setEntropy(fresh);
      setShown(true);
      onMade();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!words) return;
    setCopied((await copyText(words.join(" "))) ? "Copied" : "Copy failed — write them down");
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <section className="share">
      <h2>The twelve words</h2>

      {error ? <p className="error">{error}</p> : null}

      {!hasKey ? (
        <>
          <p className="note">
            This game has no key. If this browser loses the address, nobody can run the
            game any more: there is no account to sign in to and no password to reset.
          </p>
          <p className="note">
            Making one writes twelve words on this screen. Write them on paper. Typing
            them back on any device gives you the game again, and the server never sees
            them: it is given a public half that cannot open anything.
          </p>
          <button type="button" className="primary" disabled={busy} onClick={make}>
            {busy ? "Making the key…" : "Make a key and show the words"}
          </button>
        </>
      ) : words ? (
        <>
          <p className="note">
            This game has a key and this device holds it. The words are the only other
            copy. Write them down once and any device can take the game back.
          </p>
          <div className="share-actions">
            <button type="button" className="link" onClick={() => setShown(!shown)}>
              {shown ? "Hide the words" : "Show the words"}
            </button>
            <button type="button" onClick={copy}>
              {copied || "Copy the words"}
            </button>
          </div>
          {shown ? (
            <>
              <p className="note">
                This screen may be on a shared display. Whoever reads these twelve words
                can take the game.
              </p>
              <ol className="seed-words">
                {words.map((word, index) => (
                  <li key={word + index}>{word}</li>
                ))}
              </ol>
            </>
          ) : (
            <p className="share-hidden">Hidden. This screen may be on a shared display.</p>
          )}
        </>
      ) : (
        <>
          <p className="note">
            This game has a key, and it was made on another device. This one cannot show
            the words, and nothing on the server can: the private half never left the
            browser that made it.
          </p>
          <p className="note">
            With the words in hand, take the game back at{" "}
            <a href={"/recover/" + encodeURIComponent(gameId)}>/recover/{gameId}</a>. That
            address carries no secret and opens nothing on its own.
          </p>
        </>
      )}
    </section>
  );
}
