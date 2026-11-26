// node:test reporter for CI: Node's own JUnit reporter, with the top-level
// tests of each test file grouped in a <testsuite> named after the file.
// Node's reporter puts top-level tests directly under <testsuites>, which
// JUnit parsers such as Mergify's reject.
//   node --test --test-reporter=./tools/junit-reporter.mjs --test-reporter-destination=junit.xml
import { relative, sep } from "node:path";
import { junit } from "node:test/reporters";

const RESULTS = new Set(["test:start", "test:pass", "test:fail"]);

function suiteName(file) {
  return relative(process.cwd(), file).split(sep).join("/");
}

// Rewrites the event stream: each file's events move one level down, under a
// synthetic suite that starts before the file's first event and ends after its
// last. Events without a file (the run's summary diagnostics) stay on top.
export async function* groupByFile(source) {
  let open = null;
  const close = () => {
    const { name, file, failed, duration } = open;
    open = null;
    return {
      type: failed ? "test:fail" : "test:pass",
      data: { name, nesting: 0, file, details: { type: "suite", duration_ms: duration } },
    };
  };
  for await (const event of source) {
    const data = event.data;
    const grouped = data?.file && (RESULTS.has(event.type) || event.type === "test:diagnostic");
    if (!grouped) {
      if (open && event.type === "test:diagnostic") yield close();
      yield event;
      continue;
    }
    if (open?.file !== data.file) {
      if (open) yield close();
      open = { name: suiteName(data.file), file: data.file, failed: false, duration: 0 };
      yield { type: "test:start", data: { name: open.name, nesting: 0, file: data.file } };
    }
    if (data.nesting === 0 && event.type !== "test:start" && event.type !== "test:diagnostic") {
      open.duration += data.details?.duration_ms ?? 0;
      if (event.type === "test:fail") open.failed = true;
    }
    yield { ...event, data: { ...data, nesting: data.nesting + 1 } };
  }
  if (open) yield close();
}

export default async function* junitByFile(source) {
  yield* junit(groupByFile(source));
}
