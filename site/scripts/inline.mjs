// Build step: embed worker/app.html into worker/index.js as the APP_HTML string.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const html = readFileSync(new URL('worker/app.html', root), 'utf8');
const src = readFileSync(new URL('worker/index.js', root), 'utf8');
if (!src.includes('__APP_HTML__')) throw new Error('worker/index.js is missing the __APP_HTML__ placeholder');
writeFileSync(process.argv[2], src.replace('"__APP_HTML__"', JSON.stringify(html)));
