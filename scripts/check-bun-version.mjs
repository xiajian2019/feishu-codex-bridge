const required = [1, 4, 2];
const actual = globalThis.Bun?.version;
const version = actual?.split(".").map(Number);
const isSupported = version?.length >= 3
  && version.every(Number.isInteger)
  && (version[0] > required[0]
    || (version[0] === required[0] && version[1] > required[1])
    || (version[0] === required[0] && version[1] === required[1] && version[2] >= required[2]));

if (!isSupported) {
  console.error(
    `feishu-codex-bridge requires Bun >= ${required.join(".")}; `
      + `found ${actual || "no Bun runtime"}. Run: bun upgrade --stable`,
  );
  process.exit(1);
}
