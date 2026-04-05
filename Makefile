include .env
export

DB_CONTAINER = romulus6-db

.PHONY: dev backend db stop-db

dev: db backend

db:
	@docker rm -f $(DB_CONTAINER) 2>/dev/null || true
	docker run -d \
		--name $(DB_CONTAINER) \
		-e POSTGRES_USER=$(DB_USER) \
		-e POSTGRES_PASSWORD=$(DB_PASSWORD) \
		-e POSTGRES_DB=$(DB_NAME) \
		-p $(DB_PORT):5432 \
		postgres:16

backend:
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port $(BACKEND_PORT)

stop-db:
	docker rm -f $(DB_CONTAINER) 2>/dev/null || true
