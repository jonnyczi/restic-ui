package restic

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestCommandEnvAndArgs(t *testing.T) {
	r := &Runner{Bin: "restic", CacheDir: "/tmp/cache-x"}
	rc := RepoConfig{
		Repository: "sftp://u@h:22//repo",
		Password:   "pw",
		Env:        []string{"FOO=bar"},
		ExtraArgs:  []string{"-o", "sftp.command=ssh h"},
	}
	cmd := r.Command(context.Background(), rc, "snapshots", "--json")

	wantArgs := []string{"snapshots", "--json", "-o", "sftp.command=ssh h"}
	if got := cmd.Args[1:]; !slices.Equal(got, wantArgs) {
		t.Errorf("args = %q, want %q", got, wantArgs)
	}

	// Only inspect entries we appended, not the inherited environment.
	added := cmd.Env[len(os.Environ()):]
	for _, want := range []string{
		"RESTIC_REPOSITORY=sftp://u@h:22//repo",
		"RESTIC_PASSWORD=pw",
		"RESTIC_CACHE_DIR=/tmp/cache-x",
		"FOO=bar",
	} {
		if !slices.Contains(added, want) {
			t.Errorf("env missing %q (added entries: %q)", want, added)
		}
	}
}

func TestCommandNoCacheDirWhenUnset(t *testing.T) {
	r := &Runner{Bin: "restic"}
	cmd := r.Command(context.Background(), RepoConfig{Repository: "x", Password: "y"}, "snapshots")

	added := cmd.Env[len(os.Environ()):]
	for _, e := range added {
		if strings.HasPrefix(e, "RESTIC_CACHE_DIR=") {
			t.Errorf("unexpected cache dir entry %q", e)
		}
	}
}
