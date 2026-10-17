import assert from "node:assert/strict";
import { test } from "node:test";

test("Node runs TypeScript tests and exposes cancellation signals", () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled: boolean = controller.signal.aborted;
  assert.equal(cancelled, true);
});
