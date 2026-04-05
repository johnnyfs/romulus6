import os
import subprocess
from functools import lru_cache

from kubernetes import client, config
from kubernetes.client import AppsV1Api, CoreV1Api

DEPLOY_MODE = os.environ.get("DEPLOY_MODE", "local")
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "romulus")
WORKER_IMAGE = os.environ.get("WORKER_IMAGE", "worker:latest")

# NodePort range reserved for dynamically-provisioned sandbox workers.
# 30808 is already claimed by the static worker-nodeport service.
SANDBOX_NODEPORT_MIN = 30900
SANDBOX_NODEPORT_MAX = 32767


@lru_cache(maxsize=1)
def _get_minikube_ip() -> str:
    explicit = os.environ.get("MINIKUBE_IP")
    if explicit:
        return explicit
    result = subprocess.run(
        ["minikube", "ip"], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def init_k8s() -> None:
    """Call once at application startup via FastAPI lifespan."""
    if DEPLOY_MODE == "kubernetes":
        config.load_incluster_config()
    else:
        config.load_kube_config()


def apps_api() -> AppsV1Api:
    return client.AppsV1Api()


def core_api() -> CoreV1Api:
    return client.CoreV1Api()


# ── Resource name helpers ─────────────────────────────────────────────────────

def deployment_name(worker_id: str) -> str:
    return f"worker-{worker_id}"


def clusterip_service_name(worker_id: str) -> str:
    return f"worker-{worker_id}"


def nodeport_service_name(worker_id: str) -> str:
    return f"worker-{worker_id}-np"


def worker_url_kubernetes(worker_id: str) -> str:
    svc = clusterip_service_name(worker_id)
    return f"http://{svc}.{K8S_NAMESPACE}.svc.cluster.local"


def worker_url_local(node_port: int) -> str:
    ip = _get_minikube_ip()
    return f"http://{ip}:{node_port}"


# ── NodePort allocation ───────────────────────────────────────────────────────

def allocate_node_port() -> int:
    """
    Scan all NodePort services in the namespace and return the first unused
    port in [SANDBOX_NODEPORT_MIN, SANDBOX_NODEPORT_MAX].
    Raises RuntimeError when the range is exhausted.
    """
    api = core_api()
    services = api.list_namespaced_service(namespace=K8S_NAMESPACE)
    used: set[int] = set()
    for svc in services.items:
        if svc.spec.type == "NodePort":
            for port in svc.spec.ports:
                if port.node_port:
                    used.add(port.node_port)
    for port in range(SANDBOX_NODEPORT_MIN, SANDBOX_NODEPORT_MAX + 1):
        if port not in used:
            return port
    raise RuntimeError("NodePort range exhausted")


# ── K8s manifest builders ─────────────────────────────────────────────────────

def build_deployment(worker_id: str) -> dict:
    name = deployment_name(worker_id)
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": K8S_NAMESPACE,
            "labels": {
                "app": "worker",
                "worker-id": worker_id,
            },
        },
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"worker-id": worker_id}},
            "template": {
                "metadata": {"labels": {"app": "worker", "worker-id": worker_id}},
                "spec": {
                    "containers": [
                        {
                            "name": "worker",
                            "image": WORKER_IMAGE,
                            "imagePullPolicy": "IfNotPresent",
                            "ports": [{"containerPort": 8080}],
                            "envFrom": [
                                {"configMapRef": {"name": "worker-config"}},
                                {"secretRef": {"name": "worker-secrets"}},
                            ],
                            "env": [
                                {"name": "XDG_DATA_HOME", "value": "/data/.local/share"},
                                {"name": "HOME", "value": "/data"},
                            ],
                            "volumeMounts": [
                                {"name": "workspaces", "mountPath": "/workspaces"},
                                {"name": "opencode-data", "mountPath": "/data/.local/share"},
                            ],
                            "resources": {
                                "requests": {"cpu": "250m", "memory": "256Mi"},
                                "limits": {"cpu": "2000m", "memory": "2Gi"},
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/health", "port": 8080},
                                "initialDelaySeconds": 10,
                                "periodSeconds": 30,
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/health", "port": 8080},
                                "initialDelaySeconds": 5,
                                "periodSeconds": 10,
                            },
                        }
                    ],
                    "volumes": [
                        {"name": "workspaces", "emptyDir": {}},
                        {"name": "opencode-data", "emptyDir": {}},
                    ],
                },
            },
        },
    }


def build_clusterip_service(worker_id: str) -> dict:
    name = clusterip_service_name(worker_id)
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": name,
            "namespace": K8S_NAMESPACE,
            "labels": {"app": "worker", "worker-id": worker_id},
        },
        "spec": {
            "selector": {"worker-id": worker_id},
            "ports": [{"port": 80, "targetPort": 8080, "protocol": "TCP"}],
            "type": "ClusterIP",
        },
    }


def build_nodeport_service(worker_id: str, node_port: int) -> dict:
    name = nodeport_service_name(worker_id)
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": name,
            "namespace": K8S_NAMESPACE,
            "labels": {"app": "worker", "worker-id": worker_id},
        },
        "spec": {
            "selector": {"worker-id": worker_id},
            "ports": [{"port": 8080, "targetPort": 8080, "nodePort": node_port}],
            "type": "NodePort",
        },
    }
