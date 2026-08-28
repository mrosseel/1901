import { useEffect, useRef, useState } from "react";
import { mount } from "../board/board";
import type { PhasePlan } from "../board/phases";
import type {
  BoardApi,
  BoardHandle,
  BoardState,
  BuilderView,
  ReviewDraw,
  Unit,
} from "../board/types";
import "../board/board.css";

/*
The React side of the map island. It owns one mounted board, feeds it state,
and draws the order builder the board asks for. Nothing in here reaches into
the SVG; everything goes through the board handle.
*/
export function Board({
  api,
  state,
  plan,
  review,
  hideOrders,
  canOrder,
  refusal,
  onState,
  onStatus,
  onSelect,
  onHandle,
}: {
  api: BoardApi;
  state: BoardState | null;
  plan: PhasePlan;
  /** Set while the phase that just resolved is being shown instead. */
  review?: ReviewDraw | null;
  /** This device's switch: draw the player's own pending arrows, or not. */
  hideOrders?: boolean;
  canOrder?: (province: string, unit: Unit | undefined) => boolean;
  refusal?: (province: string, unit: Unit | undefined) => string;
  onState: (state: BoardState) => void;
  onStatus: (text: string, isError: boolean) => void;
  onSelect: (province: string | null) => void;
  onHandle?: (handle: BoardHandle | null) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const handle = useRef<BoardHandle | null>(null);
  const [builder, setBuilder] = useState<BuilderView | null>(null);
  // A pointing device with hover is what "desktop" means here: it is the one
  // test that answers "is there a keyboard beside this screen".
  const [desktop] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches,
  );

  // The callbacks change with every render; the board keeps this one box and
  // reads the current ones out of it, so it never has to be remounted.
  const live = useRef({ canOrder, refusal, onState, onStatus, onSelect });
  live.current = { canOrder, refusal, onState, onStatus, onSelect };

  useEffect(() => {
    if (!host.current) return;
    const board = mount(host.current, api, {
      status: (text, isError) => live.current.onStatus(text, Boolean(isError)),
      builder: setBuilder,
      state: (next) => live.current.onState(next),
      select: (province) => live.current.onSelect(province),
      canOrder: (province, unit) =>
        live.current.canOrder ? live.current.canOrder(province, unit) : true,
      refusal: (province, unit) =>
        live.current.refusal ? live.current.refusal(province, unit) : "That unit is not yours.",
    });
    handle.current = board;
    if (onHandle) onHandle(board);
    board.ready.catch((err: unknown) => {
      live.current.onStatus(err instanceof Error ? err.message : String(err), true);
    });

    /*
    The keyboard mirrors the bottom bar, and only where there is a keyboard to
    mirror it with: a phone that pops one up for a text field must not have m
    and h stolen from it. Escape is bound everywhere, because a hardware
    keyboard on a tablet still deserves it.
    */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        board.escape();
        return;
      }
      if (!desktop) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target?.isContentEditable) return;
      if (board.press(event.key)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      board.destroy();
      handle.current = null;
      if (onHandle) onHandle(null);
    };
    // The api object is built once per page; remounting on it is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (state) handle.current?.update(state, plan);
  }, [state, plan]);

  // After the state, so a fresh board state never wipes the review off it.
  useEffect(() => {
    handle.current?.showReview(review || null);
  }, [review]);

  useEffect(() => {
    handle.current?.setHideOrders(Boolean(hideOrders));
  }, [hideOrders, state]);

  return (
    <>
      <div className="board" ref={host} aria-label="Diplomacy map" />
      {builder && !review ? (
        <section className="builder">
          <div className="builder-head">
            <h2>{builder.title}</h2>
            <button type="button" className="link" onClick={() => handle.current?.escape()}>
              Cancel{desktop ? <kbd>Esc</kbd> : null}
            </button>
          </div>
          <p className="crumbs">{builder.hint}</p>
          <div className="buttons">
            {builder.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.danger ? "danger" : undefined}
                title={option.filter}
                onClick={() => handle.current?.choose(option.id)}
              >
                {option.label}
                {/* The letter is printed only where it works: a phone has no
                    keyboard to press it with. */}
                {desktop && option.key ? <kbd>{option.key}</kbd> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
