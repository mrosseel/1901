/*
What was clicked, said well enough that the work can start.

The comment tool itself is @mrosseel/page-comments, which is a component on its
own: it takes the click, keeps the note, and hands it to the collector. What it
cannot know is this app. A note that says "span.col-seats" sends a reader
hunting; a note that also says GameList drew it, inside #board, reading "7 / 7",
does not.

So this file is the app's half of one element note. Nothing here touches the
DOM it describes beyond reading it, and nothing here stores anything, which
keeps the parts a test can hold on to away from the parts that need a browser.
*/

/** The extra facts, in the shape the comment tool merges over its own. */
export interface Annotation {
  selector: string;
  components: string[];
}

function tagOf(node: Element): string {
  return node.tagName.toLowerCase();
}

/* One step of the path. The class is what makes a step readable, the position
   is what makes it unambiguous, and the position is only added when the tag
   really repeats among the siblings. */
function step(node: Element): string {
  const classes = Array.from(node.classList).slice(0, 2);
  let out = tagOf(node) + classes.map((one) => "." + one).join("");
  const parent = node.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((one) => one.tagName === node.tagName);
    if (same.length > 1) out += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
  }
  return out;
}

/* The mount point every page hangs under. It names no part of any screen, so
   it is never worth a step in a path. */
const ROOT_ID = "root";

/*
A path short enough to read and long enough to find.

It stops at the first ancestor with an id, because an id is the shortest true
answer, and otherwise at the mount point, the body, or after six steps: past
that the path stops telling anybody anything the class names had not said.
*/
export function cssPath(node: Element): string {
  const parts: string[] = [];
  let at: Element | null = node;
  while (at && at.tagName !== "BODY" && at.tagName !== "HTML" && parts.length < 6) {
    if (at.id === ROOT_ID) break;
    if (at.id) {
      parts.unshift(tagOf(at) + "#" + at.id);
      break;
    }
    parts.unshift(step(at));
    at = at.parentElement;
  }
  return parts.join(" > ");
}

/* The gallery's own wrapper around a screen. Naming it in a comment would
   send a reader to this folder instead of to the page. */
const WRAPPER = "Screen";

/*
The component names, read off React's own bookkeeping.

React hangs a fiber on every host node it made, and each fiber points at the
one that rendered it. Walking that chain gives the components a designer would
name — SeatPage, PressPanel — which is where the work will be done. It is a
private field with a random suffix, so this is best effort by definition: any
surprise up there ends the walk and the comment is still worth having.
*/
export function componentsOf(node: Element): string[] {
  const names: string[] = [];
  try {
    const holder = node as unknown as Record<string, unknown>;
    const key = Object.keys(holder).find((one) => one.startsWith("__reactFiber$"));
    if (!key) return names;
    let fiber = holder[key] as { return?: unknown; type?: unknown } | null;
    let steps = 0;
    while (fiber && names.length < 4 && steps < 60) {
      const type = fiber.type as { displayName?: string; name?: string } | string | null;
      if (typeof type === "function" || (type && typeof type === "object")) {
        const named = type as { displayName?: string; name?: string };
        const name = named.displayName || named.name;
        if (name === WRAPPER) break;
        if (name && !names.includes(name)) names.push(name);
      }
      fiber = (fiber.return || null) as { return?: unknown; type?: unknown } | null;
      steps++;
    }
  } catch {
    // No fiber, or a React that keeps its bookkeeping elsewhere. Names are a bonus.
  }
  return names;
}

/** What the gallery adds to the note the comment tool writes for a click. */
export function annotate(node: Element): Annotation {
  return { selector: cssPath(node), components: componentsOf(node) };
}
