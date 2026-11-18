#!/usr/bin/env node
// Dynamic-run journal retention CLI (plan item 102).
//
// Compresses the terminal run's append-only journal prefix into a durable
// gzip archive after verifying the readback digest, leaving the live tail
// readable. Never rewrites snapshots, spec revisions, request indexes or child
// receipts, and never prunes native leases. Defaults to a read-only inspection
// (dry run); `--apply` is required to write, and `--restore` is the reverse
// path.
//
// usage: node scripts/dynamic-retention.mjs --root <dynamic-state-dir> --run <runId>
//          [--before <ISO>] [--apply | --restore] [--json]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DynamicStore, MAX_JOURNAL_BYTES } from "../src/dynamic-store.mjs";

const USAGE = `usage: node scripts/dynamic-retention.mjs --root <dynamic-state-dir> --run <dyn-...> [--before <ISO>] [--apply | --restore] [--json]

Inspect (default) reports what would be archived. --apply compresses journal
entries with timestamps <= --before into <runId>.journal.jsonl.gz (readback
verified, source untouched on mismatch). --restore merges the archive back into
the raw journal and removes it. Active runs, live leases and oversized journals
(> 16 MiB by default) are refused explicitly.`;

export function parseRetentionArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      run: { type: "string" },
      before: { type: "string" },
      apply: { type: "boolean", default: false },
      restore: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "max-journal-bytes": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  let values;
  try {
    values = parseRetentionArgs(argv);
  } catch (error) {
    err.write(`retention failed: ${error?.message ?? error}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) { out.write(`${USAGE}\n`); return 0; }
  if (!values.root || !values.run || (values.apply && values.restore)) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const maxJournalBytes = values["max-journal-bytes"] ? Number(values["max-journal-bytes"]) : MAX_JOURNAL_BYTES;
  if (!Number.isFinite(maxJournalBytes) || maxJournalBytes < 1) {
    err.write("retention failed: --max-journal-bytes must be a positive number\n");
    return 2;
  }
  const store = new DynamicStore(resolve(values.root));
  try {
    let receipt;
    if (values.restore) {
      receipt = await store.restoreJournal(values.run, { maxJournalBytes });
    } else if (values.apply) {
      if (!values.before) throw Object.assign(new Error("--apply requires --before <ISO>"), { details: { kind: "validation" } });
      receipt = await store.compressJournal(values.run, { beforeISO: values.before, apply: true, maxJournalBytes });
    } else {
      receipt = await store.compressJournal(values.run, { beforeISO: values.before ?? new Date().toISOString(), apply: false, maxJournalBytes });
    }
    const label = values.restore ? "RETENTION_RESTORE" : values.apply ? "RETENTION_APPLY" : "RETENTION_INSPECT";
    out.write(values.json ? `${JSON.stringify(receipt)}\n` : `${label} ${JSON.stringify(receipt)}\n`);
    return 0;
  } catch (error) {
    err.write(`retention failed: ${error?.message ?? error}\n`);
    if (values.json) err.write(`${JSON.stringify({ ok: false, kind: error?.details?.kind ?? null })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`retention failed: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
}
