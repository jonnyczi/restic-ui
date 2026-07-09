// Package notify sends operation notifications through an Apprise API server
// (e.g. the linuxserver/apprise-api container), which fans out to 80+ services
// (Discord, Telegram, ntfy, email, ...). Keeping Apprise external avoids
// bundling Python in this image.
package notify

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jonnyczi/restic-ui/internal/ops"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// Settings is the notification configuration (settings table, single row).
type Settings struct {
	// AppriseAPIURL is the base URL of an Apprise API server,
	// e.g. "http://apprise:8000". Empty disables notifications.
	AppriseAPIURL string `json:"appriseApiUrl"`
	// AppriseURLs are the target service URLs (one per line), passed to
	// Apprise, e.g. "discord://webhook_id/token".
	AppriseURLs     string `json:"appriseUrls"`
	NotifyOnSuccess bool   `json:"notifyOnSuccess"`
	NotifyOnFailure bool   `json:"notifyOnFailure"`
}

// Service loads settings and delivers notifications.
type Service struct {
	st     *store.Store
	client *http.Client
}

// NewService constructs a Service.
func NewService(st *store.Store) *Service {
	return &Service{st: st, client: &http.Client{Timeout: 15 * time.Second}}
}

type settingsData struct {
	AppriseAPIURL string `json:"appriseApiUrl"`
}

// Get returns the current notification settings.
func (s *Service) Get(ctx context.Context) (*Settings, error) {
	var (
		urls      string
		onSuccess int
		onFailure int
		dataJSON  string
	)
	err := s.st.DB.QueryRowContext(ctx, `
		SELECT apprise_urls, notify_on_success, notify_on_failure, data FROM settings WHERE id=1`,
	).Scan(&urls, &onSuccess, &onFailure, &dataJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return &Settings{NotifyOnFailure: true}, nil
	}
	if err != nil {
		return nil, err
	}
	var data settingsData
	_ = json.Unmarshal([]byte(dataJSON), &data)
	return &Settings{
		AppriseAPIURL:   data.AppriseAPIURL,
		AppriseURLs:     urls,
		NotifyOnSuccess: onSuccess != 0,
		NotifyOnFailure: onFailure != 0,
	}, nil
}

// Save persists notification settings.
func (s *Service) Save(ctx context.Context, in Settings) error {
	in.AppriseAPIURL = strings.TrimRight(strings.TrimSpace(in.AppriseAPIURL), "/")
	if in.AppriseAPIURL != "" && !strings.HasPrefix(in.AppriseAPIURL, "http") {
		return errors.New("apprise api url must start with http:// or https://")
	}
	dataJSON, _ := json.Marshal(settingsData{AppriseAPIURL: in.AppriseAPIURL})
	_, err := s.st.DB.ExecContext(ctx, `
		UPDATE settings SET apprise_urls=?, notify_on_success=?, notify_on_failure=?, data=?, updated_at=?
		WHERE id=1`,
		in.AppriseURLs, boolToInt(in.NotifyOnSuccess), boolToInt(in.NotifyOnFailure),
		string(dataJSON), time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// Send delivers one notification through the configured Apprise API server.
func (s *Service) Send(ctx context.Context, title, body, kind string) error {
	cfg, err := s.Get(ctx)
	if err != nil {
		return err
	}
	if cfg.AppriseAPIURL == "" {
		return errors.New("no Apprise API server configured")
	}

	payload := map[string]string{
		"title": title,
		"body":  body,
		"type":  kind, // info | success | warning | failure
	}
	if urls := strings.TrimSpace(cfg.AppriseURLs); urls != "" {
		payload["urls"] = strings.Join(strings.Fields(urls), ",")
	}
	raw, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.AppriseAPIURL+"/notify", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("apprise api returned %s", resp.Status)
	}
	return nil
}

// NotifyOp implements ops.Notifier: sends a message for terminal operations
// according to the success/failure toggles.
func (s *Service) NotifyOp(op ops.Operation) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cfg, err := s.Get(ctx)
	if err != nil || cfg.AppriseAPIURL == "" {
		return
	}

	var kind string
	switch op.Status {
	case "success":
		if !cfg.NotifyOnSuccess {
			return
		}
		kind = "success"
	case "warning":
		if !cfg.NotifyOnFailure {
			return
		}
		kind = "warning"
	case "error":
		if !cfg.NotifyOnFailure {
			return
		}
		kind = "failure"
	default:
		return
	}

	subject := op.Type
	if op.PlanName != "" {
		subject = fmt.Sprintf("%s %q", op.Type, op.PlanName)
	}
	title := fmt.Sprintf("restic-ui: %s %s", subject, op.Status)
	body := fmt.Sprintf("Repository: %s\nStatus: %s", op.RepoName, op.Status)
	if op.Summary != nil {
		var sum struct {
			SnapshotID string `json:"snapshot_id"`
			FilesNew   int64  `json:"files_new"`
			DataAdded  int64  `json:"data_added"`
		}
		if json.Unmarshal(op.Summary, &sum) == nil && sum.SnapshotID != "" {
			body += fmt.Sprintf("\nSnapshot: %.8s (%d new files, %d bytes added)",
				sum.SnapshotID, sum.FilesNew, sum.DataAdded)
		}
	}

	if err := s.Send(ctx, title, body, kind); err != nil {
		slog.Warn("notification failed", "op", op.ID, "err", err)
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
