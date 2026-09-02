// Writing a JSON answer, and writing a refusal.
//
// Every endpoint answers in JSON, including the ones that fail, so a client
// parses one shape whatever happened.

package httpx

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

// WriteJSON sends a body as JSON under the given status.
func WriteJSON(w http.ResponseWriter, code int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("encode: %v", err)
	}
}

// WriteErr sends a refusal: the status, and one sentence saying why.
func WriteErr(w http.ResponseWriter, code int, format string, args ...interface{}) {
	WriteJSON(w, code, map[string]string{"error": fmt.Sprintf(format, args...)})
}
