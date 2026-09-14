import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { patchAampSqlite } from '../scripts/aamp-sqlite-patch.mjs';
import { StateDatabase } from '../src/db.ts';
import { DatabaseSync } from '../src/sqlite.ts';

describe('AAMP SQLite runtime patch', () => {
  it('writes dispatch metadata before transport and persists stream/result state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aamp-sqlite-patch-'));
    const databasePath = join(directory, 'bridge.db');
    const previousDatabase = process.env.AAMP_BRIDGE_SQLITE_PATH;
    const previousAttachments = process.env.AAMP_BRIDGE_ATTACHMENTS_DIR;
    process.env.AAMP_BRIDGE_SQLITE_PATH = databasePath;
    process.env.AAMP_BRIDGE_ATTACHMENTS_DIR = join(directory, 'attachments');

    const seedDb = new StateDatabase(databasePath);
    const direct = seedDb.ingestDirectMessage({
      sourceEventId: 'direct-event',
      eventType: 'im.message.receive_v1',
      messageId: 'direct-message',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderId: 'ou_user',
      text: '直连任务',
      sessionKey: 'chat:oc_chat',
    });
    seedDb.close();

    class FakeRuntime {
      constructor() {
        this.state = { tasks: {} };
        this.cardSessions = new Map();
        this.aamp = { on: () => undefined };
      }

      async dispatchTask(task) {
        this.state.tasks[task.taskId] = task;
      }

      async handleTaskAck() {}

      async handleTaskStreamOpened() {}

      async handleStreamEvent(taskId, event) {
        this.state.tasks[taskId].streamText = event.payload.text;
      }

      async handleTaskResult(task) {
        this.state.tasks[task.taskId].outputText = task.output;
      }

      async handleTaskHelp() {}

      async handleCardAction() {}

      async startStreamCardSession(task) {
        this.cardSessions.set(task.taskId, { cardId: 'cardkit-1', messageId: 'om-card-1' });
      }

      async sendOrUpdateTerminalCard() {}

      async sendHelpCard() {}

      registerAampHandlers() {}

      async stop() {}
    }

    try {
      patchAampSqlite(FakeRuntime);
      const runtime = new FakeRuntime();
      const task = {
        taskId: 'aamp-patch-task',
        chatId: 'oc_chat',
        userMessageText: '请查看这张图',
        threadKey: 'group:oc_chat',
      };
      await runtime.dispatchTask(task, {
        bodyText: '请查看这张图',
        attachments: [{ filename: 'input.png', contentType: 'image/png', content: Buffer.from('png') }],
      });
      const dispatchDb = new DatabaseSync(databasePath, { readOnly: true });
      const dispatchRow = dispatchDb
        .prepare('SELECT last_event_json FROM aamp_tasks WHERE aamp_task_id = ?')
        .get(task.taskId);
      dispatchDb.close();
      expect(dispatchRow.last_event_json).toContain('[binary]');
      expect(dispatchRow.last_event_json).not.toContain('112,110,103');
      await runtime.startStreamCardSession(task, {});
      await runtime.handleTaskAck({ taskId: task.taskId });
      await runtime.handleStreamEvent(task.taskId, { type: 'text.delta', payload: { text: '进行中' } });
      await runtime.handleTaskResult({ taskId: task.taskId, status: 'completed', output: '完成' });
      await runtime.handleTaskAck({ taskId: task.taskId });
      expect(runtime.listGlobalTasks('oc_chat')).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: task.taskId, sourceMode: 'aamp', status: 'completed' }),
      ]));

      expect(runtime.getAampHiddenTaskIds('oc_chat')).toEqual([]);
      expect(runtime.hideAampTask(task.taskId, 'oc_chat')).toBe(true);
      expect(runtime.getAampHiddenTaskIds('oc_chat')).toEqual([task.taskId]);
      expect(runtime.getAampHiddenTaskIds('oc_other')).toEqual([]);
      expect(runtime.globalTaskMode).toBe('aamp');
      expect(runtime.listGlobalTasks('oc_chat')).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: task.taskId, sourceMode: 'aamp', status: 'completed' }),
        expect.objectContaining({ taskId: direct.task.bridge_task_id, sourceMode: 'direct', status: 'queued' }),
      ]));
      await runtime.stop();

      const db = new DatabaseSync(databasePath, { readOnly: true });
      const row = db.prepare('SELECT * FROM aamp_tasks WHERE aamp_task_id = ?').get(task.taskId);
      const hiddenRows = db.prepare('SELECT chat_id, aamp_task_id FROM aamp_hidden_tasks').all();
      db.close();
      expect(row).toMatchObject({
        aamp_task_id: task.taskId,
        chat_id: 'oc_chat',
        status: 'done',
        card_id: 'cardkit-1',
        card_message_id: 'om-card-1',
        last_delta_text: '完成',
      });
      expect(JSON.parse(row.image_local_paths)).toHaveLength(1);
      expect(existsSync(JSON.parse(row.image_local_paths)[0])).toBe(true);
      expect(hiddenRows).toEqual([{
        chat_id: 'oc_chat',
        aamp_task_id: task.taskId,
      }]);
    } finally {
      if (previousDatabase === undefined) delete process.env.AAMP_BRIDGE_SQLITE_PATH;
      else process.env.AAMP_BRIDGE_SQLITE_PATH = previousDatabase;
      if (previousAttachments === undefined) delete process.env.AAMP_BRIDGE_ATTACHMENTS_DIR;
      else process.env.AAMP_BRIDGE_ATTACHMENTS_DIR = previousAttachments;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
