import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AAMP_COMMAND_ACTION_KIND,
  AAMP_TASK_HIDE_ACTION_KIND,
  buildDirectTaskCard,
  buildHelpCard,
  buildRecentCard,
  buildStatusCard,
  buildTaskCommandCard,
  buildThreadsOverviewCard,
  buildUsageCard,
  parseAampCommand,
  patchAampCommands,
  readAampCanonicalTaskStates,
} from '../scripts/aamp-command-patch.mjs';

const temporaryDirectories = [];
const environmentKeys = [
  'AAMP_COMMAND_ACPX_SESSIONS_DIR',
  'AAMP_COMMAND_CODEX_SESSIONS_DIR',
  'AAMP_COMMAND_CONFIG_PATH',
  'AAMP_CODEX_WORKTREE_METADATA_DIR',
  'AAMP_TASK_STATE_HOME',
  'AAMP_LOG_DIR',
];

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AAMP Feishu slash commands', () => {
  it('keeps terminal AAMP state when replay logs contain a later non-terminal ack', () => {
    const root = mkdtempSync(join(tmpdir(), 'aamp-canonical-'));
    temporaryDirectories.push(root);
    const stateHome = join(root, 'state');
    const logDir = join(root, 'logs', 'runs', 'run-1');
    mkdirSync(join(stateHome, 'runtime-v1', 'binding'), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(stateHome, 'runtime-v1', 'binding', 'state.json'), JSON.stringify({
      tasks: {
        task: {
          taskId: 'task-terminal',
          status: 'completed',
          updatedAt: '2026-09-13T10:00:00.000Z',
          outputText: '已完成',
        },
      },
    }));
    writeFileSync(join(logDir, 'acp.jsonl'), [
      JSON.stringify({ type: 'task.completed', taskId: 'task-terminal', timestamp: '2026-09-13T10:00:00.000Z' }),
      JSON.stringify({ type: 'task.received', taskId: 'task-terminal', timestamp: '2026-09-13T11:00:00.000Z' }),
    ].join('\n'));
    process.env.AAMP_TASK_STATE_HOME = stateHome;
    process.env.AAMP_LOG_DIR = join(root, 'logs');

    expect(readAampCanonicalTaskStates()['task-terminal']).toMatchObject({
      status: 'completed',
      outputText: '已完成',
    });
  });

  it('parses the supported simple commands and leaves unknown commands alone', () => {
    expect(parseAampCommand('/status')).toMatchObject({ command: 'status', args: [] });
    expect(parseAampCommand('/cancel')).toMatchObject({ command: 'cancel', args: [] });
    expect(parseAampCommand('/usage')).toMatchObject({ command: 'usage', args: [] });
    expect(parseAampCommand('/recent')).toMatchObject({ command: 'recent', args: [] });
    expect(parseAampCommand('/help')).toMatchObject({ command: 'help', args: [] });
    expect(parseAampCommand('/tasks task-123')).toMatchObject({ command: 'tasks', args: ['task-123'] });
    expect(parseAampCommand('/threads --project food --search "fix bug"')).toMatchObject({
      command: 'threads',
      args: ['--project', 'food', '--search', 'fix bug'],
    });
    expect(parseAampCommand('/thread')).toMatchObject({ command: 'thread', args: [] });
    expect(parseAampCommand('/events task-123')).toMatchObject({ command: 'events', args: ['task-123'] });
    expect(parseAampCommand('@Codex /recent')).toMatchObject({ command: 'recent', args: [] });
    expect(parseAampCommand('/not-a-command')).toBeUndefined();
    expect(parseAampCommand('please /status')).toBeUndefined();
  });

  it('intercepts commands before normal AAMP task dispatch', async () => {
    const runtime = createRuntime();

    await runtime.handleIncomingMessage(message('/recent'));

    expect(runtime.forwarded).toBe(false);
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
    expect(runtime.channel.send.mock.calls[0][0]).toBe('chat-1');
    expect(runtime.channel.send.mock.calls[0][1].card.body.elements[0].content).toContain('最近任务');
    expect(runtime.channel.send.mock.calls[0][2]).toBeUndefined();
    expect(runtime.persisted).toBe(1);

    await runtime.handleIncomingMessage(message('普通任务'));
    expect(runtime.forwarded).toBe(true);
  });

  it('adds received and thinking reactions around ordinary AAMP tasks', async () => {
    const runtime = createRuntime();

    await runtime.handleIncomingMessage(message('普通任务'));
    for (let attempt = 0; attempt < 10 && runtime.channel.addReaction.mock.calls.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(runtime.channel.addReaction.mock.calls).toEqual([
      ['message-普通任务', 'Get'],
      ['message-普通任务', 'Think'],
    ]);
  });

  it('intercepts /help and lists every supported slash command', async () => {
    const runtime = createRuntime();

    await runtime.handleIncomingMessage(message('/help'));

    const card = runtime.channel.send.mock.calls[0][1].card;
    const content = card.body.elements[0].content;
    expect(content).toContain('Codex 全局命令');
    expect(content).toContain('/help');
    expect(content).toContain('/status');
    expect(content).toContain('/usage');
    expect(content).toContain('/recent');
    expect(content).toContain('/tasks <任务ID>');
    expect(content).toContain('/cancel [任务ID]');
    expect(content).toContain('/threads [筛选参数]');
    expect(content).not.toContain('`/thread` 查看');
    expect(content).toContain('/task <任务ID>');
    expect(runtime.forwarded).toBe(false);

    const actions = card.body.elements.find((element) => element.element_id === 'help_actions');
    expect(actions.columns.map((column) => column.elements[0].text.content)).toEqual([
      '/status',
      '/usage',
      '/recent',
    ]);
    expect(actions.columns.map((column) => column.elements[0].value.command)).toEqual([
      'status',
      'usage',
      'recent',
    ]);
    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'help-card',
      action: { value: actions.columns[0].elements[0].value },
    });
    expect(runtime.channel.send).toHaveBeenCalledTimes(2);
    expect(runtime.channel.send.mock.calls[1][1].card.body.elements[0].content).toContain('Codex 全局状态');

    const directCard = buildHelpCard(runtime);
    expect(directCard.body.elements[0].content).toContain('/help');
    runtime.globalTaskMode = 'direct';
    expect(buildHelpCard(runtime).body.elements[0].content).toContain('/thread');
  });

  it('keeps direct task actions visible while separating long task content', () => {
    const runtime = createRuntime();
    const card = buildDirectTaskCard(runtime, {
      bridge_task_id: 'bridge-direct-1',
      status: 'RUNNING',
      text: '检查仓库并运行测试',
      last_progress_text: '正在执行 pnpm test',
      thread_id: 'thread-1',
      created_at: '2026-09-14T00:00:00.000Z',
      updated_at: '2026-09-14T00:01:00.000Z',
    }, ['screen.png']);

    expect(card.body.elements.some((element) => element.tag === 'collapsible_panel'))
      .toBe(true);
    const actions = card.body.elements.find((element) => element.element_id === 'direct_task_actions');
    expect(actions.columns.map((column) => column.elements[0].text.content)).toEqual([
      '查看详情', '事件', '中断',
    ]);
    expect(actions.columns[0].elements[0].value).toMatchObject({
      kind: 'aamp_command',
      command: 'tasks',
      taskId: 'bridge-direct-1',
    });
  });

  it('shows AAMP tasks and App/CLI threads from the mode-independent /threads command', async () => {
    const runtime = createRuntime();
    runtime.queryCodexThreads = vi.fn(async (args) => {
      expect(args).toEqual(['--project', 'food', '--search', 'fix bug']);
      return {
        items: [{
          id: 'thr-cli',
          preview: 'Fix bug from CLI',
          source: 'cli',
          cwd: '/tmp/food',
          status: { type: 'idle' },
          updatedAt: 1757030400,
        }],
        total: 1,
        nextCursor: null,
      };
    });

    await runtime.handleIncomingMessage(message('/threads --project food --search "fix bug"'));

    expect(runtime.forwarded).toBe(false);
    expect(runtime.persisted).toBe(1);
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
    const card = runtime.channel.send.mock.calls[0][1].card;
    const content = JSON.stringify(card);
    expect(content).toContain('Codex Threads');
    expect(content).toContain('Codex App/CLI（1）');
    expect(content).toContain('thr-cli');
    expect(content).toContain('Fix bug from CLI');

    const nativeRow = card.body.elements.find((element) => element.element_id === 'threads_native_row_0');
    const nativeAction = nativeRow.columns[0].elements
      .find((element) => element.element_id === 'threads_native_actions_0')
      .columns[0].elements[0];
    expect(nativeAction).toMatchObject({
      text: { content: '查看执行' },
      value: {
        kind: 'aamp_command',
        command: 'thread',
        taskId: 'thr-cli',
        source: 'native_thread',
      },
    });

    const aampTab = card.body.elements.find((element) => element.element_id === 'threads_tabs')
      .columns[1].elements[0];
    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'threads-card',
      action: { value: aampTab.value },
    });
    for (let attempt = 0; attempt < 10 && !runtime.channel.updateCard.mock.calls.length; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const aampCard = runtime.channel.updateCard.mock.calls.at(-1)[1];
    expect(JSON.stringify(aampCard)).toContain('task-123');

    const taskRow = aampCard.body.elements.find((element) => element.element_id === 'threads_aamp_row_0');
    const detailButton = taskRow.columns[0].elements
      .find((element) => element.element_id === 'threads_task_actions_0')
      .columns[0].elements[0];
    expect(detailButton).toMatchObject({
      text: { content: '查看详情' },
      value: { kind: 'aamp_command', command: 'tasks', taskId: 'task-123' },
    });
    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'threads-card',
      action: { value: detailButton.value },
    });
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
    expect(runtime.channel.updateCard).toHaveBeenCalledWith(
      'threads-card',
      expect.objectContaining({ body: expect.objectContaining({ elements: expect.any(Array) }) }),
    );
    expect(JSON.stringify(runtime.channel.updateCard.mock.calls.at(-1)[1])).toContain('task-123');
  });

  it('opens task details from the list card action and keeps chat scoping', async () => {
    const runtime = createRuntime();
    const listCard = buildTaskCommandCard(runtime, 'chat-1', undefined);
    expect(listCard.body.elements[0].content).toContain('/tasks');

    const detailCard = buildTaskCommandCard(runtime, 'chat-1', 'task-123');
    expect(detailCard.body.elements.some((element) => element.content?.includes('task-123'))).toBe(true);
    const detailRequest = detailCard.body.elements.find((element) => element.element_id === 'task_request');
    const detailMetadata = detailCard.body.elements.find((element) => element.element_id === 'task_metadata');
    expect(detailRequest.content).toBe('测试请求');
    expect(detailRequest.content).not.toContain('提示词：');
    expect(detailMetadata.content).not.toContain('项目：');
    expect(detailMetadata.content).not.toContain('仓库：');
    expect(detailMetadata.content).toContain('worktree：');
    expect(detailMetadata.content).toContain('任务文件：');
    expect(detailMetadata.content).toContain('创建时间：');
    expect(detailMetadata.content).toContain('更新时间：');
    expect(detailCard.body.elements.indexOf(detailRequest)).toBeLessThan(detailCard.body.elements.indexOf(detailMetadata));

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'card-1',
      operator: { openId: 'user-1' },
      action: {
        value: {
          kind: AAMP_COMMAND_ACTION_KIND,
          command: 'tasks',
          taskId: 'task-123',
        },
      },
    });
    expect(runtime.cardForwarded).toBe(false);
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
    expect(runtime.channel.send.mock.calls[0][1].card.body.elements[0].content).toContain('task-123');

    const hidden = buildTaskCommandCard(runtime, 'other-chat', 'task-123');
    expect(hidden.body.elements[0].content).toContain('没有找到');
  });

  it('opens native thread execution details in a new card', async () => {
    const runtime = createRuntime();
    runtime.queryCodexThread = vi.fn(async (threadId) => ({
      thread: {
        id: threadId,
        preview: 'CLI execution detail',
        source: 'cli',
        cwd: '/tmp/food',
        status: { type: 'idle' },
        updatedAt: 1757030400,
        turns: [{ type: 'command_execution', command: 'npm test', status: 'completed' }],
      },
    }));
    const card = buildThreadsOverviewCard(runtime, 'chat-1', {
      nativeThreads: [{
        id: 'thr-cli-detail',
        preview: 'CLI execution detail',
        source: 'cli',
        cwd: '/tmp/food',
        status: { type: 'idle' },
        updatedAt: 1757030400,
      }],
      nativeCount: 1,
    });
    const action = card.body.elements
      .find((element) => element.element_id === 'threads_native_row_0')
      .columns[0].elements
      .find((element) => element.element_id === 'threads_native_actions_0')
      .columns[0].elements[0];

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'threads-card-native',
      action: { value: action.value },
    });
    expect(runtime.queryCodexThread).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 10 && !runtime.queryCodexThread.mock.calls.length; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runtime.queryCodexThread).toHaveBeenCalledWith('thr-cli-detail');
    expect(runtime.channel.updateCard).not.toHaveBeenCalled();
    expect(runtime.channel.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtime.channel.send.mock.calls[0][1].card)).toContain('Codex Thread 执行详情');
  });

  it('renders compact task rows with a prompt preview and an interrupt action', async () => {
    const runtime = createRuntime();
    runtime.state.tasks['task-done'] = {
      taskId: 'task-done',
      chatId: 'chat-1',
      status: 'completed',
      title: '已完成任务',
      userMessageText: '已经完成的请求',
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T08:00:00.000Z',
    };
    runtime.state.tasks['task-long'] = {
      taskId: 'task-long',
      chatId: 'chat-1',
      status: 'completed',
      title: '长提示词任务',
      userMessageText: '这是一条超过一行的任务提示词，用来验证默认收起和点击展开全部内容。',
      createdAt: '2026-09-12T07:00:00.000Z',
      updatedAt: '2026-09-12T07:00:00.000Z',
    };

    const card = buildRecentCard(runtime, 'chat-1');
    const rows = card.body.elements.filter((element) => element.tag === 'column_set' && element.element_id.startsWith('recent_row_'));
    const liveRow = rows.find((row) => row.columns[0].elements[0].content.includes('task-123'));
    const doneRow = rows.find((row) => row.columns[0].elements[0].content.includes('task-done'));
    const longRow = rows.find((row) => row.columns[0].elements[0].content.includes('task-long'));
    const liveActions = liveRow.columns[0].elements.find((element) => element.element_id === 'recent_actions_0');
    const doneActions = doneRow.columns[0].elements.find((element) => element.element_id === 'recent_actions_1');
    const longPrompt = longRow.columns[0].elements.find((element) => element.element_id === 'recent_prompt_2');
    const livePrompt = liveRow.columns[0].elements.find((element) => element.element_id === 'recent_prompt_0');
    const liveMetadata = liveRow.columns[0].elements.find((element) => element.element_id === 'recent_meta_0');
    const doneHeader = doneRow.columns[0].elements[0].content;

    expect(JSON.stringify(card)).not.toContain('当前列表按更新时间倒序');
    expect(liveRow.columns[0].elements[0].content).toContain('执行中');
    expect(liveRow.columns[0].elements[0].content).toContain('task-123');
    expect(liveRow.columns[0].elements[0].content).toContain("font color='blue'");
    expect(livePrompt.content).toBe('测试请求');
    expect(livePrompt.content).not.toContain('提示词：');
    expect(liveMetadata.content).toContain('分支名：xiajian/agent/test-task');
    expect(liveMetadata.content).toContain('更新时间：');
    expect(doneHeader).toContain('已完成');
    expect(doneHeader).toContain('task-done');
    expect(doneHeader).not.toContain('ID：');
    expect(liveActions.columns.slice(1).map((column) => column.elements[0].text.content)).toEqual(['详情', '中断', '屏蔽']);
    expect(liveActions.columns[2].elements[0].value).toMatchObject({
      kind: 'task_cancel',
      taskId: 'task-123',
      source: 'recent',
    });
    expect(doneActions.columns.slice(1).map((column) => column.elements[0].text.content)).toEqual(['详情', '屏蔽']);
    expect(longRow.columns[0].elements[0].content).not.toContain('ID：');
    expect(longRow.columns[0].elements[0].content).not.toContain('提示词：');
    expect(longPrompt).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(longPrompt.header.title.content).not.toContain('提示词：');
    expect(longPrompt.header.title.content).toContain('这是一条超过一行');
    expect(longPrompt.elements[0].content).toContain('超过一行');

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'recent-card-1',
      action: { value: liveActions.columns[2].elements[0].value },
    });

    expect(runtime.cancelledTaskId).toBe('task-123');
    expect(runtime.channel.updateCard).toHaveBeenCalledWith(
      'recent-card-1',
      expect.objectContaining({ body: expect.objectContaining({ elements: expect.any(Array) }) }),
    );
    const refreshed = runtime.channel.updateCard.mock.calls[0][1];
    expect(JSON.stringify(refreshed)).not.toContain('recent_cancel_');
  });

  it('merges AAMP and direct tasks while exposing interrupt only for the active runtime mode', async () => {
    const runtime = createRuntime();
    runtime.listGlobalTasks = () => [{
      taskId: 'bridge-direct-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceMode: 'direct',
      status: 'running',
      title: 'Codex 直连任务',
      userMessageText: '直连请求',
      createdAt: '2026-09-12T10:30:00.000Z',
      updatedAt: '2026-09-12T10:30:00.000Z',
    }];

    const aampCard = buildRecentCard(runtime, 'chat-1');
    const aampRows = aampCard.body.elements.filter((element) => element.element_id?.startsWith('recent_row_'));
    const aampRow = aampRows.find((row) => JSON.stringify(row).includes('task-123'));
    const directRow = aampRows.find((row) => JSON.stringify(row).includes('bridge-direct-1'));
    expect(JSON.stringify(aampRow)).toContain('接入模式：AAMP');
    expect(JSON.stringify(directRow)).toContain('接入模式：Codex 直连');
    expect(JSON.stringify(aampRow)).toContain('中断');
    expect(JSON.stringify(directRow)).not.toContain('中断');
    const directActions = directRow.columns[0].elements.find((element) => element.element_id === 'recent_actions_0');
    expect(directActions.columns.slice(1).map((column) => column.elements[0].text.content)).toEqual(['详情', '屏蔽']);

    runtime.globalTaskMode = 'direct';
    const directCard = buildRecentCard(runtime, 'chat-1');
    const directModeRows = directCard.body.elements.filter((element) => element.element_id?.startsWith('recent_row_'));
    expect(JSON.stringify(directModeRows.find((row) => JSON.stringify(row).includes('task-123')))).not.toContain('中断');
    expect(JSON.stringify(directModeRows.find((row) => JSON.stringify(row).includes('bridge-direct-1')))).toContain('中断');

    const directDetail = buildTaskCommandCard(runtime, 'chat-1', 'bridge-direct-1');
    expect(JSON.stringify(directDetail)).toContain('Codex 任务详情');
    expect(JSON.stringify(directDetail)).toContain('接入模式：Codex 直连');
    const detailActions = directDetail.body.elements.find((element) => element.element_id === 'task_actions');
    expect(detailActions.columns.map((column) => column.elements[0].text.content)).toEqual([
      '返回最近任务', '刷新详情', '中断',
      '进度', '事件', '变更', '命令', '工具',
    ]);
    expect(detailActions.columns[2].elements[0].value).toMatchObject({
      kind: 'task_cancel',
      taskId: 'bridge-direct-1',
      sourceMode: 'direct',
      source: 'detail',
    });

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'cross-mode-cancel',
      action: { value: { kind: 'task_cancel', taskId: 'bridge-direct-1', sourceMode: 'direct' } },
    });
    expect(runtime.cancelledTaskId).toBeUndefined();
  });

  it('compacts recent cards when direct diagnostics would exceed Feishu element limits', () => {
    const runtime = createRuntime();
    runtime.listGlobalTasks = () => Array.from({ length: 10 }, (_, index) => ({
      taskId: `direct-${index}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceMode: 'direct',
      status: 'completed',
      title: '直连任务',
      userMessageText: `任务 ${index}`,
      createdAt: `2026-09-12T10:${String(index).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-09-12T10:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const card = buildRecentCard(runtime, 'chat-1', 10);
    const elementCount = (value) => {
      if (!value || typeof value !== 'object') return 0;
      if (Array.isArray(value)) return value.reduce((total, item) => total + elementCount(item), 0);
      return (value.tag ? 1 : 0) + Object.values(value).reduce((total, item) => total + elementCount(item), 0);
    };
    expect(elementCount(card)).toBeLessThanOrEqual(190);
    expect(card.body.elements[0].content).toMatch(/Codex 最近任务（\d+）/);
  });

  it('hides a task from subsequent recent cards without deleting its detail', async () => {
    const runtime = createRuntime();
    const visible = buildRecentCard(runtime, 'chat-1');
    const row = visible.body.elements.find((element) => element.element_id === 'recent_row_0');
    const actions = row.columns[0].elements.find((element) => element.element_id === 'recent_actions_0');
    const hideButton = actions.columns
      .slice(1)
      .map((column) => column.elements[0])
      .find((element) => element.text.content === '屏蔽');

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'recent-card-hide',
      action: { value: hideButton.value },
    });

    expect(runtime.channel.updateCard).toHaveBeenCalledWith(
      'recent-card-hide',
      expect.objectContaining({ body: expect.objectContaining({ elements: expect.any(Array) }) }),
    );
    const hiddenCard = runtime.channel.updateCard.mock.calls[0][1];
    expect(JSON.stringify(hiddenCard)).not.toContain('task-123');
    expect(buildTaskCommandCard(runtime, 'chat-1', 'task-123').body.elements[0].content).toContain('task-123');
  });

  it('uses colors for status and keeps status actions on one row', () => {
    const runtime = createRuntime();
    const card = buildStatusCard(runtime, 'chat-1');
    const content = card.body.elements[0].content;
    expect(content).toContain("font color='green'");
    expect(content).toContain('已连接');
    expect(card.body.elements[1]).toMatchObject({ tag: 'column_set', element_id: 'status_actions' });
    expect(card.body.elements[1].columns.some((column) =>
      column.elements.some((element) => element.text?.content === '查看最近任务'))).toBe(true);
  });

  it('normalizes a JSON-serialized cancel callback before forwarding it', async () => {
    const runtime = createRuntime();

    await runtime.handleCardAction({
      chatId: 'chat-1',
      messageId: 'recent-card-serialized',
      action: {
        value: JSON.stringify({
          kind: 'task_cancel',
          taskId: 'task-123',
          source: 'recent',
        }),
      },
    });

    expect(runtime.cancelledTaskId).toBe('task-123');
  });

  it('renders account rate limits and AAMP ACP session token usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'aamp-command-'));
    temporaryDirectories.push(root);
    const acpxSessions = join(root, 'acpx-sessions');
    const codexSessions = join(root, 'codex-sessions');
    mkdirSync(acpxSessions, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    process.env.AAMP_COMMAND_ACPX_SESSIONS_DIR = acpxSessions;
    process.env.AAMP_COMMAND_CODEX_SESSIONS_DIR = codexSessions;

    writeFileSync(join(acpxSessions, 'task.json'), JSON.stringify({
      schema: 'acpx.session.v1',
      name: 'aamp-codex-task-123',
      last_used_at: '2026-09-12T10:00:00.000Z',
      acpx: { current_model_id: 'gpt-5.6-luna' },
      cumulative_token_usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
      },
      messages: [{ User: { content: [{ Text: 'Task ID: task-123' }] } }],
    }));
    writeFileSync(join(codexSessions, 'rollout.jsonl'), JSON.stringify({
      timestamp: '2026-09-12T10:01:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 18, window_minutes: 300, resets_at: 1_789_201_274 },
          secondary: { used_percent: 73, window_minutes: 10_080, resets_at: 1_789_445_221 },
          credits: { has_credits: false, unlimited: false, balance: '0' },
        },
      },
    }) + '\n');

    const runtime = createRuntime();
    const card = buildUsageCard(runtime, 'chat-1');
    const content = JSON.stringify(card);
    expect(content).toContain('5 小时窗口');
    expect(content).toContain('已用 18%');
    expect(content).toContain('输入 tokens');
    expect(content).toContain('120');
    expect(content).toContain('gpt-5.6-luna');
    expect(card.body.elements.find((element) => element.element_id === 'usage_account')).toMatchObject({
      tag: 'collapsible_panel',
      expanded: true,
    });
    const usageActions = card.body.elements.find((element) => element.element_id === 'usage_actions');
    expect(usageActions).toMatchObject({ tag: 'column_set' });
    expect(usageActions.columns.some((column) =>
      column.elements.some((element) => element.text?.content === '刷新用量'))).toBe(true);

    const detailCard = buildTaskCommandCard(runtime, 'chat-1', 'task-123');
    const taskUsage = detailCard.body.elements.find((element) => element.element_id === 'task_metadata');
    expect(taskUsage.content).toContain('Token usage: total=120 input=100 output=20');
    expect(taskUsage.content).not.toContain('ACP token 用量');
    expect(taskUsage.content).not.toContain('模型：');
    expect(taskUsage.content).not.toContain('会话：');
  });
});

