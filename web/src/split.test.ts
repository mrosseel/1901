import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MAP_SHARE,
  MIN_MAP_SHARE,
  MIN_SIDE_PX,
  SPLIT_DEFAULTS,
  clampSplit,
  defaultSplit,
  forgetSplit,
  initialSplit,
  modeFor,
  readSplit,
  splitAfterDrag,
  splitKey,
  splitTrack,
  writeSplit,
} from "./split";

describe("modeFor", () => {
  it("matches the media queries in app.css", () => {
    expect(modeFor(390, 844)).toBe("portrait");
    expect(modeFor(780, 844)).toBe("portrait");
    expect(modeFor(844, 390)).toBe("landscape");
    // Short wins over narrow, as the second media block does.
    expect(modeFor(390, 500)).toBe("landscape");
    expect(modeFor(1440, 900)).toBe("desktop");
    expect(modeFor(781, 501)).toBe("desktop");
  });
});

describe("clampSplit", () => {
  it("holds a phone between a quarter and most of the height", () => {
    expect(clampSplit("portrait", 0.1, 844)).toBe(MIN_MAP_SHARE);
    expect(clampSplit("portrait", 0.99, 844)).toBe(MAX_MAP_SHARE);
    expect(clampSplit("landscape", 0.5, 390)).toBe(0.5);
  });

  it("keeps a desktop panel readable and leaves the map room", () => {
    expect(clampSplit("desktop", 40, 1440)).toBe(MIN_SIDE_PX);
    expect(clampSplit("desktop", 5000, 1440)).toBe(720);
    expect(clampSplit("desktop", 400, 1440)).toBe(400);
    // A narrow window: the panel may not push the map under its minimum.
    expect(clampSplit("desktop", 600, 900)).toBe(580);
  });

  it("gives the panel its minimum when the window is smaller than both", () => {
    expect(clampSplit("desktop", 400, 400)).toBe(MIN_SIDE_PX);
  });

  it("answers the default for a number that is not one", () => {
    expect(clampSplit("portrait", Number.NaN, 844)).toBe(SPLIT_DEFAULTS.portrait);
  });
});

describe("defaultSplit", () => {
  it("is the mode's default, clamped", () => {
    expect(defaultSplit("portrait", 844)).toBe(0.58);
    expect(defaultSplit("landscape", 390)).toBe(0.75);
    expect(defaultSplit("desktop", 1440)).toBe(340);
    expect(defaultSplit("desktop", 500)).toBe(MIN_SIDE_PX);
  });
});

describe("splitAfterDrag", () => {
  it("gives the map more when a phone handle is dragged down", () => {
    expect(splitAfterDrag("portrait", 0.5, 84.4, 844)).toBeCloseTo(0.6, 6);
    expect(splitAfterDrag("portrait", 0.5, -84.4, 844)).toBeCloseTo(0.4, 6);
  });

  it("clamps at both ends of the drag", () => {
    expect(splitAfterDrag("portrait", 0.8, 400, 844)).toBe(MAX_MAP_SHARE);
    expect(splitAfterDrag("landscape", 0.3, -400, 390)).toBe(MIN_MAP_SHARE);
  });

  it("narrows the desktop panel when the handle is dragged right", () => {
    expect(splitAfterDrag("desktop", 400, 60, 1440)).toBe(340);
    expect(splitAfterDrag("desktop", 400, -60, 1440)).toBe(460);
  });

  it("survives a container with no extent", () => {
    expect(splitAfterDrag("portrait", 0.5, 40, 0)).toBe(0.5);
  });
});

describe("splitTrack", () => {
  it("is pixels on a desktop and a percentage on a phone", () => {
    expect(splitTrack("desktop", 340.4)).toBe("340px");
    expect(splitTrack("portrait", 0.58)).toBe("58.000%");
  });
});

describe("storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("keys each layout mode apart", () => {
    expect(splitKey("portrait")).toBe("1901.split.portrait");
    expect(splitKey("landscape")).toBe("1901.split.landscape");
    expect(splitKey("desktop")).toBe("1901.split.desktop");
  });

  it("remembers one mode without touching the others", () => {
    writeSplit("portrait", 0.7);
    expect(readSplit("portrait")).toBe(0.7);
    expect(readSplit("landscape")).toBeNull();
    expect(initialSplit("landscape", 390)).toBe(0.75);
  });

  it("clamps what it reads back, in case the window changed", () => {
    writeSplit("desktop", 900);
    expect(initialSplit("desktop", 900)).toBe(580);
  });

  it("falls back to the default for a value that is not a number", () => {
    window.localStorage.setItem(splitKey("portrait"), "wide");
    expect(readSplit("portrait")).toBeNull();
    expect(initialSplit("portrait", 844)).toBe(0.58);
  });

  it("forgets a mode, so the default comes back", () => {
    writeSplit("portrait", 0.3);
    forgetSplit("portrait");
    expect(readSplit("portrait")).toBeNull();
  });

  it("works when storage refuses", () => {
    const refuse = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    expect(readSplit("portrait", refuse)).toBeNull();
    expect(() => writeSplit("portrait", 0.5, refuse)).not.toThrow();
    expect(() => forgetSplit("portrait", refuse)).not.toThrow();
    expect(initialSplit("portrait", 844, refuse)).toBe(0.58);
  });
});
