// Serving compressed responses.
//
// The maps are the whole reason this file exists. Classical's parchment SVG is
// 1.8 MB of text and gzips to under a megabyte; all 26 boards together are 25 MB
// raw and 7.5 MB gzipped. Everything else the server sends is JSON, the app
// shell, and vite's bundles, which compress about as well and cost nothing to
// compress because they are small.
//
// Two rules decide whether a response is compressed, and both are refusals. A
// client that did not offer gzip never gets it. A body that is not text never
// gets it either: a PNG or a QR image is already compressed, and running deflate
// over it spends CPU to add bytes.
//
// Every compressible response carries `Vary: Accept-Encoding`, whether or not it
// was compressed. A cache that stores one response and hands it to the next
// client would otherwise serve gzip to a client that cannot read it.
package main

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// minCompressBytes is the body size below which a response is sent as it is.
// A gzip stream costs about twenty bytes of header and trailer before it has
// compressed anything, and under a kilobyte the saving is not worth the CPU at
// either end.
const minCompressBytes = 1024

// gzipWriters pools the compressors. A gzip.Writer holds a 32 KB window and
// its hash tables, which is a lot to allocate per request.
var gzipWriters = sync.Pool{
	New: func() any {
		w, err := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
		if err != nil {
			panic(err)
		}
		return w
	},
}

// gzipBytes compresses a whole body at once, for callers that cache the result.
func gzipBytes(body []byte) []byte {
	out := &bytes.Buffer{}
	w := gzipWriters.Get().(*gzip.Writer)
	w.Reset(out)
	w.Write(body)
	w.Close()
	gzipWriters.Put(w)
	return out.Bytes()
}

// acceptsGzip reports whether the client offered gzip.
//
// A bare `gzip` in the list is an offer. `gzip;q=0` is the opposite: it is how
// a client says it will not take gzip even though the encoding exists, and it
// is the one thing that has to be read out of the parameters.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		for _, param := range strings.Split(params, ";") {
			key, value, found := strings.Cut(param, "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			if q, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && q == 0 {
				return false
			}
		}
		return true
	}
	return false
}

// compressibleTypes are the media types worth compressing. Everything this
// server sends that is not on this list is already compressed bytes.
var compressibleTypes = map[string]bool{
	"application/javascript": true,
	"application/json":       true,
	"application/manifest":   true,
	"application/xml":        true,
	"image/svg+xml":          true,
}

// compressible reads a Content-Type header and says whether its body is text.
func compressible(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	media = strings.ToLower(strings.TrimSpace(media))
	if media == "" {
		return false
	}
	if strings.HasPrefix(media, "text/") {
		return true
	}
	// A structured suffix says what the body IS: application/manifest+json is
	// JSON, whatever the type in front of it means.
	if _, suffix, found := strings.Cut(media, "+"); found {
		return suffix == "json" || suffix == "xml" || suffix == "text"
	}
	return compressibleTypes[media]
}

// compressWriter holds a response back until it knows two things it cannot know
// before the handler starts writing: what the body's media type is, and whether
// there is enough of it to be worth compressing.
type compressWriter struct {
	http.ResponseWriter
	status  int
	held    []byte
	decided bool
	gz      *gzip.Writer
	mayGzip bool
}

func (self *compressWriter) WriteHeader(status int) {
	if self.decided {
		self.ResponseWriter.WriteHeader(status)
		return
	}
	self.status = status
}

func (self *compressWriter) Write(body []byte) (int, error) {
	if self.decided {
		if self.gz != nil {
			return self.gz.Write(body)
		}
		return self.ResponseWriter.Write(body)
	}
	self.held = append(self.held, body...)
	if len(self.held) >= minCompressBytes {
		self.decide()
	}
	return len(body), nil
}

// Flush sends what is held. A handler that flushes is asking for the bytes to
// leave now, which settles the question of whether more are coming.
func (self *compressWriter) Flush() {
	if !self.decided {
		self.decide()
	}
	if self.gz != nil {
		self.gz.Flush()
	}
	if flusher, ok := self.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// decide settles the encoding, writes the header, and releases the held body.
func (self *compressWriter) decide() {
	self.decided = true
	header := self.Header()

	contentType := header.Get("Content-Type")
	if contentType == "" && len(self.held) > 0 {
		contentType = http.DetectContentType(self.held)
	}
	text := compressible(contentType)
	if text && header.Get("Content-Encoding") == "" {
		// Announced whether or not this particular response was compressed:
		// the next one on the same URL may be, for a client that asks.
		if header.Get("Vary") == "" {
			header.Set("Vary", "Accept-Encoding")
		}
	}
	if self.mayGzip && text && len(self.held) >= minCompressBytes &&
		self.status == http.StatusOK && header.Get("Content-Encoding") == "" {
		header.Set("Content-Type", contentType)
		header.Set("Content-Encoding", "gzip")
		// The length of the compressed body is not known until it is written,
		// and the uncompressed one would be a lie.
		header.Del("Content-Length")
		self.gz = gzipWriters.Get().(*gzip.Writer)
		self.gz.Reset(self.ResponseWriter)
	}

	self.ResponseWriter.WriteHeader(self.status)
	if len(self.held) > 0 {
		if self.gz != nil {
			self.gz.Write(self.held)
		} else {
			self.ResponseWriter.Write(self.held)
		}
	}
	self.held = nil
}

// close finishes the response. A body that never reached minCompressBytes is
// released here, uncompressed.
func (self *compressWriter) close() {
	if !self.decided {
		self.decide()
	}
	if self.gz != nil {
		self.gz.Close()
		gzipWriters.Put(self.gz)
		self.gz = nil
	}
}

// compress wraps a handler so its text responses are gzipped for clients that
// asked for it.
//
// A range request is passed through untouched. The range names bytes of the
// representation the client already has a length for, and compressing the
// answer would renumber them.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		writer := &compressWriter{
			ResponseWriter: w,
			status:         http.StatusOK,
			mayGzip:        acceptsGzip(r),
		}
		defer writer.close()
		next.ServeHTTP(writer, r)
	})
}
