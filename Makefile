include .env
export

DB_CONTAINER = romulus6-db

.PHONY: dev backend db stop-db frontend install-frontend migrate makemigrations install-tests test-backend worker worker-build worker-deploy k8s-namespace sandbox-delete-all

dev: k8s-namespace db backend

k8s-namespace:
	@minikube status --format '{{.Host}}' 2>/dev/null | grep -q Running || minikube start --driver=docker
	kubectl apply -f worker/k8s/namespace.yaml

db:
	@docker rm -f $(DB_CONTAINER) 2>/dev/null || true
	docker run -d \
		--name $(DB_CONTAINER) \
		-e POSTGRES_USER=$(DB_USER) \
		-e POSTGRES_PASSWORD=$(DB_PASSWORD) \
		-e POSTGRES_DB=$(DB_NAME) \
		-p $(DB_PORT):5432 \
		-v $(PWD)/.pg-data:/var/lib/postgresql/data \
		postgres:16
	@echo "Waiting for postgres..."
	@until docker exec $(DB_CONTAINER) pg_isready -U $(DB_USER) -d $(DB_NAME) -q; do sleep 1; done

backend: migrate
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port $(BACKEND_PORT)

stop-db:
	docker rm -f $(DB_CONTAINER) 2>/dev/null || true

migrate:
	cd backend && uv run alembic upgrade head

makemigrations:
	cd backend && uv run alembic revision --autogenerate -m "$(MSG)"

frontend:
	cd frontend && VITE_PORT=$(FRONTEND_PORT) npm run dev -- --port $(FRONTEND_PORT)

install-frontend:
	cd frontend && npm install

install-tests:
	cd tests && npm install

test-backend:
	cd tests && npm run test -- $(ARGS)

worker:
	cd worker && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8080

worker-build:
	cp /usr/bin/opencode worker/opencode
	eval $$(minikube docker-env) && docker build -t worker:latest worker/
	rm -f worker/opencode

sandbox-delete-all:
	kubectl get deployments -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)
	kubectl get services   -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)

worker-deploy: k8s-namespace worker-build
	kubectl apply -f worker/k8s/namespace.yaml
	kubectl apply -f worker/k8s/configmap.yaml
	kubectl apply -f worker/k8s/service.yaml
	kubectl apply -f worker/k8s/deployment.yaml
	kubectl create secret generic worker-secrets -n romulus \
		--from-literal=ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) \
		--from-literal=OPENAI_API_KEY=$(OPENAI_API_KEY) \
		--dry-run=client -o yaml | kubectl apply -f -
	kubectl rollout restart deployment/worker -n romulus
	kubectl rollout status deployment/worker -n romulus
