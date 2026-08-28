import { useMemo } from "react";
import { encode, svgPath } from "../qr";

/* The QR is drawn from the local encoder — nothing is fetched. It scales with
   its box, so the page decides the size in CSS. */
export function QrImage({ text, label }: { text: string; label?: string }) {
  const drawing = useMemo(() => {
    try {
      const code = encode(text);
      const margin = 4;
      return { path: svgPath(code, margin), span: code.size + margin * 2 };
    } catch {
      return null;
    }
  }, [text]);

  if (!drawing) return null;
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${drawing.span} ${drawing.span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label || "QR code for " + text}
    >
      <rect width={drawing.span} height={drawing.span} fill="#ffffff" />
      <path d={drawing.path} fill="#000000" />
    </svg>
  );
}
