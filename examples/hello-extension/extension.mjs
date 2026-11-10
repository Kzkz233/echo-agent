// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
let settings = {};
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  let result;
  if (request.method === 'echo/settingsChanged') {
    settings = request.params.settings;
    continue;
  }
  if (request.method === 'echo/initialize') {
    settings = request.params.settings ?? {};
    result = {
      operations: [
        {
          name: 'hello.greet',
          description: 'Return a local greeting without inference',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          permission: 'hello.read',
          mcp: true,
        },
      ],
    };
  } else if (request.method === 'echo/invoke' && request.params.name === 'hello.greet')
    result = { text: `${settings.greeting ?? 'Hello'}, ${request.params.input.name}!` };
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Unknown operation' },
      }) + '\n',
    );
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
