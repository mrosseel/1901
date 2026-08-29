/*
The switch between the two ways an order list can be written.

It sits in the header of the list it rewrites, and nowhere else. The map's own
switches went onto the map for the same reason this one did not: a control
belongs beside the thing it changes, and this one changes a list.

Small, quiet, and off by default. "Army Paris moves to Burgundy." is what a
first game needs; "A Par → Bur" is what a fiftieth wants, and a shorthand
nobody has been taught is a cipher (prefs.ts).
*/
export function OrderNotationToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (brief: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={value ? "notation-toggle on" : "notation-toggle"}
      aria-pressed={value}
      title={value ? "Write orders out in full" : "Write orders in notation"}
      onClick={() => onChange(!value)}
    >
      {value ? "A→B" : "Full"}
    </button>
  );
}
