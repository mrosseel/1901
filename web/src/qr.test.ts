import { describe, expect, it } from "vitest";
import { encode, svgPath } from "./qr";

/*
The encoder is verified end to end elsewhere: the module grid is written out as
an image and read back by zbar, which decodes every case below. These tests
hold the structure that decoding depends on, so a regression is caught without
a decoder in the loop.
*/
describe("qr", () => {
  it("picks the smallest version that holds the text", () => {
    expect(encode("hi").version).toBe(1);
    expect(encode("x".repeat(120)).version).toBe(7);
    expect(encode("Q".repeat(232)).version).toBe(11);
  });

  it("sizes the grid from the version", () => {
    const code = encode("http://localhost:8191/join/7/Yk8s2Qw9rTn4vLp0Zt");
    expect(code.size).toBe(code.version * 4 + 17);
    expect(code.modules.length).toBe(code.size);
    expect(code.modules[0].length).toBe(code.size);
  });

  it("draws the three finder patterns", () => {
    const code = encode("finders");
    const finder = (x: number, y: number) =>
      [-3, -2, -1, 0, 1, 2, 3].map((dy) =>
        [-3, -2, -1, 0, 1, 2, 3]
          .map((dx) => (code.modules[y + dy][x + dx] ? "#" : "."))
          .join(""),
      );
    const wanted = [
      "#######",
      "#.....#",
      "#.###.#",
      "#.###.#",
      "#.###.#",
      "#.....#",
      "#######",
    ];
    expect(finder(3, 3)).toEqual(wanted);
    expect(finder(code.size - 4, 3)).toEqual(wanted);
    expect(finder(3, code.size - 4)).toEqual(wanted);
  });

  it("alternates the timing lines and keeps the dark module", () => {
    const code = encode("timing");
    for (let i = 8; i < code.size - 8; i++) {
      expect(code.modules[6][i]).toBe(i % 2 === 0);
      expect(code.modules[i][6]).toBe(i % 2 === 0);
    }
    expect(code.modules[code.size - 8][8]).toBe(true);
  });

  it("draws one square for each dark module", () => {
    const code = encode("path");
    const dark = code.modules.flat().filter(Boolean).length;
    expect(svgPath(code, 4).match(/h1v1h-1z/g)?.length).toBe(dark);
  });

  it("refuses text that no version can hold", () => {
    expect(() => encode("x".repeat(3000))).toThrow(/too long/);
  });
});
