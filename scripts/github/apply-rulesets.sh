#!/usr/bin/env bash
# Applies the branch and tag rulesets in .github/rulesets/ to the GitHub repo.
# Requires: gh CLI authenticated with admin rights on the repo. Rulesets on a PRIVATE repo need GitHub Pro.
# Usage: scripts/github/apply-rulesets.sh <owner>/<repo>
set -euo pipefail

repo="${1:?usage: $0 <owner>/<repo>}"
dir="$(cd "$(dirname "$0")/../../.github/rulesets" && pwd)"

for file in "$dir"/*.json; do
  name="$(jq -r .name "$file")"
  existing="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
  if [[ -n "$existing" ]]; then
    echo "Updating ruleset '$name' (id $existing)"
    gh api --method PUT "repos/$repo/rulesets/$existing" --input "$file" >/dev/null
  else
    echo "Creating ruleset '$name'"
    gh api --method POST "repos/$repo/rulesets" --input "$file" >/dev/null
  fi
done

echo "Current rulesets:"
gh api "repos/$repo/rulesets" --jq '.[] | "\(.id)\t\(.name)\t\(.enforcement)"'
