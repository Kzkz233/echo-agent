import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const type = 'reading.reminders',
  event = 'reading.due',
  checkpoint = 'reading.checkpoint';
const tasks = new Map(),
  calls = new Map(),
  running = new Set();
let lease;
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

function notify(task, requestId) {
  if (lease || running.has(task.id)) throw Error('Reading reminder is draining');
  running.add(task.id);
  const id = randomUUID();
  const done = new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
  send({
    id,
    method: 'echo/call',
    params: {
      name: 'automation.dispatch',
      input: {
        action: 'conversation',
        kind: event,
        requestId,
        conversationId: task.conversationId,
        text: task.name,
        task: { type, id: task.id },
        outputTargets: task.outputTargets,
      },
    },
  });
  return done.finally(() => running.delete(task.id));
}

async function provide(provider, input) {
  if (provider === event) return { action: 'conversation', messageSource: 'trigger' };
  if (provider === checkpoint) {
    if (input.action === 'resume') {
      if (lease === input.requestId) lease = undefined;
      return { blockers: [] };
    }
    if (lease && lease !== input.requestId) throw Error('Conflicting restart');
    lease = input.requestId;
    return { blockers: running.size ? ['阅读提醒正在提交'] : [] };
  }
  if (provider !== type) throw Error('Unknown provider');
  switch (input.action) {
    case 'catalog':
      return {
        catalog: {
          scope: 'character',
          fields: [{ key: 'name', kind: 'text', label: '书名' }],
          defaults: { enabled: true },
          canRun: true,
          items:
            input.view === 'definition'
              ? []
              : [...tasks.values()].map((task) => ({
                  id: task.id,
                  name: task.name,
                  enabled: task.enabled,
                  state: running.has(task.id) ? 'running' : 'waiting',
                  personaId: task.personaId,
                  settings: task,
                })),
        },
      };
    case 'save':
      tasks.set(input.id, { ...input.settings, id: input.id });
      return {};
    case 'run': {
      const task = tasks.get(input.id);
      if (!task?.enabled) throw Error('Inactive reading task');
      await notify(task, input.requestId);
      return {};
    }
    default:
      throw Error('Unknown task action');
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const call = calls.get(message.id);
    if (call) {
      calls.delete(message.id);
      if (message.error) call.reject(Error(message.error.message));
      else call.resolve(message.result);
    }
    return;
  }
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === 'echo/initialize')
      result = {
        providers: [
          { point: 'core.automation.types@1', id: type, label: '阅读提醒' },
          { point: 'core.automation.signals@3', id: event, label: '阅读提醒' },
          { point: 'core.lifecycle.participants@1', id: checkpoint, label: '阅读提醒' },
        ],
      };
    else if (message.method === 'echo/provide')
      result = await provide(message.params.id, message.params.input);
    else throw Error('Unknown request');
    send({ id: message.id, result });
  } catch (e) {
    send({ id: message.id, error: { code: -32000, message: e.message } });
  }
});
