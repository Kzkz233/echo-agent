import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { storageLocation } from '../../packages/kernel/storage.ts';
import { version } from '../../packages/contracts/version.ts';

const help = `Echo Agent ${version}

  echo-agent doctor
  echo-agent roles
  echo-agent tasks
  echo-agent task status TYPE ID [--request-id ID]
  echo-agent task run TYPE ID [--request-id ID] [--wait]
  echo-agent chat --role ID "Message" [--no-wait]
  echo-agent chat --conversation ID "Message" [--no-wait]
  echo-agent chat-status REQUEST_ID

Options: --json, --data-dir PATH, --wait-seconds SECONDS, --help
Start Echo Agent before running a command. Review supports --wait. Chat waits by default.
`;

const { values: options, positionals: [command, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
    'data-dir': { type: 'string' },
    'request-id': { type: 'string' },
    role: { type: 'string' },
    conversation: { type: 'string' },
    wait: { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    'wait-seconds': { type: 'string' },
  },
});
type Result = { state?: string; error?: string; text?: string; requestId?: string; runId?: string };
let submitted: string | undefined;

async function run() {
  if (options.version) return options.json ? { version } : version;
  if (options.help || !command) return help;
  const anchor = resolve(options['data-dir'] ?? process.env.ECHO_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Echo'));
  const directory = await storageLocation(anchor);
  let connection: { url: string; token: string };
  try {
    connection = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(connection.url) ||
      typeof connection.token !== 'string' || !connection.token) throw new Error();
  } catch {
    throw new Error('Echo Agent is not running at this data directory. Start the app or check --data-dir.');
  }
  const rpc = async (method: string, params: object = {}) => {
    let response: Response;
    try {
      response = await fetch(connection.url + '/cli', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      throw new Error('Could not reach the local Echo Agent backend.');
    }
    const body = await response.json().catch(() => undefined);
    if (body?.error) throw new Error(body.error.message);
    if (!response.ok || body?.jsonrpc !== '2.0') throw new Error('Local backend did not accept the CLI request. Check the installed Echo version.');
    return body.result;
  };
  const waitSeconds = Number(options['wait-seconds'] ?? 300);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 1800)
    throw new Error('--wait-seconds must be between 1 and 1800.');
  const waitFor = async (read: () => Promise<Result>, done: (result: Result) => boolean) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const result = await read();
      if (done(result)) return result;
      if (Date.now() >= deadline) throw new Error('Stopped waiting. Check the saved request status to see whether it finishes.');
      await sleep(750);
    }
  };
  if (['doctor', 'roles', 'tasks'].includes(command) && args.length === 0) return rpc(command);
  if (command === 'task' && args.length === 3 && ['status', 'run'].includes(args[0])) {
    const [action, type, id] = args;
    const params = { type, id, requestId: options['request-id'] };
    if (action === 'status') return rpc('task.status', params);
    if (options.wait && type !== 'review.policies') throw new Error('--wait is available for memory Review tasks.');
    const requestId = params.requestId ?? randomUUID();
    submitted = requestId;
    const accepted = await rpc('task.run', { ...params, requestId });
    return options.wait
      ? waitFor(() => rpc('task.status', { ...params, requestId }),
        (result) => Boolean(result.runId && !['pending', 'running'].includes(result.state ?? '')))
      : accepted;
  }
  if (command === 'chat-status' && args.length === 1)
    return rpc('chat.status', { requestId: args[0] });
  if (command === 'chat' && args.length > 0) {
    const requestId = options['request-id'] ?? randomUUID();
    submitted = requestId;
    const receipt = await rpc('chat.send', {
      role: options.role, conversationId: options.conversation, requestId, text: args.join(' '),
    });
    if (options['no-wait']) return receipt;
    const result = await waitFor(() => rpc('chat.status', { requestId }),
      (result) => !['queued', 'running'].includes(result.state ?? ''));
    if (!options.json && result.state === 'succeeded' && result.text) return result.text;
    return result;
  }
  throw new Error('Invalid command. Run echo-agent --help.');
}

try {
  const result = await run();
  if (typeof result !== 'string' && ['failed', 'unknown', 'cancelled', 'paused'].includes(result?.state))
    process.exitCode = 1;
  console.log(typeof result === 'string' ? result.trimEnd() : JSON.stringify(result, null, options.json ? 0 : 2));
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : 'Echo CLI request failed.';
  if (options.json) console.log(JSON.stringify({ error: message, requestId: submitted }));
  else console.error(submitted ? message + '\nRequest ID: ' + submitted : message);
}
