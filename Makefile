.PHONY: build web run dev docker tidy test clean

# Full build: compile the frontend, then the Go binary with the SPA embedded.
build: web
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/restic-ui ./cmd/restic-ui

# Build the frontend into web/dist (embedded by the Go build).
web:
	cd web && pnpm install && pnpm build

# Run the backend directly (serves the placeholder SPA unless `make web` ran).
run:
	go run ./cmd/restic-ui

# Frontend dev server with hot reload; proxies /api to :8080.
# Run `make run` in another terminal alongside this.
dev:
	cd web && pnpm dev

docker:
	docker build -t restic-ui:latest .

tidy:
	go mod tidy

test:
	go test ./...

clean:
	rm -rf bin web/dist/assets
