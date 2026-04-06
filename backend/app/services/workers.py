import datetime
import uuid

from kubernetes.client.rest import ApiException
from sqlmodel import Session

from app import k8s
from app.models.worker import Worker, WorkerStatus


def create_worker(session: Session, workspace_id: uuid.UUID | None = None) -> Worker:
    worker = Worker(status=WorkerStatus.pending)
    session.add(worker)
    session.commit()
    session.refresh(worker)

    worker_id_str = str(worker.id)

    try:
        apps = k8s.apps_api()
        core = k8s.core_api()

        apps.create_namespaced_deployment(
            namespace=k8s.K8S_NAMESPACE,
            body=k8s.build_deployment(worker_id_str, workspace_id=str(workspace_id) if workspace_id else None),
        )
        worker.deployment_name = k8s.deployment_name(worker_id_str)

        core.create_namespaced_service(
            namespace=k8s.K8S_NAMESPACE,
            body=k8s.build_clusterip_service(worker_id_str),
        )
        worker.service_name = k8s.clusterip_service_name(worker_id_str)

        if k8s.DEPLOY_MODE == "local":
            node_port = k8s.allocate_node_port()
            core.create_namespaced_service(
                namespace=k8s.K8S_NAMESPACE,
                body=k8s.build_nodeport_service(worker_id_str, node_port),
            )
            worker.nodeport_service_name = k8s.nodeport_service_name(worker_id_str)
            worker.node_port = node_port
            worker.worker_url = k8s.worker_url_local(node_port)
        else:
            worker.worker_url = k8s.worker_url_kubernetes(worker_id_str)

        worker.status = WorkerStatus.running
    except Exception:
        worker.status = WorkerStatus.failed
        raise
    finally:
        worker.updated_at = datetime.datetime.utcnow()
        session.add(worker)
        session.commit()
        session.refresh(worker)

    return worker


def delete_worker(session: Session, worker_id: uuid.UUID) -> None:
    worker = session.get(Worker, worker_id)
    if worker is None:
        return

    worker.status = WorkerStatus.terminating
    worker.updated_at = datetime.datetime.utcnow()
    session.add(worker)
    session.commit()

    apps = k8s.apps_api()
    core = k8s.core_api()

    def _delete_ignore_404(fn, name: str) -> None:
        try:
            fn(name=name, namespace=k8s.K8S_NAMESPACE)
        except ApiException as e:
            if e.status != 404:
                raise

    if worker.deployment_name:
        _delete_ignore_404(apps.delete_namespaced_deployment, worker.deployment_name)
    if worker.service_name:
        _delete_ignore_404(core.delete_namespaced_service, worker.service_name)
    if worker.nodeport_service_name:
        _delete_ignore_404(core.delete_namespaced_service, worker.nodeport_service_name)

    worker.status = WorkerStatus.terminated
    worker.deleted = True
    worker.updated_at = datetime.datetime.utcnow()
    session.add(worker)
    session.commit()
