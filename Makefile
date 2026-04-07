include .env
export

MINIKUBE ?= minikube
K8S_NAMESPACE ?= romulus
K8S_DEV_DIR := k8s/dev

BACKEND_IMAGE ?= backend:latest
WORKER_IMAGE ?= worker:latest
BACKEND_NODEPORT ?= 30800
WORKER_POOL_TARGET ?= 1
WORKER_POOL_MAX ?= 1

.PHONY: \
	dev dev-up dev-down dev-clean dev-restart-backend \
	dev-restart-workers \
	dev-namespace dev-config dev-secrets dev-db dev-db-migrate \
	dev-backend dev-frontend dev-worker \
	dev-build-images dev-build-backend-image dev-build-worker-image \
	backend db frontend migrate stop-db worker worker-build worker-deploy \
	makemigrations install-frontend install-tests test-backend sandbox-delete-all k8s-namespace

dev: dev-up dev-frontend

dev-up: dev-namespace dev-build-images dev-config dev-secrets dev-db dev-db-migrate dev-backend dev-worker

dev-namespace:
	@$(MINIKUBE) status --format '{{.Host}}' 2>/dev/null | grep -q Running || $(MINIKUBE) start --driver=docker
	kubectl apply -f $(K8S_DEV_DIR)/namespace.yaml

dev-build-images: dev-build-backend-image dev-build-worker-image

dev-build-backend-image:
	eval $$($(MINIKUBE) docker-env) && docker build -t $(BACKEND_IMAGE) backend/

dev-build-worker-image:
	cp /usr/bin/opencode worker/opencode
	eval $$($(MINIKUBE) docker-env) && docker build -t $(WORKER_IMAGE) worker/
	rm -f worker/opencode

dev-config: dev-namespace
	kubectl create configmap romulus-backend-config -n $(K8S_NAMESPACE) \
		--from-literal=BACKEND_PORT=8000 \
		--from-literal=CONTROLLER_INTERVAL_SECONDS=1 \
		--from-literal=DB_HOST=romulus-postgres \
		--from-literal=DB_PORT=5432 \
		--from-literal=DEPLOY_MODE=kubernetes \
		--from-literal=FRONTEND_PORT=$(FRONTEND_PORT) \
		--from-literal=K8S_NAMESPACE=$(K8S_NAMESPACE) \
		--from-literal=WORKER_IMAGE=$(WORKER_IMAGE) \
		--dry-run=client -o yaml | kubectl apply -f -
	kubectl create configmap worker-config -n $(K8S_NAMESPACE) \
		--from-literal=ROMULUS_BACKEND_URL=http://romulus-backend:8000/api/v1 \
		--from-literal=WORKER_DEFAULT_MODEL=anthropic/claude-sonnet-4-5 \
		--from-literal=WORKER_HEARTBEAT_INTERVAL_SECONDS=5 \
		--from-literal=WORKER_LOG_LEVEL=$(WORKER_LOG_LEVEL) \
		--from-literal=WORKER_PORT=8080 \
		--from-literal=WORKER_ROMULUS_BACKEND_URL=http://romulus-backend:8000/api/v1 \
		--from-literal=WORKER_WORKSPACE_ROOT=/workspaces \
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

dev-db-migrate: dev-config dev-secrets dev-db dev-build-backend-image
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
	kubectl rollout status deployment/worker -n $(K8S_NAMESPACE)

dev-restart-workers: dev-build-worker-image dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/worker-service.yaml
	sed 's|image: worker:latest|image: $(WORKER_IMAGE)|' $(K8S_DEV_DIR)/worker-deployment.yaml | kubectl apply -f -
	kubectl scale deployment/worker -n $(K8S_NAMESPACE) --replicas=$(WORKER_POOL_TARGET)
	kubectl rollout restart deployment/worker -n $(K8S_NAMESPACE)
	kubectl rollout status deployment/worker -n $(K8S_NAMESPACE)

dev-frontend:
	cd frontend && \
		VITE_PORT=$(FRONTEND_PORT) \
		VITE_BACKEND_TARGET=http://$$($(MINIKUBE) ip):$(BACKEND_NODEPORT) \
		npm run dev -- --port $(FRONTEND_PORT)

dev-restart-backend: dev-build-backend-image dev-config dev-secrets
	kubectl apply -f $(K8S_DEV_DIR)/backend-rbac.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-service.yaml
	kubectl apply -f $(K8S_DEV_DIR)/backend-nodeport-service.yaml
	sed 's|image: backend:latest|image: $(BACKEND_IMAGE)|' $(K8S_DEV_DIR)/backend-deployment.yaml | kubectl apply -f -
	kubectl rollout restart deployment/romulus-backend -n $(K8S_NAMESPACE)
	kubectl rollout status deployment/romulus-backend -n $(K8S_NAMESPACE)

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

backend: dev-backend

db: dev-db

frontend: dev-frontend

migrate: dev-db-migrate

stop-db: dev-down

worker-build: dev-build-worker-image

worker-deploy: dev-worker

k8s-namespace: dev-namespace

makemigrations:
	cd backend && uv run alembic revision --autogenerate -m "$(MSG)"

install-frontend:
	cd frontend && npm install

install-tests:
	cd tests && npm install

test-backend: dev-namespace
	cd tests && PLAYWRIGHT_BASE_URL=http://$$($(MINIKUBE) ip):$(BACKEND_NODEPORT) npm run test -- $(ARGS)

sandbox-delete-all:
	kubectl get deployments -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)
	kubectl get services -n $(K8S_NAMESPACE) -l app=worker -o name | xargs -r kubectl delete -n $(K8S_NAMESPACE)
