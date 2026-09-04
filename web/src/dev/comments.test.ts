// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { annotate, componentsOf, cssPath } from "./comments";

/*
The app's half of a comment: the path a click turns into, and the components
behind it. The clicking itself, the note and the store are the comment tool's
own (@mrosseel/page-comments) and are left to the eye.
*/

function page(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the path to a clicked element", () => {
  it("names the element by its class and its place among its like", () => {
    const body = page(`
      <main class="page">
        <section class="card"><p>first</p></section>
        <section class="card">
          <ul class="game-list">
            <li><span class="col-seats">3 / 7</span></li>
            <li><span class="col-seats">7 / 7</span></li>
          </ul>
        </section>
      </main>`);
    const seats = body.querySelectorAll("span.col-seats")[1];
    expect(cssPath(seats)).toBe(
      "main.page > section.card:nth-of-type(2) > ul.game-list > li:nth-of-type(2) > span.col-seats",
    );
  });

  it("leaves the mount point out of the path", () => {
    const body = page('<div id="root"><main class="page"><b>x</b></main></div>');
    expect(cssPath(body.querySelector("b")!)).toBe("main.page > b");
  });

  it("stops at an id, because an id is the whole answer", () => {
    const body = page('<div class="a"><div id="board"><b><i>x</i></b></div></div>');
    expect(cssPath(body.querySelector("i")!)).toBe("div#board > b > i");
  });
});

describe("the components behind a clicked element", () => {
  it("says nothing when React drew nothing", () => {
    const body = page("<p>Hello</p>");
    expect(componentsOf(body.querySelector("p")!)).toEqual([]);
  });

  it("gives the comment tool a path and the component names together", () => {
    const body = page('<main class="page"><b>x</b></main>');
    expect(annotate(body.querySelector("b")!)).toEqual({
      selector: "main.page > b",
      components: [],
    });
  });
});
