/*
Names and colours for whichever map is in play.

The map SVG carries a names layer, but its labels sit in their own coordinate
space and cannot be matched back to the hit shapes, so the names come from the
server: every state answer carries the variant's own province names, and
setProvinceNames puts them here. Hints read as sentences, and a sentence needs
a name: "Vienna supports Budapest to hold", never "vie Support bud bud". An
abbreviation with no entry falls back to upper case.

Colours work the same way: the classical seven keep the colours players know,
and any other variant's powers get evenly spaced hues, set once the page knows
who is playing.
*/

import type { BoardState } from "./types";

const CLASSICAL_POWER_COLORS: Record<string, string> = {
  Austria: "#e05252",
  England: "#7c5cd6",
  France: "#4fa3e0",
  Germany: "#8d8d8d",
  Italy: "#4fbf6a",
  Russia: "#e8e8e8",
  Turkey: "#e0b93f",
};

let palette: Record<string, string> = { ...CLASSICAL_POWER_COLORS };

/*
Gives every power of the variant in play its own colour. The classical seven
keep theirs; any other set is spread around the wheel by name order, so the
same power is the same colour on every device.
*/
export function setPowerPalette(powers: string[]): void {
  const names = Array.from(new Set(powers.filter(Boolean))).sort();
  if (names.length === 0) return;
  if (names.every((power) => CLASSICAL_POWER_COLORS[power])) {
    palette = { ...CLASSICAL_POWER_COLORS };
    return;
  }
  const next: Record<string, string> = {};
  names.forEach((power, i) => {
    next[power] = "hsl(" + Math.round((360 * i) / names.length) + " 62% 62%)";
  });
  palette = next;
}

/** The colour of one power's units, and of its dot in a list. */
export function powerColor(power: string): string {
  return palette[power] || CLASSICAL_POWER_COLORS[power] || "#bbbbbb";
}

/*
The classical names, kept only as the fallback for a server that does not send
provinceNames yet. The names in play come from the state.
*/
const CLASSICAL_PROVINCE_NAMES: Record<string, string> = {
  adr: "Adriatic Sea", aeg: "Aegean Sea", alb: "Albania", ank: "Ankara",
  apu: "Apulia", arm: "Armenia", bal: "Baltic Sea", bar: "Barents Sea",
  bel: "Belgium", ber: "Berlin", bla: "Black Sea", boh: "Bohemia",
  bot: "Gulf of Bothnia", bre: "Brest", bud: "Budapest", bul: "Bulgaria",
  bur: "Burgundy", cly: "Clyde", con: "Constantinople", den: "Denmark",
  eas: "Eastern Mediterranean", edi: "Edinburgh", eng: "English Channel",
  fin: "Finland", gal: "Galicia", gas: "Gascony", gol: "Gulf of Lyon",
  gre: "Greece", hel: "Helgoland Bight", hol: "Holland", ion: "Ionian Sea",
  iri: "Irish Sea", kie: "Kiel", lon: "London", lvn: "Livonia",
  lvp: "Liverpool", mar: "Marseilles", mid: "Mid-Atlantic Ocean",
  mos: "Moscow", mun: "Munich", naf: "North Africa", nap: "Naples",
  nat: "North Atlantic Ocean", nrg: "Norwegian Sea", nth: "North Sea",
  nwy: "Norway", par: "Paris", pic: "Picardy", pie: "Piedmont",
  por: "Portugal", pru: "Prussia", rom: "Rome", ruh: "Ruhr", rum: "Rumania",
  ser: "Serbia", sev: "Sevastopol", sil: "Silesia", ska: "Skagerrak",
  smy: "Smyrna", spa: "Spain", stp: "St Petersburg", swe: "Sweden",
  syr: "Syria", tri: "Trieste", tun: "Tunis", tus: "Tuscany", tyr: "Tyrolia",
  tys: "Tyrrhenian Sea", ukr: "Ukraine", ven: "Venice", vie: "Vienna",
  wal: "Wales", war: "Warsaw", wes: "Western Mediterranean", yor: "Yorkshire",
};

const COAST_NAMES: Record<string, string> = {
  nc: "north coast",
  sc: "south coast",
  ec: "east coast",
};

let provinceNames: Record<string, string> = { ...CLASSICAL_PROVINCE_NAMES };

/*
Takes the long names of the variant in play. An empty table is ignored rather
than believed: a state answer without names must not turn the board into
abbreviations.
*/
export function setProvinceNames(names: Record<string, string> | undefined): void {
  if (names && Object.keys(names).length) provinceNames = names;
}

/** For the tests, and for a page that changes variant without a reload. */
export function resetProvinceNames(): void {
  provinceNames = { ...CLASSICAL_PROVINCE_NAMES };
}

export function baseProvince(province: string): string {
  const slash = province.indexOf("/");
  return slash === -1 ? province : province.slice(0, slash);
}

export function provinceName(province: string): string {
  const base = baseProvince(province);
  const name = provinceNames[base] || base.toUpperCase();
  if (base === province) return name;
  const coast = COAST_NAMES[province.slice(base.length + 1)];
  return coast ? name + " (" + coast + ")" : name;
}

/** The power holding a province, or "" when it is empty. */
export function powerOf(state: BoardState | null, province: string): string {
  const unit = state?.units?.[province];
  return unit ? unit.nation : "";
}

/*
"Army Vienna" — the unit standing in a province, named for a sentence. In a
retreat phase the unit that matters is the dislodged one, which is not the unit
the province holds, so the caller says which it means.
*/
export function unitLabel(state: BoardState | null, province: string, dislodged = false): string {
  const units = (dislodged ? state?.dislodged : state?.units) || {};
  const unit = units[province] || units[baseProvince(province)];
  return (unit ? unit.type + " " : "") + provinceName(province);
}

/** What an order reads as once it is in: "Vienna supports Budapest to hold." */
export function describeOrder(province: string, parts: string[]): string {
  const from = provinceName(province);
  const type = parts[0];
  if (type === "Move") return from + " moves to " + provinceName(parts[1]) + ".";
  if (type === "Hold") return from + " holds.";
  if (type === "Support" || type === "Convoy") {
    const verb = type === "Convoy" ? " convoys " : " supports ";
    const src = provinceName(parts[1]);
    if (parts.length < 3 || parts[2] === parts[1]) return from + verb + src + " to hold.";
    return from + verb + src + " to " + provinceName(parts[2]) + ".";
  }
  return from + " " + parts.map(provinceName).join(" ") + ".";
}

export function phaseLabel(phase: BoardState["phase"]): string {
  if (!phase) return "—";
  return [phase.season, phase.year, phase.type].filter(Boolean).join(" ") || "—";
}
