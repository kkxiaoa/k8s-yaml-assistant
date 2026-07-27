#!/usr/bin/python3 -I

import base64
import binascii
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import syslog
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import AbstractSet, BinaryIO, TextIO

MAX_REQUEST_BYTES = 64 * 1024
MAX_RESULT_BYTES = 4 * 1024
MAX_LEDGER_BYTES = 1024 * 1024
MAX_OPERATION_BYTES = 16 * 1024
MAX_TEMPLATE_BYTES = 1024 * 1024
MAX_CHILD_STDOUT_BYTES = 2 * 1024 * 1024

REPOSITORY = "kkxiaoa/k8s-yaml-assistant"
IMAGE_NAME = f"ghcr.io/{REPOSITORY}"
NAMESPACE = "k8s-yaml-assistant-prod"
DEPLOYMENT = "k8s-yaml-assistant"
CONTAINER = "app"
POD_SELECTOR = "app.kubernetes.io/name=k8s-yaml-assistant"
IMAGE_MARKER = "__K8S_YAML_ASSISTANT_IMAGE__"

AUTHORIZATION_CERTIFICATE_IDENTITY = (
    "https://github.com/kkxiaoa/k8s-yaml-assistant/"
    ".github/workflows/published-release-deploy.yml@refs/heads/main"
)
PROVENANCE_CERTIFICATE_IDENTITY = (
    "https://github.com/kkxiaoa/k8s-yaml-assistant/"
    ".github/workflows/release-artifacts.yml@refs/heads/main"
)
OIDC_ISSUER = "https://token.actions.githubusercontent.com"
BUILDKIT_SLSA_V1_BUILD_TYPE = (
    "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md"
)
VCS_SOURCE = "https://github.com/kkxiaoa/k8s-yaml-assistant"

CHILD_ENVIRONMENT = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
}

_OUTER_FIELDS = {
    "schemaVersion",
    "authorization",
    "authorizationBundle",
    "provenanceBundle",
}
_AUTHORIZATION_FIELD_ORDER = (
    "schemaVersion",
    "action",
    "repository",
    "releaseId",
    "releaseTag",
    "sourceCommit",
    "publishedAt",
    "imageName",
    "imageDigest",
    "provenanceBundleSha256",
    "workflowRunId",
    "workflowRunAttempt",
)
_AUTHORIZATION_FIELDS = set(_AUTHORIZATION_FIELD_ORDER)
_LEDGER_EVENT_FIELDS = {
    "action",
    "releaseId",
    "releaseTag",
    "sourceCommit",
    "publishedAt",
    "imageDigest",
    "workflowRunId",
    "workflowRunAttempt",
    "deployedAt",
}
_DECIMAL_ID = re.compile(r"^[1-9][0-9]{0,31}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
_DEPLOY_TAG = re.compile(rf"^v{_SEMVER}$")
_ROLLBACK_TAG = re.compile(
    rf"^rollback-v{_SEMVER}-sha256-(?P<digest>[a-f0-9]{{64}})"
    r"-r[1-9][0-9]{0,31}$"
)
_RFC3339_UTC = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
    r"[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)
_RUNTIME_IMAGE_DIGEST = re.compile(r"(sha256:[a-f0-9]{64})$")


@dataclass(frozen=True)
class RuntimePaths:
    cosign_path: str
    k3s_path: str
    kubeconfig_path: str
    template_path: str
    trusted_root_path: str
    state_dir: str
    runtime_dir: str
    expected_uid: int


PRODUCTION_PATHS = RuntimePaths(
    cosign_path="/usr/local/bin/cosign",
    k3s_path="/usr/local/bin/k3s",
    kubeconfig_path="/etc/rancher/k3s/k3s.yaml",
    template_path=("/etc/k8s-yaml-assistant-deployer/deployment-template.yaml"),
    trusted_root_path=("/etc/k8s-yaml-assistant-deployer/sigstore-trusted-root.json"),
    state_dir="/var/lib/k8s-yaml-assistant-deployer",
    runtime_dir="/run/k8s-yaml-assistant-deployer",
    expected_uid=0,
)


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    timed_out: bool


@dataclass(frozen=True)
class RequestEnvelope:
    authorization: str
    authorization_bundle: str
    provenance_bundle: str
    provenance_sha256: str


@dataclass(frozen=True)
class Authorization:
    action: str
    release_id: str
    release_tag: str
    source_commit: str
    published_at: str
    published_instant: datetime.datetime
    image_digest: str
    workflow_run_id: str
    workflow_run_attempt: str


@dataclass(frozen=True)
class LedgerEvent:
    action: str
    release_id: str
    release_tag: str
    source_commit: str
    published_at: str
    published_instant: datetime.datetime
    image_digest: str
    workflow_run_id: str
    workflow_run_attempt: str
    deployed_at: str

    def as_json(self) -> dict[str, str]:
        return {
            "action": self.action,
            "releaseId": self.release_id,
            "releaseTag": self.release_tag,
            "sourceCommit": self.source_commit,
            "publishedAt": self.published_at,
            "imageDigest": self.image_digest,
            "workflowRunId": self.workflow_run_id,
            "workflowRunAttempt": self.workflow_run_attempt,
            "deployedAt": self.deployed_at,
        }


@dataclass(frozen=True)
class VerificationFiles:
    authorization: str
    authorization_bundle: str
    provenance_bundle: str


class AdapterFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


Runner = Callable[[tuple[str, ...], bytes | None, int], ProcessResult]


def _reader_thread(
    stream: BinaryIO,
    destination: bytearray,
) -> None:
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            remaining = MAX_CHILD_STDOUT_BYTES + 1 - len(destination)
            if remaining > 0:
                destination.extend(chunk[:remaining])
    except OSError:
        pass
    finally:
        stream.close()


def _writer_thread(stream: BinaryIO, content: bytes) -> None:
    try:
        stream.write(content)
        stream.flush()
    except OSError:
        pass
    finally:
        stream.close()


def run_process(
    argv: tuple[str, ...],
    input_bytes: bytes | None,
    timeout_seconds: int,
) -> ProcessResult:
    if (
        not argv
        or not os.path.isabs(argv[0])
        or timeout_seconds <= 0
        or any("\0" in argument for argument in argv)
    ):
        raise AdapterFailure("internal_error")

    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd="/",
        env=CHILD_ENVIRONMENT,
        shell=False,
        start_new_session=True,
    )
    assert process.stdout is not None
    output = bytearray()
    reader = threading.Thread(
        target=_reader_thread,
        args=(process.stdout, output),
        daemon=True,
    )
    reader.start()
    writer = None
    if input_bytes is not None:
        assert process.stdin is not None
        writer = threading.Thread(
            target=_writer_thread,
            args=(process.stdin, input_bytes),
            daemon=True,
        )
        writer.start()

    timed_out = False
    try:
        returncode = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        returncode = process.wait()

    if writer is not None:
        writer.join()
    reader.join()
    return ProcessResult(returncode, bytes(output), timed_out)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_nonfinite_number(_: str) -> object:
    raise ValueError("non-finite number")


