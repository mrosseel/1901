import { useEffect, useRef, useState } from "react";
import { mount } from "../board/board";
import type { BoardApi, BoardHandle, BoardState, BuilderView, Unit } from "../board/types";
import "../board/board.css";

/*
The React side of the map island. It owns one mounted board, feeds it state,
and draws the order builder the board asks for. Nothing in here reaches into
the SVG; everything goes through the board handle.
*/
export function Board({
  api,
  state,
  canOrder,
  refusal,
  onState,
  onStatus,
  onSelect,
  onHandle,
}: {
  api: BoardApi;
  state: BoardState | null;
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

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") board.escape();
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
    if (state) handle.current?.update(state);
  }, [state]);

  return (
    <>
      <div className="board" ref={host} aria-label="Diplomacy map" />
      {builder ? (
        <section className="builder">
          <div className="builder-head">
            <h2>{builder.title}</h2>
            <button type="button" className="link" onClick={() => handle.current?.escape()}>
              Cancel
            </button>
          </div>
          <p className="crumbs">{builder.hint}</p>
          <div className="buttons">
            {builder.options.map((option) => (
              <button
                key={option.key}
                type="button"
                title={option.filter}
                onClick={() => handle.current?.choose(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
