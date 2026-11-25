// gh actions-lock records immutable commit SHAs for direct and transitive
// workflow dependencies in actions.lock. Workflow refs stay readable tags;
// the lockfile is the enforced immutable pin.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "..", ".github", "workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
// Matches `uses:` in block style, in flow mappings (`- {uses: a/b@v1}`) and with quoted keys.
export function actionRefs(text) {
  return [...text.matchAll(/["']?\buses["']?\s*:\s*["']?([^\s"',}]+)/g)].map((m) => m[1]);
}
const uses = files.flatMap((f) =>
  actionRefs(readFileSync(join(dir, f), "utf8")).map((ref) => `${f}: ${ref}`),
);
const lock = readFileSync(join(dir, "actions.lock"), "utf8");
const workflows = lock.split("\nworkflows:\n")[1]?.split("\ndependencies:\n")[0] ?? "";
const dependencies = lock.split("\ndependencies:\n")[1] ?? "";

test("actionRefs finds block and flow-mapping references", () => {
  assert.deepEqual(actionRefs("- uses: a/b@v1\n- {uses: c/d@v2, with: {x: 1}}\n- {name: x, uses: \"e/f@v3\"}\n- {\"uses\": \"g/h@v4\"}\n- {'uses': 'i/j@v5'}"), [
    "a/b@v1",
    "c/d@v2",
    "e/f@v3",
    "g/h@v4",
    "i/j@v5",
  ]);
});

test("workflows use at least one action", () => {
  assert.ok(uses.length > 0);
});

test("every workflow is onboarded with its own action list in actions.lock", () => {
  for (const file of files) {
    const refs = actionRefs(readFileSync(join(dir, file), "utf8")).filter(
      (ref) => !ref.startsWith("./") && !ref.startsWith("$/"),
    );
    if (refs.length === 0) continue;
    const entryStart = workflows.indexOf(`    '.github/workflows/${file}':\n`);
    assert.notEqual(entryStart, -1, `${file} is not onboarded in actions.lock`);
    const nextEntry = workflows.indexOf("\n    '", entryStart + 1);
    const entry = workflows.slice(entryStart, nextEntry === -1 ? workflows.length : nextEntry);
    for (const ref of refs) {
      const at = ref.lastIndexOf("@");
      const actionPath = ref.slice(0, at).split("/").slice(0, 2).join("/");
      const lockRef = `${actionPath}${ref.slice(at)}`.toLowerCase();
      assert.ok(entry.includes(`- '${lockRef}'`), `${file} does not list ${lockRef} in actions.lock`);
    }
  }
});

test("every workflow action has an immutable SHA in actions.lock", () => {
  assert.ok(dependencies.length > 0, "actions.lock has no dependencies section");
  for (const item of uses) {
    const ref = item.slice(item.indexOf(": ") + 2);
    const at = ref.lastIndexOf("@");
    assert.ok(at > 0, `${item} has no version or SHA`);
    const version = ref.slice(at + 1);
    const actionPath = ref.slice(0, at).split("/").slice(0, 2).join("/");
    const lockRef = `${actionPath}@${version}`.toLowerCase();
    const escaped = lockRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lockedTag = new RegExp(`^    '${escaped}':\\n(?:(?:        ).*\\n)*?        commit: 'sha1-[0-9a-f]{40}'`, "m").test(dependencies);
    const lockedSha = /^[0-9a-f]{40}$/.test(version) && new RegExp(`^    '${escaped}':\\n(?:(?:        ).*\\n)*?        commit: 'sha1-${version}'`, "m").test(dependencies);
    assert.ok(lockedTag || lockedSha, `${item} has no immutable SHA in actions.lock`);
  }
});
