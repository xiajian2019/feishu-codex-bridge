const required = [22, 13, 1];
const actual = process.versions.node.split(".").map(Number);

const isSupported = actual[0] > required[0]
  || (actual[0] === required[0] && actual[1] > required[1])
  || (actual[0] === required[0] && actual[1] === required[1] && actual[2] >= required[2]);

if (!isSupported) {
  console.error(
    `feishu-codex-bridge requires Node.js >= ${required.join(".")}; `
      + `found ${process.versions.node}. Run: nvm use v22.13.1`,
  );
  process.exit(1);
}
