// Rounding the coordinates of map art to two decimals.
//
// godip's maps and the converted jDip ones come out of drawing programs that
// write coordinates to eight or more decimals. On a board 1524 units wide the
// third decimal is a five-thousandth of a province border, and the file pays
// six bytes a number for it. Dropping to two decimals takes about a fifth off
// the file and about a quarter off the gzipped bytes.
//
// Only two attributes are touched: a path's `d` and a polygon or polyline's
// `points`. Those are geometry in the map's own units and nothing else. Every
// other number in the art is left exactly as it was written, because two
// decimals is the wrong precision for most of them: an opacity, a gradient
// stop's offset and a transform's scale factor all live between 0 and 1, where
// rounding to a hundredth is a visible change or, at scale(0.001), the whole
// drawing collapsing to nothing. The viewBox is untouched for a further
// reason — the placement tables are quoted in the coordinate space it declares,
// so changing it would invalidate every placement on the board.
//
// A relative path command is a delta, so rounding each one on its own would let
// the error accumulate down a subpath of a thousand segments. What is rounded
// here is therefore the ABSOLUTE position: the residual of each rounding is
// carried into the next delta, so the drawn point never drifts more than half a
// hundredth from where the original art put it, however long the path.
package svground

import (
	"regexp"
	"strconv"
	"strings"
)

// geometryAttrRe matches the two attributes that carry geometry. The leading
// whitespace is what keeps `d="` from matching the tail of another attribute
// name.
var geometryAttrRe = regexp.MustCompile(`(\s)(d|points)="([^"]*)"`)

// Art rewrites one SVG's path and polygon geometry to at most two decimals.
//
// An attribute whose value does not parse is left exactly as it was: art this
// package does not understand is art it must not damage.
func Art(svg []byte) []byte {
	return geometryAttrRe.ReplaceAllFunc(svg, func(match []byte) []byte {
		m := geometryAttrRe.FindSubmatch(match)
		name, value := string(m[2]), string(m[3])
		var next string
		var ok bool
		if name == "d" {
			next, ok = roundPath(value)
		} else {
			next, ok = roundPoints(value)
		}
		if !ok {
			return match
		}
		return []byte(string(m[1]) + name + `="` + next + `"`)
	})
}

// format writes a number with at most two decimals and no trailing zeros, and
// returns the value it now stands for.
func format(value float64) (string, float64) {
	text := strconv.FormatFloat(value, 'f', 2, 64)
	text = strings.TrimSuffix(strings.TrimRight(text, "0"), ".")
	if text == "" || text == "-" || text == "-0" {
		text = "0"
	}
	rounded, _ := strconv.ParseFloat(text, 64)
	return text, rounded
}

// scanNumber reads one SVG number starting at index i, returning the index
// after it. It returns i when there is no number there.
func scanNumber(s string, i int) int {
	j := i
	if j < len(s) && (s[j] == '+' || s[j] == '-') {
		j++
	}
	digits := 0
	for j < len(s) && s[j] >= '0' && s[j] <= '9' {
		j++
		digits++
	}
	if j < len(s) && s[j] == '.' {
		j++
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
			digits++
		}
	}
	if digits == 0 {
		return i
	}
	if j < len(s) && (s[j] == 'e' || s[j] == 'E') {
		k := j + 1
		if k < len(s) && (s[k] == '+' || s[k] == '-') {
			k++
		}
		exponent := 0
		for k < len(s) && s[k] >= '0' && s[k] <= '9' {
			k++
			exponent++
		}
		if exponent > 0 {
			j = k
		}
	}
	return j
}

// numbers reads every number in a list, and reports whether anything other
// than numbers and separators was in it.
func numbers(s string) ([]float64, bool) {
	out := []float64{}
	for i := 0; i < len(s); {
		c := s[i]
		if c == ' ' || c == ',' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		end := scanNumber(s, i)
		if end == i {
			return nil, false
		}
		value, err := strconv.ParseFloat(s[i:end], 64)
		if err != nil {
			return nil, false
		}
		out = append(out, value)
		i = end
	}
	return out, true
}

// roundPoints rounds a polygon or polyline's absolute coordinate list.
func roundPoints(value string) (string, bool) {
	values, ok := numbers(value)
	if !ok || len(values) == 0 || len(values)%2 != 0 {
		return "", false
	}
	parts := make([]string, len(values))
	for i, one := range values {
		parts[i], _ = format(one)
	}
	return strings.Join(parts, " "), true
}

// pathArity is how many numbers each path command takes per group.
var pathArity = map[byte]int{
	'm': 2, 'z': 0, 'l': 2, 'h': 1, 'v': 1,
	'c': 6, 's': 4, 'q': 4, 't': 2, 'a': 7,
}

