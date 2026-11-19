import type { AuthConfig } from 'convex/server';

const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
const applicationID = process.env.CLERK_OAUTH_CLIENT_ID ?? 'convex';
export default {
  // No issuer configured means no authenticated access, never anonymous parsing.
  providers: domain ? [{ domain, applicationID }] : [],
} satisfies AuthConfig;
