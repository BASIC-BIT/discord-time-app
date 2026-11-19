import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script = fileURLToPath(new URL('./check-hosted-release-config.mjs', import.meta.url));
const production = {VITE_CONVEX_URL:'https://synthetic-production.convex.cloud',VITE_CLERK_ISSUER:'https://clerk.example.com',VITE_CLERK_OAUTH_CLIENT_ID:'synthetic-client'};
test('release configuration rejects development, missing and insecure values', () => {
  for (const overrides of [{VITE_CLERK_ISSUER:'https://synthetic.clerk.accounts.dev'}, {VITE_CLERK_OAUTH_CLIENT_ID:''}, {VITE_CONVEX_URL:'http://synthetic-production.convex.cloud'}, {VITE_CLERK_ISSUER:'http://clerk.example.com'}]) {
    assert.notEqual(spawnSync(process.execPath,[script],{env:{...process.env,...production,...overrides}}).status,0);
  }
  assert.equal(spawnSync(process.execPath,[script],{env:{...process.env,...production}}).status,0);
});
