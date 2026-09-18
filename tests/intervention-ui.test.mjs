import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../intervention.html", import.meta.url), "utf8");

test("intervention privacy footer remains accurate when optional remote AI exists", () => {
  assert.match(html, /Private by design\. No account or ads\./);
  assert.doesNotMatch(html, /Everything stays on this device/);
});
