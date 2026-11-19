for (const name of ['VITE_CONVEX_URL', 'VITE_CLERK_ISSUER', 'VITE_CLERK_OAUTH_CLIENT_ID']) {
  if (!process.env[name]?.trim()) throw new Error(name + ' is required from the dedicated RELEASE_* repository variables.');
}
const issuer = new URL(process.env.VITE_CLERK_ISSUER);
if (issuer.protocol !== 'https:' || issuer.hostname === 'clerk.accounts.dev' || issuer.hostname.endsWith('.clerk.accounts.dev')) {
  throw new Error('Releases require a production HTTPS Clerk issuer; development instances are not allowed.');
}
const relay = new URL(process.env.VITE_CONVEX_URL);
if (relay.protocol !== 'https:' || !relay.hostname.endsWith('.convex.cloud') || relay.pathname !== '/') {
  throw new Error('RELEASE_CONVEX_URL must select the intended production Convex deployment.');
}
