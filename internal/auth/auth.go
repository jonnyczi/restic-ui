// Package auth implements single-user authentication: bcrypt-verified login,
// SQLite-persisted sessions (so restarts don't log the user out), per-session
// CSRF tokens, and optional bypass modes for trusted reverse proxies.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/jonnyczi/restic-ui/internal/store"
)

// SessionTTL is how long a login remains valid.
const SessionTTL = 7 * 24 * time.Hour

// ErrInvalidCredentials is returned for a bad username/password combination.
var ErrInvalidCredentials = errors.New("invalid credentials")

// User is an authenticated principal.
type User struct {
	ID       int64
	Username string
	Role     string
}

// Session is an active login session.
type Session struct {
	User      User
	CSRFToken string
	ExpiresAt time.Time
}

// Service provides authentication operations backed by the store.
type Service struct {
	st *store.Store
}

// NewService constructs a Service.
func NewService(st *store.Store) *Service { return &Service{st: st} }

// HasUsers reports whether any account exists (false means first-run setup).
func (s *Service) HasUsers(ctx context.Context) (bool, error) {
	var n int
	err := s.st.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n > 0, err
}

// CreateUser creates an account with a bcrypt-hashed password.
func (s *Service) CreateUser(ctx context.Context, username, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	_, err = s.st.DB.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)`,
		username, string(hash), time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// Login verifies credentials and creates a session, returning the raw session
// token (for the cookie) and the session details.
func (s *Service) Login(ctx context.Context, username, password string) (string, *Session, error) {
	var (
		id   int64
		hash string
		role string
	)
	err := s.st.DB.QueryRowContext(ctx,
		`SELECT id, password_hash, role FROM users WHERE username = ?`, username,
	).Scan(&id, &hash, &role)
	if errors.Is(err, sql.ErrNoRows) {
		// Burn comparable time so missing users aren't distinguishable by timing.
		_ = bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5B0Wp5C3P0dGbC4qkjR5D3aBCDEFG"), []byte(password))
		return "", nil, ErrInvalidCredentials
	}
	if err != nil {
		return "", nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", nil, ErrInvalidCredentials
	}

	token, err := randomToken()
	if err != nil {
		return "", nil, err
	}
	csrf, err := randomToken()
	if err != nil {
		return "", nil, err
	}

	now := time.Now().UTC()
	expires := now.Add(SessionTTL)
	_, err = s.st.DB.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		hashToken(token), id, csrf, now.Format(time.RFC3339), expires.Format(time.RFC3339),
	)
	if err != nil {
		return "", nil, err
	}

	return token, &Session{
		User:      User{ID: id, Username: username, Role: role},
		CSRFToken: csrf,
		ExpiresAt: expires,
	}, nil
}

// GetSession resolves a raw cookie token to a live session, or nil if the
// token is unknown or expired.
func (s *Service) GetSession(ctx context.Context, token string) (*Session, error) {
	var (
		sess    Session
		expires string
	)
	err := s.st.DB.QueryRowContext(ctx, `
		SELECT u.id, u.username, u.role, se.csrf_token, se.expires_at
		FROM sessions se JOIN users u ON u.id = se.user_id
		WHERE se.token_hash = ?`, hashToken(token),
	).Scan(&sess.User.ID, &sess.User.Username, &sess.User.Role, &sess.CSRFToken, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.ExpiresAt, err = time.Parse(time.RFC3339, expires)
	if err != nil || time.Now().After(sess.ExpiresAt) {
		// Expired (or unparseable): treat as no session and clean up lazily.
		_, _ = s.st.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token))
		return nil, nil
	}
	return &sess, nil
}

// Logout deletes the session for the given raw token.
func (s *Service) Logout(ctx context.Context, token string) error {
	_, err := s.st.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token))
	return err
}

// PruneExpired removes expired sessions. Called opportunistically.
func (s *Service) PruneExpired(ctx context.Context) error {
	_, err := s.st.DB.ExecContext(ctx,
		`DELETE FROM sessions WHERE expires_at < ?`, time.Now().UTC().Format(time.RFC3339))
	return err
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
