// Every map, served the same way compressed and not (ADR-036).
package app

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"spring1901/spike/internal/httpx"
)

// unpack returns a response's body as the client would read it.
func unpack(t *testing.T, res *http.Response) []byte {
	t.Helper()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.Header.Get("Content-Encoding") != "gzip" {
		return body
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("the body is not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading the gzip body: %v", err)
	}
	return out
}

// TestEveryMapIsServedIdenticallyCompressed is the check the compression has to
// pass: for every variant in every style, what a gzip client unpacks is byte
// for byte what a client that offered nothing was sent.
func TestEveryMapIsServedIdenticallyCompressed(t *testing.T) {
	if err := loadStyles(); err != nil {
		t.Fatal(err)
	}
	if err := loadPlans(); err != nil {
		t.Fatal(err)
	}
	withGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}

	styles := []string{"original", "parchment", "flat", "midnight", "print"}
	compressed := 0
	for key := range generatedVariants {
		for _, style := range styles {
			url := "/variants/" + key + "/map.svg?style=" + style

			plainRec := httptest.NewRecorder()
			httpx.Compress(http.HandlerFunc(handleVariantMap)).ServeHTTP(
				plainRec, httptest.NewRequest("GET", url, nil))
			plain := plainRec.Result()
			if plain.StatusCode != http.StatusOK {
				t.Fatalf("%v in %v: status %v", key, style, plain.StatusCode)
			}
			if plain.Header.Get("Content-Encoding") != "" {
				t.Fatalf("%v in %v: a client that offered nothing got an encoding",
					key, style)
			}

			r := httptest.NewRequest("GET", url, nil)
			r.Header.Set("Accept-Encoding", "gzip")
			packedRec := httptest.NewRecorder()
			httpx.Compress(http.HandlerFunc(handleVariantMap)).ServeHTTP(packedRec, r)
			packed := packedRec.Result()
			if packed.Header.Get("Content-Encoding") != "gzip" {
				t.Fatalf("%v in %v: a map was sent uncompressed", key, style)
			}
			if packed.Header.Get("Vary") != "Accept-Encoding" {
				t.Fatalf("%v in %v: no Vary on a compressed map", key, style)
			}
			if !bytes.Equal(unpack(t, packed), unpack(t, plain)) {
				t.Fatalf("%v in %v: the decompressed map is not the map", key, style)
			}
			compressed++
		}
	}
	if compressed != len(generatedVariants)*len(styles) {
		t.Fatalf("checked %v map(s), expected %v",
			compressed, len(generatedVariants)*len(styles))
	}
}
