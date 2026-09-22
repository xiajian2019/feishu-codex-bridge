import { describe, expect, it } from 'bun:test';

import { load } from '../scripts/aamp-runtime-loader.mjs';

describe('AAMP runtime loader', () => {
  it('forces the configured internal Relay host for persisted bindings', async () => {
    const source = [
      "const host = typeof bindingOrAgent === 'object' ? bindingOrAgent.aamp_host : DEFAULT_AAMP_HOST;",
      "const command = ['--aamp-host', binding.aamp_host,];",
      "const init = { input: JSON.stringify({ aampHost: host, agents }),};",
      "const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];",
      "proxyKeys.forEach((key) => delete env[key]);",
    ].join('\n');
    const loaded = await load(
      'file:///bridge/node_modules/@larktask/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs',
      {},
      async () => ({ format: 'module', source }),
    );
    expect(loaded.source).toContain('process.env.AAMP_TASK_AAMP_HOST || bindingOrAgent.aamp_host');
    expect(loaded.source).toContain("'--aamp-host', process.env.AAMP_TASK_AAMP_HOST || binding.aamp_host,");
    expect(loaded.source).toContain('aampHost: process.env.AAMP_TASK_AAMP_HOST || host');
    expect(loaded.source).toContain('HTTP_PROXY: process.env.AAMP_TASK_HTTP_PROXY');
    expect(loaded.source).toContain('HTTPS_PROXY: process.env.AAMP_TASK_HTTPS_PROXY');
    expect(loaded.source).toContain('env[key.toLowerCase()] = value');
  });

  it('adds SQLite persistence to the Feishu bridge runtime patch chain', async () => {
    const source = 'export class FeishuBridgeRuntime {}';
    const loaded = await load(
      'file:///bridge/node_modules/@iluolyx/aamp-feishu-bridge/dist/runtime.js',
      {},
      async () => ({ format: 'module', source }),
    );
    expect(loaded.source).toContain('patchAampSqlite');
    expect(loaded.source).toContain('patchHelpCards');
    expect(loaded.source).toContain('patchAampCommands');
  });

  it('patches the renamed AAMP bridge package used by the task-agent updater', async () => {
    const source = 'export class FeishuBridgeRuntime {}';
    const loaded = await load(
      'file:///tmp/node_modules/@zhengqilin/aamp-feishu-bridge/dist/runtime.js',
      {},
      async () => ({ format: 'module', source }),
    );
    expect(loaded.source).toContain('patchAampCommands');
  });
});
