// Static server for fixture pages and the dev capture harness: http://localhost:5178/fixtures/
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5178);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Dev only: POST /__save/<name> stores a capture in dist/dev/captures/<name>.w2f.json.
  if (req.method === 'POST' && path.startsWith('/__save/')) {
    const name = path.slice('/__save/'.length).replace(/[^a-z0-9-]/gi, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await mkdir(join(root, 'dist/dev/captures'), { recursive: true });
    await writeFile(join(root, `dist/dev/captures/${name}.w2f.json`), Buffer.concat(chunks));
    return res.writeHead(204).end();
  }
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (path.endsWith('/')) file = join(file, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`Fixtures on http://localhost:${port}/fixtures/`));
