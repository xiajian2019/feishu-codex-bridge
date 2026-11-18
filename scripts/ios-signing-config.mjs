/** Read the signing team only from the current process environment. */
export function readIosDevelopmentTeam(env = process.env) {
  const raw = env.BRIDGE_IOS_DEVELOPMENT_TEAM;
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const team = raw.trim();
  if (!/^[A-Z0-9]{10}$/.test(team)) {
    throw new Error("BRIDGE_IOS_DEVELOPMENT_TEAM 必须是 10 位大写字母或数字组成的 Apple Team ID。");
  }
  return team;
}
