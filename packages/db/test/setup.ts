import { afterAll, afterEach, expect } from "vitest";
import { closePools, invariantViolations } from "./helpers.js";

// Brief §9: after every DB test, the global invariant check must come back empty.
afterEach(async () => {
  expect(await invariantViolations()).toEqual([]);
});

afterAll(async () => {
  await closePools();
});
