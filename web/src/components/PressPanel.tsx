import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PressApi } from "../api";
import { clockFace, msLeft } from "../clock";
import { usePoll, useTicker } from "../hooks";
import {
  GM_HOLDER,
  acceptPin,
  findRoom,
  holdersFor,
  keyBody,
  makeRoom,
  openMessage,
  openRoomKey,
  pinSignKeys,
  pressPublicKey,
  readPins,
  roomTitle,
  verifiers,
  sealMessage,
  signedBody,
  verifyPress,
  type PressPlace,
  type PressState,
  type PressThread,
  type Pins,
  type ReadMessage,
} from "../press";
import { PowerChip } from "./PowerChip";

/*
The press panel: what the envelope in the top bar opens (ADR-053).

It replaces the order panel below the divider and leaves the map and the
divider where they were, so a player reading a message can still see the board
being talked about, at whatever size they had already dragged it to.

Two levels, and only two. A list of rooms, and one room. A conversation at a
table has no folders.

The same component is the referee's mailbox (ADR-054). It takes a `PressApi`
rather than a seat client for that reason, and a `sign` of its own, because a
seat signs with its seat key and the game master with the key of ADR-048.

Everything readable here was decrypted on this device. The server holds
ciphertext, a member list and a time (press.ts); a room this device cannot open
is shown as a room it cannot open, never as an empty one.
*/
export function PressPanel({
  gameId,
  you,
  api,
  secret,
  sign,
  phaseIndex,
  powers,
  readOnly,
  initialThread,
  onUnread,
}: {
  gameId: string;
  /** A power's name, or GM_HOLDER for the referee's mailbox. */
  you: string;
  api: PressApi;
  /** This holder's press secret, for wrapping and unwrapping room keys. */
  secret: Uint8Array;
  /** This holder's signature over one body. */
  sign: (body: string) => string;
  /** Which phase a message written now belongs to. */
  phaseIndex: number;
  /** Every power of this variant, for the composer's chips. */
  powers: string[];
  /** The referee reads every room and writes only in the ones it opened. */
  readOnly?: boolean;
  /** The room to open at, rather than the list. */
  initialThread?: string;
  /** Told after every fetch, so the bar's badge follows the panel. */
  onUnread?: (unread: number) => void;
}) {
  const [state, setState] = useState<PressState | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(initialThread ?? null);
  const [composing, setComposing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [changedKeys, setChangedKeys] = useState<string[]>([]);
  /* Holders whose key changed with nothing signed behind it. Nothing is
     checked against one and no room is wrapped for one until the table says
     the seat really was handed on. */
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  /* Every signing key this device has ever seen for this game. A key the
     server stops sending is still checked against its pin, so taking one away
     cannot turn verification off. */
  const [pins, setPins] = useState<Pins>(() => readPins(gameId));
  const published = useRef(false);

  /* Read by every fetch and a dependency of none: a callback that re-made the
     effect that calls it would loop on its own answer. */
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;

  const refresh = useCallback(async () => {
    let next = await api.press();
    /*
    Publish this device's public press key the first time the panel is
    opened, and whenever the server holds a different one, which is what a
    handover leaves behind. It is signed with this holder's own key so a
    reader can tell it apart from a key the server made up (ADR-054).
    */
    const mine = pressPublicKey(secret);
    if (!published.current && next.keys[you] !== mine) {
      // Marked done only once it is done: a publish that failed on a bad
      // connection must be tried again on the next poll, or this device
      // spends the game unable to be written to.
      await api.pressKey(mine, sign(keyBody(gameId, you, mine)));
      published.current = true;
      next = await api.press();
    }
    setState(next);
    onUnreadRef.current?.(next.unread);
    /*
    A signing key that changed is a handover the table knows about, or a
    server handing out a key it invented, and only the room knows which. One
    that has vanished from the answer is neither, and it keeps its pin.
    */
    const seen = pinSignKeys(gameId, next.signKeys, next.signChains || []);
    setPins({ ...seen.pinned });
    setChangedKeys(seen.changed);
    setPendingKeys(seen.pending);
  }, [api, gameId, secret, sign, you]);

  useEffect(() => {
    refresh().catch((err) => setError(message(err)));
  }, [refresh]);
  usePoll(3000, () => refresh().catch(() => undefined));

  const reload = useCallback(() => {
    refresh().catch((err) => setError(message(err)));
  }, [refresh]);

  if (error && !state) return <p className="notice press-empty">{error}</p>;
  if (!state) return <p className="muted press-empty">Loading messages…</p>;

  /* One answer to "which key is this holder believed under", for wrapping,
     for reading a room's manifest, and for checking who said a line. */
  const believed = verifiers(pins, state.signKeys);

  const accept = (holder: string) => {
    setPins({ ...acceptPin(gameId, holder) });
    setPendingKeys(pendingKeys.filter((name) => name !== holder));
  };

  const thread = state.threads.find((row) => row.id === openThread);
  if (thread) {
    return (
      <PressRoom
        gameId={gameId}
        you={you}
        api={api}
        state={state}
        thread={thread}
        secret={secret}
        sign={sign}
        phaseIndex={phaseIndex}
        signKeys={believed.trusted}
        readOnly={Boolean(readOnly) && thread.openedBy !== you}
        onBack={() => setOpenThread(null)}
        onChanged={reload}
      />
    );
  }

  const notes = state.threads.find((row) => row.notes);
  const rooms = state.threads
    .filter((row) => !row.notes)
    .slice()
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));

  const openRoom = async (members: string[]) => {
    setError(null);
    try {
      /*
      The room these members already have, unless this device cannot open it.

      A handover leaves the previous player's rooms wrapped for a key this
      device does not hold (ADR-049), and handing one of those back would
      leave those powers unable to talk at all. So the server is asked for a
      fresh one, and the newest room is what the reuse rule finds afterwards.
      */
      const existing = findRoom(state.threads, members, you === GM_HOLDER);
      const readable =
        existing &&
        openRoomKey(gameId, you, existing, secret, believed.trusted).key !== null;
      if (existing && readable) {
        setComposing(false);
        setPicked([]);
        setOpenThread(existing.id);
        return;
      }
      const holders = holdersFor(members, state.gmReads);
      /* Checked against this answer where it has a key, and against what this
         device pinned where it does not. A handover really does change a
         seat's key, so a pin that refused the new one would end that seat's
         press; a key that has gone missing is the attack, and the pin is what
         catches it. */
      const made = makeRoom(gameId, you, secret, members, holders, {
        keys: state.keys,
        keySigs: state.keySigs,
        signKeys: believed.current,
        pending: believed.pending,
      }, sign);
      if (made.unverified.length) {
        /* A key that does not check is not a slow player; it is a room
           somebody else could read. Nothing is sent. */
        setError(
          "The key this server gave for " + made.unverified.join(" and ") +
            " is not signed by that power. Nothing was sent.",
        );
        return;
      }
      if (made.missing.length) {
        setError(
          made.missing.join(" and ") +
            " has not opened this game on a device yet, so there is nobody to send to.",
        );
        return;
      }
      const opened = await api.pressOpen({
        thread: made.room.threadId,
        members: made.room.members,
        openedAt: made.room.openedAt,
        openerBoxPub: made.room.openerBoxPub,
        sig: made.sig,
        keys: made.wraps,
        fresh: Boolean(existing),
      });
      setComposing(false);
      setPicked([]);
      await refresh();
      setOpenThread(opened.id);
    } catch (err) {
      setError(message(err));
    }
  };

  if (composing) {
    return (
      <section className="press">
        <header className="press-head">
          <button type="button" className="link" onClick={() => setComposing(false)}>
            ← Back
          </button>
          <h2>Who are you talking to?</h2>
        </header>
        {/* Tapping more than one power makes one room, not two messages.
            Everyone in it sees every reply, which is what happens when three
            people step into a corridor. */}
        <p className="muted">
          Everybody you pick is in the same conversation and sees every reply.
        </p>
        <div className="press-pick">
          {powers
            .filter((power) => power !== you)
            .map((power) => {
              const out = state.eliminated.includes(power);
              const on = picked.includes(power);
              return (
                <button
                  key={power}
                  type="button"
                  className={on ? "press-pick-one on" : "press-pick-one"}
                  aria-pressed={on}
                  disabled={out}
                  title={out ? power + " is eliminated and may not negotiate" : undefined}
                  onClick={() =>
                    setPicked(on ? picked.filter((name) => name !== power) : picked.concat(power))
                  }
                >
                  <PowerChip power={power} small />
                  {out ? <span className="muted"> out</span> : null}
                </button>
              );
            })}
        </div>
        {error ? <p className="notice">{error}</p> : null}
        <button
          type="button"
          className="press-open"
          disabled={!picked.length}
          onClick={() => openRoom(you === GM_HOLDER ? picked : picked.concat(you))}
        >
          {picked.length > 1 ? "Open a room with " + picked.length + " powers" : "Start writing"}
        </button>
      </section>
    );
  }

  return (
    <section className="press">
      <header className="press-head">
        <h2>Messages</h2>
        <button type="button" className="press-new" onClick={() => {
          setPicked([]);
          setError(null);
          setComposing(true);
        }}>
          New message
        </button>
      </header>

      {state.reason ? <p className="press-shut">{state.reason}</p> : null}
      {!state.reason && state.silenceAt ? (
        <SilenceLine silenceAt={state.silenceAt} />
      ) : null}
      {state.gmReads && you !== GM_HOLDER ? (
        <p className="muted press-gm-note">
          The game master reads every message in this game.
        </p>
      ) : null}
      {/* Not hidden and not fatal. A handover changes a seat's key, and so
          does a server that is lying about one; only the table knows which. */}
      {/* A key that changed with a signed handover behind it moved the pin on
          its own, and this is the rest: a key nothing signed for. Nothing is
          written to that seat until somebody at the table says what happened. */}
      {pendingKeys.map((holder) => (
        <p className="notice" key={holder}>
          The key for {holder} changed and nothing signed for the change. If
          the game master re-dealt that seat, say so out loud first. Until
          somebody confirms it, this device writes nothing to {holder}.{" "}
          <button type="button" className="link" onClick={() => accept(holder)}>
            The table confirms {holder} was handed on
          </button>
        </p>
      ))}
      {changedKeys.filter((holder) => !pendingKeys.includes(holder)).length ? (
        <p className="notice">
          The key for{" "}
          {changedKeys.filter((holder) => !pendingKeys.includes(holder)).join(" and ")}{" "}
          changed since this device last looked. That is what a handover does.
          If nobody at the table handed a seat on, stop writing and say so out
          loud.
        </p>
      ) : null}
      {error ? <p className="notice">{error}</p> : null}

      <ul className="press-list">
        {rooms.map((row) => (
          <li key={row.id}>
            <button type="button" className="press-row" onClick={() => setOpenThread(row.id)}>
              <span className="press-row-who">
                {roomTitle(row, you).map((member) => (
                  <PowerChip key={member} power={member} small />
                ))}
              </span>
              <span className="press-row-when">{shortTime(row.lastAt)}</span>
              {row.unread ? <span className="press-row-unread">{row.unread}</span> : null}
            </button>
          </li>
        ))}
        {/*
        The notepad, pinned last. It is a room with one member in it, so it
        costs no new idea and no new storage, and webDiplomacy's private notes
        tab is the most reused thing in its press UI. The referee has none: it
        holds no power and has nothing to plan.
        */}
        {you === GM_HOLDER ? null : (
          <li>
            <button
              type="button"
              className="press-row notes"
              onClick={() => (notes ? setOpenThread(notes.id) : openRoom([you]))}
            >
              <span className="press-row-who">Notes to myself</span>
              <span className="press-row-when">{notes ? shortTime(notes.lastAt) : ""}</span>
            </button>
          </li>
        )}
      </ul>

      {rooms.length === 0 ? (
        <p className="muted press-empty">
          Nothing yet. Only the powers in a conversation can read what is
          written in it. The server still knows who talks to whom, and when.
        </p>
      ) : null}
    </section>
  );
}

