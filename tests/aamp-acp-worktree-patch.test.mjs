import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  featureSlugFromTaskTitle,
  patchAcpxClient,
  patchAgentBridge,
  prepareTaskIsolation,
  slugifyTaskTitle,
  taskHash,
} from '../scripts/aamp-acp-worktree-patch.mjs';

const envKeys = [
  'AAMP_CODEX_WORKTREE_ENABLED',
  'AAMP_CODEX_TASK_DIR',
  'AAMP_CODEX_WORKTREE_ROOT',
  'AAMP_CODEX_WORKTREE_BASE_REF',
  'AAMP_CODEX_WORKTREE_BRANCH_PREFIX',
  'AAMP_CODEX_WORKTREE_METADATA_DIR',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function configureIsolation(directory) {
  const repository = join(directory, 'repo');
  const taskDir = join(directory, 'tasks');
  const worktreeRoot = join(directory, 'worktrees');
  const metadataDir = join(directory, 'metadata');
  const projectMap = join(directory, 'project-map.yaml');
  const globalAgents = join(directory, 'AGENTS.md');
  execFileSync('git', ['init', '-b', 'main', repository]);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'AAMP test']);
  writeFileSync(join(repository, 'README.md'), 'base\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'base']);
  writeFileSync(projectMap, `projects:\n  food:\n    root: ${repository}\n`);
  writeFileSync(globalAgents, '# Global test instructions\n- Run the acceptance checks.\n');
  mkdirSync(taskDir, { recursive: true });
  Object.assign(process.env, {
    AAMP_CODEX_WORKTREE_ENABLED: '1',
    AAMP_CODEX_PROJECT_MAP: projectMap,
    AAMP_CODEX_GLOBAL_AGENTS: globalAgents,
    AAMP_CODEX_TASK_DIR: taskDir,
    AAMP_CODEX_WORKTREE_ROOT: worktreeRoot,
    AAMP_CODEX_WORKTREE_BASE_REF: 'main',
    AAMP_CODEX_WORKTREE_BRANCH_PREFIX: 'tester/agent',
    AAMP_CODEX_WORKTREE_METADATA_DIR: metadataDir,
  });
  return { repository, taskDir, worktreeRoot, metadataDir };
}

