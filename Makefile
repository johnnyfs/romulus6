include .env
export

K8S_NAMESPACE ?= romulus
K8S_DEV_DIR := k8s/dev
K8S_NODE_HOST ?= $(shell minikube ip 2>/dev/null || echo localhost)
MINIKUBE_PROFILE ?= minikube
BACKEND_IMAGE ?= backend:latest
WORKER_IMAGE ?= worker:latest
BACKEND_PORT ?= 8000
BACKEND_NODEPORT ?= 30800
WORKER_POOL_TARGET ?= 1
WORKER_POOL_MAX ?= 1
WORKER_ROLLOUT_WAIT ?= 1
WORKER_FORCE_RESTART ?= 0
LOCAL_DB_PORT ?= 15432
HOST_BACKEND_PORT ?= 18000
LOCAL_WORKER_PORT ?= 18080
LOCAL_POSTGRES_CONTAINER ?= romulus-local-postgres
LOCAL_POSTGRES_VOLUME ?= romulus-local-postgres-data
LOCAL_POSTGRES_IMAGE ?= postgres:16
LOCAL_WORKSPACE_ROOT ?= $(CURDIR)/.local/workspaces
LOCAL_WORKER_HOME ?= $(CURDIR)/.local/worker-home
LOCAL_WORKER_DATA_HOME ?= $(LOCAL_WORKER_HOME)/.local/share
FRONTEND_TARGET_FILE ?= .frontend-backend-target
BACKEND_SERVICE_URL ?= http://romulus-backend:8000/api/v1

.PHONY: \
	dev dev-down dev-clean dev-restart-backend dev-restart-workers \
	dev-check-cluster dev-namespace dev-config dev-secrets \
	dev-db dev-db-migrate dev-backend dev-worker \
	dev-build-images dev-build-backend-image dev-build-worker-image \
	dev-sandbox-delete-all \
	local local-backend-services local-db-migrate local-backend local-worker \
	local-clean \
	check-frontend-node check-local-worker-opencode frontend-install frontend-reset \
	frontend \
	makemigrations install-tests test-backend test-fast

dev: dev-check-cluster dev-namespace dev-build-images dev-config dev-secrets dev-db dev-db-migrate dev-backend dev-worker
	@printf '%s\n' "http://$(K8S_NODE_HOST):$(BACKEND_NODEPORT)" > $(FRONTEND_TARGET_FILE)
	@echo "Kubernetes dev stack is ready."
	@echo "Run \`make frontend\` in another terminal."

dev-check-cluster:
	kubectl cluster-info >/dev/null

dev-namespace:
	kubectl apply -f $(K8S_DEV_DIR)/namespace.yaml

dev-build-images: dev-build-backend-image dev-build-worker-image

dev-build-backend-image:
	eval $$(minikube -p $(MINIKUBE_PROFILE) docker-env) && docker build -t $(BACKEND_IMAGE) -f backend/Dockerfile .

dev-build-worker-image:
	eval $$(minikube -p $(MINIKUBE_PROFILE) docker-env) && docker build -t $(WORKER_IMAGE) -f worker/Dockerfile .

dev-config: dev-namespace
	kubectl create configmap romulus-backend-config -n $(K8S_NAMESPACE) \
		--from-literal=BACKEND_PORT=$(BACKEND_PORT) \
		--from-literal=CONTROLLER_INTERVAL_SECONDS=1 \
		--from-literal=DB_HOST=romulus-postgres \
		--from-literal=DB_PORT=5432 \
		--from-literal=DEPLOY_MODE=kubernetes \
		--from-literal=FRONTEND_PORT=$(FRONTEND_PORT) \
		--from-literal=K8S_NAMESPACE=$(K8S_NAMESPACE) \
		--from-literal=WORKER_IMAGE=$(WORKER_IMAGE) \
		--dry-run=client -o yaml | kubectl apply -f -
	WORKER_ADVERTISE_ARG=""; \
	if [ -n "$(WORKER_ADVERTISE_URL)" ]; then \
		WORKER_ADVERTISE_ARG="--from-literal=WORKER_ADVERTISE_URL=$(WORKER_ADVERTISE_URL)"; \
	fi; \
	kubectl create configmap worker-config -n $(K8S_NAMESPACE) \
		--from-literal=ROMULUS_BACKEND_URL=$(BACKEND_SERVICE_URL) \
		--from-literal=WORKER_DEFAULT_MODEL=anthropic/claude-sonnet-4-5 \
		--from-literal=WORKER_HEARTBEAT_INTERVAL_SECONDS=5 \
		--from-literal=WORKER_LOG_LEVEL=$(WORKER_LOG_LEVEL) \
		--from-literal=WORKER_PORT=8080 \
		--from-literal=WORKER_ROMULUS_BACKEND_URL=$(BACKEND_SERVICE_URL) \
		--from-literal=WORKER_WORKSPACE_ROOT=/workspaces \
		$$WORKER_ADVERTISE_ARG \
		--dry-run=client -o yaml | kubectl apply -f -

