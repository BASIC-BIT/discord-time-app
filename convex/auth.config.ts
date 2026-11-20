import type { AuthConfig } from 'convex/server';

const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
const applicationID = process.env.CLERK_OAUTH_CLIENT_ID;
if (!domain || !applicationID) throw new Error('CLERK_JWT_ISSUER_DOMAIN and CLERK_OAUTH_CLIENT_ID are required.');
export default {
  providers: [{ domain, applicationID }],
} satisfies AuthConfig;
