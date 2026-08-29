import { afterEach, describe, expect, it } from "vitest";
import {
  describeOrder,
  phaseLabel,
  phaseTypeKey,
  phaseWords,
  powerColor,
  provinceName,
  resetProvinceNames,
  seasonKey,
  setPowerPalette,
  setProvinceNames,
  splitPhaseLabel,
} from "./provinces";

afterEach(() => {
  resetProvinceNames();
  setPowerPalette(["Austria", "England", "France", "Germany", "Italy", "Russia", "Turkey"]);
});

describe("province names", () => {
  it("uses the names the variant in play sent", () => {
    setProvinceNames({ bur: "Burgundy", cal: "Calais" });
    expect(provinceName("cal")).toBe("Calais");
    // The variant's table is the whole truth: an abbreviation it does not
    // carry is not looked up in the classical one.
    expect(provinceName("vie")).toBe("VIE");
  });

  it("keeps the coast on the end of a name it did send", () => {
    setProvinceNames({ spa: "Spain" });
    expect(provinceName("spa/sc")).toBe("Spain (south coast)");
  });

  it("ignores an empty table rather than losing every name", () => {
    setProvinceNames({});
    setProvinceNames(undefined);
    expect(provinceName("vie")).toBe("Vienna");
  });

  it("writes order sentences with the variant's names", () => {
    setProvinceNames({ cal: "Calais", pic: "Picardy" });
    expect(describeOrder("cal", ["Move", "pic"])).toBe("Calais moves to Picardy.");
  });
});

describe("power colours", () => {
  it("keeps the colours players know for the classical seven", () => {
    expect(powerColor("France")).toBe("#4fa3e0");
    expect(powerColor("Turkey")).toBe("#e0b93f");
  });

  it("gives a variant's own powers a colour each", () => {
    setPowerPalette(["Burgundy", "England", "France"]);
    const colors = ["Burgundy", "England", "France"].map(powerColor);
    expect(new Set(colors).size).toBe(3);
    // No power falls through to the grey that means "unknown".
    expect(colors).not.toContain("#bbbbbb");
  });

  it("gives the same power the same colour on every device", () => {
    setPowerPalette(["France", "England", "Burgundy"]);
    const first = powerColor("England");
    setPowerPalette(["Burgundy", "England", "France"]);
    expect(powerColor("England")).toBe(first);
  });

  it("falls back to grey for a power nobody named", () => {
    setPowerPalette(["Burgundy", "England", "France"]);
    expect(powerColor("Atlantis")).toBe("#bbbbbb");
  });
});

describe("phaseWords", () => {
  it("takes the three words straight from the phase", () => {
    expect(phaseWords({ season: "Spring", year: 1901, type: "Movement" })).toEqual({
      season: "Spring",
      year: "1901",
      type: "Movement",
    });
  });

  it("answers a missing phase with the dash the label uses", () => {
    expect(phaseWords(undefined)).toEqual({ season: "", year: "—", type: "" });
  });

  it("leaves out a part the variant does not name", () => {
    expect(phaseWords({ year: 1901, type: "Adjustment" })).toEqual({
      season: "",
      year: "1901",
      type: "Adjustment",
    });
  });
});

describe("splitPhaseLabel", () => {
  /* The review sheet has only the label: the phase it belonged to was
     resolved and put away before the sheet was built. */
  it("takes a label apart the way the phase would have been", () => {
    expect(splitPhaseLabel("Spring 1901 Movement")).toEqual({
      season: "Spring",
      year: "1901",
      type: "Movement",
    });
    expect(splitPhaseLabel("Fall 1902 Adjustment")).toEqual({
      season: "Fall",
      year: "1902",
      type: "Adjustment",
    });
  });

  it("agrees with phaseWords about the same phase", () => {
    const phase = { season: "Fall", year: 1903, type: "Retreat" };
    expect(splitPhaseLabel(phaseLabel(phase))).toEqual(phaseWords(phase));
  });

  it("keeps a multi-word season whole", () => {
    expect(splitPhaseLabel("Late Summer 1901 Retreat")).toEqual({
      season: "Late Summer",
      year: "1901",
      type: "Retreat",
    });
  });

  /* A phase type this build has never heard of takes no colour rather than
     the wrong one, and the label still reads. */
  it("leaves a label it does not recognise whole", () => {
    expect(splitPhaseLabel("Spring 1901 Diplomacy")).toEqual({
      season: "Spring 1901 Diplomacy",
      year: "",
      type: "",
    });
    expect(splitPhaseLabel("—")).toEqual({ season: "—", year: "", type: "" });
  });

  it("does not mistake a bare type for a whole label", () => {
    expect(splitPhaseLabel("Movement")).toEqual({
      season: "Movement",
      year: "",
      type: "",
    });
  });
});

describe("phaseTypeKey", () => {
  it("names each of the three types godip runs", () => {
    expect(phaseTypeKey("Movement")).toBe("movement");
    expect(phaseTypeKey("Retreat")).toBe("retreat");
    expect(phaseTypeKey("Adjustment")).toBe("adjustment");
  });

  it("gives a type it does not colour no key at all", () => {
    expect(phaseTypeKey("Diplomacy")).toBe("");
    expect(phaseTypeKey("")).toBe("");
  });
});

describe("seasonKey", () => {
  it("names the two seasons nearly every variant shares", () => {
    expect(seasonKey("Spring")).toBe("spring");
    expect(seasonKey("Fall")).toBe("fall");
  });

  it("treats autumn as the fall it is", () => {
    expect(seasonKey("Autumn")).toBe("fall");
  });

  /* A variant running one unnamed season, or four, still gets its season told
     apart from the year beside it — without this file claiming a list it has
     not got. */
  it("gives any other season the one shared key", () => {
    expect(seasonKey("Summer")).toBe("other");
    expect(seasonKey("Year")).toBe("other");
  });

  it("gives no season no key", () => {
    expect(seasonKey("")).toBe("");
    expect(seasonKey("  ")).toBe("");
  });
});
