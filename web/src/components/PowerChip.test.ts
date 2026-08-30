import { describe, expect, it } from "vitest";
import { inkOn } from "./PowerChip";

/*
The ink on a chip is picked from the colour's own brightness. The palette runs
from Germany's near-black grey to Italy's pale green, and neither white nor
black is legible on both.
*/
describe("the ink on a power chip", () => {
  it("goes dark on a light colour and light on a dark one", () => {
    expect(inkOn("#e8e8e8")).toBe("#14161a");
    expect(inkOn("#7c5cd6")).toBe("#ffffff");
  });

  it("reads a three-digit colour the same as a six-digit one", () => {
    expect(inkOn("#fff")).toBe(inkOn("#ffffff"));
    expect(inkOn("#000")).toBe(inkOn("#000000"));
  });

  it("falls back to readable ink for anything that is not a hex colour", () => {
    expect(inkOn("rgb(1,2,3)")).toBe("#14161a");
    expect(inkOn("")).toBe("#14161a");
  });
});
