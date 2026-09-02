// Opening the database, and where it lives.
//
// Every mutation is written through inside the game lock, so a crash loses
// nothing that was answered. The schema and the migrations are in schema.go,
// writing in save.go, reading back in load.go.

package server

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"os"
)

// defaultDBPath is a file made in the working directory, and it stays that
// way for a downloaded binary (ADR-051). Windows starts a double-clicked exe
// in the folder that holds it, and the macOS 1901.command changes to its own
// folder before it runs, so the game master finds 1901.db beside the file they
// downloaded. Somebody starting the server from a terminal gets it where they
// are, which is what a terminal makes you expect. Nothing ships a database:
// the first run makes an empty one.
//
// The DB environment variable overrides it.
const defaultDBPath = "1901.db"

func dbPath() string {
	if p := os.Getenv("DB"); p != "" {
		return p
	}
	return defaultDBPath
}

// db is the process-wide handle. It is nil only before openDB runs.
var db *sql.DB

// openDB opens the database and applies the schema.
func openDB(path string) (*sql.DB, error) {
	handle, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// One writer at a time keeps the write-through simple and avoids
	// SQLITE_BUSY between concurrent game locks.
	handle.SetMaxOpenConns(1)
	if _, err := handle.Exec(schema); err != nil {
		handle.Close()
		return nil, err
	}
	if err := migrate(handle); err != nil {
		handle.Close()
		return nil, err
	}
	if err := loadHandoverSalt(handle); err != nil {
		handle.Close()
		return nil, err
	}
	return handle, nil
}

// loadHandoverSalt reads the salt every handover link is signed with, making
// it on first run (ADR-041). It is stored rather than generated per boot so a
// code somebody photographed still works after a restart.
func loadHandoverSalt(handle *sql.DB) error {
	var stored string
	err := handle.QueryRow(
		`SELECT value FROM server_secret WHERE name = 'handover_salt'`).Scan(&stored)
	if err == nil {
		handoverSalt, err = base64.RawURLEncoding.DecodeString(stored)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	made, err := newToken()
	if err != nil {
		return err
	}
	if _, err := handle.Exec(
		`INSERT INTO server_secret (name, value) VALUES ('handover_salt', ?)`, made); err != nil {
		return err
	}
	handoverSalt, err = base64.RawURLEncoding.DecodeString(made)
	return err
}
