-- +goose Up
-- +goose StatementBegin
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    apprise_urls      TEXT NOT NULL DEFAULT '',
    notify_on_success INTEGER NOT NULL DEFAULT 0,
    notify_on_failure INTEGER NOT NULL DEFAULT 1,
    data              TEXT NOT NULL DEFAULT '{}',
    updated_at        TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
INSERT INTO settings (id, updated_at) VALUES (1, '1970-01-01T00:00:00Z');
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE repos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    backend_type      TEXT NOT NULL,           -- local | s3 | sftp | rclone
    config_json       TEXT NOT NULL DEFAULT '{}', -- non-secret backend config
    secrets_enc       BLOB,                    -- encrypted JSON of secret fields
    repo_password_enc BLOB,                    -- encrypted restic repo password
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE plans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    sources_json   TEXT NOT NULL DEFAULT '[]',
    excludes_json  TEXT NOT NULL DEFAULT '[]',
    tags_json      TEXT NOT NULL DEFAULT '[]',
    schedule_cron  TEXT NOT NULL DEFAULT '',
    retention_json TEXT NOT NULL DEFAULT '{}',
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE operations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,               -- backup|restore|prune|check|copy|init|forget
    repo_id      INTEGER REFERENCES repos(id) ON DELETE SET NULL,
    plan_id      INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    status       TEXT NOT NULL,               -- queued|running|success|error|canceled
    started_at   TEXT,
    ended_at     TEXT,
    exit_code    INTEGER,
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE operation_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    ts           TEXT NOT NULL,
    level        TEXT NOT NULL DEFAULT 'info',
    message      TEXT NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_operations_repo ON operations(repo_id);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX idx_operations_plan ON operations(plan_id);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX idx_operations_status ON operations(status);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX idx_operation_logs_op ON operation_logs(operation_id, seq);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS operation_logs;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE IF EXISTS operations;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE IF EXISTS plans;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE IF EXISTS repos;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE IF EXISTS settings;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE IF EXISTS users;
-- +goose StatementEnd
