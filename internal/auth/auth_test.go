package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/jonnyczi/restic-ui/internal/store"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return NewService(st)
}

func TestUserAndSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// Fresh database: no users yet.
	has, err := svc.HasUsers(ctx)
	if err != nil {
		t.Fatalf("HasUsers: %v", err)
	}
	if has {
		t.Fatal("expected no users in fresh db")
	}

	if err := svc.CreateUser(ctx, "admin", "correct horse battery"); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if has, _ = svc.HasUsers(ctx); !has {
		t.Fatal("expected users after CreateUser")
	}

	// Wrong password and unknown user both fail with ErrInvalidCredentials.
	if _, _, err := svc.Login(ctx, "admin", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password: got %v, want ErrInvalidCredentials", err)
	}
	if _, _, err := svc.Login(ctx, "nobody", "whatever"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown user: got %v, want ErrInvalidCredentials", err)
	}

	// Correct login issues a session with a CSRF token.
	token, sess, err := svc.Login(ctx, "admin", "correct horse battery")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" || sess.CSRFToken == "" || sess.User.Username != "admin" {
		t.Fatalf("unexpected session: token=%q sess=%+v", token, sess)
	}

	// The raw token resolves the session; a bogus token does not.
	got, err := svc.GetSession(ctx, token)
	if err != nil || got == nil {
		t.Fatalf("GetSession: got=%v err=%v", got, err)
	}
	if got.CSRFToken != sess.CSRFToken {
		t.Fatal("csrf token mismatch on lookup")
	}
	if bogus, _ := svc.GetSession(ctx, "not-a-real-token"); bogus != nil {
		t.Fatal("bogus token should not resolve")
	}

	// Logout invalidates the token.
	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if gone, _ := svc.GetSession(ctx, token); gone != nil {
		t.Fatal("session should be gone after logout")
	}
}
