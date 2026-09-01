/*
A green tick beside a variant whose board art is verified (ADR-014).

Everything else gets nothing at all. An "experimental" badge on twenty-two of
twenty-three variants said far more about the label than about the variants:
it was on almost every card, so it read as decoration, and the one thing it
could have meant — this map's start positions have not been checked — is not
something a warning next to a name can usefully say. The tick marks the one
that HAS been checked, and silence is the honest default for the rest.
*/
export function SupportedMark({ supported, explicit = false }: { supported: boolean; explicit?: boolean }) {
  if (!supported && !explicit) return null;
  return (
    <span
      className={
        "supported-mark" + (explicit ? " explicit" : "") + (supported ? "" : " unverified")
      }
      title={supported ? "Positions and board art verified" : "Positions not yet verified for live play"}
    >
      {explicit ? (supported ? "Verified" : "Not yet verified") : "✓"}
    </span>
  );
}