dev-secrets: dev-namespace
	kubectl create secret generic romulus-dev-secrets -n $(K8S_NAMESPACE) \
		--from-literal=ANTHROPIC_API_KEY=$(ANTHROPIC_API_KEY) \
		--from-literal=DB_NAME=$(DB_NAME) \
		--from-literal=DB_PASSWORD=$(DB_PASSWORD) \
		--from-literal=DB_USER=$(DB_USER) \
		--from-literal=GOOGLE_API_KEY=$(GOOGLE_API_KEY) \
		--from-literal=OPENAI_API_KEY=$(OPENAI_API_KEY) \
		--dry-run=client -o yaml | kubectl apply -f -

dev-db: dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/postgres-pvc.yaml
	kubectl apply -f $(K8S_DEV_DIR)/postgres-service.yaml
	kubectl apply -f $(K8S_DEV_DIR)/postgres-deployment.yaml
	kubectl rollout status deployment/romulus-postgres -n $(K8S_NAMESPACE)

dev-db-migrate: dev-config dev-secrets dev-db
	kubectl delete job romulus-backend-migrate -n $(K8S_NAMESPACE) --ignore-not-found
	sed 's|image: backend:latest|image: $(BACKEND_IMAGE)|' $(K8S_DEV_DIR)/backend-migrate-job.yaml | kubectl apply -f -
	kubectl wait --for=condition=complete job/romulus-backend-migrate -n $(K8S_NAMESPACE) --timeout=180s

dev-backend: dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/backend-rbac.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-service.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-nodeport-service.yaml
	sed 's|image: backend:latest|image: $(BACKEND_IMAGE)|' $(K8S_DEV_DIR)/backend-deployment.yaml | kubectl apply -f -
	kubectl rollout status deployment/romulus-backend -n $(K8S_NAMESPACE)

dev-worker: dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/worker-service.yaml
	sed 's|image: worker:latest|image: $(WORKER_IMAGE)|' $(K8S_DEV_DIR)/worker-deployment.yaml | kubectl apply -f -
	kubectl scale deployment/worker -n $(K8S_NAMESPACE) --replicas=$(WORKER_POOL_TARGET)
	@if [ "$(WORKER_FORCE_RESTART)" = "1" ]; then \
		kubectl rollout restart deployment/worker -n $(K8S_NAMESPACE); \
	fi
	@if [ "$(WORKER_ROLLOUT_WAIT)" = "1" ]; then \
		kubectl rollout status deployment/worker -n $(K8S_NAMESPACE); \
	else \
		echo "Skipping worker rollout wait; the worker becomes ready after the backend is reachable."; \
	fi

dev-restart-workers: dev-build-worker-image dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/worker-service.yaml
	sed 's|image: worker:latest|image: $(WORKER_IMAGE)|' $(K8S_DEV_DIR)/worker-deployment.yaml | kubectl apply -f -
	kubectl scale deployment/worker -n $(K8S_NAMESPACE) --replicas=$(WORKER_POOL_TARGET)
	kubectl rollout restart deployment/worker -n $(K8S_NAMESPACE)
	kubectl rollout status deployment/worker -n $(K8S_NAMESPACE)

frontend/node_modules/.bin/vite: frontend/package-lock.json frontend/package.json
	cd frontend && npm ci

