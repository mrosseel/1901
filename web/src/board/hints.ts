/*
The hint line, and the keyboard letters that mirror the bottom bar.

Backstabbr's hint under the map enumerates what you may do next — "Selected
Ber. You may now: …" — instead of naming the state the interface is in. That
is better for the same reason a menu beats a mode: the player reads the answer
rather than deducing it. So the hint lists the actual options of the step the
order builder is on, with each option's keyboard letter beside it.

The letters are Backstabbr's too, and they are assigned here rather than in the
board so both the bar and the key handler read one table. A letter is claimed
once per step: if two choices would want the same one, the first keeps it and
the second simply has none — a wrong shortcut is worse than a missing one.
*/

export interface HintChoice {
  label: string;
  key?: string;
}

/** The order types that have a letter, and which one. */
export const SHORTCUT_KEYS: Record<string, string> = {
  Move: "m",
  Hold: "h",
  Support: "s",
  Convoy: "c",
  Disband: "d",
};

/*
The letters for one step's order types, in the order the buttons are drawn.
Anything that is not an order type — a province, a unit type — has no letter:
there are only five letters and a movement phase can offer twenty provinces.
*/
export function shortcutsFor(types: string[]): Array<string | undefined> {
  const taken = new Set<string>();
  return types.map((type) => {
    const key = SHORTCUT_KEYS[type];
    if (!key || taken.has(key)) return undefined;
    taken.add(key);
    return key;
  });
}

/*
Beyond this many the list stops being a sentence and starts being the bar
itself, so the hint says how many there are and points at the buttons.
*/
export const MAX_LISTED = 6;

// An order type reads as a verb in a sentence; a province name keeps its capital.
const ORDER_WORDS = new Set(["Move", "Hold", "Support", "Convoy", "Disband", "Build"]);

function say(label: string): string {
  const head = String(label || "").split(" ")[0];
  return ORDER_WORDS.has(head) ? label.toLowerCase() : label;
}

/**
 * "Army Berlin: move (m), support (s), hold (h) — or tap a highlighted province"
 */
export function optionsHint(
  subject: string,
  choices: HintChoice[],
  highlighted: boolean,
): string {
  const tail = highlighted ? " — or tap a highlighted province" : "";
  if (!choices.length) return subject + ": nothing to order here.";
  if (choices.length > MAX_LISTED) {
    return subject + ": " + choices.length + " options below" + (tail || " — pick one.");
  }
  const said = choices.map((one) => say(one.label) + (one.key ? " (" + one.key + ")" : ""));
  return subject + ": " + said.join(", ") + tail;
}
