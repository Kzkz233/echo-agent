import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { storageLocation } from '../../packages/kernel/storage.ts';
import { version } from '../../packages/contracts/version.ts';
import { buildInfo } from '../../packages/contracts/build.ts';
import { localUpdateStatus } from '../../packages/kernel/cli-updates.ts';

const help = `Echo Agent ${version}

  echo-agent doctor
  echo-agent roles
  echo-agent tasks
  echo-agent task status TYPE ID [--request-id ID]
  echo-agent task run TYPE ID [--request-id ID] [--wait]
  echo-agent chat --role ID "Message" [--no-wait]
  echo-agent chat --conversation ID "Message" [--no-wait]
  echo-agent chat-status REQUEST_ID
  echo-agent status | logs | plugins | models | mcp
  echo-agent app start | stop | restart | cancel
  echo-agent jobs list | show ID | watch ID | pause ID | resume ID | cancel ID
  echo-agent knowledge vaults | import PATH --vault ID | search QUERY --vault ID
  echo-agent knowledge inspect ID --vault ID
  echo-agent knowledge pipeline show | save --input FILE
  echo-agent knowledge migrate plan --vault ID [--input POLICY_FILE] [--reparse]
  echo-agent knowledge migrate apply PLAN_ID | status | pause | resume ID | rollback ID
  echo-agent update check | stage [PATH] | apply | status | rollback
  echo-agent commands | command ID --input FILE

Options: --json, --data-dir PATH, --wait-seconds SECONDS, --help
Chat waits by default. Task --wait uses the task provider's execution receipt.
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
    input: { type: 'string' }, vault: { type: 'string', multiple: true }, folder: { type: 'string' },
    strategy: { type: 'string' }, reparse: { type: 'boolean' }, app: { type: 'string' },
    'stream-json': { type: 'boolean' }, 'run-id': { type: 'string' },
    attach: { type: 'string', multiple: true },
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
  const executable = options.app ?? [
    ...['Echo.exe', 'echo-desktop.exe'].map(name => join(dirname(process.execPath), '..', name)),
    ...['Echo.exe', 'echo-desktop.exe'].map(name => join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Echo Agent', name)),
  ].find(existsSync);
  if (command === 'app' && args[0] === 'start') {
    if (!executable || !existsSync(executable)) throw Error('Echo desktop executable not found. Pass --app PATH.');
    const child = spawn(executable, [], { cwd: dirname(executable), env: { ...process.env, ECHO_DATA_DIR: anchor }, detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
    return { accepted: true, executable, dataDirectory: directory };
  }
  let connection: { url: string; token: string };
  try {
    connection = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(connection.url) ||
      typeof connection.token !== 'string' || !connection.token) throw new Error();
  } catch {
    if (command === 'update' && args[0] === 'status') return localUpdateStatus(executable);
    if (['doctor', 'status'].includes(command)) return { cli: buildInfo, backend: 'stopped', dataDirectory: directory,
      installation: executable ?? null, dataExists: existsSync(join(directory, 'echo.sqlite')) };
    throw new Error('Echo Agent is not running at this data directory. Start the app or check --data-dir.');
  }
  const rpc = async (method: string, params: object = {}) => {
    let response: Response;
    try {
      response = await fetch(connection.url + '/cli', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(method === 'update.stage' ? waitSeconds * 1000 : 30000),
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      if (method === 'update.status') return localUpdateStatus(executable);
      if (['doctor', 'status'].includes(command)) return { cli: buildInfo, backend: 'unreachable', dataDirectory: directory, installation: executable ?? null };
      throw new Error('Could not reach the local Echo Agent backend.');
    }
    const body = await response.json().catch(() => undefined);
    if (body?.error) throw new Error(body.error.message);
    if (!response.ok || body?.jsonrpc !== '2.0') throw new Error('Local backend did not accept the CLI request. Check the installed Echo version.');
    return body.result;
  };
  const input = async () => options.input ? JSON.parse(await readFile(resolve(options.input), 'utf8')) : {};
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
  if (['doctor', 'status', 'roles', 'tasks', 'plugins', 'models', 'mcp', 'commands'].includes(command) && args.length === 0) return rpc(command);
  if (command === 'logs') return rpc('logs', { runId: options['run-id'] });
  if (command === 'command' && args.length === 1) return rpc('command', { id: args[0], input: await input() });
  if (command === 'app') {
    if (args[0] === 'cancel') return rpc('lifecycle.cancel');
    if (['stop', 'restart'].includes(args[0])) return rpc('lifecycle.request', { action: args[0], timeoutSeconds: waitSeconds });
  }
  if (command === 'jobs') {
    if (!args.length || args[0] === 'list') return rpc('jobs');
    const find = async () => { const row = (await rpc('jobs') as any[]).find(j => j.id === args[1]); if (!row) throw Error('Job not found.'); return row; };
    if (args[0] === 'show') return find();
    if (args[0] === 'watch') {
      let previous = '';
      return waitFor(async () => { const row = await find(); const serialized = JSON.stringify(row);
        if (serialized !== previous) { previous = serialized; if (options['stream-json']) process.stdout.write(JSON.stringify({ type: 'job', data: row }) + '\n'); else process.stderr.write(row.state + (row.completed === undefined ? '' : ` ${row.completed}/${row.total}`) + '\n'); }
        return row;
      }, row => !['running', 'queued', 'pending', 'pausing'].includes(row.state ?? ''));
    }
    if (['pause', 'resume', 'cancel'].includes(args[0])) return rpc('job.control', { id: args[1], action: args[0] });
  }
  if (command === 'update') {
    if (args[0] === 'status') {
      const status = await rpc('update.status');
      if (status.backend === 'unavailable') return status;
      return { ...status, maintenance: await rpc('lifecycle.status') };
    }
    if (args[0] === 'apply') {
      const status = await rpc('update.status'); if (!status.prepared) throw Error('No staged update. Run update stage first.');
      return rpc('lifecycle.request', { action: 'update', updateId: status.prepared.id, timeoutSeconds: waitSeconds });
    }
    if (['check', 'stage', 'rollback'].includes(args[0])) return rpc('update.' + args[0], args[0] === 'stage' ? { path: args[1] } : {});
  }
  if (command === 'knowledge') {
    const vaultId = options.vault?.[0];
    if (args[0] === 'vaults') return rpc('knowledge.vaults');
    if (args[0] === 'import') return rpc('knowledge.import', { vaultId, source: resolve(args[1]), folder: options.folder, requestId: options['request-id'] ?? randomUUID() });
    if (args[0] === 'search') return rpc('knowledge.search', { query: args.slice(1).join(' '), vaultId, strategy: options.strategy ?? 'hybrid' });
    if (args[0] === 'inspect') return rpc('knowledge.inspect', { vaultId, id: args[1] });
    if (args[0] === 'pipeline') {
      const status = await rpc('pipeline.status');
      if (args[1] === 'save') return rpc('pipeline.save', { policy: await input(), expected: status.fingerprint });
      return status;
    }
    if (args[0] === 'migrate') {
      if (args[1] === 'plan') return rpc('migration.plan', { vaultIds: options.vault ?? [], policy: options.input ? await input() : undefined, refreshParsing: options.reparse ?? false });
      if (args[1] === 'apply') return rpc('migration.start', { planId: args[2], requestId: options['request-id'] ?? randomUUID() });
      if (['status', 'pause', 'resume', 'rollback'].includes(args[1])) return rpc('migration.' + args[1], args[1] === 'pause' ? {} : { id: args[2] });
    }
  }
  if (command === 'task' && args.length === 3 && ['status', 'run'].includes(args[0])) {
    const [action, type, id] = args;
    const params = { type, id, requestId: options['request-id'] };
    if (action === 'status') return rpc('task.status', params);
    const requestId = params.requestId ?? randomUUID();
    submitted = requestId;
    const accepted = await rpc('task.run', { ...params, requestId });
    if (options.wait && accepted.tracking === false) return { ...accepted, waiting: false };
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
    const text = args.length === 1 && args[0] === '-' ? await new Promise<string>((done, reject) => { let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { value += s; if (value.length > 100000) { process.stdin.destroy(); reject(Error('Input exceeds 100000 characters.')); } }); process.stdin.once('end', () => done(value)); process.stdin.once('error', reject); }) : args.join(' ');
    const receipt = await rpc('chat.send', {
      role: options.role, conversationId: options.conversation, requestId, text,
      attachments: await Promise.all((options.attach ?? []).map(async file => {
        if ((await stat(resolve(file))).size > 8 * 1024 * 1024) throw Error('Attachment exceeds 8 MB.');
        const bytes = await readFile(resolve(file)); if (bytes.length > 8 * 1024 * 1024) throw Error('Attachment exceeds 8 MB.');
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        return { name: basename(file), mediaType: mime[extname(file).toLowerCase()] ?? 'application/octet-stream', data: bytes.toString('base64') };
      })),
    });
    if (options['no-wait']) return receipt;
    const sent = new Set<string>();
    const result = await waitFor(async () => {
      const row = await rpc('chat.status', { requestId });
      if (options['stream-json']) for (const delivery of row.deliveries ?? []) {
        if (delivery.state !== 'delivered' || delivery.targetId !== 'core.chat' || sent.has(delivery.id)) continue;
        sent.add(delivery.id); process.stdout.write(JSON.stringify({ type: 'message', data: delivery }) + '\n');
      }
      return row;
    },
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
  console.log(options['stream-json'] ? JSON.stringify({ type: 'result', data: result }) : typeof result === 'string' ? result.trimEnd() : JSON.stringify(result, null, options.json ? 0 : 2));
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : 'Echo CLI request failed.';
  if (options.json) console.log(JSON.stringify({ error: message, requestId: submitted }));
  else console.error(submitted ? message + '\nRequest ID: ' + submitted : message);
}
