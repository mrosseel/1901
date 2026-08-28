import { describe, expect, it } from "vitest";
import {
  EXPERIMENTAL_BADGE,
  SUPPORTED_BADGE,
  blurb,
  claimLine,
  findVariant,
  normalizeVariant,
  preferredVariant,
  readVariants,
  sortVariants,
  variantCard,
  type Variant,
} from "./variants";

const classical: Partial<Variant> = {
  key: "classical",
  name: "Classical",
  powers: ["Austria", "England", "France", "Germany", "Italy", "Russia", "Turkey"],
  powerCount: 7,
  soloSCCount: 18,
  totalSCCount: 34,
  startYear: 1901,
  description: "The original game.",
  rules: "Standard rules.",
  createdBy: "Allan B. Calhamer",
  supported: true,
  mapUrl: "/variants/classical/map.svg",
};

const hundred: Partial<Variant> = {
  key: "hundred",
  name: "Hundred",
  powers: ["Burgundy", "England", "France"],
  powerCount: 3,
  soloSCCount: 9,
  totalSCCount: 17,
  startYear: 1425,
};

describe("reading the catalogue", () => {
  it("fills in what the server left out", () => {
    const variant = normalizeVariant({ key: "north_sea_wars", powers: ["A", "B"] });
    expect(variant.name).toBe("north_sea_wars");
    expect(variant.powerCount).toBe(2);
    expect(variant.supported).toBe(false);
    expect(variant.mapUrl).toBe("/variants/north_sea_wars/map.svg");
    expect(variant.soloSCCount).toBe(0);
  });

  it("refuses nonsense counts rather than printing them", () => {
    const variant = normalizeVariant({ key: "x", soloSCCount: -3, startYear: 0 });
    expect(variant.soloSCCount).toBe(0);
    expect(variantCard(variant).startLine).toBe("");
    expect(variantCard(variant).soloLine).toBe("");
  });

  it("takes a bare list or a wrapped one, and drops entries with no key", () => {
    expect(readVariants([classical, hundred]).map((v) => v.key)).toEqual([
      "classical",
      "hundred",
    ]);
    expect(readVariants({ variants: [hundred] }).map((v) => v.key)).toEqual(["hundred"]);
    expect(readVariants([{ name: "nameless" }])).toEqual([]);
    expect(readVariants(null)).toEqual([]);
  });

  it("puts classical first, then the other supported maps, then the rest", () => {
    const list = sortVariants([
      normalizeVariant(hundred),
      normalizeVariant({ key: "ancient", name: "Ancient Mediterranean" }),
      normalizeVariant(classical),
      normalizeVariant({ key: "pure", name: "Pure", supported: true }),
    ]);
    expect(list.map((v) => v.key)).toEqual(["classical", "pure", "ancient", "hundred"]);
  });

  it("starts on classical, or on the first card when there is none", () => {
    expect(preferredVariant(readVariants([hundred, classical]))).toBe("classical");
    expect(preferredVariant(readVariants([hundred]))).toBe("hundred");
    expect(preferredVariant([])).toBe("classical");
    expect(findVariant(readVariants([hundred]), "hundred")?.name).toBe("Hundred");
    expect(findVariant(readVariants([hundred]), "classical")).toBeNull();
  });
});

describe("what a card says", () => {
  it("names the powers, the solo target and the year", () => {
    const card = variantCard(normalizeVariant(classical));
    expect(card.powersLine).toBe("7 powers");
    expect(card.powerNames).toBe("Austria, England, France, Germany, Italy, Russia, Turkey");
    expect(card.soloLine).toBe("Solo at 18 of 34 supply centres.");
    expect(card.startLine).toBe("Starts in 1901.");
    expect(card.credit).toBe("By Allan B. Calhamer");
    expect(card.badge).toBe(SUPPORTED_BADGE);
  });

  it("counts the powers of the variant, not of classical", () => {
    const card = variantCard(normalizeVariant(hundred));
    expect(card.powersLine).toBe("3 powers");
    expect(card.powerNames).toBe("Burgundy, England, France");
    expect(card.soloLine).toBe("Solo at 9 of 17 supply centres.");
    expect(card.startLine).toBe("Starts in 1425.");
    expect(card.badge).toBe(EXPERIMENTAL_BADGE);
  });

  it("cuts the closed card's line at a word, and leaves a short one alone", () => {
    expect(blurb("The original game.")).toBe("The original game.");
    expect(blurb("one two three", 7)).toBe("one two…");
    // The cut never leaves a dangling comma or full stop before the ellipsis.
    expect(blurb("one two, three four", 8)).toBe("one two…");
    expect(blurb("")).toBe("");
    // Whitespace in godip's notes is collapsed, newlines included.
    expect(blurb("a\n  b")).toBe("a b");
  });

  it("puts a one-line blurb on the card and keeps the whole description", () => {
    const long = "A".repeat(200);
    const card = variantCard(normalizeVariant({ key: "x", description: long }));
    expect(card.description).toBe(long);
    expect(card.blurb.length).toBeLessThan(long.length);
    expect(card.blurb.endsWith("…")).toBe(true);
  });

  it("leaves out the lines the server said nothing about", () => {
    const card = variantCard(normalizeVariant({ key: "bare", powers: ["One"] }));
    expect(card.powersLine).toBe("1 power");
    expect(card.soloLine).toBe("");
    expect(card.startLine).toBe("");
    expect(card.credit).toBe("");
    expect(card.description).toBe("");
  });
});

describe("how many powers the invite hands out", () => {
  it("holds one back for the game master", () => {
    expect(claimLine(7, true)).toBe(
      "Players claim 6 of the 7 powers. One is held for the game master.",
    );
    expect(claimLine(7, false)).toBe("Players claim all 7 powers.");
  });

  it("counts from the variant: the hundred has three powers", () => {
    expect(claimLine(3, true)).toBe(
      "Players claim 2 of the 3 powers. One is held for the game master.",
    );
    expect(claimLine(3, false)).toBe("Players claim all 3 powers.");
  });

  it("says nothing when the count is unknown", () => {
    expect(claimLine(0, true)).toBe("");
  });
});
