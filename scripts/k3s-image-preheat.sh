#!/bin/bash

set -euo pipefail

readonly REPOSITORY="kkxiaoa/k8s-yaml-assistant"
readonly EXPECTED_IMAGE="ghcr.io/kkxiaoa/k8s-yaml-assistant"
readonly EXPECTED_PLATFORM="linux/amd64"
readonly SKOPEO_CONTAINER="quay.io/skopeo/stable:v1.22.2-immutable@sha256:4a16d57b37617a04b3d643079a477a2848efe892dffcdf0ce56df4262b65f810"
readonly SSH_TARGET="root@120.46.57.214"
readonly SSH_PORT="22"
readonly SSH_IDENTITY="/Users/xiaokuangkuang/.ssh/huawei-k3s"
readonly STABLE_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly ROLLBACK_TAG_PATTERN='^rollback-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-sha256-([0-9a-f]{64})-r([1-9][0-9]{0,31})$'

tag=""
release_kind=""
rollback_digest=""
work_dir=""
remote_archive=""
ssh_args=()
scp_args=()

usage() {
  cat <<'EOF'
用法：
  k3s-image-preheat.sh vX.Y.Z
  k3s-image-preheat.sh rollback-vX.Y.Z-sha256-<64位摘要>-r<运行号>
  k3s-image-preheat.sh --help

认证：
  默认使用 gh 当前登录身份读取草稿 Release 和 GHCR。
  如需单独指定 GHCR 凭据，可设置 GHCR_USERNAME 和 GHCR_TOKEN。

固定目标：
  root@120.46.57.214
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

cleanup() {
  local status=$?
  trap - EXIT

  if [[ -n "$remote_archive" ]]; then
    ssh "${ssh_args[@]}" "$SSH_TARGET" "rm -f -- '$remote_archive'" \
      >/dev/null 2>&1 || true
  fi

  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi

  exit "$status"
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  fail "只需要提供一个稳定发布或回滚草稿标签"
fi

tag=$1
if [[ "$tag" =~ $STABLE_TAG_PATTERN ]]; then
  release_kind="application"
elif [[ "$tag" =~ $ROLLBACK_TAG_PATTERN ]]; then
  release_kind="rollback"
  rollback_digest="sha256:${BASH_REMATCH[4]}"
else
  fail "标签必须是 vX.Y.Z，或 rollback-vX.Y.Z-sha256-<64位摘要>-r<运行号>"
fi

[[ -f "$SSH_IDENTITY" && -r "$SSH_IDENTITY" ]] \
  || fail "固定 SSH 私钥不存在或不可读：$SSH_IDENTITY"

require_command gh
require_command python3
require_command ssh
require_command scp
require_command shasum
require_command tar

skopeo_backend=""
if command -v skopeo >/dev/null 2>&1; then
  skopeo_backend="native"
elif command -v docker >/dev/null 2>&1; then
  skopeo_backend="docker"
else
  fail "需要 skopeo，或可运行容器的 Docker"
fi

ssh_args=(
  -p "$SSH_PORT"
  -o "StrictHostKeyChecking=yes"
  -o "PreferredAuthentications=publickey"
  -o "PasswordAuthentication=no"
  -o "KbdInteractiveAuthentication=no"
  -o "ConnectTimeout=10"
  -o "ServerAliveInterval=15"
  -o "ServerAliveCountMax=2"
  -o "IdentitiesOnly=yes"
  -i "$SSH_IDENTITY"
)
scp_args=(
  -P "$SSH_PORT"
  -o "StrictHostKeyChecking=yes"
  -o "PreferredAuthentications=publickey"
  -o "PasswordAuthentication=no"
  -o "KbdInteractiveAuthentication=no"
  -o "ConnectTimeout=10"
  -o "IdentitiesOnly=yes"
  -i "$SSH_IDENTITY"
)

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/k3s-image-preheat.XXXXXX")
chmod 700 "$work_dir"
trap cleanup EXIT

release_json="$work_dir/release.json"
manifest_dir="$work_dir/release"
manifest_path="$manifest_dir/release-manifest.json"
auth_file="$work_dir/auth.json"
layout_path="$work_dir/image.oci"
archive_path="$work_dir/image.oci.tar"
mkdir -m 700 "$manifest_dir"

printf '1/5 校验 GitHub 草稿 Release：%s\n' "$tag"
gh release view "$tag" \
  --repo "$REPOSITORY" \
  --json tagName,isDraft,isPrerelease,assets \
  >"$release_json"

python3 - "$release_json" "$tag" "$release_kind" <<'PY'
import json
import sys

path, expected_tag, release_kind = sys.argv[1:]
with open(path, "r", encoding="utf-8") as handle:
    release = json.load(handle)

if release.get("tagName") != expected_tag:
    raise SystemExit("Release 标签与请求不一致")
if release.get("isDraft") is not True:
    raise SystemExit("Release 不是草稿；脚本拒绝预热已发布版本")
if release.get("isPrerelease") is not False:
    raise SystemExit("Release 被标记为预发布版本")

assets = release.get("assets")
if not isinstance(assets, list):
    raise SystemExit("Release 附件列表格式无效")
if release_kind == "application":
    matches = [
        asset for asset in assets
        if asset.get("name") == "release-manifest.json"
    ]
    if len(matches) != 1:
        raise SystemExit("应用草稿必须恰好包含一个 release-manifest.json")
elif release_kind != "rollback":
    raise SystemExit("未知的 Release 类型")
PY

if [[ "$release_kind" == "application" ]]; then
  gh release download "$tag" \
    --repo "$REPOSITORY" \
    --pattern "release-manifest.json" \
    --dir "$manifest_dir"

  manifest_values=$(
    python3 - "$manifest_path" "$tag" "$EXPECTED_IMAGE" "$EXPECTED_PLATFORM" <<'PY'
import json
import os
import re
import sys

path, expected_tag, expected_image, expected_platform = sys.argv[1:]
if os.path.getsize(path) > 2 * 1024 * 1024:
    raise SystemExit("release-manifest.json 超过 2 MiB 上限")

with open(path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)

if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 2:
    raise SystemExit("只接受 schemaVersion=2 的发布清单")

release = manifest.get("release")
image = manifest.get("image")
if not isinstance(release, dict) or not isinstance(image, dict):
    raise SystemExit("发布清单缺少 release 或 image")
if release.get("tag") != expected_tag:
    raise SystemExit("发布清单中的 release.tag 不匹配")
if image.get("name") != expected_image:
    raise SystemExit("发布清单中的 image.name 不匹配")
if image.get("platform") != expected_platform:
    raise SystemExit("发布清单中的 image.platform 不是 linux/amd64")

digest = image.get("digest")
if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    raise SystemExit("发布清单中的 image.digest 无效")

print(f"{expected_image}|{digest}")
PY
  )

  IFS='|' read -r image_name image_digest <<<"$manifest_values"
else
  image_name="$EXPECTED_IMAGE"
  image_digest="$rollback_digest"
fi

exact_image="${image_name}@${image_digest}"

printf '    类型：%s\n' "$release_kind"
printf '    镜像：%s\n' "$exact_image"
printf '    平台：%s\n' "$EXPECTED_PLATFORM"
printf '    目标：%s（端口 %s）\n' "$SSH_TARGET" "$SSH_PORT"

printf '2/5 认证 GHCR 并导出 OCI 归档\n'
registry_username="${GHCR_USERNAME:-}"
if [[ -z "$registry_username" ]]; then
  registry_username=$(gh api user --jq .login 2>/dev/null) \
    || fail "无法确定 GHCR 用户名；请设置 GHCR_USERNAME"
fi
[[ "$registry_username" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] \
  || fail "GHCR 用户名格式无效"

registry_token="${GHCR_TOKEN:-}"
if [[ -z "$registry_token" ]]; then
  registry_token=$(gh auth token 2>/dev/null) \
    || fail "无法读取 GitHub 令牌；请先运行 gh auth login"
fi
[[ -n "$registry_token" ]] || fail "GitHub 令牌为空"
unset GHCR_TOKEN

if [[ "$skopeo_backend" == "native" ]]; then
  printf '%s' "$registry_token" |
    skopeo login \
      --authfile "$auth_file" \
      --username "$registry_username" \
      --password-stdin \
      ghcr.io
else
  printf '    本机未安装 skopeo，使用固定摘要的官方容器\n'
  printf '%s' "$registry_token" |
    docker run --rm -i \
      --volume "$work_dir:/work" \
      --entrypoint /usr/bin/skopeo \
      "$SKOPEO_CONTAINER" \
      login \
      --authfile /work/auth.json \
      --username "$registry_username" \
      --password-stdin \
      ghcr.io
fi
registry_token=""
unset registry_token
chmod 600 "$auth_file"

if [[ "$skopeo_backend" == "native" ]]; then
  skopeo copy \
    --all \
    --preserve-digests \
    --src-authfile "$auth_file" \
    "docker://$exact_image" \
    "oci:$layout_path"
else
  docker run --rm \
    --volume "$work_dir:/work" \
    --entrypoint /usr/bin/skopeo \
    "$SKOPEO_CONTAINER" \
    copy \
    --all \
    --preserve-digests \
    --src-authfile /work/auth.json \
    "docker://$exact_image" \
    "oci:/work/image.oci"
fi

rm -f -- "$auth_file"

# oci-archive 会为多镜像索引增加包装层；K3s 导入需要顶层描述符保持发布根摘要。
COPYFILE_DISABLE=1 tar -C "$layout_path" -cf "$archive_path" .

printf '3/5 校验 OCI 根摘要\n'
python3 - "$archive_path" "$image_digest" <<'PY'
import hashlib
import json
import sys
import tarfile

archive_path, expected_digest = sys.argv[1:]
hex_digest = expected_digest.removeprefix("sha256:")

with tarfile.open(archive_path, "r:*") as archive:
    members = {
        member.name[2:] if member.name.startswith("./") else member.name: member
        for member in archive.getmembers()
    }

    index_member = members.get("index.json")
    if index_member is None or not index_member.isfile():
        raise SystemExit("OCI 归档缺少 index.json")
    if index_member.size > 1024 * 1024:
        raise SystemExit("OCI index.json 超过 1 MiB 上限")

    index_file = archive.extractfile(index_member)
    if index_file is None:
        raise SystemExit("无法读取 OCI index.json")
    index = json.load(index_file)

    manifests = index.get("manifests")
    if not isinstance(manifests, list):
        raise SystemExit("OCI index.json 的 manifests 无效")
    if sum(item.get("digest") == expected_digest for item in manifests) != 1:
        raise SystemExit("OCI 顶层索引未唯一引用目标根摘要")

    blob_member = members.get(f"blobs/sha256/{hex_digest}")
    if blob_member is None or not blob_member.isfile():
        raise SystemExit("OCI 归档缺少根摘要内容")
    blob_file = archive.extractfile(blob_member)
    if blob_file is None:
        raise SystemExit("无法读取 OCI 根摘要内容")

    digest = hashlib.sha256()
    for chunk in iter(lambda: blob_file.read(1024 * 1024), b""):
        digest.update(chunk)
    if digest.hexdigest() != hex_digest:
        raise SystemExit("OCI 根摘要内容校验失败")
PY

read -r archive_sha _ < <(shasum -a 256 "$archive_path")
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]] || fail "无法计算归档 SHA-256"
archive_bytes=$(wc -c <"$archive_path" | tr -d '[:space:]')
printf '    归档：%s 字节，SHA-256 %s\n' "$archive_bytes" "$archive_sha"

printf '4/5 传输归档到 K3s 节点\n'
remote_archive=$(
  ssh "${ssh_args[@]}" "$SSH_TARGET" \
    'umask 077; mktemp /var/tmp/k8s-yaml-assistant-preheat.XXXXXXXXXX'
)
[[ "$remote_archive" =~ ^/var/tmp/k8s-yaml-assistant-preheat\.[A-Za-z0-9]+$ ]] \
  || fail "服务器返回了无效的临时路径"

scp "${scp_args[@]}" "$archive_path" "$SSH_TARGET:$remote_archive"

printf '5/5 校验、导入并确认精确镜像引用\n'
remote_script='
set -euo pipefail

remote_archive=$1
expected_archive_sha=$2
image_name=$3
image_digest=$4
exact_image="${image_name}@${image_digest}"

cleanup_remote() {
  rm -f -- "$remote_archive"
}
trap cleanup_remote EXIT

actual_archive_sha=$(sha256sum "$remote_archive")
actual_archive_sha=${actual_archive_sha%% *}
if [[ "$actual_archive_sha" != "$expected_archive_sha" ]]; then
  printf "归档传输摘要不匹配\n" >&2
  exit 1
fi

if [[ $(id -u) -eq 0 ]]; then
  k3s_command=(k3s)
elif sudo -n true 2>/dev/null; then
  k3s_command=(sudo -n k3s)
else
  printf "当前用户不是 root，且没有免交互 sudo 权限\n" >&2
  exit 1
fi

"${k3s_command[@]}" ctr --namespace k8s.io images import \
  --all-platforms \
  --base-name "$image_name" \
  --digests \
  --index-name "$exact_image" \
  "$remote_archive"

"${k3s_command[@]}" ctr --namespace k8s.io content get "$image_digest" >/dev/null

found=false
while IFS= read -r imported_image; do
  if [[ "$imported_image" == "$exact_image" ]]; then
    found=true
    break
  fi
done < <("${k3s_command[@]}" ctr --namespace k8s.io images list -q)

if [[ "$found" != "true" ]]; then
  printf "K3s 中未找到精确根摘要镜像引用\n" >&2
  exit 1
fi

printf "K3s 已预热：%s\n" "$exact_image"
'

printf '%s\n' "$remote_script" |
  ssh "${ssh_args[@]}" "$SSH_TARGET" \
    bash -s -- "$remote_archive" "$archive_sha" "$image_name" "$image_digest"

remote_archive=""
printf '\n完成：%s 已在 K3s 中按根摘要预热。\n' "$exact_image"
printf '现在可以在 GitHub 中 Publish；部署适配器会继续校验并使用同一摘要。\n'
