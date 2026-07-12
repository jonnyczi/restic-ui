// Package repo manages restic repository definitions: CRUD with encrypted
// credentials, and assembling runnable restic.RepoConfig values per backend.
package repo

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// ErrNotFound is returned when a repository id does not exist.
var ErrNotFound = errors.New("repository not found")

// Config is the non-secret backend configuration, stored as JSON. Fields are
// a union across backends; validation enforces the right ones per type.
type Config struct {
	// local
	Path string `json:"path,omitempty"`
	// s3
	Endpoint    string `json:"endpoint,omitempty"` // host[:port], no scheme
	Bucket      string `json:"bucket,omitempty"`
	Prefix      string `json:"prefix,omitempty"`
	Region      string `json:"region,omitempty"`
	AccessKeyID string `json:"accessKeyId,omitempty"`
	UseHTTP     bool   `json:"useHttp,omitempty"` // plain http (e.g. LAN MinIO)
	// sftp
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	User string `json:"user,omitempty"`
	// rclone
	Remote string `json:"remote,omitempty"` // rclone remote name (no colon)
}

// Secrets are encrypted-at-rest credentials. A union across backends.
type Secrets struct {
	SecretAccessKey string `json:"secretAccessKey,omitempty"` // s3
	PrivateKey      string `json:"privateKey,omitempty"`      // sftp: PEM
	RcloneConf      string `json:"rcloneConf,omitempty"`      // rclone: config file content
}

