#!/usr/bin/env bash
set -euo pipefail

version="8.30.1"
archive_name="gitleaks_${version}_linux_x64.tar.gz"
expected_archive_sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
expected_binary_sha256="88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
expected_binary_bytes="21958840"
release_url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive_name}"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
temporary_root="$(mktemp -d "${RUNNER_TEMP%/}/ralph-v2-gitleaks.XXXXXX")"
trap 'rm -rf -- "${temporary_root}"' EXIT
archive_path="${temporary_root}/${archive_name}"
extract_root="${temporary_root}/extract"
binary_root="artifacts/ci/tooling/bin"
mkdir -p "${extract_root}" "${binary_root}" "artifacts/ci/tooling"
if [[ -e "${binary_root}/gitleaks" || -L "${binary_root}/gitleaks" ]]; then
  printf 'Refusing to overwrite an existing Gitleaks binary.\n' >&2
  exit 1
fi
if [[ -e artifacts/ci/tooling/gitleaks-install.json || -L artifacts/ci/tooling/gitleaks-install.json ]]; then
  printf 'Refusing to overwrite an existing Gitleaks install receipt.\n' >&2
  exit 1
fi

curl \
  --proto '=https' \
  --tlsv1.2 \
  --fail \
  --location \
  --retry 3 \
  --retry-all-errors \
  --output "${archive_path}" \
  "${release_url}"

printf '%s  %s\n' "${expected_archive_sha256}" "${archive_path}" | sha256sum --check --strict
tar --extract --gzip --file "${archive_path}" --directory "${extract_root}" gitleaks
binary_path="${binary_root}/gitleaks"
install -m 0755 "${extract_root}/gitleaks" "${binary_path}"

observed_version="$("${binary_path}" version)"
if [[ "${observed_version}" != "${version}" ]]; then
  printf 'Pinned Gitleaks binary reported an unexpected version: %s\n' "${observed_version}" >&2
  exit 1
fi

binary_sha256="$(sha256sum "${binary_path}" | cut -d ' ' -f 1)"
binary_bytes="$(wc -c < "${binary_path}" | tr -d '[:space:]')"
if [[ "${binary_sha256}" != "${expected_binary_sha256}" || "${binary_bytes}" != "${expected_binary_bytes}" ]]; then
  printf 'Pinned Gitleaks binary bytes/hash do not match the verified official archive.\n' >&2
  exit 1
fi

cat > artifacts/ci/tooling/gitleaks-install.json <<EOF
{
  "schemaVersion": 1,
  "artifactClass": "pinned-ci-tool-install",
  "tool": "gitleaks",
  "version": "${version}",
  "source": "${release_url}",
  "archiveSha256": "${expected_archive_sha256}",
  "binaryPath": "artifacts/ci/tooling/bin/gitleaks",
  "binaryBytes": ${binary_bytes},
  "binarySha256": "${binary_sha256}",
  "reportedVersion": "${observed_version}"
}
EOF

printf 'Installed Gitleaks %s from checksum-pinned official release asset.\n' "${version}"