def _decode_json_text(text: str, failure_code: str) -> object:
    try:
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonfinite_number,
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        raise AdapterFailure(failure_code) from None


def _strict_object(
    value: object,
    fields: AbstractSet[str],
    failure_code: str,
) -> dict[str, object]:
    if type(value) is not dict or set(value) != fields:
        raise AdapterFailure(failure_code)
    return value


def _strict_string(
    value: object,
    failure_code: str,
) -> str:
    if type(value) is not str:
        raise AdapterFailure(failure_code)
    return value


def _strict_integer(
    value: object,
    failure_code: str,
) -> int:
    if type(value) is not int:
        raise AdapterFailure(failure_code)
    return value


def _parse_utc_timestamp(
    value: object,
    failure_code: str,
) -> tuple[str, datetime.datetime]:
    text = _strict_string(value, failure_code)
    if not _RFC3339_UTC.fullmatch(text):
        raise AdapterFailure(failure_code)
    try:
        instant = datetime.datetime.fromisoformat(text.removesuffix("Z") + "+00:00")
    except ValueError:
        raise AdapterFailure(failure_code) from None
    return text, instant


def _validate_tag(
    action: str,
    release_tag: str,
    image_digest: str,
    failure_code: str,
) -> None:
    if len(release_tag.encode()) > 128:
        raise AdapterFailure(failure_code)
    if action == "deploy":
        if not _DEPLOY_TAG.fullmatch(release_tag):
            raise AdapterFailure(failure_code)
        return
    match = _ROLLBACK_TAG.fullmatch(release_tag)
    if match is None or match.group("digest") != image_digest.removeprefix("sha256:"):
        raise AdapterFailure(failure_code)


def decode_request(raw: bytes) -> RequestEnvelope:
    if len(raw) > MAX_REQUEST_BYTES:
        raise AdapterFailure("request_too_large")
    if not raw:
        raise AdapterFailure("invalid_request")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise AdapterFailure("invalid_request") from None
    value = _strict_object(
        _decode_json_text(text, "invalid_request"),
        _OUTER_FIELDS,
        "invalid_request",
    )
    if _strict_integer(value["schemaVersion"], "invalid_request") != 1:
        raise AdapterFailure("invalid_request")
    authorization = _strict_string(
        value["authorization"],
        "invalid_request",
    )
    authorization_bundle = _strict_string(
        value["authorizationBundle"],
        "invalid_request",
    )
    provenance_bundle = _strict_string(
        value["provenanceBundle"],
        "invalid_request",
    )
    return RequestEnvelope(
        authorization=authorization,
        authorization_bundle=authorization_bundle,
        provenance_bundle=provenance_bundle,
        provenance_sha256=hashlib.sha256(provenance_bundle.encode("utf-8")).hexdigest(),
    )


