-- +goose Up
-- +goose StatementBegin
ALTER TABLE plans ADD COLUMN notify_muted INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE plans DROP COLUMN notify_muted;
-- +goose StatementEnd
