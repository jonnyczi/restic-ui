// Package config loads runtime configuration from environment variables.
//
// Every secret-bearing variable also supports a "_FILE" companion (the Docker
// secrets convention): if VAR_FILE is set, the secret is read from that file's
// contents instead of VAR.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config holds all runtime configuration for the server.
type Config struct {
	// Port is the TCP port the HTTP server listens on.
	Port int
	// DataDir is where the SQLite database and generated master key live.
	// In the container this is /config; locally it defaults to ./data.
	DataDir string
	// CacheDir is where restic keeps its repository metadata cache
	// (exported as RESTIC_CACHE_DIR so restic never falls back to
	// $HOME/.cache/restic, which is unwritable in the container).
	CacheDir string
	// ResticBinary is the path (or PATH name) of the restic executable.
	ResticBinary string
	// RcloneBinary is the path (or PATH name) of the rclone executable.
	RcloneBinary string
	// MasterKey is the raw master key used to encrypt secrets at rest. When
	// empty, the server generates one and persists it under DataDir.
	MasterKey string
	// AuthDisabled turns off the built-in login entirely (for use only behind
	// a trusted reverse proxy that enforces access control).
	AuthDisabled bool
	// TrustedProxyHeader, when set, names an HTTP header (e.g. "Remote-User")
	// injected by a trusted reverse proxy that authenticates the request.
	TrustedProxyHeader string
}

// Load reads configuration from the environment, applying defaults.
func Load() (*Config, error) {
	c := &Config{
		Port:               8080,
		DataDir:            "./data",
		ResticBinary:       "restic",
		RcloneBinary:       "rclone",
		AuthDisabled:       false,
		TrustedProxyHeader: "",
	}

	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT %q: %w", v, err)
		}
		c.Port = p
	}
	if v := os.Getenv("DATA_DIR"); v != "" {
		c.DataDir = v
	}
	c.CacheDir = filepath.Join(c.DataDir, "cache")
	if v := os.Getenv("RESTIC_CACHE_DIR"); v != "" {
		c.CacheDir = v
	}
	if v := os.Getenv("RESTIC_BINARY"); v != "" {
		c.ResticBinary = v
	}
	if v := os.Getenv("RCLONE_BINARY"); v != "" {
		c.RcloneBinary = v
	}

	key, err := readSecret("RESTIC_UI_KEY")
	if err != nil {
		return nil, err
	}
	c.MasterKey = key

	if b, ok := readBool("AUTH_DISABLED"); ok {
		c.AuthDisabled = b
	}
	if v := os.Getenv("TRUSTED_PROXY_HEADER"); v != "" {
		c.TrustedProxyHeader = v
	}

	return c, nil
}

// readSecret returns the value of name, or the contents of the file named by
// name+"_FILE" if that is set instead. The result is trimmed of surrounding
// whitespace.
func readSecret(name string) (string, error) {
	if path := os.Getenv(name + "_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("reading %s_FILE %q: %w", name, path, err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return os.Getenv(name), nil
}

// readBool parses a boolean env var. The second return reports whether the var
// was set at all.
func readBool(name string) (val, ok bool) {
	v := os.Getenv(name)
	if v == "" {
		return false, false
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true, true
	default:
		return false, true
	}
}