describe('AAMP ACP worktree compatibility', () => {
  it('keeps task feature names short and drops opaque Feishu identifiers', () => {
    const title = 'Feishu DM from ou_411e315ef3c8996291b76c41ef44b276';

    expect(featureSlugFromTaskTitle(title)).toBe('feishu-dm-from-ou');
  });

  it('routes each named ACP session to its registered cwd', () => {
    class FakeAcpxClient {
      constructor() { this.cwd = '/default'; }
      buildAcpxArgs(_agent, args) {
        return ['--approve-all', '--cwd', this.cwd, 'agent', ...args];
      }
    }
    patchAcpxClient(FakeAcpxClient);
    const client = new FakeAcpxClient();
    client.setAampSessionCwd('task-session', '/task/worktree');

    expect(client.buildAcpxArgs('agent', ['prompt', '-s', 'task-session', 'hello']).slice(0, 3))
      .toEqual(['--approve-all', '--cwd', '/task/worktree']);
    expect(client.buildAcpxArgs('agent', ['sessions', 'close', 'task-session']).slice(0, 3))
      .toEqual(['--approve-all', '--cwd', '/task/worktree']);
    expect(client.buildAcpxArgs('agent', ['prompt', '-s', 'other', 'hello']).slice(0, 3))
      .toEqual(['--approve-all', '--cwd', '/default']);
  });

  it('creates and idempotently reuses a task file, branch, and worktree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aamp-worktree-'));
    try {
      const paths = configureIsolation(directory);
      const task = { taskId: 'task/中文-123', title: '修复登录 callback', bodyText: '项目：food\n实现并测试。' };
      const first = await prepareTaskIsolation(task);
      const second = await prepareTaskIsolation(task);

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.worktreePath).toBe(first.worktreePath);
      expect(first.worktreePath).toBe(
        join(paths.worktreeRoot, 'food', `wt-callback-${taskHash(task.taskId)}`),
      );
      expect(first.branch).toBe(`tester/agent/food/callback-${taskHash(task.taskId)}`);
      expect(existsSync(first.taskFile)).toBe(true);
      expect(readFileSync(first.taskFile, 'utf8')).toContain('实现并测试。');
      expect(readFileSync(first.taskFile, 'utf8')).toContain('Global test instructions');
      expect(git(first.worktreePath, ['branch', '--show-current'])).toBe(first.branch);
      expect(git(paths.repository, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2);
      expect(slugifyTaskTitle(task.title)).toBe('callback');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the official task handler with a unique session and isolated prompt context', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aamp-agent-worktree-'));
    try {
      configureIsolation(directory);
      class FakeAcpxClient {
        constructor() { this.cwd = '/default'; }
        buildAcpxArgs(_agent, args) {
          return ['--approve-all', '--cwd', this.cwd, 'agent', ...args];
        }
      }
      patchAcpxClient(FakeAcpxClient);
      class FakeAgentBridge {
        constructor() {
          this.name = 'codex';
          this.sessionName = 'aamp-codex';
          this.client = {};
          this.stopping = false;
          this.activeTaskSessions = new Map();
          this.settledTaskLifecycles = new Map();
          this.sessionNames = new Set();
          this.acpx = new FakeAcpxClient();
        }
        resolveTaskSessionName() { return this.sessionName; }
        async ensureAcpSession(sessionName) {
          this.sessionNames.add(sessionName);
          return sessionName;
        }
        async closeAcpSession(sessionName) {
          this.closedArgs = this.acpx.buildAcpxArgs('agent', ['sessions', 'close', sessionName]);
        }
        async handleTask(task) {
          const sessionName = this.resolveTaskSessionName(task);
          await this.ensureAcpSession(sessionName);
          return {
            task,
            sessionName,
            promptArgs: this.acpx.buildAcpxArgs('agent', ['prompt', '-s', sessionName, task.bodyText]),
          };
        }
      }
      patchAgentBridge(FakeAgentBridge);
      const bridge = new FakeAgentBridge();
      const result = await bridge.handleTask({
        taskId: 'task-123',
        messageId: 'message-123',
        from: 'sender@example.com',
        title: 'Implement callback',
        bodyText: '项目：food\nOriginal request',
      });

      expect(result.sessionName).toMatch(/^aamp-codex-task-/);
      expect(result.task.bodyText).toContain('## Local task isolation');
      expect(result.task.bodyText).toContain('Original request');
      expect(result.task.bodyText).toContain('Global test instructions');
      expect(result.promptArgs[2]).toMatch(/\/worktrees\/food\/wt-implement-callback-/);
      expect(bridge.closedArgs[2]).toBe(result.promptArgs[2]);
      expect(bridge.sessionNames.size).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not create worktrees while replaying terminal history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aamp-terminal-replay-'));
    try {
      const paths = configureIsolation(directory);
      class FakeAgentBridge {
        constructor() {
          this.sessionName = 'aamp-codex';
          this.client = {
            hydrateTaskDispatch: async () => ({
              threadHistory: [{ intent: 'task.result' }],
            }),
          };
          this.stopping = false;
          this.activeTaskSessions = new Map();
          this.settledTaskLifecycles = new Map();
          this.sessionNames = new Set();
          this.acpx = {};
        }
        resolveTaskSessionName() { return this.sessionName; }
        async ensureAcpSession() {}
        async closeAcpSession() {}
        async handleTask() { return 'official-skip'; }
      }
      patchAgentBridge(FakeAgentBridge);
      const bridge = new FakeAgentBridge();
      const result = await bridge.handleTask({ taskId: 'settled', title: 'Done', bodyText: '项目：food' }, { historical: true });

      expect(result).toBe('official-skip');
      expect(existsSync(paths.metadataDir)).toBe(false);
      expect(existsSync(paths.worktreeRoot)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves unlabelled tasks in the official path and rejects unknown project routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aamp-unmapped-'));
    try {
      const paths = configureIsolation(directory);
      expect(await prepareTaskIsolation({ taskId: 'no-project', title: 'Chat', bodyText: '请回复我。' }))
        .toBeUndefined();
      await expect(prepareTaskIsolation({ taskId: 'unknown-project', title: 'Task', bodyText: '项目：unknown\n执行。' }))
        .rejects.toThrow('project "unknown" is not mapped');
      expect(existsSync(paths.worktreeRoot)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
