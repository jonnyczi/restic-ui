package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jonnyczi/restic-ui/internal/auth"
)

// authMeResponse describes the caller's auth state; the SPA uses it to decide
// between setup, login, and the app.
type authMeResponse struct {
	SetupRequired bool   `json:"setupRequired"`
	Authenticated bool   `json:"authenticated"`
	Username      string `json:"username,omitempty"`
	CSRFToken     string `json:"csrfToken,omitempty"`
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	resp := authMeResponse{}

	hasUsers, err := s.auth.HasUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	// In bypass modes setup is irrelevant; otherwise first run requires it.
	bypass := s.cfg.AuthDisabled || s.cfg.TrustedProxyHeader != ""
	resp.SetupRequired = !hasUsers && !bypass

	if sess := auth.FromContext(r.Context()); sess != nil {
		resp.Authenticated = true
		resp.Username = sess.User.Username
		resp.CSRFToken = sess.CSRFToken
		if resp.CSRFToken == "" {
			// Bypass identity: any value satisfies the header-presence check.
			resp.CSRFToken = "bypass"
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type credentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	hasUsers, err := s.auth.HasUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if hasUsers {
		writeError(w, http.StatusConflict, "setup already completed")
		return
	}

	var req credentialsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "username required and password must be at least 8 characters")
		return
	}

	if err := s.auth.CreateUser(r.Context(), req.Username, req.Password); err != nil {
		slog.Error("create user", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create user")
		return
	}
	slog.Info("initial admin account created", "username", req.Username)

	// Log the new admin straight in.
	s.loginAndRespond(w, r, req.Username, req.Password)
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.loginAndRespond(w, r, strings.TrimSpace(req.Username), req.Password)
}

func (s *Server) loginAndRespond(w http.ResponseWriter, r *http.Request, username, password string) {
	token, sess, err := s.auth.Login(r.Context(), username, password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if err != nil {
		slog.Error("login", "err", err)
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}

	http.SetCookie(w, s.sessionCookie(r, token, sess.ExpiresAt))
	// Opportunistic cleanup of expired sessions (request context would be
	// canceled once the handler returns, so use Background).
	go func() {
		if err := s.auth.PruneExpired(context.Background()); err != nil {
			slog.Warn("prune expired sessions", "err", err)
		}
	}()

	writeJSON(w, http.StatusOK, authMeResponse{
		Authenticated: true,
		Username:      sess.User.Username,
		CSRFToken:     sess.CSRFToken,
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil && c.Value != "" {
		if err := s.auth.Logout(r.Context(), c.Value); err != nil {
			slog.Error("logout", "err", err)
		}
	}
	http.SetCookie(w, s.sessionCookie(r, "", time.Unix(0, 0)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// sessionCookie builds the session cookie; an empty token with a past expiry
// clears it. Secure is set when the request arrived over TLS (directly or via
// a proxy that says so).
func (s *Server) sessionCookie(r *http.Request, token string, expires time.Time) *http.Cookie {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	return &http.Cookie{
		Name:     auth.CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}
}
