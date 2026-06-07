import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Minimal protobuf ENCODER (mirror of the reader) ──────────────────────────
function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
function tag(field, wire) { return encodeVarint((field << 3) | wire); }
function varintField(field, value) { return Buffer.concat([tag(field, 0), encodeVarint(value)]); }
function lenField(field, buf) { return Buffer.concat([tag(field, 2), encodeVarint(buf.length), buf]); }
function strField(field, s) { return lenField(field, Buffer.from(s, "utf8")); }

// usageMetadata submessage: f2=prompt, f3=thinking+output(checksum), f9=thinking, f10=output
function usageMeta({ prompt, output, thinking }) {
  return Buffer.concat([
    varintField(2, prompt),
    varintField(3, thinking + output),
    varintField(9, thinking),
    varintField(10, output),
  ]);
}

// A model-call step payload: a wrapper message carrying
//  - field 1: a unix-seconds timestamp (so day derives from the payload)
//  - field 7: the usageMetadata submessage (arbitrary outer field number)
function stepPayload({ usage, tsSeconds }) {
  return Buffer.concat([
    varintField(1, tsSeconds),
    lenField(7, usageMeta(usage)),
  ]);
}

// gen_metadata blob carrying a model id string nested one level deep, mimicking
// the real layout (model id lives nested, not at top level).
function genMetadata(modelId) {
  const inner = strField(28, modelId); // nested field
  return lenField(3, inner); // wrap so the model id is one level deep
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dest = process.argv[2] || path.join(__dirname, "antigravity-conv.db");
try { fs.rmSync(dest, { force: true }); } catch {}

const db = new DatabaseSync(dest);
db.exec(`CREATE TABLE steps (
  idx integer,
  step_type integer NOT NULL DEFAULT 0,
  status integer NOT NULL DEFAULT 0,
  metadata blob,
  step_payload blob,
  PRIMARY KEY (idx)
)`);
db.exec(`CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))`);
db.exec(`CREATE TABLE executor_metadata (idx integer, data blob, PRIMARY KEY (idx))`);

// 2026-06-07T08:24:10Z → day 2026-06-07
const ts1 = 1780842250;
const ts2 = 1780842253;

const usageA = { prompt: 15475, output: 209, thinking: 386 };
const usageB = { prompt: 53, output: 138, thinking: 0 };

// step 0: no usage (a plain non-model step) — must be ignored.
const insStep = db.prepare("INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?,?,?,?)");
insStep.run(0, 14, strField(11, "DX8laoCJEqqEz7IPkO6hyAg"), null);
// step 1: model-call A. The SAME usage appears mirrored in BOTH step_payload AND
// metadata — we parse step_payload ONLY, so the metadata copy must not double-count.
insStep.run(1, 98, stepPayload({ usage: usageA, tsSeconds: ts1 }), usageMeta(usageA));
// step 2: model-call B.
insStep.run(2, 15, stepPayload({ usage: usageB, tsSeconds: ts2 }), null);
// step 3: a DUPLICATE of model-call A's usage (same {prompt,output,thinking}) —
// must dedupe to a single contribution.
insStep.run(3, 15, stepPayload({ usage: usageA, tsSeconds: ts2 }), null);

db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?,?,?)").run(0, genMetadata("gemini-3.5-flash-low"), 0);
db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?,?)").run(0, genMetadata("gemini-3.5-flash-low"));

db.close();
console.log("wrote", dest);

// Self-check: expected summed totals (dedupe A+B, A-dup dropped):
//   prompt  = 15475 + 53     = 15528
//   output  = 209   + 138    = 347
//   thinking= 386   + 0      = 386
console.log("expected prompt=15528 output=347 thinking=386 model=gemini-3.5-flash-low day=2026-06-07");
