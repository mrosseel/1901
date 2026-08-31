// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCatalogue } from "./Gallery";
import { installStub } from "./stub";

/*
Every screen in the gallery, mounted.

The coverage test says a screen exists for every route. It does not say the
screen works, and a gallery of broken screens is worse than a short one: it is
the surface a design decision gets made on.
*/

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!(globalThis as { CSS?: unknown }).CSS) {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
  };
}

const MAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="provinces"><path id="vie" d="M 10,10 h 20 v 20 h -20 z"/></g>
</svg>`;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("every screen in the gallery", () => {
  const catalogue = buildCatalogue();

  it.each(catalogue.map((e) => [e.screen + "/" + e.state, e] as const))(
    "renders %s",
    async (_name, entry) => {
      const errors: unknown[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const href = typeof input === "string" ? input : String(input);
        if (/map\.svg/.test(href)) {
          return { ok: true, status: 200, text: async () => MAP } as unknown as Response;
        }
        // Anything the stub did not answer reached the network, which in a
        // gallery means a screen with no fixture behind it.
        errors.push(href);
        return { ok: true, status: 200, text: async () => "[]" } as unknown as Response;
      });
      const restore = installStub(entry.scenario);
      const host = document.createElement("div");
      document.body.appendChild(host);
      await act(async () => {
        root = createRoot(host);
        root!.render(entry.render());
      });
      restore();
      expect(host.textContent).not.toBe("");
    },
  );
});
