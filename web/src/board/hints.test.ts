import { describe, expect, it } from "vitest";
import { MAX_LISTED, SHORTCUT_KEYS, optionsHint, shortcutsFor } from "./hints";

describe("the keyboard letters", () => {
  it("gives each order type its letter, in button order", () => {
    expect(shortcutsFor(["Move", "Support", "Hold"])).toEqual(["m", "s", "h"]);
    expect(shortcutsFor(["Disband", "Convoy"])).toEqual(["d", "c"]);
  });

  it("gives a letter to the first claimant only", () => {
    expect(shortcutsFor(["Move", "Move"])).toEqual(["m", undefined]);
  });

  it("gives nothing to anything that is not an order type", () => {
    expect(shortcutsFor(["", "Adriatic Sea", "Build"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(SHORTCUT_KEYS.Build).toBeUndefined();
  });
});

describe("the hint line", () => {
  it("enumerates the options rather than naming the state", () => {
    expect(
      optionsHint(
        "Army Berlin",
        [
          { label: "Move", key: "m" },
          { label: "Support", key: "s" },
          { label: "Hold", key: "h" },
        ],
        true,
      ),
    ).toBe("Army Berlin: move (m), support (s), hold (h) — or tap a highlighted province");
  });

  it("leaves the tap off when nothing on the map is highlighted", () => {
    expect(optionsHint("Rome", [{ label: "Build Army" }, { label: "Build Fleet" }], false)).toBe(
      "Rome: build army, build fleet",
    );
  });

  it("keeps a province name's capital, and lowercases only the verbs", () => {
    expect(optionsHint("Fleet Trieste", [{ label: "Adriatic Sea" }], false)).toBe(
      "Fleet Trieste: Adriatic Sea",
    );
  });

  it("stops listing once the list would stop being a sentence", () => {
    const many = Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({ label: "Province " + i }));
    expect(optionsHint("Army Vienna", many, true)).toBe(
      "Army Vienna: " + many.length + " options below — or tap a highlighted province",
    );
    expect(optionsHint("Army Vienna", many, false)).toBe(
      "Army Vienna: " + many.length + " options below — pick one.",
    );
  });

  it("says so when there is nothing to pick", () => {
    expect(optionsHint("Army Vienna", [], true)).toBe("Army Vienna: nothing to order here.");
  });
});
