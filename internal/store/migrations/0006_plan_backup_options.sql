-- +goose Up
-- +goose StatementBegin
ALTER TABLE plans ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE plans DROP COLUMN options_json;
-- +goose StatementEnd
