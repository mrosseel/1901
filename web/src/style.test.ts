import { beforeEach, describe, expect, it } from "vitest";
import { STYLE_KEY, readStyle, readStyles, styledMapUrl, writeStyle } from "./style";

describe("the map style on a URL", () => {
  it("leaves the URL alone when there is no preference", () => {
    expect(styledMapUrl("/variants/sailho/map.svg", "")).toBe("/variants/sailho/map.svg");
  });

  it("adds the style, and joins an existing query correctly", () => {
    expect(styledMapUrl("/variants/sailho/map.svg", "midnight")).toBe(
      "/variants/sailho/map.svg?style=midnight",
    );
    expect(styledMapUrl("/game/x/map.svg?v=2", "print")).toBe("/game/x/map.svg?v=2&style=print");
  });

  it("escapes the name rather than trusting it", () => {
    expect(styledMapUrl("/map.svg", "a b&c")).toBe("/map.svg?style=a%20b%26c");
  });
});

describe("the device's preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("is remembered, and cleared by the empty choice", () => {
    expect(readStyle()).toBe("");
    writeStyle("midnight");
    expect(window.localStorage.getItem(STYLE_KEY)).toBe("midnight");
    expect(readStyle()).toBe("midnight");
    writeStyle("");
    expect(readStyle()).toBe("");
  });
});

describe("the style list the server publishes", () => {
  it("drops anything malformed rather than drawing it", () => {
    const list = readStyles([
      { name: "parchment", title: "Parchment", description: "The house style." },
      { name: "", title: "Nameless" },
      null,
      "midnight",
      { name: "print" },
    ]);
    expect(list.map((one) => one.name)).toEqual(["parchment", "print"]);
    // A style with no title of its own is shown under its name.
    expect(list[1].title).toBe("print");
    expect(list[1].description).toBe("");
  });

  it("answers with nothing at all when the server answers with nonsense", () => {
    expect(readStyles(undefined)).toEqual([]);
    expect(readStyles({ styles: [] })).toEqual([]);
  });
});
