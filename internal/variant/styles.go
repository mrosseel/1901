// Named map styles, as data the server can read (ADR-033, ADR-026).
//
// A style is a JSON file in mapstyles/, with its assets — pattern
// definitions and @font-face rules — beside it, named by relative path. The
// directory is embedded in the binary, so a styled map costs no file system
// access and a deployment is one executable.
//
// The same directory is read by dipmap's style detector, which is why it sits at the
// top of the repository and not inside either program. Everything a style can
// say is a presentation property; a style that could say more would no longer
// be a restyle.
package variant

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"

	"spring1901/spike/mapstyles"
)

// styleTypography is how one kind of name is set. Lengths are quoted against
// the style's referenceWidth and carried onto the map by carryLength.
type styleTypography struct {
	Family        string  `json:"family"`
	Weight        string  `json:"weight"`
	Style         string  `json:"style"`
	LetterSpacing float64 `json:"letterSpacing"`
	Fill          string  `json:"fill"`
	// Halo is the stroke painted under the glyph with paint-order, or nil.
	// It is the whole of the legibility budget: it widens nothing and moves
	// nothing, so a placement measured against a label box still holds.
	Halo *struct {
		Color string  `json:"color"`
		Width float64 `json:"width"`
	} `json:"halo"`
}

type styleDefinition struct {
	Name           string  `json:"name"`
	Title          string  `json:"title"`
	Description    string  `json:"description"`
	ReferenceWidth float64 `json:"referenceWidth"`
	Terrain        struct {
		Land       string `json:"land"`
		Sea        string `json:"sea"`
		Impassable string `json:"impassable"`
		Ground     string `json:"ground"`
		// GroundInland is what shows through the hairline gaps between the
		// one-polygon-per-province art of a converted jDip map. The sea tone
		// there would turn every inland border into a channel of water.
		GroundInland string `json:"groundInland"`
	} `json:"terrain"`
	Border struct {
		Stroke   string    `json:"stroke"`
		Width    float64   `json:"width"`
		Opacity  float64   `json:"opacity"`
		Dash     []float64 `json:"dash"`
		Linejoin string    `json:"linejoin"`
	} `json:"border"`
	Coast struct {
		Mode   string  `json:"mode"`
		Stroke string  `json:"stroke"`
		Width  float64 `json:"width"`
		Blur   float64 `json:"blur"`
	} `json:"coast"`
	Grain *struct {
		PatternID string   `json:"patternId"`
		Opacity   float64  `json:"opacity"`
		Defs      []string `json:"defs"`
	} `json:"grain"`
	Defs       []string `json:"defs"`
	Fonts      []string `json:"fonts"`
	Typography struct {
		Land                   styleTypography `json:"land"`
		Sea                    styleTypography `json:"sea"`
		SeaAbbrevLetterSpacing float64         `json:"seaAbbrevLetterSpacing"`
	} `json:"typography"`
	SupplyCentre struct {
		Fill        string  `json:"fill"`
		Stroke      string  `json:"stroke"`
		StrokeWidth float64 `json:"strokeWidth"`
		Opacity     float64 `json:"opacity"`
	} `json:"supplyCentre"`
}

// loadedStyle is a style with everything it points at read in, which is what
// an applier works from.
type loadedStyle struct {
	styleDefinition
	// LoadedDefs are the definitions the style needs, as SVG text.
	LoadedDefs []string
	// FontFaces are the @font-face rules, verbatim, or empty.
	FontFaces string
	// GrainSVG is the grain's pattern definition, empty when there is none.
	GrainSVG string
}

var (
	styles     = map[string]*loadedStyle{}
	styleNames []string
	stylesOnce sync.Once
	stylesErr  error
)

// readStyleAsset reads one asset by its path relative to mapstyles/.
// Every file is trimmed, exactly as the detector trims it, so the two
// programs embed the same bytes.
func readStyleAsset(rel string) (string, error) {
	b, err := mapstyles.FS.ReadFile(rel)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func loadStyle(name string) (*loadedStyle, error) {
	b, err := mapstyles.FS.ReadFile(name + ".json")
	if err != nil {
		return nil, err
	}
	def := styleDefinition{}
	if err := json.Unmarshal(b, &def); err != nil {
		return nil, fmt.Errorf("parse mapstyles/%v.json: %w", name, err)
	}
	if def.Name != name {
		return nil, fmt.Errorf("mapstyles/%v.json calls itself %q", name, def.Name)
	}
	out := &loadedStyle{styleDefinition: def}
	for _, rel := range def.Defs {
		text, err := readStyleAsset(rel)
		if err != nil {
			return nil, fmt.Errorf("style %v: %w", name, err)
		}
		out.LoadedDefs = append(out.LoadedDefs, text)
	}
	faces := []string{}
	for _, rel := range def.Fonts {
		text, err := readStyleAsset(rel)
		if err != nil {
			return nil, fmt.Errorf("style %v: %w", name, err)
		}
		faces = append(faces, text)
	}
	out.FontFaces = strings.Join(faces, "\n")
	if def.Grain != nil {
		parts := []string{}
		for _, rel := range def.Grain.Defs {
			text, err := readStyleAsset(rel)
			if err != nil {
				return nil, fmt.Errorf("style %v: %w", name, err)
			}
			parts = append(parts, text)
		}
		out.GrainSVG = strings.Join(parts, "\n")
	}
	return out, nil
}

// LoadStyles reads every style once. A broken style file is a startup error:
// a server that serves three of four styles is worse than one that says so.
func LoadStyles() error {
	stylesOnce.Do(func() {
		entries, err := fs.ReadDir(mapstyles.FS, ".")
		if err != nil {
			stylesErr = err
			return
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			name := strings.TrimSuffix(entry.Name(), ".json")
			style, err := loadStyle(name)
			if err != nil {
				stylesErr = err
				return
			}
			styles[name] = style
			styleNames = append(styleNames, name)
		}
		sort.Strings(styleNames)
	})
	return stylesErr
}

// styleCard is one entry in the style picker.
type styleCard struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// DefaultStyle is the style a map is served in when nobody asks for one.
const DefaultStyle = "parchment"

// styleCards lists the styles for the picker: the default first, then the
// rest alphabetically. A picker is drawn in this order, and the style a map
// already has belongs at the top of it.
func styleCards() []styleCard {
	ordered := append([]string{}, styleNames...)
	sort.Slice(ordered, func(i, j int) bool {
		if (ordered[i] == DefaultStyle) != (ordered[j] == DefaultStyle) {
			return ordered[i] == DefaultStyle
		}
		return ordered[i] < ordered[j]
	})
	out := make([]styleCard, 0, len(ordered))
	for _, name := range ordered {
		style := styles[name]
		out = append(out, styleCard{
			Name:        style.Name,
			Title:       style.Title,
			Description: style.Description,
		})
	}
	return out
}