def decode_authorization(
    text: str,
    observed_provenance_sha256: str,
) -> Authorization:
    value = _strict_object(
        _decode_json_text(text, "authorization_invalid"),
        _AUTHORIZATION_FIELDS,
        "authorization_invalid",
    )
    canonical = (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    if list(value) != list(_AUTHORIZATION_FIELD_ORDER) or text != canonical:
        raise AdapterFailure("authorization_invalid")
    if (
        _strict_integer(
            value["schemaVersion"],
            "authorization_invalid",
        )
        != 1
    ):
        raise AdapterFailure("authorization_invalid")

    action = _strict_string(value["action"], "authorization_invalid")
    repository = _strict_string(
        value["repository"],
        "authorization_invalid",
    )
    release_id = _strict_string(
        value["releaseId"],
        "authorization_invalid",
    )
    release_tag = _strict_string(
        value["releaseTag"],
        "authorization_invalid",
    )
    source_commit = _strict_string(
        value["sourceCommit"],
        "authorization_invalid",
    )
    published_at, published_instant = _parse_utc_timestamp(
        value["publishedAt"],
        "authorization_invalid",
    )
    image_name = _strict_string(
        value["imageName"],
        "authorization_invalid",
    )
    image_digest = _strict_string(
        value["imageDigest"],
        "authorization_invalid",
    )
    provenance_bundle_sha256 = _strict_string(
        value["provenanceBundleSha256"],
        "authorization_invalid",
    )
    workflow_run_id = _strict_string(
        value["workflowRunId"],
        "authorization_invalid",
    )
    workflow_run_attempt = _strict_string(
        value["workflowRunAttempt"],
        "authorization_invalid",
    )

    if (
        action not in {"deploy", "rollback"}
        or repository != REPOSITORY
        or image_name != IMAGE_NAME
        or not _DECIMAL_ID.fullmatch(release_id)
        or not _DECIMAL_ID.fullmatch(workflow_run_id)
        or not _DECIMAL_ID.fullmatch(workflow_run_attempt)
        or not _COMMIT.fullmatch(source_commit)
        or not _IMAGE_DIGEST.fullmatch(image_digest)
        or not _SHA256.fullmatch(provenance_bundle_sha256)
    ):
        raise AdapterFailure("authorization_invalid")
    _validate_tag(
        action,
        release_tag,
        image_digest,
        "authorization_invalid",
    )
    if provenance_bundle_sha256 != observed_provenance_sha256:
        raise AdapterFailure("identity_mismatch")

    return Authorization(
        action=action,
        release_id=release_id,
        release_tag=release_tag,
        source_commit=source_commit,
        published_at=published_at,
        published_instant=published_instant,
        image_digest=image_digest,
        workflow_run_id=workflow_run_id,
        workflow_run_attempt=workflow_run_attempt,
    )


def _nested_object(
    value: object,
    key: str,
    failure_code: str,
) -> dict[str, object]:
    if type(value) is not dict or type(value.get(key)) is not dict:
        raise AdapterFailure(failure_code)
    return value[key]


def decode_and_validate_provenance(
    bundle_text: str,
    authorization: Authorization,
) -> None:
    bundle = _decode_json_text(bundle_text, "provenance_invalid")
    if type(bundle) is not dict:
        raise AdapterFailure("provenance_invalid")
    if bundle.get("mediaType") != "application/vnd.dev.sigstore.bundle.v0.3+json":
        raise AdapterFailure("provenance_invalid")
    envelope = _nested_object(
        bundle,
        "dsseEnvelope",
        "provenance_invalid",
    )
    if envelope.get("payloadType") != "application/vnd.in-toto+json":
        raise AdapterFailure("provenance_invalid")
    payload_text = envelope.get("payload")
    if type(payload_text) is not str:
        raise AdapterFailure("provenance_invalid")
    try:
        payload_bytes = base64.b64decode(payload_text, validate=True)
        payload_source = payload_bytes.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        raise AdapterFailure("provenance_invalid") from None
    statement = _decode_json_text(payload_source, "provenance_invalid")
    if type(statement) is not dict:
        raise AdapterFailure("provenance_invalid")
    if (
        statement.get("_type") != "https://in-toto.io/Statement/v0.1"
        or statement.get("predicateType") != "https://slsa.dev/provenance/v1"
    ):
        raise AdapterFailure("provenance_invalid")

    subjects = statement.get("subject")
    if type(subjects) is not list or len(subjects) != 1:
        raise AdapterFailure("provenance_invalid")
    subject = _strict_object(
        subjects[0],
        {"name", "digest"},
        "provenance_invalid",
    )
    digest = _strict_object(
        subject["digest"],
        {"sha256"},
        "provenance_invalid",
    )
    subject_name = _strict_string(
        subject["name"],
        "provenance_invalid",
    )
    subject_digest = _strict_string(
        digest["sha256"],
        "provenance_invalid",
    )
    if (
        subject_name != IMAGE_NAME
        or subject_digest != authorization.image_digest.removeprefix("sha256:")
    ):
        raise AdapterFailure("identity_mismatch")

    predicate = _nested_object(
        statement,
        "predicate",
        "provenance_invalid",
    )
    build_definition = _nested_object(
        predicate,
        "buildDefinition",
        "provenance_invalid",
    )
    if build_definition.get("buildType") != BUILDKIT_SLSA_V1_BUILD_TYPE:
        raise AdapterFailure("provenance_invalid")
    external = _nested_object(
        build_definition,
        "externalParameters",
        "provenance_invalid",
    )
    config_source = _nested_object(
        external,
        "configSource",
        "provenance_invalid",
    )
    request = _nested_object(
        external,
        "request",
        "provenance_invalid",
    )
    args = _nested_object(
        request,
        "args",
        "provenance_invalid",
    )
    root = _nested_object(
        request,
        "root",
        "provenance_invalid",
    )
    root_config = _nested_object(
        root,
        "configSource",
        "provenance_invalid",
    )
    root_request = _nested_object(
        root_config,
        "request",
        "provenance_invalid",
    )
    root_args = _nested_object(
        root_request,
        "args",
        "provenance_invalid",
    )
    if config_source.get("path") != "Dockerfile" or args.get("target") != "runtime":
        raise AdapterFailure("provenance_invalid")
    if (
        root_args.get("vcs:source") != VCS_SOURCE
        or root_args.get("vcs:revision") != authorization.source_commit
    ):
        raise AdapterFailure("identity_mismatch")


def _path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise AdapterFailure("internal_error")
    return path


def _secure_directory(
    path_text: str,
    expected_uid: int,
    failure_code: str,
) -> Path:
    path = _path(path_text)
    try:
        info = path.lstat()
    except OSError:
        raise AdapterFailure(failure_code) from None
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise AdapterFailure(failure_code)
    return path


def _secure_regular_file(
    path_text: str,
    expected_uid: int,
    failure_code: str,
    *,
    private: bool = False,
    executable: bool = False,
) -> None:
    path = _path(path_text)
    try:
        info = path.lstat()
    except OSError:
        raise AdapterFailure(failure_code) from None
    mode = stat.S_IMODE(info.st_mode)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or mode & 0o022
        or (private and mode != 0o600)
        or (executable and not mode & stat.S_IXUSR)
    ):
        raise AdapterFailure(failure_code)


