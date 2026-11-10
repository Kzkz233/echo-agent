import readline from 'node:readline';
const values = new Map();
const schema = { type: 'object', properties: {
  message: { type: 'string' }, count: { type: 'number' }, personaId: { type: 'string' },
}, additionalProperties: false };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  if (message.method === 'echo/initialize') result = { operations: [
    { name: 'workbenchdemo.read', description: 'Read example preferences', inputSchema: schema, outputSchema: schema, permission: 'workbenchdemo.read' },
    { name: 'workbenchdemo.save', description: 'Save example preferences', inputSchema: schema, outputSchema: schema, permission: 'workbenchdemo.write' },
  ] };
  else if (message.method === 'echo/invoke') {
    const input = message.params.input, key = input.personaId ?? 'workspace';
    if (message.params.name === 'workbenchdemo.save') values.set(key, input);
    result = values.get(key) ?? { message: 'Hello from a plugin', count: 1 };
  } else continue;
  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}
