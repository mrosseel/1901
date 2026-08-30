package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcceptsGzipReadsTheOffer(t *testing.T) {
	cases := map[string]bool{
		"":                              false,
		"identity":                      false,
		"deflate, br":                   false,
		"gzip":                          true,
		"gzip, deflate, br":             true,
		"GZIP":                          true,
		" gzip ;q=0.5 ":                 true,
		"gzip;q=0":                      false,
		"deflate, gzip;q=0.0":           false,
		"gzip;q=0.001":                  true,
		"deflate;q=0, gzip;q=1.0":       true,
		"x-gzip":                        false,
		"*":                             false,
		"br;q=1.0, gzip;q=0.8, *;q=0.1": true,
	}
	for header, want := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		if header != "" {
			r.Header.Set("Accept-Encoding", header)
		}
		if got := acceptsGzip(r); got != want {
			t.Errorf("Accept-Encoding %q: got %v, want %v", header, got, want)
		}
	}
}

func TestCompressibleReadsTheMediaType(t *testing.T) {
	cases := map[string]bool{
		"image/svg+xml":                   true,
		"application/json":                true,
		"application/json; charset=utf-8": true,
		"text/html; charset=utf-8":        true,
		"text/css":                        true,
		"application/javascript":          true,
		"application/manifest+json":       true,
		"image/png":                       false,
		"image/jpeg":                      false,
		"font/woff2":                      false,
		"application/octet-stream":        false,
		"":                                false,
	}
	for media, want := range cases {
		if got := compressible(media); got != want {
			t.Errorf("%q: got %v, want %v", media, got, want)
		}
	}
}

// serve runs one request through the middleware and returns the response.
func serve(t *testing.T, handler http.HandlerFunc, encoding string) *http.Response {
	t.Helper()
	r := httptest.NewRequest("GET", "/", nil)
	if encoding != "" {
		r.Header.Set("Accept-Encoding", encoding)
	}
	w := httptest.NewRecorder()
	compress(handler).ServeHTTP(w, r)
	return w.Result()
}

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
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("the body is not a gzip stream: %v", err)
	}
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func textHandler(media string, size int) http.HandlerFunc {
	body := strings.Repeat("province ", size/9+1)[:size]
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", media)
		w.Write([]byte(body))
	}
}

func TestTextIsCompressedForAClientThatAsked(t *testing.T) {
	handler := textHandler("image/svg+xml", 40000)
	res := serve(t, handler, "gzip")
	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("a client that offered gzip did not get it")
	}
	if res.Header.Get("Vary") != "Accept-Encoding" {
		t.Error("a compressed response must vary on Accept-Encoding")
	}
	if res.Header.Get("Content-Type") != "image/svg+xml" {
		t.Errorf("the media type became %q", res.Header.Get("Content-Type"))
	}
	plain := serve(t, handler, "")
	if plain.Header.Get("Content-Encoding") != "" {
		t.Fatal("a client that offered nothing was sent an encoding")
	}
	if !bytes.Equal(unpack(t, res), unpack(t, plain)) {
		t.Error("the decompressed body is not the uncompressed body")
	}
}

func TestSmallAndBinaryResponsesAreLeftAlone(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"under a kilobyte", textHandler("application/json", minCompressBytes-1)},
		{"a png", textHandler("image/png", 40000)},
	}
	for _, one := range cases {
		res := serve(t, one.handler, "gzip")
		if res.Header.Get("Content-Encoding") != "" {
			t.Errorf("%v was compressed", one.name)
		}
	}
}

func TestOnlyTextAnnouncesTheVary(t *testing.T) {
	// A cache that ignores Vary would hand a gzipped body to a client that
	// cannot read it, so the header goes on every response that COULD be
	// compressed, not only the ones that were.
	res := serve(t, textHandler("application/json", minCompressBytes-1), "")
	if res.Header.Get("Vary") != "Accept-Encoding" {
		t.Error("an uncompressed text response did not vary on Accept-Encoding")
	}
	png := serve(t, textHandler("image/png", 40000), "gzip")
	if png.Header.Get("Vary") != "" {
		t.Error("a binary response varies on nothing")
	}
}

func TestAnAlreadyEncodedBodyIsNotCompressedTwice(t *testing.T) {
	packed := gzipBytes([]byte(strings.Repeat("province ", 5000)))
	res := serve(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(packed)
	}, "gzip")
	if !bytes.Equal(unpack(t, res), []byte(strings.Repeat("province ", 5000))) {
		t.Error("a handler's own gzip stream did not survive the middleware")
	}
}

func TestARangeRequestIsPassedThrough(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("Range", "bytes=0-99")
	w := httptest.NewRecorder()
	compress(textHandler("image/svg+xml", 40000)).ServeHTTP(w, r)
	if w.Result().Header.Get("Content-Encoding") != "" {
		t.Error("a range request was answered with a renumbered body")
	}
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
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}

	styles := []string{"original", "parchment", "flat", "midnight", "print"}
	compressed := 0
	for key := range generatedVariants {
		for _, style := range styles {
			url := "/variants/" + key + "/map.svg?style=" + style

			plainRec := httptest.NewRecorder()
			compress(http.HandlerFunc(handleVariantMap)).ServeHTTP(
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
			compress(http.HandlerFunc(handleVariantMap)).ServeHTTP(packedRec, r)
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
