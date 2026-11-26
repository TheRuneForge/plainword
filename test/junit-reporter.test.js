import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import junitByFile, { groupByFile } from "../tools/junit-reporter.mjs";

const root = join(import.meta.dirname, "..");
const reporter = join(root, "tools", "junit-reporter.mjs");

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function* events(list) {
  yield* list;
}

// Runs node --test with the reporter on the given files and returns the report.
function report(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "junit-reporter-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // A runner started from inside a test reports to its parent unless this is cleared.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=junit.xml", ...Object.keys(files)],
    { cwd: dir, env, encoding: "utf8" },
  );
  return { status: run.status, stderr: run.stderr, xml: readFileSync(join(dir, "junit.xml"), "utf8") };
}

function suite(xml, name) {
  const match = xml.match(new RegExp(`^\\t<testsuite name="${name.replace(/\./g, "\\.")}"[^>]*>$([\\s\\S]*?)^\\t</testsuite>$`, "m"));
  assert.ok(match, `no top-level suite ${name}`);
  return match[0];
}

test("puts every top-level test of a real run in a suite named after its file", (t) => {
  const { status, xml } = report(t, {
    "a.test.js": `import { test, describe } from "node:test";
test("passes", () => {});
test("fails", () => { throw new Error("boom"); });
test("skipped", { skip: "later" }, () => {});
test("todo", { todo: true }, () => {});
test("waits", async () => { await new Promise((r) => setTimeout(r, 50)); });
describe("group", () => { test("inner one", () => {}); test("inner two", () => {}); });
`,
    "b.test.js": `import { test } from "node:test";
test("passes", async () => { await new Promise((r) => setTimeout(r, 10)); });
`,
    "c.test.js": "this is not javascript (\n",
  });
  assert.equal(status, 1, "the run fails because tests fail");
  // Directly under <testsuites> there are only suites and the run's summary comments.
  for (const line of xml.split("\n").filter((l) => /^\t\S/.test(l)))
    assert.match(line, /^\t(<testsuite name="[abc]\.test\.js"|<\/testsuite>|<!-- )/, line);
  for (const name of ["a.test.js", "b.test.js", "c.test.js"])
    assert.equal(xml.split(`<testsuite name="${name}"`).length, 2, `${name} must be one suite`);

  const a = suite(xml, "a.test.js");
  assert.match(a, /^\t<testsuite name="a\.test\.js"[^>]* tests="6" failures="1" skipped="2"/m);
  assert.match(a, /^\t\t<testcase name="fails"[^>]*>\n\t\t\t<failure [^>]*message="boom"/m);
  assert.match(a, /^\t\t<testsuite name="group"[^>]* tests="2"/m);
  assert.match(a, /^\t\t\t<testcase name="inner two"/m);
  assert.match(suite(xml, "b.test.js"), /tests="1" failures="0"/);
  assert.match(suite(xml, "c.test.js"), /failures="1"[\s\S]*<failure /);
  assert.match(xml, /^\t<!-- tests 9 -->$/m);
});

test("names a suite by its path relative to the working directory, with forward slashes", async () => {
  const file = join(process.cwd(), "test", "dir", "x.test.js");
  const out = await collect(groupByFile(events([
    { type: "test:start", data: { name: "t", nesting: 0, file } },
    { type: "test:pass", data: { name: "t", nesting: 0, file, details: { duration_ms: 2 } } },
  ])));
  assert.deepEqual(out.map((e) => [e.type, e.data.name, e.data.nesting]), [
    ["test:start", "test/dir/x.test.js", 0],
    ["test:start", "t", 1],
    ["test:pass", "t", 1],
    ["test:pass", "test/dir/x.test.js", 0],
  ]);
  assert.equal(out[3].data.details.duration_ms, 2);
});

test("ends a file's suite as failed when a top-level test failed, and before diagnostics without a file", async () => {
  const file = join(process.cwd(), "f.test.js");
  const out = await collect(groupByFile(events([
    { type: "test:enqueue", data: { name: "t", nesting: 0, file } },
    { type: "test:start", data: { name: "t", nesting: 0, file } },
    { type: "test:fail", data: { name: "t", nesting: 0, file, details: { duration_ms: 1 } } },
    { type: "test:diagnostic", data: { message: "tests 1", nesting: 0 } },
  ])));
  assert.deepEqual(out.map((e) => [e.type, e.data.name ?? e.data.message, e.data.nesting]), [
    ["test:enqueue", "t", 0],
    ["test:start", "f.test.js", 0],
    ["test:start", "t", 1],
    ["test:fail", "t", 1],
    ["test:fail", "f.test.js", 0],
    ["test:diagnostic", "tests 1", 0],
  ]);
});

test("an empty run is an empty but valid report", async () => {
  assert.deepEqual(await collect(groupByFile(events([]))), []);
  assert.equal((await collect(junitByFile(events([])))).join(""), '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n</testsuites>\n');
});

test("the CI jobs that run the tests upload the report with their ID token and no Mergify key", () => {
  for (const file of ["ci.yml", "deploy.yml"]) {
    const workflow = readFileSync(join(root, ".github", "workflows", file), "utf8");
    assert.match(workflow, /run: npm test -- --test-reporter=spec --test-reporter-destination=stdout --test-reporter=\.\/tools\/junit-reporter\.mjs --test-reporter-destination=junit\.xml\n/, file);
    assert.match(workflow, /run: pipx run --spec mergify-cli==\d{4}\.\d+\.\d+ mergify ci junit-process junit\.xml\n/, file);
    assert.match(workflow, /^ {6}id-token: write /m, file);
    assert.doesNotMatch(workflow, /MERGIFY_TOKEN|--token|^\s+token:/m, file);
  }
});
