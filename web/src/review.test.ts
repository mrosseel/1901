// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PreviousPhase } from "./api";
import {
  dismiss,
  failureReason,
  isDismissed,
  isFailure,
  nmrLine,
  reviewKey,
  reviewPlan,
} from "./review";
import { resetProvinceNames, setProvinceNames } from "./board/provinces";

afterEach(() => {
  resetProvinceNames();
  window.localStorage.clear();
});

/*
One movement phase carrying all four cases the review has to read: a bounce, a
supported attack that came off, the dislodge it caused, and a power that gave
no orders at all.
*/
const PHASE: PreviousPhase = {
  phase: { season: "Spring", year: 1901, type: "Movement" },
  orderParts: {
    vie: ["Move", "gal"],
    bud: ["Support", "vie", "gal"],
    war: ["Move", "gal"],
    tri: ["Move", "alb"],
  },
  orders: {
    vie: "Vienna moves to Galicia.",
    bud: "Budapest supports Vienna to Galicia.",
    war: "Warsaw moves to Galicia.",
    tri: "Trieste moves to Albania.",
  },
  powers: { vie: "Austria", bud: "Austria", war: "Russia", tri: "Austria" },
  resolutions: { vie: "OK", bud: "OK", war: "ErrBounce:gal", tri: "OK" },
  dislodged: { gal: { type: "Army", nation: "Russia" } },
  nmr: ["Turkey"],
};

describe("reading a resolution", () => {
  it("counts anything that is not OK as a failure", () => {
    expect(isFailure("OK")).toBe(false);
    expect(isFailure("ok")).toBe(false);
    expect(isFailure("")).toBe(false);
    expect(isFailure(undefined)).toBe(false);
    expect(isFailure("ErrBounce:gal")).toBe(true);
    expect(isFailure("ErrSupportBroken")).toBe(true);
  });

  it("turns godip's error code into words, with the province named", () => {
    expect(failureReason("ErrBounce:gal")).toBe("bounce (Galicia)");
    expect(failureReason("ErrSupportBroken")).toBe("support broken");
    expect(failureReason("OK")).toBe("");
  });

  it("names the province with the variant's own table", () => {
    setProvinceNames({ cal: "Calais" });
    expect(failureReason("ErrBounce:cal")).toBe("bounce (Calais)");
  });
});

describe("the plan a review draws", () => {
  it("lists every power's orders and marks the ones that failed", () => {
    const plan = reviewPlan(PHASE)!;
    expect(plan.title).toBe("Spring 1901 Movement");
    expect(plan.kind).toBe("movement");
    expect(plan.rows.map((row) => row.province)).toEqual(["bud", "tri", "vie", "war"]);
    expect(plan.ordered).toBe(4);
    expect(plan.succeeded).toBe(3);
    expect(Array.from(plan.failed)).toEqual(["war"]);

    const bounced = plan.rows.find((row) => row.province === "war")!;
    expect(bounced.failed).toBe(true);
    expect(bounced.power).toBe("Russia");
    expect(bounced.reason).toBe("bounce (Galicia)");

    const supported = plan.rows.find((row) => row.province === "vie")!;
    expect(supported.failed).toBe(false);
    expect(supported.text).toBe("Vienna moves to Galicia.");
  });

  /*
  godip's own prose reads "Army Galicia Move Budapest". The board already
  writes sentences, so it writes these too.
  */
  it("writes the sentence itself rather than repeating godip's wording", () => {
    const plan = reviewPlan({
      phase: { season: "Fall", year: 1901, type: "Movement" },
      orderParts: { tri: ["Support", "tyr", "ven"] },
      orders: { tri: "Fleet Trieste Support Tyrolia Venice" },
      powers: { tri: "Austria" },
      resolutions: { tri: "OK" },
    })!;
    expect(plan.rows[0].text).toBe("Trieste supports Tyrolia to Venice.");
  });

  it("carries the dislodged unit and the powers that gave nothing", () => {
    const plan = reviewPlan(PHASE)!;
    expect(plan.dislodged).toEqual({ gal: { type: "Army", nation: "Russia" } });
    expect(plan.nmr).toEqual(["Turkey"]);
    expect(nmrLine("Turkey")).toBe("Turkey: no orders — units hold.");
  });

  it("writes a sentence itself when the server sent only the parts", () => {
    const plan = reviewPlan({
      phase: { season: "Fall", year: 1901, type: "Retreat" },
      orderParts: { tri: ["Move", "alb"], ven: ["Disband"] },
      powers: { tri: "Austria", ven: "Italy" },
      resolutions: { tri: "OK", ven: "OK" },
    })!;
    expect(plan.kind).toBe("retreat");
    expect(plan.rows[0].text).toBe("Trieste retreats to Albania.");
    expect(plan.rows[1].text).toBe("Venice disbands.");
  });

  it("is nothing at all when there is no phase to review", () => {
    expect(reviewPlan(null)).toBeNull();
    expect(reviewPlan(undefined)).toBeNull();
    expect(reviewPlan({})).toBeNull();
  });

  it("still stands when the only news is that nobody ordered", () => {
    const plan = reviewPlan({ phase: { season: "Spring", year: 1901 }, nmr: ["Italy"] })!;
    expect(plan.ordered).toBe(0);
    expect(plan.nmr).toEqual(["Italy"]);
  });
});

describe("what this device has read", () => {
  it("keys a review by the game and the phase it reviewed", () => {
    const key = reviewKey("g7", PHASE);
    expect(key).toBe("1901.review.g7.Spring-1901-Movement");
    // Another phase of the same game is another review.
    expect(reviewKey("g7", { phase: { season: "Fall", year: 1901, type: "Movement" } })).not.toBe(key);
    // And the same phase of another game is too.
    expect(reviewKey("g8", PHASE)).not.toBe(key);
  });

  it("remembers Continue on this device and nowhere else", () => {
    const key = reviewKey("g7", PHASE);
    expect(isDismissed(key)).toBe(false);
    dismiss(key);
    expect(isDismissed(key)).toBe(true);
    // The next adjudication is a new key, so it opens again.
    expect(isDismissed(reviewKey("g7", { phase: { season: "Fall", year: 1901 } }))).toBe(false);
  });

  it("carries on when the browser refuses to remember anything", () => {
    const key = reviewKey("g7", PHASE);
    const store = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("site data is blocked");
      },
    });
    expect(() => dismiss(key)).not.toThrow();
    expect(isDismissed(key)).toBe(false);
    Object.defineProperty(window, "localStorage", { configurable: true, value: store });
  });
});
