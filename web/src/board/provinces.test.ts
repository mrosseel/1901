import { afterEach, describe, expect, it } from "vitest";
import {
  describeOrder,
  powerColor,
  provinceName,
  resetProvinceNames,
  setPowerPalette,
  setProvinceNames,
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