check-frontend-node:
	@node -e 'const version = process.versions.node.split(".").map(Number); const cmp = (a, b) => { for (let i = 0; i < 3; i += 1) { if ((a[i] || 0) > (b[i] || 0)) return 1; if ((a[i] || 0) < (b[i] || 0)) return -1; } return 0; }; const ok = (version[0] === 20 && cmp(version, [20, 19, 0]) >= 0) || cmp(version, [22, 12, 0]) >= 0; if (!ok) { console.error("Frontend requires Node 20.19+ or 22.12+; current Node is " + process.versions.node + "."); console.error("Switch Node versions, then run `make frontend-reset` to reinstall frontend dependencies cleanly."); process.exit(1); }'

frontend/node_modules/.bin/vite: check-frontend-node

frontend-install: frontend/node_modules/.bin/vite

frontend-reset: check-frontend-node
	rm -rf frontend/node_modules
	cd frontend && npm ci

tests/node_modules/.bin/playwright: tests/package-lock.json tests/package.json
	cd tests && npm ci

frontend: frontend/node_modules/.bin/vite
	@BACKEND_TARGET="$${FRONTEND_BACKEND_TARGET:-$$(cat $(FRONTEND_TARGET_FILE) 2>/dev/null)}"; \
	if [ -z "$$BACKEND_TARGET" ]; then \
		echo "No frontend backend target is configured."; \
		echo "Run \`make dev\` or \`make local-backend\` first, or set FRONTEND_BACKEND_TARGET=..."; \
		exit 1; \
	fi; \
	echo "Starting frontend against $$BACKEND_TARGET"; \
	cd frontend && \
		VITE_PORT=$(FRONTEND_PORT) \
		VITE_BACKEND_TARGET=$$BACKEND_TARGET \
		npm run dev -- --port $(FRONTEND_PORT)

dev-restart-backend: dev-build-backend-image dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/backend-rbac.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-service.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-nodeport-service.yaml
	sed 's|image: backend:latest|image: $(BACKEND_IMAGE)|' $(K8S_DEV_DIR)/backend-deployment.yaml | kubectl apply -f -
	kubectl rollout restart deployment/romulus-backend -n $(K8S_NAMESPACE)
	kubectl rollout status deployment/romulus-backend -n $(K8S_NAMESPACE)

local:
	@echo "Local mode is split intentionally."
	@echo "Run these in separate terminals:"
	@echo "  make local-backend"
	@echo "  make local-worker"
	@echo "Then run \`make frontend\` once the backend is up."

local-backend-services:
	@if ! docker volume inspect $(LOCAL_POSTGRES_VOLUME) >/dev/null 2>&1; then \
		docker volume create $(LOCAL_POSTGRES_VOLUME) >/dev/null; \
	fi
	@if docker ps --format '{{.Names}}' | grep -Fxq $(LOCAL_POSTGRES_CONTAINER); then \
		echo "Local Postgres is already running on localhost:$(LOCAL_DB_PORT)."; \
	elif docker ps -a --format '{{.Names}}' | grep -Fxq $(LOCAL_POSTGRES_CONTAINER); then \
		docker start $(LOCAL_POSTGRES_CONTAINER) >/dev/null; \
		echo "Started existing local Postgres container $(LOCAL_POSTGRES_CONTAINER)."; \
	else \
		docker run -d \
			--name $(LOCAL_POSTGRES_CONTAINER) \
			-e POSTGRES_DB=$(DB_NAME) \
			-e POSTGRES_USER=$(DB_USER) \
			-e POSTGRES_PASSWORD=$(DB_PASSWORD) \
			-p $(LOCAL_DB_PORT):5432 \
			-v $(LOCAL_POSTGRES_VOLUME):/var/lib/postgresql/data \
			$(LOCAL_POSTGRES_IMAGE) >/dev/null; \
		echo "Created local Postgres container $(LOCAL_POSTGRES_CONTAINER)."; \
	fi
	@until docker exec $(LOCAL_POSTGRES_CONTAINER) pg_isready -U $(DB_USER) -d $(DB_NAME) >/dev/null 2>&1; do \
		sleep 1; \
	done
	@echo "Local Postgres is ready on localhost:$(LOCAL_DB_PORT)."

local-db-migrate: local-backend-services
	cd backend && \
		PYTHONPATH=../common \
		DB_HOST=127.0.0.1 \
		DB_PORT=$(LOCAL_DB_PORT) \
		uv run alembic upgrade head

