// Package store owns the SQLite connection and schema migrations.
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"path/filepath"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite" // pure-Go sqlite driver, registered as "sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store wraps the application database.
type Store struct {
	DB *sql.DB
}

// Open opens (creating if needed) the SQLite database under dataDir and applies
// all pending migrations.
func Open(dataDir string) (*Store, error) {
	dbPath := filepath.Join(dataDir, "restic-ui.db")
	// WAL for concurrent readers, a generous busy timeout so brief write
	// contention retries instead of erroring, and enforced foreign keys.
	dsn := fmt.Sprintf(
		"file:%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)",
		dbPath,
	)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// Serialize access through a single connection: simplest correct behaviour
	// for SQLite and plenty for this workload.
	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}

	return &Store{DB: db}, nil
}

func migrate(db *sql.DB) error {
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}

// Close closes the underlying database.
func (s *Store) Close() error { return s.DB.Close() }
