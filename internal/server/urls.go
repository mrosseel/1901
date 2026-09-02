// The addresses a phone is given, and the machine they name.
//
// A table joins by scanning a QR code, so the invite has to carry an address
// the other phones on the network can actually reach. That is why the LAN
// host is worked out at startup and pinned: a request's own Host header is
// whatever the browser typed, and on the GM's laptop that is localhost.

package server

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
)

// baseURLFixed is the pinned origin from BASE_URL, read once at startup.
var baseURLFixed string

// lanHost is this machine's address on the table's network, found once at
// startup by pinLANHost. It is empty when there is no single answer.
var lanHost string

// baseURL is the origin the invite, seat, and GM links point at.
//
// BASE_URL pins it at startup. Without it the origin comes from the
// request: r.Host. That value is attacker-chosen everywhere except a
// direct browser connection — a man in the middle on the table's network
// can make the GM's next state poll hand back an invite URL that points
// at their own machine. Forwarded headers are not read at all; behind a
// reverse proxy, BASE_URL is the setting.
//
// A loopback host is the exception, because a loopback link is useless to
// everyone at the table: the GM opens localhost on the laptop, and the QR
// code carries a name no phone can resolve. There the host becomes lanHost,
// which the server read from its own interfaces. Nothing in the request
// decides it, so this trusts no more than it did before. The port and the
// scheme are the request's, because that is what the GM reached.
func baseURL(r *http.Request) string {
	if baseURLFixed != "" {
		return baseURLFixed
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + reachableHost(r.Host)
}

// reachableHost swaps a loopback host for the LAN address, keeping the port.
func reachableHost(hostPort string) string {
	if lanHost == "" || !isLoopbackHost(hostPort) {
		return hostPort
	}
	_, port, err := net.SplitHostPort(hostPort)
	if err != nil || port == "" {
		return lanHost
	}
	return net.JoinHostPort(lanHost, port)
}

func isLoopbackHost(hostPort string) bool {
	host := hostPort
	if h, _, err := net.SplitHostPort(hostPort); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// pinLANHost finds the address a phone on the same network can reach, and
// is a no-op once BASE_URL has pinned the origin.
//
// It takes IPv4 only. A QR code is read by a human eye as often as by a
// camera, and an IPv6 address in a URL is bracketed, long, and hard to
// retype.
//
// The kernel's own routing table answers this best, so routedIPv4 asks it
// first. Reading the interfaces instead gives a laptop with docker three
// answers and no way to rank them.
func pinLANHost() {
	if baseURLFixed != "" {
		return
	}
	if ip := routedIPv4(); ip != "" {
		lanHost = ip
		return
	}
	lanHost = scannedIPv4()
}

// routedIPv4 asks the kernel which of this machine's addresses it would
// send from. A UDP "connection" sends nothing; it only fixes a route. The
// destination is TEST-NET-1, which is reserved and never routed anywhere,
// so nothing leaves the machine even if the address were used. This fails
// when there is no default route, which is the case on a table with a
// switch and no uplink.
func routedIPv4() string {
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return ""
	}
	defer c.Close()
	a, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok || a.IP == nil || a.IP.IsLoopback() || a.IP.IsUnspecified() {
		return ""
	}
	ip := a.IP.To4()
	if ip == nil {
		return ""
	}
	return ip.String()
}

// scannedIPv4 is the fallback for a machine with no default route: read the
// interfaces and take the one address that qualifies. Interfaces that are
// down, loopback, or point-to-point are skipped; a link-local address
// (169.254/16) means DHCP failed, so it is skipped too. Two candidates left
// is not a tie the server can settle, so it declines and says so.
func scannedIPv4() string {
	found := []string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("no LAN address: %v — set BASE_URL if the links must leave this machine", err)
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := n.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			found = append(found, ip.String())
		}
	}
	switch len(found) {
	case 0:
		log.Printf("no LAN address found — a link to localhost will not open on a phone; set BASE_URL")
	case 1:
		return found[0]
	default:
		log.Printf("%v LAN addresses (%v) and no default route to rank them — set BASE_URL",
			len(found), strings.Join(found, ", "))
	}
	return ""
}

func inviteURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/join/%v/%v", baseURL(r), id, token)
}

func seatURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/game/%v/seat/%v/", baseURL(r), id, token)
}

// sandboxURL is the whole of a sandbox's authorisation (ADR-047): the person
// holding this link drives the board, and anybody else has the read-only id.
func sandboxURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/game/%v/sandbox/%v/", baseURL(r), id, token)
}

func gmURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/game/%v/gm/%v/", baseURL(r), id, token)
}

// deviceCookieName keeps one device secret per game, so one browser can
// hold seats in several games.
func deviceCookieName(id string) string {
	return "d1901_" + id
}

// refereeCookieName marks the browser that created the game. It answers
// /game/{id}/referee/, which is how the GM reaches the GM view without the
// link ever being displayed anywhere.
func refereeCookieName(id string) string {
	return "r1901_" + id
}

// refereeCookieValue reads the referee cookie, empty when absent.
func refereeCookieValue(r *http.Request, id string) string {
	c, err := r.Cookie(refereeCookieName(id))
	if err != nil {
		return ""
	}
	return c.Value
}
