import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const workflows = join(root, ".github", "workflows");
const files = readdirSync(workflows).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
const refs = files.flatMap((file) =>
  readFileSync(join(workflows, file), "utf8")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("uses:" ) || line.trimStart().startsWith("- uses:"))
    .map((line) => line.match(/uses:\s*([^\s#]+)/)?.[1])
    .filter((ref) => ref && !ref.startsWith("./") && !ref.startsWith("docker://")),
);

test("workflows use at least one external action", () => {
  assert.ok(refs.length > 0);
});

test("every external workflow action is pinned to a full commit SHA", () => {
  for (const ref of refs) {
    const at = ref.lastIndexOf("@");
    assert.ok(at > 0, ref + " has no version or SHA");
    assert.match(ref.slice(at + 1), /^[0-9a-f]{40}$/, ref + " is not immutable");
  }
});

test("the repository pin verifier checks all workflow files", () => {
  const result = spawnSync(process.execPath, ["tools/verify-action-pins.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified [0-9]+ immutable action pins/);
});
