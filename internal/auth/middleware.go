package auth

import (
	"context"
	"crypto/subtle"
	"net/http"

	"github.com/jonnyczi/restic-ui/internal/config"
)

// CookieName is the session cookie name.
const CookieName = "restic_ui_session"

type ctxKey int

const (
	sessionKey ctxKey = iota
)

// FromContext returns the session attached to the request, or nil.
func FromContext(ctx context.Context) *Session {
	s, _ := ctx.Value(sessionKey).(*Session)
	return s
}

// Middleware resolves the caller's identity and attaches it to the request
// context. It does not reject requests — RequireAuth does that — so public
// endpoints can share it.
//
// Identity sources, in order:
//  1. AUTH_DISABLED: every request is the built-in admin.
//  2. TRUSTED_PROXY_HEADER: a non-empty value in that header authenticates the
//     request as that user (the proxy is trusted to strip client-set values).
//  3. Session cookie.
func Middleware(svc *Service, cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var sess *Session

			switch {
			case cfg.AuthDisabled:
				sess = &Session{User: User{ID: 0, Username: "admin", Role: "admin"}}
			case cfg.TrustedProxyHeader != "" && r.Header.Get(cfg.TrustedProxyHeader) != "":
				sess = &Session{User: User{
					ID:       0,
					Username: r.Header.Get(cfg.TrustedProxyHeader),
					Role:     "admin",
				}}
			default:
				if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
					if got, err := svc.GetSession(r.Context(), c.Value); err == nil && got != nil {
						sess = got
					}
				}
			}

			if sess != nil {
				r = r.WithContext(context.WithValue(r.Context(), sessionKey, sess))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAuth rejects unauthenticated requests with 401 and enforces CSRF on
// mutating methods.
//
// CSRF model: the frontend echoes the per-session token from /api/auth/me in
// the X-CSRF-Token header. In bypass modes there is no session token, but the
// header must still be present — browsers cannot attach custom headers
// cross-site without a CORS preflight (which we never allow), so requiring it
// blocks form-based CSRF there too.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess := FromContext(r.Context())
		if sess == nil {
			http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			// Safe methods: no CSRF check.
		default:
			header := r.Header.Get("X-CSRF-Token")
			if header == "" {
				http.Error(w, `{"error":"missing csrf token"}`, http.StatusForbidden)
				return
			}
			// Sessions carry a bound token; bypass identities only require the
			// custom header's presence.
			if sess.CSRFToken != "" &&
				subtle.ConstantTimeCompare([]byte(header), []byte(sess.CSRFToken)) != 1 {
				http.Error(w, `{"error":"invalid csrf token"}`, http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
