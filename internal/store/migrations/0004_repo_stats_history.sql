-- +goose Up
-- +goose StatementBegin
CREATE TABLE repo_stats_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id          INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    operation_id     INTEGER REFERENCES operations(id) ON DELETE SET NULL,
    captured_at      TEXT NOT NULL,
    total_size       INTEGER NOT NULL,
    total_file_count INTEGER NOT NULL,
    snapshots_count  INTEGER NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_repo_stats_history_repo ON repo_stats_history(repo_id, captured_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS repo_stats_history;
-- +goose StatementEnd
