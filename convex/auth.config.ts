import type { AuthConfig } from 'convex/server';

const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
export default {
  // No issuer configured means no authenticated access, never anonymous parsing.
  providers: domain ? [{ domain, applicationID: 'convex' }] : [],
} satisfies AuthConfig;
