package server

import (
	"net"
	"net/http"
	"strings"
)

// Direct TLS and a pinned HTTPS origin always require secure cookies. Only
// configured proxies may assert the external protocol; use the last hop.
func secureCookies(r *http.Request) bool {
	if r.TLS != nil || strings.HasPrefix(baseURLFixed, "https://") {
		return true
	}
	if baseURLFixed != "" {
		return false
	} // explicitly configured LAN HTTP
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !fromTrustedProxy(host) {
		return false
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")
	return strings.EqualFold(strings.TrimSpace(hops[len(hops)-1]), "https")
}
