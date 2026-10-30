import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/fixtures/', import.meta.url));
const files = { '/fixtures/youtube.html': ['youtube.html', 'text/html; charset=utf-8'], '/fixtures/fixture.js': ['fixture.js', 'text/javascript; charset=utf-8'] };
const server = createServer(async (request, response) => {
  const entry = files[new URL(request.url ?? '/', 'http://localhost:8765').pathname];
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const body = await readFile(root + entry[0]);
    response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(500); response.end('Fixture unavailable'); }
});
server.listen(8765, '127.0.0.1', () => console.log('Fixture: http://localhost:8765/fixtures/youtube.html'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
