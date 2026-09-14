const patchUrl = new URL('./aamp-runtime-patch.mjs', import.meta.url).href;
const worktreePatchUrl = new URL('./aamp-acp-worktree-patch.mjs', import.meta.url).href;
const sqlitePatchUrl = new URL('./aamp-sqlite-patch.mjs', import.meta.url).href;
const commandPatchUrl = new URL('./aamp-command-patch.mjs', import.meta.url).href;
const controllerProxyBlock = [
  "const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];",
  "proxyKeys.forEach((key) => delete env[key]);",
].join('\n');
const indentedControllerProxyBlock = [
  "const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];",
  "  proxyKeys.forEach((key) => delete env[key]);",
].join('\n');

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const source = String(result.source);
  if (url.endsWith('/aamp-feishu-bridge/dist/runtime.js')) {
    if (!source.includes('export class FeishuBridgeRuntime')) {
      throw new Error('AAMP compatibility: unsupported runtime export; review upstream update before starting');
    }
    return {
      ...result,
      source: source + `\nimport { patchHelpCards } from ${JSON.stringify(patchUrl)};\npatchHelpCards(FeishuBridgeRuntime);\nimport { patchAampSqlite } from ${JSON.stringify(sqlitePatchUrl)};\npatchAampSqlite(FeishuBridgeRuntime);\nimport { patchAampCommands } from ${JSON.stringify(commandPatchUrl)};\npatchAampCommands(FeishuBridgeRuntime);\n`,
    };
  }
  if (url.endsWith('/@larktask/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs')) {
    const hostDefault = 'const host = typeof bindingOrAgent === \'object\' ? bindingOrAgent.aamp_host : DEFAULT_AAMP_HOST;';
    const hostStart = "'--aamp-host', binding.aamp_host,";
    const currentHostStart = "args.push('--aamp-host', host || DEFAULT_AAMP_HOST);";
    const acpHost = '{ input: JSON.stringify({ aampHost: host, agents }),';
    const proxyBlock = source.includes(controllerProxyBlock)
      ? controllerProxyBlock
      : source.includes(indentedControllerProxyBlock)
        ? indentedControllerProxyBlock
        : undefined;
    if (!source.includes(hostDefault)
      || (!source.includes(hostStart) && !source.includes(currentHostStart))
      || !source.includes(acpHost)
      || !proxyBlock) {
      throw new Error('AAMP compatibility: controller host/proxy environment changed; review upstream update before starting');
    }
    let replaced = source
      .replace(hostDefault, "const host = typeof bindingOrAgent === 'object' ? (process.env.AAMP_TASK_AAMP_HOST || bindingOrAgent.aamp_host) : DEFAULT_AAMP_HOST;")
      .replace(acpHost, "{ input: JSON.stringify({ aampHost: process.env.AAMP_TASK_AAMP_HOST || host, agents }),");
    replaced = replaced.includes(hostStart)
      ? replaced.replace(hostStart, "'--aamp-host', process.env.AAMP_TASK_AAMP_HOST || binding.aamp_host,")
      : replaced.replace(currentHostStart, "args.push('--aamp-host', process.env.AAMP_TASK_AAMP_HOST || host || DEFAULT_AAMP_HOST);");
    replaced = replaced.replace(proxyBlock, [
        proxyBlock,
        "const configuredProxyValues = {",
        "  HTTP_PROXY: process.env.AAMP_TASK_HTTP_PROXY,",
        "  HTTPS_PROXY: process.env.AAMP_TASK_HTTPS_PROXY,",
        "};",
        "for (const [key, value] of Object.entries(configuredProxyValues)) {",
        "  if (!value) continue;",
        "  env[key] = value;",
        "  env[key.toLowerCase()] = value;",
        "}",
      ].join('\n'));
    return { ...result, source: replaced };
  }
  if (url.endsWith('/aamp-acp-bridge/dist/acpx-client.js')) {
    if (!source.includes('export class AcpxClient')) {
      throw new Error('AAMP compatibility: unsupported AcpxClient export; review upstream update before starting');
    }
    return {
      ...result,
      source: source + `\nimport { patchAcpxClient } from ${JSON.stringify(worktreePatchUrl)};\npatchAcpxClient(AcpxClient);\n`,
    };
  }
  if (url.endsWith('/aamp-acp-bridge/dist/agent-bridge.js')) {
    if (!source.includes('export class AgentBridge')) {
      throw new Error('AAMP compatibility: unsupported AgentBridge export; review upstream update before starting');
    }
    return {
      ...result,
      source: source + `\nimport { patchAgentBridge } from ${JSON.stringify(worktreePatchUrl)};\npatchAgentBridge(AgentBridge);\n`,
    };
  }
  return result;
}
