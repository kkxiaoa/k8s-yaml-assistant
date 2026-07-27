import base64
import datetime
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

import k8s_yaml_assistant_deploy as deployer

IMAGE_NAME = "ghcr.io/kkxiaoa/k8s-yaml-assistant"
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
CONFIG_DIGEST = "sha256:" + "c" * 64
COMMIT_A = "1" * 40
COMMIT_B = "2" * 40
NOW = datetime.datetime(2026, 7, 27, 8, 0, tzinfo=datetime.timezone.utc)


def strict_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonical_authorization(value: dict[str, object]) -> str:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )


def provenance_statement(
    *,
    digest: str = DIGEST_A,
    source_commit: str = COMMIT_A,
    image_name: str = IMAGE_NAME,
    build_type: str = deployer.BUILDKIT_SLSA_V1_BUILD_TYPE,
    target: str = "runtime",
    vcs_source: str = "https://github.com/kkxiaoa/k8s-yaml-assistant",
) -> dict[str, object]:
    return {
        "_type": "https://in-toto.io/Statement/v0.1",
        "subject": [
            {
                "name": image_name,
                "digest": {"sha256": digest.removeprefix("sha256:")},
            }
        ],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": build_type,
                "externalParameters": {
                    "configSource": {"path": "Dockerfile"},
                    "request": {
                        "args": {"target": target},
                        "root": {
                            "configSource": {
                                "path": "Dockerfile",
                            },
                            "request": {
                                "args": {
                                    "vcs:source": vcs_source,
                                    "vcs:revision": source_commit,
                                }
                            }
                        },
                    },
                },
            }
        },
    }


def provenance_bundle(statement: dict[str, object] | None = None) -> str:
    payload = strict_json(statement or provenance_statement()).encode()
    return strict_json(
        {
            "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
            "verificationMaterial": {},
            "dsseEnvelope": {
                "payloadType": "application/vnd.in-toto+json",
                "payload": base64.b64encode(payload).decode(),
                "signatures": [],
            },
        }
    )


def authorization(
    *,
    action: str = "deploy",
    release_id: str = "101",
    release_tag: str = "v0.1.0",
    source_commit: str = COMMIT_A,
    published_at: str = "2026-07-27T07:00:00Z",
    image_digest: str = DIGEST_A,
    provenance: str | None = None,
    workflow_run_id: str = "201",
    workflow_run_attempt: str = "1",
) -> dict[str, object]:
    raw_provenance = provenance or provenance_bundle(
        provenance_statement(
            digest=image_digest,
            source_commit=source_commit,
        )
    )
    if action == "rollback" and release_tag == "v0.1.0":
        release_tag = (
            "rollback-v0.1.0-sha256-"
            f"{image_digest.removeprefix('sha256:')}-r{workflow_run_id}"
        )
    return {
        "schemaVersion": 1,
        "action": action,
        "repository": "kkxiaoa/k8s-yaml-assistant",
        "releaseId": release_id,
        "releaseTag": release_tag,
        "sourceCommit": source_commit,
        "publishedAt": published_at,
        "imageName": IMAGE_NAME,
        "imageDigest": image_digest,
        "provenanceBundleSha256": hashlib.sha256(raw_provenance.encode()).hexdigest(),
        "workflowRunId": workflow_run_id,
        "workflowRunAttempt": workflow_run_attempt,
    }


def request_bytes(
    *,
    authorization_value: dict[str, object] | None = None,
    authorization_text: str | None = None,
    authorization_bundle: str = '{"signed":true}',
    provenance: str | None = None,
) -> bytes:
    raw_provenance = provenance or provenance_bundle()
    auth_text = authorization_text or canonical_authorization(
        authorization_value or authorization(provenance=raw_provenance)
    )
    return strict_json(
        {
            "schemaVersion": 1,
            "authorization": auth_text,
            "authorizationBundle": authorization_bundle,
            "provenanceBundle": raw_provenance,
        }
    ).encode()


def deployment_json(
    digest: str,
    *,
    observed_generation: int = 1,
    replicas: int = 1,
    ready_replicas: int = 1,
    available_replicas: int = 1,
) -> bytes:
    return strict_json(
        {
            "metadata": {"generation": 1},
            "spec": {
                "replicas": 1,
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "app",
                                "image": f"{IMAGE_NAME}@{digest}",
                            }
                        ]
                    }
                },
            },
            "status": {
                "observedGeneration": observed_generation,
                "replicas": replicas,
                "readyReplicas": ready_replicas,
                "availableReplicas": available_replicas,
            },
        }
    ).encode()


