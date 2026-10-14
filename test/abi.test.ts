import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { curveAbi, registryAbi } from "../src/abis.js";

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !["name", "internalType"].includes(key)
      && !(["indexed", "anonymous"].includes(key) && child === false)).map(([key, child]) => [key, shape(child)]));
  return value;
}
test("SDK selectors, tuple layouts and events match the retained contract ABIs", () => {
  for (const [name, abi] of [["ElysiumReserveCurveVNext", curveAbi], ["ElysiumDealRegistry", registryAbi]] as const) {
    const retained = JSON.parse(readFileSync(new URL(`../abis/${name}.json`, import.meta.url), "utf8")) as { type: string; name?: string }[];
    for (const item of abi) {
      const original = retained.find(candidate => candidate.type === item.type && candidate.name === item.name);
      assert.ok(original, `Missing ${item.name}`);
      assert.deepEqual(shape(item), shape(original), `ABI mismatch: ${item.name}`);
    }
  }
});
test("test fixtures match their retained provenance hashes", () => {
  const provenance = JSON.parse(readFileSync(new URL("./fixtures/provenance.json", import.meta.url), "utf8")) as {
    evidence: { name: string; fixtureSha256: string }[];
  };
  for (const entry of provenance.evidence) {
    const raw = readFileSync(new URL(`./fixtures/${entry.name}.json`, import.meta.url));
    assert.equal(createHash("sha256").update(raw).digest("hex"), entry.fixtureSha256);
  }
});
