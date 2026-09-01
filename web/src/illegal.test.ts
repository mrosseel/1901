import { describe, expect, it } from "vitest";

import {
  ILLEGAL_RESOLUTION,
  illegalAllowed,
  illegalDraftNote,
  illegalReason,
  isIllegal,
} from "./illegal";

describe("illegalAllowed", () => {
  it("is on when the table turned it on", () => {
    expect(illegalAllowed({ illegalMoves: true })).toBe(true);
  });

  it("is off only when the table said so outright", () => {
    expect(illegalAllowed({ illegalMoves: false })).toBe(false);
  });

  /* A server that predates the setting accepted whatever it was sent, so an
     absent setting has to read as the permissive one — otherwise the client
     would start refusing orders the server would have kept. */
  it("is on where nothing says otherwise", () => {
    expect(illegalAllowed({})).toBe(true);
    expect(illegalAllowed(undefined)).toBe(true);
  });
});

describe("invalid-order consequences", () => {
  it("does not claim every phase turns an invalid order into a hold", () => {
    expect(illegalReason("movement")).toContain("held");
    expect(illegalReason("retreat")).toContain("disbanded");
    expect(illegalReason("adjustment")).toContain("adjustment rules");
    expect(illegalDraftNote("retreat")).toContain("will be disbanded");
  });
});

describe("isIllegal", () => {
  it("names the resolution the server sends for one", () => {
    expect(isIllegal(ILLEGAL_RESOLUTION)).toBe(true);
  });

  it("reads it with godip's Err prefix too", () => {
    expect(isIllegal("Err" + ILLEGAL_RESOLUTION)).toBe(true);
  });

  it("reads it with a province on the end", () => {
    expect(isIllegal(ILLEGAL_RESOLUTION + ":bur")).toBe(true);
  });

  it("leaves every other outcome alone", () => {
    expect(isIllegal("OK")).toBe(false);
    expect(isIllegal("ErrBounce:tri")).toBe(false);
    expect(isIllegal("ErrSupportBroken:vie")).toBe(false);
    expect(isIllegal("")).toBe(false);
    expect(isIllegal(undefined)).toBe(false);
  });
});