/*
One room: what was said, and the box to say something.

The messages are decrypted here rather than in the list, so the list costs one
request and this costs one more. A message whose signature does not check is
shown with a mark instead of being hidden, because a reader who is being lied
to needs to see the lie.
*/
function PressRoom({
  gameId,
  you,
  api,
  state,
  thread,
  secret,
  sign,
  phaseIndex,
  signKeys: keys,
  readOnly,
  onBack,
  onChanged,
}: {
  gameId: string;
  you: string;
  api: PressApi;
  state: PressState;
  thread: PressThread;
  secret: Uint8Array;
  sign: (body: string) => string;
  phaseIndex: number;
  /** Every key a sender may be believed under: the pinned one, then the ones
      it replaced, so a handover does not turn old lines into forgeries. */
  signKeys: Record<string, string[]>;
  readOnly: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<ReadMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /* The same guard as `sending`, in a ref. Two Enter presses inside one render
     both see the old state, and the second would seal the same words against
     the next sequence and store them twice. */
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);
  /* How far this device has told the server it has read. A ref, so marking
     read never re-makes the effect that marks read. */
  const marked = useRef(0);
  const signKeys = useRef(keys);
  signKeys.current = keys;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  /* The member list decides the room key, and it arrives as a fresh array on
     every poll. Keyed on its contents, so an answer that says the same thing
     does not re-derive the key and re-run everything that depends on it. */
  /* The room's whole description decides the key, and it arrives as fresh
     objects on every poll. Keyed on what those objects say, so an answer that
     repeats itself does not re-check a signature and re-run everything that
     depends on the key. */
  const described = JSON.stringify([thread, keys]);
  const read = useMemo(
    () => openRoomKey(gameId, you, thread, secret, keys),
    // The room and the keys are compared by what they hold, above.
    [gameId, you, secret, described],
  );
  const roomKey = read.key;

  const load = useCallback(async () => {
    if (!roomKey) return;
    const full = await api.pressThread(thread.id);
    setMessages(
      (full.messages || []).map((line) => ({
        ...line,
        text: openMessage(gameId, thread.id, roomKey, line) ?? "",
        proof: verifyPress(gameId, thread.id, line, signKeys.current[line.sender]),
      })),
    );
    // Only when there is something new to mark. Otherwise every poll would
    // post a marker and wake the list behind it.
    if (full.lastSeq > marked.current) {
      // After, not before: a marker that failed to reach the server must be
      // sent again, or the badge stays lit on a room that has been read.
      await api.pressRead(thread.id, full.lastSeq);
      marked.current = full.lastSeq;
      onChangedRef.current();
    }
  }, [api, gameId, roomKey, thread.id]);

  useEffect(() => {
    load().catch((err) => setError(message(err)));
  }, [load]);
  usePoll(3000, () => load().catch(() => undefined));

  useEffect(() => {
    // Not every browser this app runs in has it, and a conversation that does
    // not scroll itself is still a readable conversation.
    foot.current?.scrollIntoView?.({ block: "end" });
  }, [messages?.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !roomKey || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      /*
      A message is sealed against the place it is going: the room, the number
      it takes, who is writing, which phase, and when. If somebody else wrote
      while this one was being typed, the server refuses it — storing it under
      another number would make it unreadable to everybody — so the room is
      re-read first and the refusal is shown if it still races.
      */
      const fresh = await api.pressThread(thread.id, thread.lastSeq);
      const place: PressPlace = {
        threadId: thread.id,
        seq: fresh.lastSeq + 1,
        sender: you,
        phaseIndex: phaseIndex,
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      };
      const box = sealMessage(gameId, place, roomKey, text);
      await api.pressSend({
        thread: thread.id,
        seq: place.seq,
        phaseIndex: place.phaseIndex,
        at: place.at,
        box: box,
        sig: sign(signedBody(gameId, place, box)),
      });
      setDraft("");
      await load();
      onChangedRef.current();
    } catch (err) {
      setError(message(err));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const who = roomTitle(thread, you);
  /* The notepad answers to its own gate: it survives the writing minute, a
     retreat phase and elimination, and closes only when the game does. */
  const canWrite =
    (thread.notes ? state.notesOpen : state.open) && !readOnly && Boolean(roomKey);

  return (
    <section className="press press-room">
      <header className="press-head">
        <button type="button" className="link" onClick={onBack}>
          ← All messages
        </button>
        <h2>
          {who.length ? (
            who.map((member) => <PowerChip key={member} power={member} small />)
          ) : (
            "Notes to myself"
          )}
        </h2>
      </header>

      {roomKey ? null : <p className="notice">{read.reason}</p>}
      {/* A room whose opener holds no signing key at all: a seat with a token,
          or a game made before ADR-049. It opens and it is not checked, and
          the reader is told which. */}
      {roomKey && read.unverified ? (
        <p className="notice">
          Nobody has a signing key for {thread.openedBy}, so this device could
          not check who opened this room.
        </p>
      ) : null}

      <div className="press-log">
        {(messages || []).map((line, index) => (
          <div key={line.seq}>
            {index > 0 && messages![index - 1].phaseIndex !== line.phaseIndex ? (
              <p className="press-phase-rule">the phase resolved</p>
            ) : null}
            <div className={line.sender === you ? "press-line mine" : "press-line"}>
              <span className="press-line-who">
                {line.sender === you ? (
                  "You"
                ) : line.sender === GM_HOLDER ? (
                  "The game master"
                ) : (
                  <PowerChip power={line.sender} small />
                )}
              </span>
              <span className="press-line-text">
                {line.text || "(this device cannot read this)"}
              </span>
              {/* Three states, and the middle one is not the first: a seat
                  that holds no key cannot sign, and drawing that as verified
                  would claim something this device did not check. */}
              {line.proof === "ok" ? null : line.proof === "unsigned" ? (
                <span className="press-line-unsigned" title="This seat holds no key to sign with">
                  unsigned
                </span>
              ) : (
                <span className="press-line-forged" title="The signature does not match this power">
                  not from this power
                </span>
              )}
              <span className="press-line-at">{shortTime(line.at)}</span>
            </div>
          </div>
        ))}
        <div ref={foot} />
      </div>

      {error ? <p className="notice">{error}</p> : null}

      {canWrite ? (
        <div className="press-compose">
          <textarea
            value={draft}
            rows={2}
            placeholder={thread.notes ? "A note only you can read" : "Say something"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends. A thumb at a table wants one tap, and a new
              // line is still there on the other half of the key.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button type="button" disabled={sending || !draft.trim()} onClick={send}>
            Send
          </button>
        </div>
      ) : (
        <p className="press-shut">
          {readOnly
            ? "You read this room. You do not speak in it."
            : (thread.notes ? state.notesReason : state.reason) ||
              "This conversation is closed."}
        </p>
      )}
    </section>
  );
}

/*
How long is left before the table stops talking.

WDC 4b2 gives a board its last minute to write orders in, and 4d says the
silence is enforced. A player who is told about it a second before it lands has
been ambushed, so the panel counts down to it.
*/
function SilenceLine({ silenceAt }: { silenceAt: string }) {
  useTicker(true);
  const left = msLeft(silenceAt);
  if (left === null || left <= 0) return null;
  return <p className="muted press-silence">Writing time starts in {clockFace(left)}.</p>;
}

function shortTime(at: string): string {
  if (!at) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
