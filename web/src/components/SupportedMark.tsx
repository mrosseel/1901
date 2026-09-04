/*
A green tick beside a variant whose board art is verified (ADR-014).

Everything else gets nothing at all. An "experimental" badge on twenty-two of
twenty-three variants said far more about the label than about the variants:
it was on almost every card, so it read as decoration, and the one thing it
could have meant — this map's start positions have not been checked — is not
something a warning next to a name can usefully say. The tick marks the one
that HAS been checked, and silence is the honest default for the rest.

The tick is on its way out (ADR-061). Where a map is named on a screen that
was reviewed — the seat header, the waiting room, the games list, the creation
gallery — the sentence somebody wrote about the review stands in its place
(VariantNote). This is what the screens that have not been through that review
still draw, and what the c003 switch puts back.
*/
export function SupportedMark({ supported }: { supported: boolean }) {
  if (!supported) return null;
  return (
    <span className="supported-mark" title="Positions and board art verified">
      ✓
    </span>
  );
}