def pods_json(
    digest: str,
    *,
    ready: bool = True,
    image_id: str | None = None,
    image: str | None = None,
    count: int = 1,
) -> bytes:
    item = {
        "spec": {
            "containers": [
                {
                    "name": "app",
                    "image": image or f"{IMAGE_NAME}@{digest}",
                }
            ]
        },
        "status": {
            "containerStatuses": [
                {
                    "name": "app",
                    "ready": ready,
                    "imageID": image_id or f"containerd://{digest}",
                }
            ]
        }
    }
    return strict_json({"items": [item for _ in range(count)]}).encode()


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], bytes | None, int]] = []
        self.digest: str | None = None
        self.fail_authorization = False
        self.fail_provenance = False
        self.fail_apply = False
        self.fail_rollout_digests: set[str] = set()
        self.fail_delete = False
        self.timeout_authorization = False
        self.timeout_provenance = False
        self.timeout_get_deployment = False
        self.timeout_apply_digests: set[str] = set()
        self.timeout_rollout_digests: set[str] = set()
        self.timeout_delete = False
        self.deployment_overrides: dict[str, int] = {}
        self.pod_ready = True
        self.pod_count = 1
        self.image_id_override: str | None = None
        self.pod_image_override: str | None = None
        self.observed_verification_files: dict[str, bytes] = {}

    def __call__(
        self,
        argv: tuple[str, ...],
        input_bytes: bytes | None,
        timeout_seconds: int,
    ) -> deployer.ProcessResult:
        self.calls.append((argv, input_bytes, timeout_seconds))
        if argv[0].endswith("cosign"):
            bundle_path = argv[argv.index("--bundle") + 1]
            self.observed_verification_files[
                "provenance"
                if "verify-blob-attestation" in argv
                else "authorizationBundle"
            ] = Path(bundle_path).read_bytes()
            if "verify-blob-attestation" in argv:
                return deployer.ProcessResult(
                    1 if self.fail_provenance else 0,
                    b"",
                    self.timeout_provenance,
                )
            self.observed_verification_files["authorization"] = Path(
                argv[-1]
            ).read_bytes()
            return deployer.ProcessResult(
                1 if self.fail_authorization else 0,
                b"",
                self.timeout_authorization,
            )

        if "get" in argv and "deployment" in argv:
            if self.timeout_get_deployment:
                return deployer.ProcessResult(-9, b"", True)
            if self.digest is None:
                return deployer.ProcessResult(0, b"", False)
            return deployer.ProcessResult(
                0,
                deployment_json(
                    self.digest,
                    **self.deployment_overrides,
                ),
                False,
            )

        if "apply" in argv:
            assert input_bytes is not None
            match = re.search(
                rb"ghcr\.io/kkxiaoa/k8s-yaml-assistant@"
                rb"(sha256:[a-f0-9]{64})",
                input_bytes,
            )
            assert match is not None
            self.digest = match.group(1).decode()
            if self.digest in self.timeout_apply_digests:
                return deployer.ProcessResult(-9, b"", True)
            return deployer.ProcessResult(
                1 if self.fail_apply else 0,
                b"",
                False,
            )

        if "rollout" in argv:
            if self.digest in self.timeout_rollout_digests:
                return deployer.ProcessResult(-9, b"", True)
            return deployer.ProcessResult(
                1 if self.digest in self.fail_rollout_digests else 0,
                b"",
                False,
            )

        if "pods" in argv:
            assert self.digest is not None
            return deployer.ProcessResult(
                0,
                pods_json(
                    self.digest,
                    ready=self.pod_ready,
                    image_id=self.image_id_override,
                    image=self.pod_image_override,
                    count=self.pod_count,
                ),
                False,
            )

        if "delete" in argv:
            if self.timeout_delete:
                return deployer.ProcessResult(-9, b"", True)
            if not self.fail_delete:
                self.digest = None
            return deployer.ProcessResult(
                1 if self.fail_delete else 0,
                b"",
                False,
            )

        raise AssertionError(f"unexpected command: {argv!r}")

    def kubernetes_writes(self) -> list[tuple[str, ...]]:
        return [
            argv for argv, _, _ in self.calls if "apply" in argv or "delete" in argv
        ]


class AdapterFixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state_dir = self.root / "state"
        self.runtime_dir = self.root / "runtime"
        self.state_dir.mkdir(mode=0o700)
        self.runtime_dir.mkdir(mode=0o700)
        self.template = self.root / "deployment-template.yaml"
        self.template.write_text(
            "apiVersion: apps/v1\n"
            "kind: Deployment\n"
            "metadata:\n"
            "  name: k8s-yaml-assistant\n"
            "  namespace: k8s-yaml-assistant-prod\n"
            "spec:\n"
            "  template:\n"
            "    spec:\n"
            "      containers:\n"
            "        - name: app\n"
            "          image: __K8S_YAML_ASSISTANT_IMAGE__\n"
        )
        self.trusted_root = self.root / "trusted-root.json"
        self.trusted_root.write_text("{}")
        self.kubeconfig = self.root / "k3s.yaml"
        self.kubeconfig.write_text("apiVersion: v1\n")
        self.cosign = self.root / "cosign"
        self.k3s = self.root / "k3s"
        self.cosign.write_text("#!/bin/sh\nexit 0\n")
        self.k3s.write_text("#!/bin/sh\nexit 0\n")
        os.chmod(self.template, 0o644)
        os.chmod(self.trusted_root, 0o644)
        os.chmod(self.kubeconfig, 0o600)
        os.chmod(self.cosign, 0o755)
        os.chmod(self.k3s, 0o755)
        self.paths = deployer.RuntimePaths(
            cosign_path=str(self.cosign),
            k3s_path=str(self.k3s),
            kubeconfig_path=str(self.kubeconfig),
            template_path=str(self.template),
            trusted_root_path=str(self.trusted_root),
            state_dir=str(self.state_dir),
            runtime_dir=str(self.runtime_dir),
            expected_uid=os.getuid(),
        )
        self.runner = FakeRunner()

    def close(self) -> None:
        self.temporary.cleanup()

    def run(
        self,
        raw: bytes | None = None,
        runner: FakeRunner | None = None,
    ) -> tuple[int, dict[str, object]]:
        return deployer.process_request(
            raw if raw is not None else request_bytes(),
            self.paths,
            runner or self.runner,
            now=lambda: NOW,
        )

    def write_ledger(self, events: list[dict[str, str]]) -> None:
        path = self.state_dir / "ledger.json"
        path.write_text(strict_json(events))
        os.chmod(path, 0o600)

    def read_ledger(self) -> list[dict[str, str]]:
        return json.loads((self.state_dir / "ledger.json").read_text())


