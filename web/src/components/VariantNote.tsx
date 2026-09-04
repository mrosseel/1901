/*
The sentence somebody wrote about a map's review (ADR-061).

It replaces the green tick. A tick could only say that classical had been
checked, and next to a name it read as a property of the software rather than
of somebody's afternoon with a rulebook. The note says who checked what, in
words, and a map nobody has written about shows nothing at all — which is the
honest default, and still most of them.
*/
export function VariantNote({ note }: { note?: string }) {
  const said = (note || "").trim();
  if (!said) return null;
  return <span className="variant-review">{said}</span>;
}
