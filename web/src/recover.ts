/*
Taking the game-master role back (ADR-048).

Two things start this, and they differ only in where the sixteen bytes came
from: twelve typed words, or a key this browser already stored. Everything
after that is the same three steps, so they live here rather than twice on the
page that offers both.

The entropy never leaves the browser. It rebuilds the key, the key signs a
sentence the server made up, and the signature is what the server checks
against the public half it was given when the key was made. What travels is 64
bytes that prove the words without carrying them.
*/

import { recoverChallenge, recoverClaim } from "./api";
import { signMessage, writeStoredKey } from "./gmkey";

/*
Runs the recovery and answers with the game master's new address.

The key is written under the game the server answered for, never under what
was typed, and it is written on success: this device now holds it, so the role
is not one lost tab away from being recovered a second time.
*/
export async function recoverGameMaster(
  gameId: string,
  entropy: Uint8Array,
): Promise<string> {
  const challenge = await recoverChallenge(gameId);
  const { gmUrl } = await recoverClaim(
    gameId,
    challenge.nonce,
    signMessage(entropy, challenge.message),
  );
  writeStoredKey(challenge.gameId, entropy);
  return gmUrl;
}