// Repo is a stored repository definition (no secret material).
type Repo struct {
	ID          int64          `json:"id"`
	Name        string         `json:"name"`
	BackendType restic.Backend `json:"backendType"`
	Config      Config         `json:"config"`
	HasSecrets  bool           `json:"hasSecrets"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

// Input is the create/update payload from the API.
type Input struct {
	Name        string         `json:"name"`
	BackendType restic.Backend `json:"backendType"`
	Config      Config         `json:"config"`
	// Password is the restic repo password. Required on create; on update an
	// empty value means "keep existing".
	Password string `json:"password"`
	// Secrets: on update, zero-value fields keep their existing values.
	Secrets Secrets `json:"secrets"`
}

// Service implements repository management.
type Service struct {
	st  *store.Store
	box *crypto.Box
	// dataDir is where materialized credential files (ssh keys, rclone conf)
	// live, under dataDir/creds.
	dataDir string
}

// NewService constructs a Service.
func NewService(st *store.Store, box *crypto.Box, dataDir string) *Service {
	return &Service{st: st, box: box, dataDir: dataDir}
}

// Validate checks an Input for completeness per backend.
func (in *Input) Validate(isCreate bool) error {
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("name is required")
	}
	if !restic.ValidBackend(in.BackendType) {
		return fmt.Errorf("unsupported backend type %q", in.BackendType)
	}
	if isCreate && in.Password == "" {
		return errors.New("repository password is required")
	}
	c := in.Config
	switch in.BackendType {
	case restic.BackendLocal:
		if !filepath.IsAbs(c.Path) {
			return errors.New("local backend requires an absolute path")
		}
	case restic.BackendS3:
		if c.Endpoint == "" || c.Bucket == "" {
			return errors.New("s3 backend requires endpoint and bucket")
		}
		if strings.Contains(c.Endpoint, "://") {
			return errors.New("endpoint must be host[:port] without scheme; use the http toggle for plain http")
		}
		if c.AccessKeyID == "" {
			return errors.New("s3 backend requires an access key id")
		}
		if isCreate && in.Secrets.SecretAccessKey == "" {
			return errors.New("s3 backend requires a secret access key")
		}
	case restic.BackendSFTP:
		if c.Host == "" || c.User == "" || c.Path == "" {
			return errors.New("sftp backend requires host, user, and path")
		}
	case restic.BackendRclone:
		if c.Remote == "" || c.Path == "" {
			return errors.New("rclone backend requires remote and path")
		}
		if strings.Contains(c.Remote, ":") {
			return errors.New("remote must be the rclone remote name without a colon")
		}
	}
	return nil
}

func (s *Service) sealJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return s.box.Seal(raw)
}

// Create stores a new repository definition with encrypted credentials.
func (s *Service) Create(ctx context.Context, in Input) (*Repo, error) {
	if err := in.Validate(true); err != nil {
		return nil, err
	}
	cfgJSON, err := json.Marshal(in.Config)
	if err != nil {
		return nil, err
	}
	secretsEnc, err := s.sealJSON(in.Secrets)
	if err != nil {
		return nil, err
	}
	pwEnc, err := s.box.Seal([]byte(in.Password))
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.st.DB.ExecContext(ctx, `
		INSERT INTO repos (name, backend_type, config_json, secrets_enc, repo_password_enc, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		in.Name, string(in.BackendType), string(cfgJSON), secretsEnc, pwEnc, now, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, fmt.Errorf("a repository named %q already exists", in.Name)
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.Get(ctx, id)
}

// Update modifies name/config, and password/secrets only when provided.
func (s *Service) Update(ctx context.Context, id int64, in Input) (*Repo, error) {
	if err := in.Validate(false); err != nil {
		return nil, err
	}
	existing, secrets, _, err := s.getFull(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing.BackendType != in.BackendType {
		return nil, errors.New("backend type cannot be changed; create a new repository instead")
	}

	// Merge secrets: empty incoming fields keep their stored values.
	if in.Secrets.SecretAccessKey != "" {
		secrets.SecretAccessKey = in.Secrets.SecretAccessKey
	}
	if in.Secrets.PrivateKey != "" {
		secrets.PrivateKey = in.Secrets.PrivateKey
	}
	if in.Secrets.RcloneConf != "" {
		secrets.RcloneConf = in.Secrets.RcloneConf
	}

	cfgJSON, err := json.Marshal(in.Config)
	if err != nil {
		return nil, err
	}
	secretsEnc, err := s.sealJSON(secrets)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if in.Password != "" {
		pwEnc, err := s.box.Seal([]byte(in.Password))
		if err != nil {
			return nil, err
		}
		_, err = s.st.DB.ExecContext(ctx, `
			UPDATE repos SET name=?, config_json=?, secrets_enc=?, repo_password_enc=?, updated_at=? WHERE id=?`,
			in.Name, string(cfgJSON), secretsEnc, pwEnc, now, id)
		if err != nil {
			return nil, err
		}
	} else {
		_, err = s.st.DB.ExecContext(ctx, `
			UPDATE repos SET name=?, config_json=?, secrets_enc=?, updated_at=? WHERE id=?`,
			in.Name, string(cfgJSON), secretsEnc, now, id)
		if err != nil {
			return nil, err
		}
	}
	return s.Get(ctx, id)
}

// Delete removes the definition. Backup data on the backend is untouched.
func (s *Service) Delete(ctx context.Context, id int64) error {
	res, err := s.st.DB.ExecContext(ctx, `DELETE FROM repos WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// Best-effort cleanup of materialized credential files.
	_ = os.Remove(s.credPath(id, "sshkey"))
	_ = os.Remove(s.credPath(id, "rclone.conf"))
	return nil
}

// Get returns one repository without secrets.
func (s *Service) Get(ctx context.Context, id int64) (*Repo, error) {
	r, _, _, err := s.getFull(ctx, id)
	return r, err
}

// List returns all repositories without secrets.
func (s *Service) List(ctx context.Context) ([]Repo, error) {
	rows, err := s.st.DB.QueryContext(ctx, `
		SELECT id, name, backend_type, config_json, secrets_enc, created_at, updated_at
		FROM repos ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	repos := []Repo{}
	for rows.Next() {
		var (
			r       Repo
			cfgJSON string
			secEnc  []byte
		)
		if err := rows.Scan(&r.ID, &r.Name, (*string)(&r.BackendType), &cfgJSON, &secEnc, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(cfgJSON), &r.Config); err != nil {
			return nil, fmt.Errorf("repo %d: corrupt config: %w", r.ID, err)
		}
		r.HasSecrets = len(secEnc) > 0
		repos = append(repos, r)
	}
	return repos, rows.Err()
}

// getFull loads a repo including decrypted secrets and password.
func (s *Service) getFull(ctx context.Context, id int64) (*Repo, *Secrets, string, error) {
	var (
		r       Repo
		cfgJSON string
		secEnc  []byte
		pwEnc   []byte
	)
	err := s.st.DB.QueryRowContext(ctx, `
		SELECT id, name, backend_type, config_json, secrets_enc, repo_password_enc, created_at, updated_at
		FROM repos WHERE id=?`, id,
	).Scan(&r.ID, &r.Name, (*string)(&r.BackendType), &cfgJSON, &secEnc, &pwEnc, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, "", ErrNotFound
	}
	if err != nil {
		return nil, nil, "", err
	}
	if err := json.Unmarshal([]byte(cfgJSON), &r.Config); err != nil {
		return nil, nil, "", fmt.Errorf("repo %d: corrupt config: %w", r.ID, err)
	}
	r.HasSecrets = len(secEnc) > 0

	var secrets Secrets
	if len(secEnc) > 0 {
		raw, err := s.box.Open(secEnc)
		if err != nil {
			return nil, nil, "", err
		}
		if err := json.Unmarshal(raw, &secrets); err != nil {
			return nil, nil, "", err
		}
	}
	password := ""
	if len(pwEnc) > 0 {
		raw, err := s.box.Open(pwEnc)
		if err != nil {
			return nil, nil, "", err
		}
		password = string(raw)
	}
	return &r, &secrets, password, nil
}

// credPath is where a materialized credential file for a repo lives.
func (s *Service) credPath(id int64, name string) string {
	return filepath.Join(s.dataDir, "creds", fmt.Sprintf("repo-%d-%s", id, name))
}

func (s *Service) writeCredFile(id int64, name, content string) (string, error) {
	path := s.credPath(id, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	// Ensure trailing newline: OpenSSH rejects PEM keys without one.
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// knownHostsPath ensures DATA_DIR/ssh exists and returns the shared
// known_hosts file used by all SFTP repositories. ssh creates the file on
// first accept-new, but not its directory — and the container user has no
// home to fall back to.
func (s *Service) knownHostsPath() (string, error) {
	dir := filepath.Join(s.dataDir, "ssh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "known_hosts"), nil
}

// BuildRepoConfig assembles a runnable restic.RepoConfig for the repo,
// decrypting credentials and materializing key/config files where needed.
func (s *Service) BuildRepoConfig(ctx context.Context, id int64) (*Repo, restic.RepoConfig, error) {
	r, secrets, password, err := s.getFull(ctx, id)
	if err != nil {
		return nil, restic.RepoConfig{}, err
	}

	rc := restic.RepoConfig{Password: password}
	c := r.Config

	switch r.BackendType {
	case restic.BackendLocal:
		rc.Repository = c.Path

	case restic.BackendS3:
		scheme := "https"
		if c.UseHTTP {
			scheme = "http"
		}
		loc := fmt.Sprintf("s3:%s://%s/%s", scheme, c.Endpoint, url.PathEscape(c.Bucket))
		if c.Prefix != "" {
			loc += "/" + strings.Trim(c.Prefix, "/")
		}
		rc.Repository = loc
		rc.Env = append(rc.Env,
			"AWS_ACCESS_KEY_ID="+c.AccessKeyID,
			"AWS_SECRET_ACCESS_KEY="+secrets.SecretAccessKey,
		)
		if c.Region != "" {
			rc.Env = append(rc.Env, "AWS_DEFAULT_REGION="+c.Region)
		}

	case restic.BackendSFTP:
		port := c.Port
		if port == 0 {
			port = 22
		}
		// URL path: "/dir" is relative to the login home, "//dir" is absolute.
		// Prefixing one "/" to the user's value yields exactly that mapping.
		rc.Repository = fmt.Sprintf("sftp://%s@%s:%d/%s", c.User, c.Host, port, c.Path)
		knownHosts, err := s.knownHostsPath()
		if err != nil {
			return nil, restic.RepoConfig{}, err
		}
		// Note: restic splits sftp.command on spaces, so none of these
		// values (incl. dataDir-derived paths) may contain spaces.
		sshArgs := []string{
			"ssh", c.Host,
			"-l", c.User,
			"-p", fmt.Sprint(port),
			// First connection records the host key; later mismatches still fail.
			"-o", "StrictHostKeyChecking=accept-new",
			"-o", "UserKnownHostsFile=" + knownHosts,
			"-o", "BatchMode=yes",
		}
		if secrets.PrivateKey != "" {
			keyPath, err := s.writeCredFile(r.ID, "sshkey", secrets.PrivateKey)
			if err != nil {
				return nil, restic.RepoConfig{}, err
			}
			sshArgs = append(sshArgs, "-i", keyPath)
		}
		sshArgs = append(sshArgs, "-s", "sftp")
		rc.ExtraArgs = append(rc.ExtraArgs, "-o", "sftp.command="+strings.Join(sshArgs, " "))

	case restic.BackendRclone:
		rc.Repository = fmt.Sprintf("rclone:%s:%s", c.Remote, c.Path)
		if secrets.RcloneConf != "" {
			confPath, err := s.writeCredFile(r.ID, "rclone.conf", secrets.RcloneConf)
			if err != nil {
				return nil, restic.RepoConfig{}, err
			}
			rc.Env = append(rc.Env, "RCLONE_CONFIG="+confPath)
		}

	default:
		return nil, restic.RepoConfig{}, fmt.Errorf("unsupported backend %q", r.BackendType)
	}

	return r, rc, nil
}
