export const initialState = () => ({ name: '旧登记系统导出', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/exports') { json(200, [{ exportId: 'register-a', revision: state.revision, href: '/exports/source.sql' }]); return true; }
  if (url.pathname === '/exports/source.sql') {
    let raw = await readFile(new URL(state.unsupported ? '../fixtures/unsupported.sql' : '../fixtures/source.sql', import.meta.url));
    if (state.truncated) raw = raw.subarray(0, raw.lastIndexOf(Buffer.from('COMMIT;')));
    bytes(200, raw, 'application/sql; charset=utf-8'); return true;
  }
  return false;
}
