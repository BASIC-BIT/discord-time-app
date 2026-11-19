import { useEffect, useState } from 'react';
import type { Clerk } from '@clerk/clerk-js';
import { getHostedClerk, hostedConfigured } from '../lib/hosted-auth';

export function HostedAccount() {
  const [clerk, setClerk] = useState<Clerk | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void getHostedClerk()?.then(value => {
      if (!active) return;
      setClerk(value);
      setSignedIn(Boolean(value.session));
      unsubscribe = value.addListener(({ session }) => setSignedIn(Boolean(session)));
    }).catch(() => { if (active) setError('Account sign-in is unavailable. Try reopening Settings.'); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  if (!hostedConfigured) return null;
  return <div className="setting-group">
    <h3>Account</h3>
    <p>Sign in to use smart parsing while RunPod warms up.</p>
    <button type="button" disabled={!clerk} onClick={() => {
      if (signedIn) void clerk?.signOut().catch(() => setError('Could not sign out. Please try again.'));
      else clerk?.openSignIn();
    }}>{clerk ? signedIn ? 'Sign out' : 'Sign in' : 'Connecting…'}</button>
    <p>{signedIn ? 'Signed in. Smart fallback is available.' : 'Local parsing works without an account.'}</p>
    <p>Sign in again after restarting the app.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