def _read_regular_file(
    path_text: str,
    expected_uid: int,
    max_bytes: int,
    failure_code: str,
    *,
    private: bool,
) -> bytes:
    path = _path(path_text)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise AdapterFailure(failure_code) from None
    try:
        info = os.fstat(descriptor)
        mode = stat.S_IMODE(info.st_mode)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
            or mode & 0o022
            or (private and mode != 0o600)
            or info.st_size > max_bytes
        ):
            raise AdapterFailure(failure_code)
        content = bytearray()
        while len(content) <= max_bytes:
            chunk = os.read(
                descriptor,
                min(64 * 1024, max_bytes + 1 - len(content)),
            )
            if not chunk:
                return bytes(content)
            content.extend(chunk)
        raise AdapterFailure(failure_code)
    finally:
        os.close(descriptor)


def _write_exclusive_file(path: Path, content: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def _verification_files(
    envelope: RequestEnvelope,
    runtime_dir: Path,
) -> Iterator[VerificationFiles]:
    directory = Path(tempfile.mkdtemp(prefix=".verify-", dir=runtime_dir))
    os.chmod(directory, 0o700)
    files = {
        "authorization.json": envelope.authorization.encode("utf-8"),
        "authorization.sigstore.json": (envelope.authorization_bundle.encode("utf-8")),
        "provenance.sigstore.json": (envelope.provenance_bundle.encode("utf-8")),
    }
    try:
        for name, content in files.items():
            _write_exclusive_file(directory / name, content)
        _fsync_directory(directory)
        yield VerificationFiles(
            authorization=str(directory / "authorization.json"),
            authorization_bundle=str(directory / "authorization.sigstore.json"),
            provenance_bundle=str(directory / "provenance.sigstore.json"),
        )
    finally:
        for name in files:
            try:
                (directory / name).unlink()
            except FileNotFoundError:
                pass
        directory.rmdir()


def _validate_proof_files(paths: RuntimePaths) -> None:
    _secure_regular_file(
        paths.cosign_path,
        paths.expected_uid,
        "internal_error",
        executable=True,
    )
    _secure_regular_file(
        paths.trusted_root_path,
        paths.expected_uid,
        "internal_error",
    )


def _validate_kubernetes_files(paths: RuntimePaths) -> None:
    _secure_regular_file(
        paths.k3s_path,
        paths.expected_uid,
        "internal_error",
        executable=True,
    )
    _secure_regular_file(
        paths.kubeconfig_path,
        paths.expected_uid,
        "internal_error",
        private=True,
    )


def _verify_proofs(
    envelope: RequestEnvelope,
    paths: RuntimePaths,
    runner: Runner,
    runtime_dir: Path,
) -> Authorization:
    _validate_proof_files(paths)
    with _verification_files(envelope, runtime_dir) as files:
        authorization_result = runner(
            (
                paths.cosign_path,
                "verify-blob",
                "--offline",
                "--bundle",
                files.authorization_bundle,
                "--trusted-root",
                paths.trusted_root_path,
                "--certificate-identity",
                AUTHORIZATION_CERTIFICATE_IDENTITY,
                "--certificate-oidc-issuer",
                OIDC_ISSUER,
                "--certificate-github-workflow-trigger",
                "release",
                files.authorization,
            ),
            None,
            30,
        )
        if authorization_result.timed_out or authorization_result.returncode != 0:
            raise AdapterFailure("authorization_invalid")
        authorization = decode_authorization(
            envelope.authorization,
            envelope.provenance_sha256,
        )
        provenance_result = runner(
            (
                paths.cosign_path,
                "verify-blob-attestation",
                "--offline",
                "--bundle",
                files.provenance_bundle,
                "--trusted-root",
                paths.trusted_root_path,
                "--digest",
                authorization.image_digest.removeprefix("sha256:"),
                "--digestAlg",
                "sha256",
                "--certificate-identity",
                PROVENANCE_CERTIFICATE_IDENTITY,
                "--certificate-oidc-issuer",
                OIDC_ISSUER,
                "--type",
                "slsaprovenance1",
            ),
            None,
            30,
        )
        if provenance_result.timed_out or provenance_result.returncode != 0:
            raise AdapterFailure("provenance_invalid")
        decode_and_validate_provenance(
            envelope.provenance_bundle,
            authorization,
        )
        return authorization


@contextlib.contextmanager
def _deployment_lock(
    paths: RuntimePaths,
    runtime_dir: Path,
) -> Iterator[None]:
    lock_path = runtime_dir / "deploy.lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError:
        raise AdapterFailure("state_invalid") from None
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != paths.expected_uid
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise AdapterFailure("state_invalid")
        try:
            fcntl.flock(
                descriptor,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
        except BlockingIOError:
            raise AdapterFailure("busy") from None
        yield
    finally:
        os.close(descriptor)


def _decode_ledger_event(value: object) -> LedgerEvent:
    event = _strict_object(
        value,
        _LEDGER_EVENT_FIELDS,
        "state_invalid",
    )
    strings = {
        key: _strict_string(event[key], "state_invalid") for key in _LEDGER_EVENT_FIELDS
    }
    if (
        strings["action"] not in {"deploy", "rollback"}
        or not _DECIMAL_ID.fullmatch(strings["releaseId"])
        or not _DECIMAL_ID.fullmatch(strings["workflowRunId"])
        or not _DECIMAL_ID.fullmatch(strings["workflowRunAttempt"])
        or not _COMMIT.fullmatch(strings["sourceCommit"])
        or not _IMAGE_DIGEST.fullmatch(strings["imageDigest"])
    ):
        raise AdapterFailure("state_invalid")
    published_at, published_instant = _parse_utc_timestamp(
        strings["publishedAt"],
        "state_invalid",
    )
    deployed_at, _ = _parse_utc_timestamp(
        strings["deployedAt"],
        "state_invalid",
    )
    _validate_tag(
        strings["action"],
        strings["releaseTag"],
        strings["imageDigest"],
        "state_invalid",
    )
    return LedgerEvent(
        action=strings["action"],
        release_id=strings["releaseId"],
        release_tag=strings["releaseTag"],
        source_commit=strings["sourceCommit"],
        published_at=published_at,
        published_instant=published_instant,
        image_digest=strings["imageDigest"],
        workflow_run_id=strings["workflowRunId"],
        workflow_run_attempt=strings["workflowRunAttempt"],
        deployed_at=deployed_at,
    )


def _load_ledger(
    paths: RuntimePaths,
    state_dir: Path,
) -> list[LedgerEvent]:
    ledger_path = state_dir / "ledger.json"
    try:
        ledger_path.lstat()
    except FileNotFoundError:
        return []
    except OSError:
        raise AdapterFailure("state_invalid") from None
    content = _read_regular_file(
        str(ledger_path),
        paths.expected_uid,
        MAX_LEDGER_BYTES,
        "state_invalid",
        private=True,
    )
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise AdapterFailure("state_invalid") from None
    value = _decode_json_text(text, "state_invalid")
    if type(value) is not list:
        raise AdapterFailure("state_invalid")
    events = [_decode_ledger_event(item) for item in value]
    release_ids: set[str] = set()
    for event in events:
        if event.release_id in release_ids:
            raise AdapterFailure("state_invalid")
        release_ids.add(event.release_id)
    return events


def _operation_exists(
    paths: RuntimePaths,
    state_dir: Path,
) -> bool:
    operation_path = state_dir / "operation.json"
    try:
        info = operation_path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        raise AdapterFailure("state_invalid") from None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != paths.expected_uid
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size > MAX_OPERATION_BYTES
    ):
        raise AdapterFailure("state_invalid")
    return True


def _atomic_write_json(
    path: Path,
    value: object,
    max_bytes: int,
    expected_uid: int,
) -> None:
    content = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(content) > max_bytes:
        raise AdapterFailure("state_invalid")
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise AdapterFailure("state_invalid")
    temporary = path.parent / (f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    try:
        _write_exclusive_file(temporary, content)
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except AdapterFailure:
        raise
    except OSError:
        raise AdapterFailure("state_invalid") from None
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _remove_operation(state_dir: Path) -> None:
    path = state_dir / "operation.json"
    try:
        path.unlink()
        _fsync_directory(path.parent)
    except OSError:
        raise AdapterFailure("state_invalid") from None


def _write_operation(
    paths: RuntimePaths,
    state_dir: Path,
    authorization: Authorization,
    previous_digest: str | None,
    started_at: str,
) -> None:
    path = state_dir / "operation.json"
    if path.exists() or path.is_symlink():
        raise AdapterFailure("recovery_required")
    operation = {
        "startedAt": started_at,
        "action": authorization.action,
        "releaseId": authorization.release_id,
        "sourceCommit": authorization.source_commit,
        "previousDigest": previous_digest,
        "targetDigest": authorization.image_digest,
        "workflowRunId": authorization.workflow_run_id,
    }
    _atomic_write_json(
        path,
        operation,
        MAX_OPERATION_BYTES,
        paths.expected_uid,
    )


def _command_prefix(paths: RuntimePaths) -> tuple[str, ...]:
    return (
        paths.k3s_path,
        "kubectl",
        "--kubeconfig",
        paths.kubeconfig_path,
        "--namespace",
        NAMESPACE,
    )


def _run_kubectl(
    paths: RuntimePaths,
    runner: Runner,
    arguments: tuple[str, ...],
    input_bytes: bytes | None = None,
    timeout_seconds: int = 30,
) -> ProcessResult:
    return runner(
        _command_prefix(paths) + arguments,
        input_bytes,
        timeout_seconds,
    )


def _decode_kubernetes_json(
    result: ProcessResult,
    failure_code: str,
) -> object:
    if (
        result.timed_out
        or result.returncode != 0
        or len(result.stdout) > MAX_CHILD_STDOUT_BYTES
    ):
        raise AdapterFailure(failure_code)
    try:
        text = result.stdout.decode("utf-8")
    except UnicodeDecodeError:
        raise AdapterFailure(failure_code) from None
    return _decode_json_text(text, failure_code)


def _read_deployment(
    paths: RuntimePaths,
    runner: Runner,
    failure_code: str,
) -> dict[str, object] | None:
    result = _run_kubectl(
        paths,
        runner,
        (
            "get",
            "deployment",
            DEPLOYMENT,
            "--output=json",
            "--ignore-not-found=true",
        ),
    )
    if (
        result.timed_out
        or result.returncode != 0
        or len(result.stdout) > MAX_CHILD_STDOUT_BYTES
    ):
        raise AdapterFailure(failure_code)
    if not result.stdout.strip():
        return None
    value = _decode_kubernetes_json(result, failure_code)
    if type(value) is not dict:
        raise AdapterFailure(failure_code)
    return value


def _deployment_digest(
    deployment: dict[str, object],
    failure_code: str,
) -> str:
    spec = _nested_object(deployment, "spec", failure_code)
    template = _nested_object(spec, "template", failure_code)
    template_spec = _nested_object(template, "spec", failure_code)
    containers = template_spec.get("containers")
    if type(containers) is not list or len(containers) != 1:
        raise AdapterFailure(failure_code)
    container = containers[0]
    if (
        type(container) is not dict
        or container.get("name") != CONTAINER
        or type(container.get("image")) is not str
    ):
        raise AdapterFailure(failure_code)
    prefix = f"{IMAGE_NAME}@"
    image = container["image"]
    if not image.startswith(prefix):
        raise AdapterFailure(failure_code)
    digest = image.removeprefix(prefix)
    if not _IMAGE_DIGEST.fullmatch(digest):
        raise AdapterFailure(failure_code)
    return digest


def _verify_ready_state(
    deployment: dict[str, object],
    expected_digest: str,
    paths: RuntimePaths,
    runner: Runner,
    mismatch_code: str,
    command_failure_code: str,
) -> None:
    if _deployment_digest(deployment, mismatch_code) != expected_digest:
        raise AdapterFailure(mismatch_code)
    metadata = _nested_object(deployment, "metadata", mismatch_code)
    spec = _nested_object(deployment, "spec", mismatch_code)
    status_value = _nested_object(deployment, "status", mismatch_code)
    generation = _strict_integer(metadata.get("generation"), mismatch_code)
    if (
        _strict_integer(
            status_value.get("observedGeneration"),
            mismatch_code,
        )
        != generation
        or _strict_integer(spec.get("replicas"), mismatch_code) != 1
        or _strict_integer(status_value.get("replicas"), mismatch_code) != 1
        or _strict_integer(
            status_value.get("readyReplicas"),
            mismatch_code,
        )
        != 1
        or _strict_integer(
            status_value.get("availableReplicas"),
            mismatch_code,
        )
        != 1
    ):
        raise AdapterFailure(mismatch_code)

    pods_result = _run_kubectl(
        paths,
        runner,
        (
            "get",
            "pods",
            "--selector",
            POD_SELECTOR,
            "--output=json",
        ),
    )
    if (
        pods_result.timed_out
        or pods_result.returncode != 0
        or len(pods_result.stdout) > MAX_CHILD_STDOUT_BYTES
    ):
        raise AdapterFailure(command_failure_code)
    pods = _decode_kubernetes_json(pods_result, mismatch_code)
    if type(pods) is not dict or type(pods.get("items")) is not list:
        raise AdapterFailure(mismatch_code)
    items = pods["items"]
    if len(items) != 1 or type(items[0]) is not dict:
        raise AdapterFailure(mismatch_code)
    pod_status = _nested_object(items[0], "status", mismatch_code)
    statuses = pod_status.get("containerStatuses")
    if type(statuses) is not list or len(statuses) != 1:
        raise AdapterFailure(mismatch_code)
    container_status = statuses[0]
    if type(container_status) is not dict:
        raise AdapterFailure(mismatch_code)
    if (
        container_status.get("name") != CONTAINER
        or container_status.get("ready") is not True
        or type(container_status.get("imageID")) is not str
    ):
        raise AdapterFailure(mismatch_code)
    image_id = container_status["imageID"]
    if not image_id.startswith("containerd://"):
        raise AdapterFailure(mismatch_code)
    match = _RUNTIME_IMAGE_DIGEST.fullmatch(image_id.removeprefix("containerd://"))
    if match is None or match.group(1) != expected_digest:
        raise AdapterFailure(mismatch_code)


def _read_template(paths: RuntimePaths) -> bytes:
    template = _read_regular_file(
        paths.template_path,
        paths.expected_uid,
        MAX_TEMPLATE_BYTES,
        "verification_failed",
        private=False,
    )
    marker = IMAGE_MARKER.encode()
    if template.count(marker) != 1:
        raise AdapterFailure("verification_failed")
    return template


def _render_template(template: bytes, digest: str) -> bytes:
    return template.replace(
        IMAGE_MARKER.encode(),
        f"{IMAGE_NAME}@{digest}".encode(),
    )


def _apply_digest(
    paths: RuntimePaths,
    runner: Runner,
    template: bytes,
    digest: str,
) -> None:
    manifest = _render_template(template, digest)
    apply_result = _run_kubectl(
        paths,
        runner,
        (
            "apply",
            "--server-side",
            "--field-manager=k8s-yaml-assistant-deployer",
            "--filename=-",
        ),
        input_bytes=manifest,
    )
    if apply_result.timed_out or apply_result.returncode != 0:
        raise AdapterFailure("verification_failed")
    rollout_result = _run_kubectl(
        paths,
        runner,
        (
            "rollout",
            "status",
            f"deployment/{DEPLOYMENT}",
            "--timeout=600s",
        ),
        timeout_seconds=600,
    )
    if rollout_result.timed_out or rollout_result.returncode != 0:
        raise AdapterFailure("verification_failed")
    deployment = _read_deployment(
        paths,
        runner,
        "verification_failed",
    )
    if deployment is None:
        raise AdapterFailure("verification_failed")
    _verify_ready_state(
        deployment,
        digest,
        paths,
        runner,
        "verification_failed",
        "verification_failed",
    )


def _delete_first_deployment(
    paths: RuntimePaths,
    runner: Runner,
) -> None:
    result = _run_kubectl(
        paths,
        runner,
        (
            "delete",
            "deployment",
            DEPLOYMENT,
            "--ignore-not-found=true",
            "--wait=true",
            "--timeout=30s",
        ),
    )
    if result.timed_out or result.returncode != 0:
        raise AdapterFailure("rollback_failed")
    if (
        _read_deployment(
            paths,
            runner,
            "rollback_failed",
        )
        is not None
    ):
        raise AdapterFailure("rollback_failed")


def _restore_previous(
    paths: RuntimePaths,
    runner: Runner,
    template: bytes,
    previous_digest: str | None,
) -> None:
    if previous_digest is None:
        _delete_first_deployment(paths, runner)
    else:
        try:
            _apply_digest(
                paths,
                runner,
                template,
                previous_digest,
            )
        except AdapterFailure:
            raise AdapterFailure("rollback_failed") from None


def _format_utc(instant: datetime.datetime) -> str:
    normalized = instant.astimezone(datetime.timezone.utc)
    return normalized.isoformat(timespec="seconds").replace("+00:00", "Z")


def _new_ledger_event(
    authorization: Authorization,
    deployed_at: str,
) -> LedgerEvent:
    return LedgerEvent(
        action=authorization.action,
        release_id=authorization.release_id,
        release_tag=authorization.release_tag,
        source_commit=authorization.source_commit,
        published_at=authorization.published_at,
        published_instant=authorization.published_instant,
        image_digest=authorization.image_digest,
        workflow_run_id=authorization.workflow_run_id,
        workflow_run_attempt=authorization.workflow_run_attempt,
        deployed_at=deployed_at,
    )


class DeploymentAdapter:
    def __init__(
        self,
        paths: RuntimePaths,
        runner: Runner,
        now: Callable[[], datetime.datetime],
    ):
        self.paths = paths
        self.runner = runner
        self.now = now
        self.authorization: Authorization | None = None
        self.previous_digest: str | None = None

    def execute(self, raw: bytes) -> str:
        envelope = decode_request(raw)
        runtime_dir = _secure_directory(
            self.paths.runtime_dir,
            self.paths.expected_uid,
            "internal_error",
        )
        self.authorization = _verify_proofs(
            envelope,
            self.paths,
            self.runner,
            runtime_dir,
        )
        with _deployment_lock(self.paths, runtime_dir):
            state_dir = _secure_directory(
                self.paths.state_dir,
                self.paths.expected_uid,
                "state_invalid",
            )
            if _operation_exists(self.paths, state_dir):
                raise AdapterFailure("recovery_required")
            events = _load_ledger(self.paths, state_dir)
            current = events[-1] if events else None
            self.previous_digest = current.image_digest if current is not None else None
            _validate_kubernetes_files(self.paths)
            deployment = _read_deployment(
                self.paths,
                self.runner,
                "verification_failed",
            )
            if current is None:
                if deployment is not None:
                    raise AdapterFailure("state_drift")
            else:
                if deployment is None:
                    raise AdapterFailure("state_drift")
                _verify_ready_state(
                    deployment,
                    current.image_digest,
                    self.paths,
                    self.runner,
                    "state_drift",
                    "verification_failed",
                )

            existing = next(
                (
                    event
                    for event in events
                    if event.release_id == self.authorization.release_id
                ),
                None,
            )
            if existing is not None:
                identity_matches = (
                    existing.action == self.authorization.action
                    and existing.image_digest == self.authorization.image_digest
                    and existing.source_commit == self.authorization.source_commit
                )
                if identity_matches and current is existing:
                    return "already_applied"
                raise AdapterFailure("replay_rejected")

            if self.authorization.action == "deploy":
                if (
                    current is not None
                    and self.authorization.published_instant
                    <= current.published_instant
                ):
                    raise AdapterFailure("replay_rejected")
            else:
                eligible = any(
                    event.image_digest == self.authorization.image_digest
                    and event.source_commit == self.authorization.source_commit
                    for event in events
                )
                if (
                    not eligible
                    or current is None
                    or current.image_digest == self.authorization.image_digest
                ):
                    raise AdapterFailure("rollback_not_accepted")

            template = _read_template(self.paths)
            started_at = _format_utc(self.now())
            _write_operation(
                self.paths,
                state_dir,
                self.authorization,
                self.previous_digest,
                started_at,
            )
            try:
                _apply_digest(
                    self.paths,
                    self.runner,
                    template,
                    self.authorization.image_digest,
                )
            except AdapterFailure:
                try:
                    _restore_previous(
                        self.paths,
                        self.runner,
                        template,
                        self.previous_digest,
                    )
                except AdapterFailure:
                    raise AdapterFailure("rollback_failed") from None
                _remove_operation(state_dir)
                raise AdapterFailure("apply_failed_rolled_back") from None

            event = _new_ledger_event(
                self.authorization,
                _format_utc(self.now()),
            )
            _atomic_write_json(
                state_dir / "ledger.json",
                [item.as_json() for item in events] + [event.as_json()],
                MAX_LEDGER_BYTES,
                self.paths.expected_uid,
            )
            _remove_operation(state_dir)
            return "success"


def _result(
    adapter: DeploymentAdapter,
    result: str,
    failure_code: str | None,
    duration_ms: int,
) -> dict[str, object]:
    authorization = adapter.authorization
    return {
        "event": "k8s_yaml_assistant_deployment",
        "action": authorization.action if authorization else None,
        "releaseId": authorization.release_id if authorization else None,
        "releaseTag": authorization.release_tag if authorization else None,
        "sourceCommit": (authorization.source_commit if authorization else None),
        "workflowRunId": (authorization.workflow_run_id if authorization else None),
        "workflowRunAttempt": (
            authorization.workflow_run_attempt if authorization else None
        ),
        "previousDigest": adapter.previous_digest,
        "targetDigest": (authorization.image_digest if authorization else None),
        "result": result,
        "failureCode": failure_code,
        "durationMs": max(0, duration_ms),
    }


def process_request(
    raw: bytes,
    paths: RuntimePaths = PRODUCTION_PATHS,
    runner: Runner = run_process,
    *,
    now: Callable[[], datetime.datetime] = lambda: datetime.datetime.now(
        datetime.timezone.utc
    ),
) -> tuple[int, dict[str, object]]:
    started = time.monotonic()
    adapter = DeploymentAdapter(paths, runner, now)
    try:
        result = adapter.execute(raw)
        return (
            0,
            _result(
                adapter,
                result,
                None,
                int((time.monotonic() - started) * 1000),
            ),
        )
    except AdapterFailure as failure:
        return (
            1,
            _result(
                adapter,
                "failure",
                failure.code,
                int((time.monotonic() - started) * 1000),
            ),
        )
    except Exception:
        return (
            1,
            _result(
                adapter,
                "failure",
                "internal_error",
                int((time.monotonic() - started) * 1000),
            ),
        )


def _write_result(stdout: TextIO, value: dict[str, object]) -> None:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    if len(serialized.encode("utf-8")) > MAX_RESULT_BYTES:
        serialized = (
            '{"event":"k8s_yaml_assistant_deployment",'
            '"result":"failure","failureCode":"internal_error"}'
        )
    try:
        syslog.syslog(syslog.LOG_INFO, serialized)
    except OSError:
        pass
    stdout.write(serialized + "\n")
    stdout.flush()


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: BinaryIO | None = None,
    stdout: TextIO | None = None,
    paths: RuntimePaths = PRODUCTION_PATHS,
    runner: Runner = run_process,
) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    output = sys.stdout if stdout is None else stdout
    if arguments:
        adapter = DeploymentAdapter(
            paths,
            runner,
            lambda: datetime.datetime.now(datetime.timezone.utc),
        )
        _write_result(
            output,
            _result(adapter, "failure", "invalid_request", 0),
        )
        return 1
    input_stream = sys.stdin.buffer if stdin is None else stdin
    try:
        raw = input_stream.read(MAX_REQUEST_BYTES + 1)
    except (OSError, ValueError):
        adapter = DeploymentAdapter(
            paths,
            runner,
            lambda: datetime.datetime.now(datetime.timezone.utc),
        )
        _write_result(
            output,
            _result(adapter, "failure", "internal_error", 0),
        )
        return 1
    if type(raw) is not bytes:
        raw = b""
    exit_code, result = process_request(
        raw,
        paths,
        runner,
    )
    _write_result(output, result)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
