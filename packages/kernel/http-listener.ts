import type { Server } from 'node:http';
import { invariant } from '../contracts/index.ts';

// WHATWG Fetch port blocking, also used by Chromium/WebView2. A locally assigned
// ephemeral port can be in this list on machines with a custom dynamic range.
export const blockedBrowserPorts = new Set(
  `1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79
87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465
512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723
2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080`
    .split(/\s+/)
    .map(Number),
);

export async function listenBrowserHttp(server: Server, requested = 0) {
  invariant(
    !blockedBrowserPorts.has(requested),
    'http_port_blocked',
    '此端口被浏览器禁止访问，请更换 ECHO_PORT。',
  );
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(requested, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    const port = (server.address() as { port: number }).port;
    if (!blockedBrowserPorts.has(port)) return port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  throw Error('无法分配可供浏览器访问的本机端口。');
}
