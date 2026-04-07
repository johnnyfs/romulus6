import os
import shutil
import socket
import subprocess
from functools import lru_cache
from urllib.parse import urlparse

from kubernetes import client, config
from kubernetes.config.kube_config import _get_kube_config_loader
from kubernetes.client import AppsV1Api, CoreV1Api

DEPLOY_MODE = os.environ.get("DEPLOY_MODE", "local")
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "romulus")
WORKER_IMAGE = os.environ.get("WORKER_IMAGE", "worker:latest")

# NodePort range reserved for dynamically-provisioned sandbox workers.
# 30808 is already claimed by the static worker-nodeport service.
SANDBOX_NODEPORT_MIN = 30900
SANDBOX_NODEPORT_MAX = 32767


@lru_cache(maxsize=1)
def _is_host_available(host: str) -> bool:
    try:
        socket.getaddrinfo(host, None)
        return True
    except socket.gaierror:
        return False


def _normalize_host(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme:
        if parsed.hostname:
            return parsed.hostname
        return value
    return value.split(":", 1)[0]


def _current_kube_server_host() -> str | None:
    try:
        loader = _get_kube_config_loader()
    except Exception:
        return None

    server = loader._cluster.safe_get("server")
    if not server:
        return None
    return urlparse(server).hostname


def _bootstrap_local_cluster_host() -> str | None:
    if shutil.which("minikube") is None:
        return None
    try:
        subprocess.run(
            ["minikube", "start"],
            capture_output=True,
            text=True,
            check=True,
        )
        result = subprocess.run(
            ["minikube", "ip"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    host = result.stdout.strip()
    return host or None


def _get_k8s_node_host() -> str:
    explicit = os.environ.get("K8S_NODE_HOST")
    if explicit:
        normalized_explicit = _normalize_host(explicit)
        if _is_host_available(normalized_explicit):
            return normalized_explicit

    kube_host = _current_kube_server_host()
    if kube_host and _is_host_available(kube_host):
        return kube_host

    bootstrapped_host = _bootstrap_local_cluster_host()
    if bootstrapped_host and _is_host_available(bootstrapped_host):
        return bootstrapped_host

    if explicit:
        raise RuntimeError(
            f"K8S_NODE_HOST={explicit!r} is not reachable and no local cluster host could be resolved"
        )
    raise RuntimeError(
        "Could not resolve a reachable Kubernetes node host. "
        "Set K8S_NODE_HOST or configure a local kube context."
    )


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
    host = _get_k8s_node_host()
    return f"http://{host}:{node_port}"


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

def build_deployment(worker_id: str, workspace_id: str | None = None) -> dict:
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
                            ] + ([
                                {"name": "ROMULUS_WORKSPACE_ID", "value": workspace_id},
                            ] if workspace_id else []),
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
