import { useEffect, useState } from "react";
import { fetchStyles, readStyle, writeStyle, type MapStyle } from "../style";


/*
The map style control: one small select, on every page that shows a map.

It is deliberately not a game setting. The style changes nothing anyone else
sees, so it is remembered on this device and asked of nobody — see style.ts.
The control hides itself when the server publishes fewer than two styles,
because a picker with one entry is furniture.
*/
export function StylePicker({
  value,
  onChange,
  label = "Map style",
}: {
  value: string;
  onChange: (style: string) => void;
  label?: string;
}) {
  const [styles, setStyles] = useState<MapStyle[]>([]);

  useEffect(() => {
    let live = true;
    fetchStyles().then((list) => {
      if (live) setStyles(list);
    });
    return () => {
      live = false;
    };
  }, []);

  if (styles.length < 2) return null;
  const chosen = styles.some((one) => one.name === value) ? value : "";
  const current = styles.find((one) => one.name === chosen);

  return (
    <label className="style-picker">
      <span className="style-picker-label">{label}</span>
      <select
        value={chosen || "parchment"}
        title={current ? current.description : "The style this device draws maps in"}
        onChange={(event) => onChange(event.target.value)}
      >
        {styles.map((one) => (
          <option key={one.name} value={one.name} title={one.description}>
            {one.title}
          </option>
        ))}
      </select>
    </label>
  );
}

/*
The device's saved style, and a setter that saves.

Every page that draws a map needs the same three lines, and one of them is the
storage guard, so they live here rather than in each page.
*/
export function useMapStyle(): [string, (style: string) => void] {
  const [style, setStyle] = useState<string>(() => readStyle());
  return [
    style,
    (next: string) => {
      writeStyle(next);
      setStyle(next);
    },
  ];
}
