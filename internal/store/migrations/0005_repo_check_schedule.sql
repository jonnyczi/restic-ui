-- +goose Up
-- +goose StatementBegin
ALTER TABLE repos ADD COLUMN check_schedule_cron TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE repos DROP COLUMN check_schedule_cron;
-- +goose StatementEnd
