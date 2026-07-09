// Package crypto provides at-rest encryption for stored secrets (repo
// passwords, backend credentials) using AES-256-GCM under a single master key.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// keyFileName is where a generated master key is persisted under the data dir.
const keyFileName = "secret.key"

// Box seals and opens secrets with AES-256-GCM.
type Box struct {
	aead cipher.AEAD
}

// NewBox derives a Box from master key material. Any non-empty string works:
// the key is the SHA-256 of the input, so callers may supply a base64 blob, a
// passphrase, or raw bytes.
func NewBox(masterKey string) (*Box, error) {
	if masterKey == "" {
		return nil, errors.New("empty master key")
	}
	key := sha256.Sum256([]byte(masterKey))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext, returning nonce||ciphertext.
func (b *Box) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plaintext, nil), nil
}

// Open decrypts data produced by Seal. A wrong master key fails closed with a
// clear error.
func (b *Box) Open(data []byte) ([]byte, error) {
	if len(data) < b.aead.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := data[:b.aead.NonceSize()], data[b.aead.NonceSize():]
	pt, err := b.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errors.New("decryption failed: wrong or missing master key (RESTIC_UI_KEY)")
	}
	return pt, nil
}

// LoadOrCreateKey returns the master key material to use. Order of precedence:
// the configured value (RESTIC_UI_KEY / _FILE), then a previously generated key
// file under dataDir, else a fresh random key persisted to that file with a
// loud warning to back it up.
func LoadOrCreateKey(configured, dataDir string) (string, error) {
	if configured != "" {
		return configured, nil
	}

	path := filepath.Join(dataDir, keyFileName)
	if data, err := os.ReadFile(path); err == nil {
		key := strings.TrimSpace(string(data))
		if key != "" {
			return key, nil
		}
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate master key: %w", err)
	}
	key := base64.RawStdEncoding.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("persist master key: %w", err)
	}
	slog.Warn("generated a new master key — BACK THIS FILE UP; losing it means losing access to all stored credentials",
		"path", path)
	return key, nil
}