def ledger_event(
    *,
    action: str = "deploy",
    release_id: str = "100",
    release_tag: str = "v0.0.9",
    source_commit: str = COMMIT_B,
    published_at: str = "2026-07-26T07:00:00Z",
    image_digest: str = DIGEST_B,
) -> dict[str, str]:
    return {
        "action": action,
        "releaseId": release_id,
        "releaseTag": release_tag,
        "sourceCommit": source_commit,
        "publishedAt": published_at,
        "imageDigest": image_digest,
        "workflowRunId": "200",
        "workflowRunAttempt": "1",
        "deployedAt": "2026-07-26T08:00:00Z",
    }


class FixtureTestCase(unittest.TestCase):
    fixture: AdapterFixture

    def setUp(self) -> None:
        self.fixture = AdapterFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def assert_failure(
        self,
        raw: bytes,
        failure_code: str,
    ) -> dict[str, object]:
        exit_code, result = self.fixture.run(raw)
        self.assertNotEqual(exit_code, 0)
        self.assertEqual(result["failureCode"], failure_code)
        return result


class StrictInputTests(FixtureTestCase):
    def test_empty_input_is_rejected(self) -> None:
        self.assert_failure(b"", "invalid_request")

    def test_invalid_utf8_is_rejected(self) -> None:
        self.assert_failure(b"\xff", "invalid_request")

    def test_input_over_64_kib_is_rejected(self) -> None:
        self.assert_failure(b"x" * 65_537, "request_too_large")

    def test_non_object_input_is_rejected(self) -> None:
        self.assert_failure(b"[]", "invalid_request")

    def test_duplicate_outer_key_is_rejected(self) -> None:
        raw = (
            b'{"schemaVersion":1,"schemaVersion":1,'
            b'"authorization":"","authorizationBundle":"",'
            b'"provenanceBundle":""}'
        )
        self.assert_failure(raw, "invalid_request")

    def test_unknown_outer_field_is_rejected(self) -> None:
        value = json.loads(request_bytes())
        value["manifest"] = "attacker-controlled"
        self.assert_failure(strict_json(value).encode(), "invalid_request")

    def test_wrong_outer_schema_version_is_rejected(self) -> None:
        value = json.loads(request_bytes())
        value["schemaVersion"] = 2
        self.assert_failure(strict_json(value).encode(), "invalid_request")

    def test_bundles_must_be_raw_strings(self) -> None:
        value = json.loads(request_bytes())
        value["provenanceBundle"] = {"mediaType": "rewritten"}
        self.assert_failure(strict_json(value).encode(), "invalid_request")

    def test_raw_provenance_bytes_drive_authorized_hash(self) -> None:
        raw_provenance = '{ "dsseEnvelope" : {} }'
        auth = authorization(provenance=raw_provenance)
        rewritten = strict_json(json.loads(raw_provenance))
        raw = request_bytes(
            authorization_value=auth,
            provenance=rewritten,
        )
        self.assert_failure(raw, "identity_mismatch")

    def test_duplicate_authorization_key_is_rejected_after_signature(self) -> None:
        text = canonical_authorization(authorization())
        text = text.replace(
            '"schemaVersion":1',
            '"schemaVersion":1,"schemaVersion":1',
            1,
        )
        self.assert_failure(
            request_bytes(authorization_text=text),
            "authorization_invalid",
        )

    def test_unknown_authorization_field_is_rejected(self) -> None:
        value = authorization()
        value["kubectlArgs"] = ["delete", "namespace", "default"]
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_authorization_requires_fixed_order_and_one_final_newline(
        self,
    ) -> None:
        value = authorization()
        reordered = {
            "action": value["action"],
            "schemaVersion": value["schemaVersion"],
            **{
                key: field_value
                for key, field_value in value.items()
                if key not in {"action", "schemaVersion"}
            },
        }
        self.assert_failure(
            request_bytes(authorization_text=canonical_authorization(reordered)),
            "authorization_invalid",
        )
        self.assert_failure(
            request_bytes(
                authorization_text=canonical_authorization(value).rstrip("\n")
            ),
            "authorization_invalid",
        )
        self.assert_failure(
            request_bytes(authorization_text=canonical_authorization(value) + "\n"),
            "authorization_invalid",
        )

    def test_decimal_identifiers_reject_leading_zero(self) -> None:
        value = authorization()
        value["releaseId"] = "0101"
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_invalid_timestamp_is_rejected(self) -> None:
        value = authorization(published_at="2026-02-30T00:00:00Z")
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_invalid_commit_is_rejected(self) -> None:
        value = authorization(source_commit="main")
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_wrong_repository_and_image_are_rejected(self) -> None:
        value = authorization()
        value["repository"] = "attacker/repository"
        value["imageName"] = "ghcr.io/attacker/image"
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_action_and_digest_are_strict(self) -> None:
        value = authorization()
        value["action"] = "delete"
        value["imageDigest"] = f"{DIGEST_A};id"
        self.assert_failure(
            request_bytes(authorization_value=value),
            "authorization_invalid",
        )

    def test_deploy_and_rollback_tags_cannot_be_swapped(self) -> None:
        deploy = authorization(
            release_tag=(
                f"rollback-v0.1.0-sha256-{DIGEST_A.removeprefix('sha256:')}-r201"
            )
        )
        self.assert_failure(
            request_bytes(authorization_value=deploy),
            "authorization_invalid",
        )
        rollback = authorization(action="rollback", release_tag="v0.1.0")
        rollback["releaseTag"] = "v0.1.0"
        self.assert_failure(
            request_bytes(authorization_value=rollback),
            "authorization_invalid",
        )

    def test_main_rejects_every_cli_argument_without_reading_input(self) -> None:
        stdin = io.BytesIO(b"secret-that-must-not-be-read")
        stdout = io.StringIO()
        with mock.patch.object(deployer.syslog, "syslog"):
            exit_code = deployer.main(
                ["--template", "/tmp/attacker.yaml"],
                stdin=stdin,
                stdout=stdout,
                paths=self.fixture.paths,
                runner=self.fixture.runner,
            )
        self.assertNotEqual(exit_code, 0)
        self.assertEqual(stdin.tell(), 0)
        self.assertNotIn("secret-that-must-not-be-read", stdout.getvalue())

    def test_result_never_contains_request_or_child_error_text(self) -> None:
        secret = "apiVersion: v1\nkind: Secret\npassword: do-not-log"
        raw = request_bytes(authorization_bundle=secret)
        self.fixture.runner.fail_authorization = True
        result = self.assert_failure(raw, "authorization_invalid")
        serialized = strict_json(result)
        self.assertNotIn(secret, serialized)
        self.assertLessEqual(len(serialized.encode()), deployer.MAX_RESULT_BYTES)

    def test_stdout_and_system_log_share_one_bounded_safe_summary(self) -> None:
        secret = "kind: Secret\nstringData:\n  token: never-log"
        stdin = io.BytesIO(request_bytes(authorization_bundle=secret))
        stdout = io.StringIO()
        self.fixture.runner.fail_authorization = True
        with mock.patch.object(deployer.syslog, "syslog") as audit:
            exit_code = deployer.main(
                [],
                stdin=stdin,
                stdout=stdout,
                paths=self.fixture.paths,
                runner=self.fixture.runner,
            )
        self.assertNotEqual(exit_code, 0)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertNotIn(secret, lines[0])
        self.assertEqual(audit.call_count, 1)
        self.assertEqual(audit.call_args.args[1], lines[0])


