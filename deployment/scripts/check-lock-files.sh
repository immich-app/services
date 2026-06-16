#!/usr/bin/env bash
#
# Verifies that every OpenTofu/Terraform root module which declares a
# `required_providers` block has a committed `.terraform.lock.hcl`.
#
# Without a committed lock file, provider versions are not pinned: each
# `tofu init` in a clean checkout (e.g. CI) resolves the version constraint to
# the newest matching release, so a module can silently jump provider versions
# without anyone explicitly upgrading it. The lock file freezes the exact
# versions (and checksums) instead.
#
# Run locally:  ./deployment/scripts/check-lock-files.sh   (or: mise run tf:check-locks)
# Runs in CI as part of the Test workflow.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Modules are identified by a tracked .tf file containing a required_providers
# block. Using `git grep` (tracked files only) avoids matching the throwaway
# copies under .terraform/ and .terragrunt-cache/.
mapfile -t modules < <(git grep -l 'required_providers' -- 'deployment' \
  | grep '\.tf$' \
  | xargs -r -n1 dirname \
  | sort -u)

if [ "${#modules[@]}" -eq 0 ]; then
  echo "No Terraform modules with required_providers found." >&2
  exit 0
fi

missing=0
for dir in "${modules[@]}"; do
  lock="$dir/.terraform.lock.hcl"
  if ! git ls-files --error-unmatch "$lock" >/dev/null 2>&1; then
    echo "::error file=$dir/config.tf::Missing committed lock file: $lock"
    missing=1
  elif ! grep -q 'provider "' "$lock"; then
    echo "::error file=$lock::Lock file has no provider entries: $lock"
    missing=1
  else
    echo "ok: $lock"
  fi
done

if [ "$missing" -ne 0 ]; then
  cat >&2 <<'EOF'

One or more modules are missing a committed .terraform.lock.hcl.
Generate it from the module directory with:

  tofu init -backend=false
  tofu providers lock \
    -platform=linux_amd64 -platform=linux_arm64 \
    -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64
  rm -rf .terraform

Then commit the generated .terraform.lock.hcl.
EOF
  exit 1
fi

echo "All Terraform modules have a committed lock file."
