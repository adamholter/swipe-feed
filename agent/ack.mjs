// Report progress on a phone-app request back to the Site: node ack.mjs <requestId> <working|done|failed> ["summary"]
import { api } from './lib.mjs';
const [id, status, result] = process.argv.slice(2);
if (!id || !status) { console.error('usage: node ack.mjs <requestId> <working|done|failed> ["summary"]'); process.exit(2); }
await api('/api/agent/status', {method: 'POST', body: {id, status, result: result || null}});
console.log('ok', id, status);
