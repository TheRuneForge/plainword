---
name: pin-actions
description: Check that every GitHub Actions uses reference is pinned to a full 40-character commit SHA.
---

1. List all uses lines in .github/workflows/*.yml.
2. Report every external reference that is not @ followed by 40 hex characters (local ./ actions and docker:// images are excepted).
3. Keep the upstream release tag in a trailing YAML comment for traceability.
4. Run node tools/verify-action-pins.mjs and the workflow tests after changes.
5. Never replace a SHA with a mutable tag or branch.
