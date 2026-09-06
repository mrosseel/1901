package server

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"spring1901/spike/internal/httpx"
)

// Only successfully used challenges occupy memory. Anonymous challenge GETs
// allocate no records. The process-local signing salt invalidates all old
// challenges on restart, while consumed hashes prevent replays within a run.
//
// Records are kept per game, and each signing key has its own share, so a
// key that proves itself in a loop blocks only itself, and a full game blocks
// nobody else. Memory is bounded by the game cap times the per-game cap.
const maxGameChallenges = 256
const maxKeyChallenges = 32

type usedChallenge struct {
	key     string
	expires time.Time
}

var challenges = struct {
	sync.Mutex
	used map[string]map[[32]byte]usedChallenge
}{used: map[string]map[[32]byte]usedChallenge{}}

// challengeCapacity prunes one game's expired records and says whether the
// game, and the key if given, may record another proof. It never walks past
// one game's bucket, so anonymous callers cannot make it expensive.
func challengeCapacity(id, key string) bool {
	bucket := challenges.used[id]
	now := time.Now()
	for hash, item := range bucket {
		if !now.Before(item.expires) {
			delete(bucket, hash)
		}
	}
	if len(bucket) == 0 {
		delete(challenges.used, id)
		return true
	}
	if len(bucket) >= maxGameChallenges {
		return false
	}
	if key == "" {
		return true
	}
	held := 0
	for _, item := range bucket {
		if item.key == key {
			held++
		}
	}
	return held < maxKeyChallenges
}

func canIssueChallenge(id string) bool {
	challenges.Lock()
	defer challenges.Unlock()
	return challengeCapacity(id, "")
}

func nonceUnused(id, nonce string) bool {
	challenges.Lock()
	defer challenges.Unlock()
	_, used := challenges.used[id][sha256.Sum256([]byte(nonce))]
	return !used
}

// Call after signature verification, with the raw public key that signed.
// HMAC validity is checked independently here, so all callers share expiry,
// domain and replay checks.
func consumeNonce(id, purpose, nonce, key string) bool {
	if !checkNonce(id, purpose, nonce) {
		return false
	}
	challenges.Lock()
	defer challenges.Unlock()
	hash := sha256.Sum256([]byte(nonce))
	if _, used := challenges.used[id][hash]; used || !challengeCapacity(id, key) {
		return false
	}
	parts := strings.Split(nonce, ".")
	expiry, _ := strconv.ParseInt(parts[1], 10, 64)
	if time.Now().Unix() >= expiry {
		return false
	}
	if challenges.used[id] == nil {
		challenges.used[id] = map[[32]byte]usedChallenge{}
	}
	challenges.used[id][hash] = usedChallenge{key, time.Unix(expiry, 0)}
	return true
}

func recoveryPurpose(epoch int) string { return fmt.Sprintf("recover:%d", epoch) }
func handoverPurpose(power string, epoch int) string {
	return fmt.Sprintf("handover:%s:%d", power, epoch)
}
func enrollmentMessage(id, purpose, nonce string) string {
	return "1901 seat enrollment|" + id + "|" + purpose + "|" + nonce
}

type enrollmentProof struct {
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

func enrollmentChallenge(w http.ResponseWriter, id, purpose string) {
	nonce, err := nonceFor(id, purpose)
	if err != nil {
		httpx.WriteErr(w, http.StatusTooManyRequests, "%v", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Nonce   string `json:"nonce"`
		Message string `json:"message"`
	}{nonce, enrollmentMessage(id, purpose, nonce)})
}

// Verify before consuming, and call under the game lock after checking that
// the requested seat/key binding is allowed. An invalid claim changes nothing.
func (proof enrollmentProof) accept(id, purpose, signPub string) bool {
	pub, err := base64.RawURLEncoding.DecodeString(signPub)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(proof.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	if !ed25519.Verify(pub, []byte(enrollmentMessage(id, purpose, proof.Nonce)), sig) {
		return false
	}
	return consumeNonce(id, purpose, proof.Nonce, string(pub))
}