// pathToken is one command letter or one number of a path's data.
type pathToken struct {
	letter byte
	number float64
}

// tokenizePath splits path data into command letters and numbers.
func tokenizePath(d string) ([]pathToken, bool) {
	out := []pathToken{}
	for i := 0; i < len(d); {
		c := d[i]
		switch {
		case c == ' ' || c == ',' || c == '\t' || c == '\n' || c == '\r':
			i++
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			if _, known := pathArity[lower(c)]; !known {
				return nil, false
			}
			out = append(out, pathToken{letter: c})
			i++
		default:
			end := scanNumber(d, i)
			if end == i {
				return nil, false
			}
			value, err := strconv.ParseFloat(d[i:end], 64)
			if err != nil {
				return nil, false
			}
			out = append(out, pathToken{letter: 0, number: value})
			i = end
		}
	}
	return out, true
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

// pen carries the difference between where the original art puts the current
// point and where the rounded output puts it, one component per axis. Every
// relative delta is corrected by it before rounding, which is what stops the
// error from accumulating along a subpath.
type pen struct {
	errX, errY     float64
	startX, startY float64
}

// coord rounds one coordinate of a command group.
//
// relative says the number is a delta from the current point; endpoint says it
// moves the current point, which a Bézier control point does not.
func (self *pen) coord(value float64, axis int, relative, endpoint bool) string {
	residual := self.errX
	if axis == 1 {
		residual = self.errY
	}
	wanted := value
	if relative {
		wanted = value + residual
	}
	text, rounded := format(wanted)
	if endpoint {
		next := wanted - rounded
		if axis == 0 {
			self.errX = next
		} else {
			self.errY = next
		}
	}
	return text
}

// roundPath rewrites path data with every coordinate at two decimals.
func roundPath(d string) (string, bool) {
	tokens, ok := tokenizePath(d)
	if !ok || len(tokens) == 0 {
		return "", false
	}
	out := strings.Builder{}
	p := &pen{}
	at := 0
	for at < len(tokens) {
		if tokens[at].letter == 0 {
			return "", false
		}
		command := tokens[at].letter
		at++
		out.WriteByte(command)

		kind := lower(command)
		relative := command >= 'a' && command <= 'z'
		arity := pathArity[kind]
		if arity == 0 {
			p.errX, p.errY = p.startX, p.startY
			continue
		}
		first := true
		for at < len(tokens) && tokens[at].letter == 0 {
			if at+arity > len(tokens) {
				return "", false
			}
			group := make([]float64, arity)
			for i := range group {
				if tokens[at+i].letter != 0 {
					return "", false
				}
				group[i] = tokens[at+i].number
			}
			at += arity

			parts := []string{}
			switch kind {
			case 'm', 'l', 't':
				parts = append(parts,
					p.coord(group[0], 0, relative, true),
					p.coord(group[1], 1, relative, true))
			case 'h':
				parts = append(parts, p.coord(group[0], 0, relative, true))
			case 'v':
				parts = append(parts, p.coord(group[0], 1, relative, true))
			case 'c':
				parts = append(parts,
					p.coord(group[0], 0, relative, false),
					p.coord(group[1], 1, relative, false),
					p.coord(group[2], 0, relative, false),
					p.coord(group[3], 1, relative, false),
					p.coord(group[4], 0, relative, true),
					p.coord(group[5], 1, relative, true))
			case 's', 'q':
				parts = append(parts,
					p.coord(group[0], 0, relative, false),
					p.coord(group[1], 1, relative, false),
					p.coord(group[2], 0, relative, true),
					p.coord(group[3], 1, relative, true))
			case 'a':
				// The two radii and the rotation are lengths and an angle, not
				// positions, so they round on their own. The large-arc and
				// sweep flags are 0 or 1 and are written back as they came.
				rx, _ := format(group[0])
				ry, _ := format(group[1])
				rotation, _ := format(group[2])
				parts = append(parts, rx, ry, rotation,
					strconv.Itoa(int(group[3])), strconv.Itoa(int(group[4])),
					p.coord(group[5], 0, relative, true),
					p.coord(group[6], 1, relative, true))
			}
			if kind == 'm' && first {
				p.startX, p.startY = p.errX, p.errY
			}
			if !first {
				out.WriteByte(' ')
			}
			first = false
			out.WriteString(strings.Join(parts, " "))

			// A moveto with more than one group draws lines, which take two
			// numbers and move the point exactly as a lineto does.
			if kind == 'm' {
				kind = 'l'
				arity = 2
			}
		}
	}
	return out.String(), true
}