local-backend: local-db-migrate
	@printf '%s\n' "http://localhost:$(HOST_BACKEND_PORT)" > $(FRONTEND_TARGET_FILE)
	@echo "Frontend target set to http://localhost:$(HOST_BACKEND_PORT)."
	cd backend && \
		PYTHONPATH=../common \
		DB_HOST=127.0.0.1 \
		DB_PORT=$(LOCAL_DB_PORT) \
		DEPLOY_MODE=local \
		ENABLE_K8S=0 \
		FRONTEND_PORT=$(FRONTEND_PORT) \
		uv run uvicorn app.main:app --host 0.0.0.0 --port $(HOST_BACKEND_PORT) --reload --reload-dir app --reload-dir ../common/romulus_common

check-local-worker-opencode:
	@command -v opencode >/dev/null 2>&1 || { \
		echo "The local worker expects \`opencode\` to be installed on your host."; \
		echo "Install it first, then rerun \`make local-worker\`."; \
		exit 1; \
	}

local-worker: check-local-worker-opencode
	rm -rf $(LOCAL_WORKSPACE_ROOT)/.opencode/tools
	mkdir -p $(LOCAL_WORKSPACE_ROOT)/.opencode/tools $(LOCAL_WORKER_HOME) $(LOCAL_WORKER_DATA_HOME)
	cp -R worker/tools/. $(LOCAL_WORKSPACE_ROOT)/.opencode/tools/
	cd worker && \
		PYTHONPATH=../common \
		HOME=$(LOCAL_WORKER_HOME) \
		XDG_DATA_HOME=$(LOCAL_WORKER_DATA_HOME) \
		WORKER_PORT=$(LOCAL_WORKER_PORT) \
		WORKER_WORKSPACE_ROOT=$(LOCAL_WORKSPACE_ROOT) \
		WORKER_ROMULUS_BACKEND_URL=http://localhost:$(HOST_BACKEND_PORT)/api/v1 \
		WORKER_ADVERTISE_URL=http://localhost:$(LOCAL_WORKER_PORT) \
		uv run uvicorn app.main:app --host 0.0.0.0 --port $(LOCAL_WORKER_PORT) --reload --reload-dir app --reload-dir ../common/romulus_common

local-clean:
	-docker rm -f $(LOCAL_POSTGRES_CONTAINER) 2>/dev/null
	-docker volume rm $(LOCAL_POSTGRES_VOLUME) 2>/dev/null
	rm -rf .local
	@echo "Local Postgres container, volume, and worker state removed."

dev-down:
	kubectl delete job romulus-backend-migrate -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete deployment romulus-backend worker romulus-postgres -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete service romulus-backend romulus-backend-nodeport worker romulus-postgres -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete configmap romulus-backend-config worker-config -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete secret romulus-dev-secrets -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete serviceaccount romulus-backend -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete role romulus-backend -n $(K8S_NAMESPACE) --ignore-not-found
	kubectl delete rolebinding romulus-backend -n $(K8S_NAMESPACE) --ignore-not-found

dev-clean: dev-down
	kubectl delete pvc romulus-postgres-data -n $(K8S_NAMESPACE) --ignore-not-found
	rm -rf .pg-data

makemigrations:
	cd backend && uv run alembic revision --autogenerate -m "$(MSG)"

install-tests:
	cd tests && npm ci

test-fast:
	cd backend && $(MAKE) test-fast

test-backend: tests/node_modules/.bin/playwright
	@BACKEND_TARGET="$${BACKEND_TARGET:-$$(cat $(FRONTEND_TARGET_FILE) 2>/dev/null)}"; \
	if [ -z "$$BACKEND_TARGET" ]; then \
		echo "No backend target configured. Run \`make dev\` or \`make local-backend\` first."; \
		exit 1; \
	fi; \
	if ! curl -sf "$$BACKEND_TARGET/health" >/dev/null 2>&1; then \
		echo "Backend is not responding at $$BACKEND_TARGET/health"; \
		echo "Start it with \`make dev\` or \`make local-backend\` first."; \
		exit 1; \
	fi; \
	cd tests && PLAYWRIGHT_BASE_URL=$$BACKEND_TARGET npm run test -- $(ARGS)

dev-sandbox-delete-all:
	kubectl get deployments -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)
	kubectl get services -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)