class ProofAndCommandTests(FixtureTestCase):
    def test_authorization_signature_failure_stops_before_kubernetes(self) -> None:
        self.fixture.runner.fail_authorization = True
        self.assert_failure(request_bytes(), "authorization_invalid")
        self.assertEqual(self.fixture.runner.kubernetes_writes(), [])

    def test_provenance_signature_failure_stops_before_kubernetes(self) -> None:
        self.fixture.runner.fail_provenance = True
        self.assert_failure(request_bytes(), "provenance_invalid")
        self.assertEqual(self.fixture.runner.kubernetes_writes(), [])

    def test_all_signed_files_preserve_the_recovered_utf8_bytes(self) -> None:
        raw_provenance = (
            json.dumps(
                json.loads(provenance_bundle()),
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        raw_authorization_bundle = '{ "bundle" : "preserve me" }\n'
        auth = authorization(provenance=raw_provenance)
        auth_text = canonical_authorization(auth)
        exit_code, _ = self.fixture.run(
            request_bytes(
                authorization_text=auth_text,
                authorization_bundle=raw_authorization_bundle,
                provenance=raw_provenance,
            )
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self.fixture.runner.observed_verification_files,
            {
                "authorization": auth_text.encode(),
                "authorizationBundle": raw_authorization_bundle.encode(),
                "provenance": raw_provenance.encode(),
            },
        )

    def test_provenance_subject_digest_and_source_are_bound(self) -> None:
        mutations = [
            provenance_statement(image_name="ghcr.io/attacker/image"),
            provenance_statement(digest=DIGEST_B),
            provenance_statement(source_commit=COMMIT_B),
        ]
        for statement in mutations:
            with self.subTest(statement=statement):
                raw_provenance = provenance_bundle(statement)
                raw = request_bytes(
                    authorization_value=authorization(provenance=raw_provenance),
                    provenance=raw_provenance,
                )
                self.assert_failure(raw, "identity_mismatch")

    def test_provenance_contract_rejects_wrong_type_target_or_source(self) -> None:
        mutations = [
            provenance_statement(build_type="https://example.invalid/build"),
            provenance_statement(target="index-artifact"),
            provenance_statement(vcs_source="https://example.invalid/repo"),
        ]
        for statement in mutations:
            with self.subTest(statement=statement):
                raw_provenance = provenance_bundle(statement)
                raw = request_bytes(
                    authorization_value=authorization(provenance=raw_provenance),
                    provenance=raw_provenance,
                )
                expected = (
                    "identity_mismatch"
                    if statement is mutations[-1]
                    else "provenance_invalid"
                )
                self.assert_failure(raw, expected)

    def test_cosign_commands_pin_paths_identities_root_and_offline_mode(
        self,
    ) -> None:
        exit_code, _ = self.fixture.run()
        self.assertEqual(exit_code, 0)
        cosign_calls = [
            call
            for call in self.fixture.runner.calls
            if call[0][0] == str(self.fixture.cosign)
        ]
        self.assertEqual(len(cosign_calls), 2)
        authorization_call = cosign_calls[0][0]
        provenance_call = cosign_calls[1][0]
        self.assertIn("--offline", authorization_call)
        self.assertIn("--trusted-root", authorization_call)
        self.assertIn(
            deployer.AUTHORIZATION_CERTIFICATE_IDENTITY,
            authorization_call,
        )
        self.assertIn("--certificate-github-workflow-trigger", authorization_call)
        self.assertIn("release", authorization_call)
        self.assertIn("verify-blob-attestation", provenance_call)
        self.assertIn(
            deployer.PROVENANCE_CERTIFICATE_IDENTITY,
            provenance_call,
        )
        self.assertIn(DIGEST_A.removeprefix("sha256:"), provenance_call)

    def test_environment_cannot_override_fixed_paths_or_identity(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "KUBECONFIG": "/tmp/attacker",
                "NAMESPACE": "default",
                "COSIGN_EXPERIMENTAL": "attacker",
            },
        ):
            exit_code, _ = self.fixture.run()
        self.assertEqual(exit_code, 0)
        flattened = "\n".join(
            " ".join(argv) for argv, _, _ in self.fixture.runner.calls
        )
        self.assertNotIn("/tmp/attacker", flattened)
        self.assertNotIn(" default", flattened)

    def test_subprocess_runner_uses_fixed_environment_and_no_shell(self) -> None:
        executable = self.fixture.root / "inspect-process"
        executable.write_text(
            f"#!{os.path.realpath(sys.executable)}\n"
            "import json, os, sys\n"
            "print(json.dumps({'argv': sys.argv[1:],"
            " 'cwd': os.getcwd(), 'env': sorted(os.environ)}))\n"
        )
        os.chmod(executable, 0o755)
        command = (
            str(executable),
            "literal;printf attacker",
            "$(id)",
        )
        result = deployer.run_process(command, None, 5)
        self.assertEqual(result.returncode, 0)
        observed = json.loads(result.stdout)
        self.assertEqual(observed["argv"], list(command[1:]))
        self.assertEqual(observed["cwd"], "/")
        self.assertTrue(set(deployer.CHILD_ENVIRONMENT).issubset(observed["env"]))
        self.assertNotIn("HOME", observed["env"])
        self.assertNotIn("PYTHONPATH", observed["env"])

    def test_subprocess_timeout_kills_the_process_group(self) -> None:
        child_pid_path = self.fixture.root / "child.pid"
        executable = self.fixture.root / "hang"
        executable.write_text(
            f"#!{os.path.realpath(sys.executable)}\n"
            "import pathlib, subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"pathlib.Path({str(child_pid_path)!r}).write_text(str(child.pid))\n"
            "time.sleep(60)\n"
        )
        os.chmod(executable, 0o755)
        result = deployer.run_process((str(executable),), None, 1)
        self.assertTrue(result.timed_out)
        self.assertNotEqual(result.returncode, 0)
        child_pid = int(child_pid_path.read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        else:
            self.fail("timed out child process remained alive")

    def test_real_fake_executables_cover_the_complete_process_boundary(
        self,
    ) -> None:
        cluster_state = self.fixture.root / "cluster-digest"
        python = os.path.realpath(sys.executable)
        self.fixture.cosign.write_text(
            f"#!{python}\n"
            + textwrap.dedent(
                f"""
                import pathlib
                import sys

                args = sys.argv[1:]
                if not args or "--offline" not in args:
                    raise SystemExit(10)
                if "--trusted-root" not in args:
                    raise SystemExit(11)
                if {str(self.fixture.trusted_root)!r} not in args:
                    raise SystemExit(12)
                if args[0] == "verify-blob":
                    required = {{
                        {deployer.AUTHORIZATION_CERTIFICATE_IDENTITY!r},
                        {deployer.OIDC_ISSUER!r},
                        "release",
                    }}
                    if not required.issubset(args):
                        raise SystemExit(13)
                    if not pathlib.Path(args[-1]).is_file():
                        raise SystemExit(14)
                elif args[0] == "verify-blob-attestation":
                    required = {{
                        {deployer.PROVENANCE_CERTIFICATE_IDENTITY!r},
                        {deployer.OIDC_ISSUER!r},
                        {DIGEST_A.removeprefix("sha256:")!r},
                        "slsaprovenance1",
                    }}
                    if not required.issubset(args):
                        raise SystemExit(15)
                else:
                    raise SystemExit(16)
                """
            )
        )
        self.fixture.k3s.write_text(
            f"#!{python}\n"
            + textwrap.dedent(
                f"""
                import json
                import pathlib
                import re
                import sys

                state = pathlib.Path({str(cluster_state)!r})
                prefix = [
                    "kubectl",
                    "--kubeconfig",
                    {str(self.fixture.kubeconfig)!r},
                    "--namespace",
                    {deployer.NAMESPACE!r},
                ]
                if sys.argv[1:6] != prefix:
                    raise SystemExit(20)
                args = sys.argv[6:]
                digest = state.read_text() if state.exists() else None
                if args == [
                    "get", "deployment", {deployer.DEPLOYMENT!r},
                    "--output=json", "--ignore-not-found=true",
                ]:
                    if digest is not None:
                        print(json.dumps({{
                            "metadata": {{"generation": 1}},
                            "spec": {{
                                "replicas": 1,
                                "template": {{"spec": {{"containers": [{{
                                    "name": {deployer.CONTAINER!r},
                                    "image": {deployer.IMAGE_NAME!r} + "@" + digest,
                                    "resources": {{}},
                                }}]}}}},
                            }},
                            "status": {{
                                "observedGeneration": 1,
                                "replicas": 1,
                                "readyReplicas": 1,
                                "availableReplicas": 1,
                            }},
                        }}))
                elif args == [
                    "apply", "--server-side",
                    "--field-manager=k8s-yaml-assistant-deployer",
                    "--filename=-",
                ]:
                    manifest = sys.stdin.buffer.read()
                    match = re.search(rb"sha256:[a-f0-9]{{64}}", manifest)
                    if match is None:
                        raise SystemExit(21)
                    state.write_text(match.group(0).decode())
                elif args == [
                    "rollout", "status",
                    "deployment/" + {deployer.DEPLOYMENT!r},
                    "--timeout=600s",
                ]:
                    if digest is None:
                        raise SystemExit(22)
                elif args == [
                    "get", "pods", "--selector",
                    {deployer.POD_SELECTOR!r}, "--output=json",
                ]:
                    if digest is None:
                        raise SystemExit(23)
                    print(json.dumps({{"items": [{{
                        "spec": {{"containers": [{{
                            "name": {deployer.CONTAINER!r},
                            "image": {deployer.IMAGE_NAME!r} + "@" + digest,
                        }}]}},
                        "status": {{"containerStatuses": [{{
                            "name": {deployer.CONTAINER!r},
                            "ready": True,
                            "imageID": "containerd://" + {CONFIG_DIGEST!r},
                        }}]}},
                    }}]}}))
                elif args == [
                    "delete", "deployment", {deployer.DEPLOYMENT!r},
                    "--ignore-not-found=true", "--wait=true",
                    "--timeout=30s",
                ]:
                    state.unlink(missing_ok=True)
                else:
                    raise SystemExit(24)
                """
            )
        )
        os.chmod(self.fixture.cosign, 0o755)
        os.chmod(self.fixture.k3s, 0o755)

        exit_code, result = deployer.process_request(
            request_bytes(),
            self.fixture.paths,
            deployer.run_process,
            now=lambda: NOW,
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["targetDigest"], DIGEST_A)
        self.assertEqual(cluster_state.read_text(), DIGEST_A)
        self.assertEqual(
            sorted(path.name for path in self.fixture.runtime_dir.iterdir()),
            ["deploy.lock"],
        )


class StateAndConcurrencyTests(FixtureTestCase):
    def test_ledger_corruption_size_symlink_and_mode_are_rejected(self) -> None:
        ledger = self.fixture.state_dir / "ledger.json"
        cases = ("corrupt", "oversized", "symlink", "mode")
        for case in cases:
            with self.subTest(case=case):
                if ledger.exists() or ledger.is_symlink():
                    ledger.unlink()
                if case == "corrupt":
                    ledger.write_text("{")
                    os.chmod(ledger, 0o600)
                elif case == "oversized":
                    ledger.write_bytes(b" " * (deployer.MAX_LEDGER_BYTES + 1))
                    os.chmod(ledger, 0o600)
                elif case == "symlink":
                    target = self.fixture.root / "other-ledger"
                    target.write_text("[]")
                    ledger.symlink_to(target)
                else:
                    ledger.write_text("[]")
                    os.chmod(ledger, 0o644)
                self.assert_failure(request_bytes(), "state_invalid")

    def test_state_file_owner_is_checked_at_the_read_boundary(self) -> None:
        ledger = self.fixture.state_dir / "ledger.json"
        ledger.write_text("[]")
        os.chmod(ledger, 0o600)
        real_fstat = deployer.os.fstat

        def wrong_owner(descriptor: int) -> os.stat_result:
            observed = list(real_fstat(descriptor))
            observed[4] = os.getuid() + 1
            return os.stat_result(observed)

        with (
            mock.patch.object(
                deployer.os,
                "fstat",
                side_effect=wrong_owner,
            ),
            self.assertRaises(deployer.AdapterFailure) as caught,
        ):
            deployer._read_regular_file(
                str(ledger),
                os.getuid(),
                deployer.MAX_LEDGER_BYTES,
                "state_invalid",
                private=True,
            )
        self.assertEqual(caught.exception.code, "state_invalid")

    def test_operation_marker_always_requires_recovery(self) -> None:
        operation = self.fixture.state_dir / "operation.json"
        operation.write_text("{not-json")
        os.chmod(operation, 0o600)
        self.assert_failure(request_bytes(), "recovery_required")

    def test_held_lock_is_busy_but_stale_lock_file_is_not(self) -> None:
        lock_path = self.fixture.runtime_dir / "deploy.lock"
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_failure(request_bytes(), "busy")
        finally:
            os.close(lock_fd)
        exit_code, _ = self.fixture.run()
        self.assertEqual(exit_code, 0)

    def test_cluster_and_ledger_digest_mismatch_is_state_drift(self) -> None:
        self.fixture.write_ledger([ledger_event()])
        self.fixture.runner.digest = DIGEST_A
        self.assert_failure(request_bytes(), "state_drift")

    def test_idempotent_rerun_does_not_write_or_append(self) -> None:
        event = ledger_event(
            release_id="101",
            release_tag="v0.1.0",
            source_commit=COMMIT_A,
            published_at="2026-07-27T07:00:00Z",
            image_digest=DIGEST_A,
        )
        self.fixture.write_ledger([event])
        self.fixture.runner.digest = DIGEST_A
        raw = request_bytes(
            authorization_value=authorization(
                workflow_run_id="999",
                workflow_run_attempt="7",
            )
        )
        exit_code, result = self.fixture.run(raw)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["result"], "already_applied")
        self.assertEqual(self.fixture.runner.kubernetes_writes(), [])
        self.assertEqual(self.fixture.read_ledger(), [event])

    def test_same_release_id_with_different_identity_is_rejected(self) -> None:
        self.fixture.write_ledger(
            [
                ledger_event(
                    release_id="101",
                    source_commit=COMMIT_B,
                    image_digest=DIGEST_B,
                )
            ]
        )
        self.fixture.runner.digest = DIGEST_B
        self.assert_failure(request_bytes(), "replay_rejected")

    def test_older_deploy_authorization_is_rejected(self) -> None:
        self.fixture.write_ledger(
            [
                ledger_event(
                    published_at="2026-07-27T07:30:00Z",
                    image_digest=DIGEST_B,
                )
            ]
        )
        self.fixture.runner.digest = DIGEST_B
        self.assert_failure(request_bytes(), "replay_rejected")

    def test_rollback_requires_historical_noncurrent_digest(self) -> None:
        self.fixture.write_ledger([ledger_event(image_digest=DIGEST_B)])
        self.fixture.runner.digest = DIGEST_B
        unknown = request_bytes(
            authorization_value=authorization(
                action="rollback",
                image_digest=DIGEST_A,
            ),
            provenance=provenance_bundle(),
        )
        self.assert_failure(unknown, "rollback_not_accepted")

        provenance = provenance_bundle(provenance_statement(digest=DIGEST_B))
        current = request_bytes(
            authorization_value=authorization(
                action="rollback",
                image_digest=DIGEST_B,
                provenance=provenance,
            ),
            provenance=provenance,
        )
        self.assert_failure(current, "rollback_not_accepted")


class KubernetesStateMachineTests(FixtureTestCase):
    def test_template_requires_exactly_one_image_marker(self) -> None:
        for body in (
            "apiVersion: apps/v1\n",
            "__K8S_YAML_ASSISTANT_IMAGE__\n__K8S_YAML_ASSISTANT_IMAGE__\n",
        ):
            with self.subTest(body=body):
                self.fixture.template.write_text(body)
                os.chmod(self.fixture.template, 0o644)
                self.assert_failure(request_bytes(), "verification_failed")
                self.assertEqual(
                    self.fixture.runner.kubernetes_writes(),
                    [],
                )

    def test_apply_is_server_side_without_force_conflicts(self) -> None:
        exit_code, _ = self.fixture.run()
        self.assertEqual(exit_code, 0)
        apply_call = next(
            argv for argv, _, _ in self.fixture.runner.calls if "apply" in argv
        )
        self.assertIn("--server-side", apply_call)
        self.assertIn("--field-manager=k8s-yaml-assistant-deployer", apply_call)
        self.assertNotIn("--force-conflicts", apply_call)
        self.assertIn("--namespace", apply_call)
        self.assertIn("k8s-yaml-assistant-prod", apply_call)

    def test_nonzero_apply_is_treated_as_a_conflict_and_restored(self) -> None:
        self.fixture.runner.fail_apply = True
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        self.assertIsNone(self.fixture.runner.digest)
        self.assertFalse((self.fixture.state_dir / "operation.json").exists())

    def test_containerd_config_digest_can_differ_from_oci_index_digest(
        self,
    ) -> None:
        self.fixture.runner.image_id_override = f"containerd://{CONFIG_DIGEST}"
        exit_code, result = self.fixture.run()
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["result"], "success")
        self.assertEqual(result["targetDigest"], DIGEST_A)

    def test_readiness_mismatches_do_not_write_success_ledger(self) -> None:
        cases = [
            ({"observed_generation": 0}, True, 1, None),
            ({"replicas": 0}, True, 1, None),
            ({"ready_replicas": 0}, True, 1, None),
            ({"available_replicas": 0}, True, 1, None),
            ({}, False, 1, None),
            ({}, True, 2, None),
            ({}, True, 1, "containerd://not-a-digest"),
        ]
        for overrides, ready, count, image_id in cases:
            with self.subTest(
                overrides=overrides,
                ready=ready,
                count=count,
                image_id=image_id,
            ):
                self.fixture.runner.deployment_overrides = overrides
                self.fixture.runner.pod_ready = ready
                self.fixture.runner.pod_count = count
                self.fixture.runner.image_id_override = image_id
                self.fixture.runner.fail_rollout_digests.add(DIGEST_B)
                self.assert_failure(request_bytes(), "apply_failed_rolled_back")
                self.assertFalse((self.fixture.state_dir / "ledger.json").exists())
                self.fixture.runner = FakeRunner()

    def test_pod_image_reference_must_match_authorized_digest(self) -> None:
        self.fixture.runner.pod_image_override = f"{IMAGE_NAME}@{DIGEST_B}"
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        self.assertFalse((self.fixture.state_dir / "ledger.json").exists())

    def test_first_deploy_failure_deletes_only_the_fixed_deployment(
        self,
    ) -> None:
        self.fixture.runner.fail_rollout_digests.add(DIGEST_A)
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        delete_call = next(
            argv for argv, _, _ in self.fixture.runner.calls if "delete" in argv
        )
        self.assertIn("deployment", delete_call)
        self.assertIn("k8s-yaml-assistant", delete_call)
        self.assertIsNone(self.fixture.runner.digest)
        self.assertFalse((self.fixture.state_dir / "operation.json").exists())

    def test_update_failure_restores_previous_successful_digest(self) -> None:
        self.fixture.write_ledger([ledger_event()])
        self.fixture.runner.digest = DIGEST_B
        self.fixture.runner.fail_rollout_digests.add(DIGEST_A)
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        applied_images: list[str] = []
        for argv, input_bytes, _ in self.fixture.runner.calls:
            if "apply" not in argv:
                continue
            matches = re.findall(
                rb"sha256:[a-f0-9]{64}",
                input_bytes or b"",
            )
            self.assertEqual(len(matches), 1)
            applied_images.append(matches[0].decode())
        self.assertEqual(applied_images, [DIGEST_A, DIGEST_B])
        self.assertEqual(self.fixture.runner.digest, DIGEST_B)
        self.assertEqual(
            self.fixture.read_ledger(),
            [ledger_event()],
        )
        self.assertFalse((self.fixture.state_dir / "operation.json").exists())

    def test_failed_automatic_restore_keeps_operation_marker(self) -> None:
        self.fixture.write_ledger([ledger_event()])
        self.fixture.runner.digest = DIGEST_B
        self.fixture.runner.fail_rollout_digests.update({DIGEST_A, DIGEST_B})
        self.assert_failure(request_bytes(), "rollback_failed")
        self.assertTrue((self.fixture.state_dir / "operation.json").exists())
        self.assertEqual(self.fixture.read_ledger(), [ledger_event()])
        operation = json.loads((self.fixture.state_dir / "operation.json").read_text())
        self.assertEqual(
            set(operation),
            {
                "startedAt",
                "action",
                "releaseId",
                "sourceCommit",
                "previousDigest",
                "targetDigest",
                "workflowRunId",
            },
        )

    def test_failed_first_delete_keeps_operation_marker(self) -> None:
        self.fixture.runner.fail_rollout_digests.add(DIGEST_A)
        self.fixture.runner.fail_delete = True
        self.assert_failure(request_bytes(), "rollback_failed")
        self.assertTrue((self.fixture.state_dir / "operation.json").exists())

    def test_success_writes_one_strict_event_and_removes_operation(self) -> None:
        exit_code, result = self.fixture.run()
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["failureCode"], None)
        self.assertEqual(
            set(result),
            {
                "event",
                "action",
                "releaseId",
                "releaseTag",
                "sourceCommit",
                "workflowRunId",
                "workflowRunAttempt",
                "previousDigest",
                "targetDigest",
                "result",
                "failureCode",
                "durationMs",
            },
        )
        events = self.fixture.read_ledger()
        self.assertEqual(len(events), 1)
        self.assertEqual(
            set(events[0]),
            {
                "action",
                "releaseId",
                "releaseTag",
                "sourceCommit",
                "publishedAt",
                "imageDigest",
                "workflowRunId",
                "workflowRunAttempt",
                "deployedAt",
            },
        )
        self.assertFalse((self.fixture.state_dir / "operation.json").exists())
        self.assertEqual(
            stat.S_IMODE((self.fixture.state_dir / "ledger.json").stat().st_mode),
            0o600,
        )

    def test_successful_update_and_rollback_append_auditable_events(
        self,
    ) -> None:
        first = ledger_event(
            release_id="99",
            release_tag="v0.0.8",
            source_commit=COMMIT_A,
            published_at="2026-07-25T07:00:00Z",
            image_digest=DIGEST_A,
        )
        current = ledger_event()
        self.fixture.write_ledger([first, current])
        self.fixture.runner.digest = DIGEST_B

        raw_provenance = provenance_bundle(
            provenance_statement(
                digest=DIGEST_A,
                source_commit=COMMIT_A,
            )
        )
        rollback_auth = authorization(
            action="rollback",
            release_id="102",
            release_tag=(
                f"rollback-v0.1.0-sha256-{DIGEST_A.removeprefix('sha256:')}-r777"
            ),
            source_commit=COMMIT_A,
            published_at="2026-07-27T07:30:00Z",
            image_digest=DIGEST_A,
            provenance=raw_provenance,
            workflow_run_id="202",
        )
        exit_code, result = self.fixture.run(
            request_bytes(
                authorization_value=rollback_auth,
                provenance=raw_provenance,
            )
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["previousDigest"], DIGEST_B)
        self.assertEqual(self.fixture.runner.digest, DIGEST_A)
        events = self.fixture.read_ledger()
        self.assertEqual(len(events), 3)
        self.assertEqual(events[-1]["action"], "rollback")
        self.assertEqual(events[-1]["imageDigest"], DIGEST_A)

    def test_each_timeout_fails_closed_and_preserves_or_restores_state(
        self,
    ) -> None:
        self.fixture.runner.timeout_authorization = True
        self.assert_failure(request_bytes(), "authorization_invalid")
        self.fixture.runner = FakeRunner()

        self.fixture.runner.timeout_provenance = True
        self.assert_failure(request_bytes(), "provenance_invalid")
        self.fixture.runner = FakeRunner()

        self.fixture.runner.timeout_get_deployment = True
        self.assert_failure(request_bytes(), "verification_failed")
        self.fixture.runner = FakeRunner()

        self.fixture.runner.timeout_apply_digests.add(DIGEST_A)
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        self.assertIsNone(self.fixture.runner.digest)
        self.fixture.runner = FakeRunner()

        self.fixture.runner.timeout_rollout_digests.add(DIGEST_A)
        self.assert_failure(request_bytes(), "apply_failed_rolled_back")
        self.assertIsNone(self.fixture.runner.digest)
        self.fixture.runner = FakeRunner()

        self.fixture.runner.timeout_rollout_digests.add(DIGEST_A)
        self.fixture.runner.timeout_delete = True
        self.assert_failure(request_bytes(), "rollback_failed")
        self.assertTrue((self.fixture.state_dir / "operation.json").exists())

    def test_restore_timeout_keeps_operation_for_manual_recovery(self) -> None:
        self.fixture.write_ledger([ledger_event()])
        self.fixture.runner.digest = DIGEST_B
        self.fixture.runner.fail_rollout_digests.add(DIGEST_A)
        self.fixture.runner.timeout_rollout_digests.add(DIGEST_B)
        self.assert_failure(request_bytes(), "rollback_failed")
        self.assertTrue((self.fixture.state_dir / "operation.json").exists())


if __name__ == "__main__":
    unittest.main()
