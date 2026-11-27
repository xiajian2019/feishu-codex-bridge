import { readFileSync } from "node:fs";

/** Use the process environment first, then an optional checkout-local xcconfig. */
export function readIosDevelopmentTeam(env = process.env, configFile = null) {
  let raw = env.BRIDGE_IOS_DEVELOPMENT_TEAM;
  if ((raw === undefined || raw === null || raw.trim() === "") && configFile) {
    let contents;
    try {
      contents = readFileSync(configFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const assignments = [...contents.matchAll(/^[ \t]*BRIDGE_IOS_DEVELOPMENT_TEAM[ \t]*=[ \t]*([^\r\n]*)/gm)];
    raw = assignments.at(-1)?.[1].replace(/\/\/.*$/, "").trim();
  }
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const team = raw.trim();
  if (!/^[A-Z0-9]{10}$/.test(team)) {
    throw new Error("BRIDGE_IOS_DEVELOPMENT_TEAM 必须是 10 位大写字母或数字组成的 Apple Team ID；ios/.xcconfig 中请使用不带引号的字面值。");
  }
  return team;
}
