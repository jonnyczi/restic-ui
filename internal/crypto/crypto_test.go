package crypto

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	box, err := NewBox("test-master-key")
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte(`{"secretAccessKey":"hunter2"}`)

	sealed, err := box.Seal(secret)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("hunter2")) {
		t.Fatal("ciphertext leaks plaintext")
	}

	opened, err := box.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, secret) {
		t.Fatalf("round trip mismatch: %q", opened)
	}

	// Two seals of the same plaintext must differ (random nonce).
	sealed2, _ := box.Seal(secret)
	if bytes.Equal(sealed, sealed2) {
		t.Fatal("nonce reuse: identical ciphertexts")
	}
}

func TestOpenWithWrongKeyFailsClosed(t *testing.T) {
	box1, _ := NewBox("key-one")
	box2, _ := NewBox("key-two")
	sealed, _ := box1.Seal([]byte("secret"))
	if _, err := box2.Open(sealed); err == nil {
		t.Fatal("expected failure with wrong key")
	}
}

func TestLoadOrCreateKey(t *testing.T) {
	dir := t.TempDir()

	// Configured key wins and writes nothing.
	key, err := LoadOrCreateKey("configured", dir)
	if err != nil || key != "configured" {
		t.Fatalf("configured key: %q err=%v", key, err)
	}
	if _, err := os.Stat(filepath.Join(dir, keyFileName)); !os.IsNotExist(err) {
		t.Fatal("configured key should not create a key file")
	}

	// No key: generate, persist 0600, and return the same value next time.
	gen1, err := LoadOrCreateKey("", dir)
	if err != nil || gen1 == "" {
		t.Fatalf("generate: %q err=%v", gen1, err)
	}
	info, err := os.Stat(filepath.Join(dir, keyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, want 0600", info.Mode().Perm())
	}
	gen2, _ := LoadOrCreateKey("", dir)
	if gen1 != gen2 {
		t.Fatal("persisted key not stable across loads")
	}
}
