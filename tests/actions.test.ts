import test from "node:test";
import assert from "node:assert/strict";
import {
  highlightSchema, editRequestSchema, editResponseSchema,
  runRequestSchema, runResponseSchema
} from "../src/lib/protocol";
import { runCodeIsolated } from "../src/lib/runner";

test("highlight schema validates correctly", () => {
  const valid = {
    documentId: "d466e5da-fcfb-47dc-8c08-17f64d68683b",
    revision: 2,
    lineStart: 1,
    lineEnd: 5,
    snippet: "export function",
  };
  assert.equal(highlightSchema.safeParse(valid).success, true);
  assert.equal(highlightSchema.safeParse({ ...valid, revision: -1 }).success, false);
});

test("edit request and response schemas validate correctly", () => {
  const editReq = {
    documentId: "d466e5da-fcfb-47dc-8c08-17f64d68683b",
    baseRevision: 3,
    editType: "replace" as const,
    targetSnippet: "return null;",
    newCode: "return [0, 1];",
  };
  assert.equal(editRequestSchema.safeParse(editReq).success, true);

  const editRes = {
    success: true,
    revision: 4,
    code: "function test() { return [0, 1]; }",
  };
  assert.equal(editResponseSchema.safeParse(editRes).success, true);
});

test("run code runner executes TypeScript in isolated sandbox", async () => {
  const code = `
export function twoSum(nums: number[], target: number): [number, number] | null {
  return [0, 1];
}
console.log("Result:", twoSum([2, 7], 9));
`;
  const result = await runCodeIsolated("d466e5da-fcfb-47dc-8c08-17f64d68683b", 1, code, 3000);
  assert.equal(result.status, "success");
  assert.equal(result.success, true);
  assert.match(result.output, /Result: \[ 0, 1 \]/);
});

test("run code runner catches execution timeouts safely", async () => {
  const infiniteLoopCode = `
while (true) {}
`;
  const result = await runCodeIsolated("d466e5da-fcfb-47dc-8c08-17f64d68683b", 1, infiniteLoopCode, 1000);
  assert.equal(result.status, "timeout");
  assert.equal(result.success, false);
  assert.match(result.error || "", /timed out/);
});