function createRuntime() {
  class Runtime {
    state = {
      connectivity: { feishu: 'connected', aamp: 'connected' },
      tasks: {
        'task-123': {
          taskId: 'task-123',
          chatId: 'chat-1',
          status: 'streaming',
          statusLabel: '正在回复...',
          title: '测试任务',
          userMessageText: '测试请求',
          outputText: '处理中',
          branch: 'xiajian/agent/test-task',
          worktreePath: '/tmp/wt-test-task',
          taskFile: '/tmp/aamp-task-test-task.md',
          createdAt: '2026-09-12T09:00:00.000Z',
          updatedAt: '2026-09-12T10:00:00.000Z',
        },
        'task-other': {
          taskId: 'task-other',
          chatId: 'other-chat',
          status: 'completed',
          title: '不应展示',
          createdAt: '2026-09-12T08:00:00.000Z',
          updatedAt: '2026-09-12T08:00:00.000Z',
        },
        'task-system': {
          taskId: 'task-system',
          chatId: 'chat-1',
          status: 'completed',
          title: '系统辅助命令',
          userMessageText: '/usage',
          createdAt: '2026-09-12T07:00:00.000Z',
          updatedAt: '2026-09-12T07:00:00.000Z',
        },
      },
      dedupMessageIds: {},
    };
    config = { targetAgentEmail: 'codex@example.com' };
    channel = {
      botIdentity: { openId: 'bot-1', name: 'Codex' },
      send: vi.fn(async () => ({ messageId: 'reply-1' })),
      updateCard: vi.fn(async () => {}),
      addReaction: vi.fn(async () => 'reaction-1'),
    };
    forwarded = false;
    cardForwarded = false;
    persisted = 0;

    shouldAcceptMessage() { return true; }
    isDuplicateMessage() { return false; }
    isBridgeAuthoredMessage() { return false; }
    shouldReplyInThread() { return false; }
    sanitizeCardText(value) { return value; }
    buildCardShell(elements) { return { schema: '2.0', body: { elements } }; }
    async persistState() { this.persisted += 1; }
    async handleIncomingMessage() { this.forwarded = true; }
    async handleCardAction(event) {
      if (event?.action?.value?.kind === 'task_cancel') {
        this.cancelledTaskId = event.action.value.taskId;
        this.state.tasks[event.action.value.taskId].status = 'failed';
        this.state.tasks[event.action.value.taskId].bridgeCancelledAt = '2026-09-12T10:01:00.000Z';
        return;
      }
      if (event?.action?.value?.kind === AAMP_TASK_HIDE_ACTION_KIND) return;
      this.cardForwarded = true;
    }
  }
  patchAampCommands(Runtime);
  return new Runtime();
}

function message(content) {
  return {
    messageId: `message-${content}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'user-1',
    content,
  };
}
