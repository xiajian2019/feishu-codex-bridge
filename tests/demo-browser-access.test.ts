import { expect, it } from "bun:test";
import { DemoBrowserAccess } from "../src/demo-browser-access.js";

it("limits one-time browser handoffs to one Demo, expires tickets and revokes existing sessions", () => {
  let now = 0; let authorized = true;
  const access = new DemoBrowserAccess(() => now);
  const issue = () => access.issue("food-photo", "/api/local-demos/food-photo/?scene=multidish", () => authorized);
  const ticket = issue();
  const grant = access.consume("food-photo", ticket)!;
  expect(grant.target).toBe("/api/local-demos/food-photo/?scene=multidish");
  expect(access.consume("food-photo", ticket)).toBeNull();
  const cookie = `bridge_demo_food-photo=${grant.token}`;
  expect(access.allows("food-photo", cookie)).toBe(true);
  expect(access.allows("openai-clip", cookie)).toBe(false);
  expect(access.consume("openai-clip", issue())).toBeNull();
  const expiring = issue(); now += 60_000;
  expect(access.consume("food-photo", expiring)).toBeNull();
  authorized = false;
  expect(access.allows("food-photo", cookie)).toBe(false);
  expect(() => issue()).toThrow("失效");
});
