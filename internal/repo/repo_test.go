package repo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	box, err := crypto.NewBox("test-key")
	if err != nil {
		t.Fatal(err)
	}
	return NewService(st, box, dir)
}

func TestCreateEncryptsSecretsAtRest(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	created, err := svc.Create(ctx, Input{
		Name:        "offsite",
		BackendType: restic.BackendS3,
		Password:    "repo-pass-123",
		Config: Config{
			Endpoint:    "minio.local:9000",
			Bucket:      "backups",
			AccessKeyID: "AKIAEXAMPLE",
			UseHTTP:     true,
		},
		Secrets: Secrets{SecretAccessKey: "super-secret-value"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Raw DB rows must not contain the plaintext password or secret.
	var secEnc, pwEnc []byte
	err = svc.st.DB.QueryRow(`SELECT secrets_enc, repo_password_enc FROM repos WHERE id=?`, created.ID).
		Scan(&secEnc, &pwEnc)
	if err != nil {
		t.Fatal(err)
	}
	for name, blob := range map[string][]byte{"secrets": secEnc, "password": pwEnc} {
		if strings.Contains(string(blob), "super-secret-value") || strings.Contains(string(blob), "repo-pass-123") {
			t.Fatalf("%s stored in plaintext", name)
		}
	}

	// API-facing struct must not carry secrets either.
	if created.HasSecrets != true {
		t.Fatal("expected HasSecrets=true")
	}

	// BuildRepoConfig decrypts and assembles the runnable form.
	_, rc, err := svc.BuildRepoConfig(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Repository != "s3:http://minio.local:9000/backups" {
		t.Fatalf("repository = %q", rc.Repository)
	}
	if rc.Password != "repo-pass-123" {
		t.Fatalf("password not round-tripped")
	}
	wantEnv := map[string]bool{
		"AWS_ACCESS_KEY_ID=AKIAEXAMPLE":            false,
		"AWS_SECRET_ACCESS_KEY=super-secret-value": false,
	}
	for _, e := range rc.Env {
		if _, ok := wantEnv[e]; ok {
			wantEnv[e] = true
		}
	}
	for k, seen := range wantEnv {
		if !seen {
			t.Fatalf("missing env %q in %v", k, rc.Env)
		}
	}
}

func TestBuildRepoConfigLocations(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	knownHosts := filepath.Join(svc.dataDir, "ssh", "known_hosts")
	sftpCommand := func(host, user, port string) string {
		return "sftp.command=ssh " + host + " -l " + user + " -p " + port +
			" -o StrictHostKeyChecking=accept-new" +
			" -o UserKnownHostsFile=" + knownHosts +
			" -o BatchMode=yes -s sftp"
	}

	cases := []struct {
		name      string
		input     Input
		want      string
		wantExtra []string
	}{
		{
			name: "local",
			input: Input{Name: "local", BackendType: restic.BackendLocal, Password: "p",
				Config: Config{Path: "/repos/main"}},
			want: "/repos/main",
		},
		{
			name: "s3 https with prefix",
			input: Input{Name: "s3", BackendType: restic.BackendS3, Password: "p",
				Config:  Config{Endpoint: "s3.amazonaws.com", Bucket: "bkt", Prefix: "/sub/dir/", AccessKeyID: "ak"},
				Secrets: Secrets{SecretAccessKey: "sk"}},
			want: "s3:https://s3.amazonaws.com/bkt/sub/dir",
		},
		{
			name: "sftp absolute path",
			input: Input{Name: "sftp-abs", BackendType: restic.BackendSFTP, Password: "p",
				Config: Config{Host: "nas.lan", User: "bk", Path: "/tank/restic"}},
			want:      "sftp://bk@nas.lan:22//tank/restic",
			wantExtra: []string{"-o", sftpCommand("nas.lan", "bk", "22")},
		},
		{
			name: "sftp relative path custom port",
			input: Input{Name: "sftp-rel", BackendType: restic.BackendSFTP, Password: "p",
				Config: Config{Host: "nas.lan", Port: 2222, User: "bk", Path: "restic"}},
			want:      "sftp://bk@nas.lan:2222/restic",
			wantExtra: []string{"-o", sftpCommand("nas.lan", "bk", "2222")},
		},
		{
			name: "rclone",
			input: Input{Name: "rc", BackendType: restic.BackendRclone, Password: "p",
				Config: Config{Remote: "gdrive", Path: "backups/host"}},
			want: "rclone:gdrive:backups/host",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			created, err := svc.Create(ctx, tc.input)
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			_, rc, err := svc.BuildRepoConfig(ctx, created.ID)
			if err != nil {
				t.Fatal(err)
			}
			if rc.Repository != tc.want {
				t.Fatalf("repository = %q, want %q", rc.Repository, tc.want)
			}
			if !slices.Equal(rc.ExtraArgs, tc.wantExtra) {
				t.Fatalf("ExtraArgs = %q, want %q", rc.ExtraArgs, tc.wantExtra)
			}
		})
	}

	// Key-less SFTP repos must still get the ssh dir created for known_hosts
	// (the creds dir is only made when a private key is materialized).
	if _, err := os.Stat(filepath.Join(svc.dataDir, "ssh")); err != nil {
		t.Fatalf("ssh dir not created: %v", err)
	}
}

func TestBuildRepoConfigSFTPWithKey(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	created, err := svc.Create(ctx, Input{
		Name: "sftp-key", BackendType: restic.BackendSFTP, Password: "p",
		Config:  Config{Host: "nas.lan", User: "bk", Path: "/tank/restic"},
		Secrets: Secrets{PrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, rc, err := svc.BuildRepoConfig(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rc.ExtraArgs) != 2 {
		t.Fatalf("ExtraArgs = %q", rc.ExtraArgs)
	}
	cmd := rc.ExtraArgs[1]
	keyPath := filepath.Join(svc.dataDir, "creds", fmt.Sprintf("repo-%d-sshkey", created.ID))
	for _, want := range []string{
		"-i " + keyPath,
		"-o UserKnownHostsFile=" + filepath.Join(svc.dataDir, "ssh", "known_hosts"),
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("sftp.command missing %q: %q", want, cmd)
		}
	}
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %o, want 600", info.Mode().Perm())
	}
}

func TestValidation(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()

	bad := []Input{
		{Name: "", BackendType: restic.BackendLocal, Password: "p", Config: Config{Path: "/x"}},
		{Name: "x", BackendType: "ftp", Password: "p"},
		{Name: "x", BackendType: restic.BackendLocal, Password: "", Config: Config{Path: "/x"}},
		{Name: "x", BackendType: restic.BackendLocal, Password: "p", Config: Config{Path: "relative"}},
		{Name: "x", BackendType: restic.BackendS3, Password: "p",
			Config:  Config{Endpoint: "https://has-scheme.com", Bucket: "b", AccessKeyID: "a"},
			Secrets: Secrets{SecretAccessKey: "s"}},
		{Name: "x", BackendType: restic.BackendRclone, Password: "p", Config: Config{Remote: "r:", Path: "p"}},
	}
	for i, in := range bad {
		if _, err := svc.Create(ctx, in); err == nil {
			t.Fatalf("case %d: expected validation error", i)
		}
	}

	// Duplicate name is rejected.
	ok := Input{Name: "dup", BackendType: restic.BackendLocal, Password: "p", Config: Config{Path: "/x"}}
	if _, err := svc.Create(ctx, ok); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, ok); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate name: got %v", err)
	}
}

func TestUpdatePreservesSecretsWhenOmitted(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	created, err := svc.Create(ctx, Input{
		Name: "s3", BackendType: restic.BackendS3, Password: "orig-pass",
		Config:  Config{Endpoint: "e.com", Bucket: "b", AccessKeyID: "ak"},
		Secrets: Secrets{SecretAccessKey: "orig-secret"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Update name only: password and secret must survive.
	_, err = svc.Update(ctx, created.ID, Input{
		Name: "s3-renamed", BackendType: restic.BackendS3,
		Config: Config{Endpoint: "e.com", Bucket: "b", AccessKeyID: "ak"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, rc, err := svc.BuildRepoConfig(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Password != "orig-pass" {
		t.Fatalf("password lost on update: %q", rc.Password)
	}
	found := false
	for _, e := range rc.Env {
		if e == "AWS_SECRET_ACCESS_KEY=orig-secret" {
			found = true
		}
	}
	if !found {
		t.Fatal("secret lost on update")
	}

	// Backend type change is rejected.
	if _, err := svc.Update(ctx, created.ID, Input{
		Name: "x", BackendType: restic.BackendLocal, Config: Config{Path: "/x"},
	}); err == nil {
		t.Fatal("expected error on backend type change")
	}
}

func TestDelete(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, Input{
		Name: "gone", BackendType: restic.BackendLocal, Password: "p", Config: Config{Path: "/x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, created.ID); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := svc.Delete(ctx, 9999); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound for missing id, got %v", err)
	}
}
