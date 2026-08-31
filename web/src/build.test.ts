import { beforeEach, describe, expect, it } from "vitest";
import { buildIsStale, forgetBuild, noteBuild } from "./build";

/*
A tab that has been open for forty minutes is running the JavaScript it was
sent. A deploy replaces the server under it and nothing says so, which is how
a player finds out by tapping something and having it fail.
*/
describe("knowing this tab is a version behind", () => {
  beforeEach(forgetBuild);

  it("is not stale before the server has answered twice", () => {
    expect(buildIsStale()).toBe(false);
    noteBuild("abc123");
    expect(buildIsStale()).toBe(false);
    noteBuild("abc123");
    expect(buildIsStale()).toBe(false);
  });

  it("is stale the moment the server serves a different build", () => {
    noteBuild("abc123");
    noteBuild("def456");
    expect(buildIsStale()).toBe(true);
  });

  /* Once stale, always stale: the deploy did not un-happen because the next
     poll came from a server that had not finished rolling. */
  it("stays stale", () => {
    noteBuild("abc123");
    noteBuild("def456");
    noteBuild("abc123");
    expect(buildIsStale()).toBe(true);
  });

  /* A server that predates the stamp sends nothing, and a page must not
     conclude anything from silence. */
  it("says nothing when the server sends no build at all", () => {
    noteBuild(undefined);
    noteBuild(null);
    noteBuild("");
    expect(buildIsStale()).toBe(false);
    noteBuild("abc123");
    noteBuild(undefined);
    expect(buildIsStale()).toBe(false);
  });
});
