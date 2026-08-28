/*
A small QR encoder, written out here because the pages must draw a code with
no network of any kind. Byte mode, error correction level M, versions 1 to 40,
which is far more than an invite URL needs.

The steps follow ISO/IEC 18004: pick the smallest version that holds the text,
build the data codewords, add Reed-Solomon blocks, lay down the function
patterns, thread the data through the grid, then keep the mask with the lowest
penalty score.
*/

// Error correction codewords per block, and block count, for level M.
const ECC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
  26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28,
];
const BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
  18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const FORMAT_BITS_M = 0; // The level M pair, before masking.
const PAD_BYTES = [0xec, 0x11];

export interface QrCode {
  size: number;
  version: number;
  /** modules[y][x] is true for a dark module. */
  modules: boolean[][];
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// --- geometry --------------------------------------------------------------

// Modules a version has for data plus error correction, function patterns
// already taken out.
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function totalCodewords(version: number): number {
  return rawDataModules(version) >>> 3;
}

function dataCodewords(version: number): number {
  return totalCodewords(version) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 40; version++) {
    if (4 + charCountBits(version) + 8 * byteLength <= dataCodewords(version) * 8) {
      return version;
    }
  }
  throw new Error("text too long for a QR code");
}

// Centres of the alignment patterns, the three finder corners included.
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

// --- Reed-Solomon over GF(256), generator 0x11d ----------------------------

function gfMultiply(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

function generatorPoly(degree: number): number[] {
  const poly = new Array<number>(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMultiply(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return poly;
}

function remainder(data: number[], generator: number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  data.forEach((byte) => {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    generator.forEach((coefficient, i) => {
      result[i] ^= gfMultiply(coefficient, factor);
    });
  });
  return result;
}

// --- codewords -------------------------------------------------------------

function dataBits(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // byte mode
  pushBits(bits, bytes.length, charCountBits(version));
  bytes.forEach((byte) => pushBits(bits, byte, 8));

  const capacity = dataCodewords(version) * 8;
  pushBits(bits, 0, Math.min(4, capacity - bits.length));
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  for (let i = 0; words.length < dataCodewords(version); i++) words.push(PAD_BYTES[i % 2]);
  return words;
}

/*
Splits the data into the version's blocks, appends each block's error
correction, then reads the blocks column by column, which is the interleaved
order the symbol wants.
*/
function interleave(words: number[], version: number): number[] {
  const blockCount = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const shortLength = Math.floor(totalCodewords(version) / blockCount) - eccLength;
  const shortCount = blockCount - (totalCodewords(version) % blockCount);
  const generator = generatorPoly(eccLength);

  const blocks: Array<{ data: number[]; ecc: number[] }> = [];
  let read = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength + (i < shortCount ? 0 : 1);
    const data = words.slice(read, read + length);
    read += length;
    blocks.push({ data: data, ecc: remainder(data, generator) });
  }

  const result: number[] = [];
  for (let i = 0; i < shortLength + 1; i++) {
    blocks.forEach((block) => {
      if (i < block.data.length) result.push(block.data[i]);
    });
  }
  for (let i = 0; i < eccLength; i++) blocks.forEach((block) => result.push(block.ecc[i]));
  return result;
}

// --- the grid --------------------------------------------------------------

function newGrid(size: number, value: boolean): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < size; y++) grid.push(new Array<boolean>(size).fill(value));
  return grid;
}

// BCH remainder, used by both the format and the version information.
function bchRemainder(value: number, generator: number, bits: number): number {
  let rest = value;
  for (let i = 0; i < bits; i++) rest = (rest << 1) ^ ((rest >>> (bits - 1)) * generator);
  return rest;
}

function drawFunctionPatterns(modules: boolean[][], reserved: boolean[][], version: number): void {
  const size = modules.length;
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Timing lines.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finders, with their separators.
  ([[3, 3], [size - 4, 3], [3, size - 4]] as Array<[number, number]>).forEach(([cx, cy]) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const reach = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, reach !== 2 && reach !== 4);
      }
    }
  });

  // Alignment patterns, skipping the three finder corners.
  const positions = alignmentPositions(version);
  positions.forEach((cy, row) => {
    positions.forEach((cx, column) => {
      const corner =
        (row === 0 && column === 0) ||
        (row === 0 && column === positions.length - 1) ||
        (row === positions.length - 1 && column === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  // The always-dark module, and the strips the format bits will fill.
  set(8, size - 8, true);
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  if (version >= 7) {
    const bits = (version << 12) | bchRemainder(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      modules[b][a] = dark;
      reserved[b][a] = true;
      modules[a][b] = dark;
      reserved[a][b] = true;
    }
  }
}

function drawFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const data = (FORMAT_BITS_M << 3) | mask;
  const bits = ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412;
  const at = (i: number) => ((bits >>> i) & 1) === 1;
  const put = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; };

  for (let i = 0; i <= 5; i++) put(8, i, at(i));
  put(8, 7, at(6));
  put(8, 8, at(7));
  put(7, 8, at(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, at(i));

  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, at(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, at(i));
  put(8, size - 8, true);
}

// The zigzag walk: two columns at a time, right to left, column 6 skipped.
function drawData(modules: boolean[][], reserved: boolean[][], codewords: number[]): void {
  const size = modules.length;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (reserved[y][x]) continue;
        const byte = codewords[bit >>> 3];
        modules[y][x] = byte !== undefined && ((byte >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

// The four penalty rules of the standard, added up.
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const runScore = (line: boolean[]): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) {
        run++;
        continue;
      }
      if (run >= 5) total += 3 + (run - 5);
      run = 1;
    }
    return total;
  };

  const finderish = (line: boolean[]): number => {
    const pattern = [true, false, true, true, true, false, true];
    let total = 0;
    for (let i = 0; i + 7 <= line.length; i++) {
      if (!pattern.every((wanted, j) => line[i + j] === wanted)) continue;
      const before = line.slice(Math.max(0, i - 4), i);
      const after = line.slice(i + 7, i + 11);
      if (before.length === 4 && before.every((m) => !m)) total += 40;
      if (after.length === 4 && after.every((m) => !m)) total += 40;
    }
    return total;
  };

  for (let i = 0; i < size; i++) {
    const column = modules.map((row) => row[i]);
    score += runScore(modules[i]) + runScore(column);
    score += finderish(modules[i]) + finderish(column);
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const first = modules[y][x];
      if (
        modules[y][x + 1] === first &&
        modules[y + 1][x] === first &&
        modules[y + 1][x + 1] === first
      ) {
        score += 3;
      }
    }
  }

  let dark = 0;
  modules.forEach((row) => row.forEach((m) => { if (m) dark++; }));
  const percent = (dark * 100) / (size * size);
  return score + Math.floor(Math.abs(percent - 50) / 5) * 10;
}

/** Builds the module grid for a piece of text. */
export function encode(text: string): QrCode {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = pickVersion(bytes.length);
  const codewords = interleave(dataBits(bytes, version), version);
  const size = version * 4 + 17;

  let best: { score: number; modules: boolean[][] } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = newGrid(size, false);
    const reserved = newGrid(size, false);
    drawFunctionPatterns(modules, reserved, version);
    drawData(modules, reserved, codewords);
    applyMask(modules, reserved, mask);
    drawFormat(modules, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { score: score, modules: modules };
  }
  return { size: size, version: version, modules: best!.modules };
}

/** The dark modules as one SVG path, in a viewBox of size + 2 × margin. */
export function svgPath(code: QrCode, margin: number): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) parts.push("M" + (x + margin) + " " + (y + margin) + "h1v1h-1z");
    }
  }
  return parts.join("");
}
