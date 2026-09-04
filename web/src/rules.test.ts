import { describe, expect, it } from "vitest";
import { retreatMinutes, ruleLines } from "./rules";

describe("the rules, one fact per bullet", () => {
  it("puts the board first and the clocks on separate lines", () => {
    expect(ruleLines({ deadlineMinutes: 30, gmPlays: false }, "Classical")).toEqual([
      "Classical map.",
      "Negotiate out loud, at the table.",
      "Movement orders: 30 minutes.",
      "Retreats and adjustments: 15 minutes (50% of the movement clock).",
      "Orders are accepted as entered; invalid orders fail under the rules for that phase.",
      "The game master does not play a power.",
    ]);
  });

  it("leaves out the board when the variant is not known yet", () => {
    expect(ruleLines({ deadlineMinutes: 0, gmPlays: false })[0]).toBe(
      "Negotiate out loud, at the table.",
    );
  });

  it("drops the retreat clock with the deadline", () => {
    const lines = ruleLines({ deadlineMinutes: 0, gmPlays: false });
    expect(lines).toContain("No deadline.");
    expect(lines.some((line) => line.startsWith("Retreats"))).toBe(false);
  });

  it("says only what this table changed", () => {
    expect(
      ruleLines(
        {
          deadlineMinutes: 20,
          gmPlays: true,
          graceMinutes: 3,
          firstTurnExtraMinutes: 10,
          endYear: 1910,
          illegalMoves: false,
          retreatBuildPercent: 25,
          pressMode: "fullpress",
          pressSilenceSeconds: 60,
          gmReadsPress: true,
        },
        "Modern",
      ),
    ).toEqual([
      "Modern map.",
      "Messages in the app, in every phase.",
      "Movement orders: 20 minutes.",
      "Retreats and adjustments: 5 minutes (25% of the movement clock).",
      "Orders stay open for 3 grace minutes after the deadline.",
      "Spring 1901 gets 10 extra minutes.",
      "Messages close 60 seconds before the deadline, for writing orders.",
      "The game master reads every message.",
      "The game stops after 1910.",
      "Only legal orders are accepted.",
      "The game master plays a power as well.",
    ]);
  });

  it("says nothing about press the app does not carry", () => {
    const lines = ruleLines(
      { deadlineMinutes: 10, gmPlays: false, pressMode: "ftf", pressSilenceSeconds: 60, gmReadsPress: true },
      "Classical",
    );
    expect(lines.some((line) => line.includes("Messages"))).toBe(false);
  });

  it("describes no game at all rather than guessing", () => {
    expect(ruleLines(undefined)).toContain("No deadline.");
  });

  it("rounds the retreat clock to a tenth of a minute", () => {
    expect(retreatMinutes({ deadlineMinutes: 30, gmPlays: false, retreatBuildPercent: 33 })).toBe(9.9);
  });
});
