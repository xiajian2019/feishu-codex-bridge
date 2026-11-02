import { expect, it } from "bun:test";
import { createBackStack } from "../web/src/mobile-back-stack.js";

it("consumes a press in the visible top layer, leaving lower dialogs and the route alone", () => {
  const stack = createBackStack();
  const closed: string[] = [];
  stack.register(() => closed.push("route"), 0, false);
  const removeAccount = stack.register(() => closed.push("account"), 200);
  const removePreview = stack.register(() => closed.push("preview"), 500);
  expect(stack.dispatch("back")).toBe(true);
  expect(closed).toEqual(["preview"]);
  expect(removeAccount()).toBe(false);
  expect(removePreview()).toBe(true);
  expect(stack.dispatch("escape")).toBe(false);
  expect(stack.dispatch("back")).toBe(true);
  expect(closed).toEqual(["preview", "route"]);
});
it("handles nested layers with the same priority and absorbs back during a pending destructive action", () => {
  const stack = createBackStack();
  let parent = 0; let busy = true; let child = 0;
  stack.register(() => { parent += 1; }, 100);
  const remove = stack.register(() => { if (!busy) child += 1; }, 100);
  expect(stack.dispatch("back")).toBe(true);
  expect([parent, child]).toEqual([0, 0]);
  busy = false; stack.dispatch("escape");
  expect([parent, child]).toEqual([0, 1]);
  remove(); remove(); stack.dispatch("back");
  expect(parent).toBe(1);
});
