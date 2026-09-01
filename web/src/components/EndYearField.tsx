interface EndYearFieldProps {
  enabled: boolean;
  year: number | "";
  startYear?: number;
  onEnabledChange: (enabled: boolean) => void;
  onYearChange: (year: number | "") => void;
}

/*
The hard stop is optional, so zero should never masquerade as a year the GM
is expected to understand. The checkbox declares the rule; the range then
puts the variant's first year beside the last-year input. This also works for
variants such as Cold War, which starts in 1960 rather than 1901.
*/
export function EndYearField({
  enabled,
  year,
  startYear,
  onEnabledChange,
  onYearChange,
}: EndYearFieldProps) {
  return (
    <div className="field end-year-field">
      <label className="end-year-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>Stop after a set year</span>
      </label>
      <div className="end-year-range">
        <span>{startYear || "Start year"} –</span>
        <input
          type="number"
          min={startYear || 1}
          max={9999}
          inputMode="numeric"
          disabled={!enabled}
          required={enabled}
          aria-label="Last year"
          placeholder="Last year"
          value={year}
          onChange={(event) =>
            onYearChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
      </div>
      <small>
        {enabled
          ? "Enter the last year to play."
          : "Off — the game continues until a solo or an agreed draw."}
      </small>
    </div>
  );
}
