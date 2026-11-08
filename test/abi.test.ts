import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";

test("test fixtures match their retained provenance hashes", () => {
  const provenance = JSON.parse(readFileSync(new URL("./fixtures/provenance.json", import.meta.url), "utf8")) as {
    evidence: { name: string; fixtureSha256: string }[];
  };
  assert.ok(provenance.evidence.length > 0);
  for (const entry of provenance.evidence) {
    const raw = readFileSync(new URL(`./fixtures/${entry.name}.json`, import.meta.url));
    assert.equal(createHash("sha256").update(raw).digest("hex"), entry.fixtureSha256);
  }
});
