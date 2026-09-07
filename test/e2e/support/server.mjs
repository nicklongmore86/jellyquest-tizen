// Serves the repo root over plain HTTP for the Playwright suite.
//
// The simulator is loaded via file:// in the browser during manual dev,
// but Chromium refuses fetch() from a file:// document (CORS treats it
// as an opaque origin) -- and Phase 4's config loading depends on
// fetch(). Serving over HTTP instead matches how the real Tizen runtime
// (and any other production embedding) actually loads the app, so this
// makes the test harness more faithful, not just fetch-capable.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

export function startServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const requestPath = decodeURIComponent(req.url.split('?')[0]);
            const filePath = path.join(repoRoot, requestPath);

            // Refuse to serve anything outside the repo root.
            if (!filePath.startsWith(repoRoot)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                const ext = path.extname(filePath);
                res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });

        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise((res) => server.close(res)),
            });
        });
    });
}
