import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { cancelHostedSignIn, getHostedAuthStatus, hostedConfigured, openHostedSignInBrowser, signOutHostedAuth, startHostedSignIn, type HostedAuthStatus } from '../lib/hosted-auth';

export function HostedAccount({ compact = false, onSignedIn }: { compact?: boolean; onSignedIn?: () => void }) {
  const [status, setStatus] = useState<HostedAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const phaseRef = useRef<string | null>(null);
  const operationRef = useRef(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await getHostedAuthStatus();
        if (!active) return;
        setStatus(next);
        if (next.phase === 'signed_in' && phaseRef.current !== 'signed_in') onSignedInRef.current?.();
        phaseRef.current = next.phase;
      } catch { if (active) setError('Could not load your account. Please try again.'); }
    };
    void refresh();
    const unlisten = listen('hosted-auth-changed', () => { void refresh(); });
    return () => { active = false; operationRef.current += 1; void unlisten.then(stop => stop()); };
  }, []);

  const start = async () => {
    const operation = ++operationRef.current;
    setBusy(true); setError(null);
    try {
      const next = await startHostedSignIn();
      if (operation !== operationRef.current) return;
      setStatus(next);
      if (next.phase === 'pending') {
        try { await openHostedSignInBrowser(next); }
        catch { setError('Could not open your browser. Use Open browser below, or visit the address and enter your code.'); }
      }
    } catch (error) { if (operation === operationRef.current) setError(typeof error === 'string' ? error : 'Could not start sign-in. Please try again.'); }
    finally { if (operation === operationRef.current) setBusy(false); }
  };

  const cancel = async () => {
    operationRef.current += 1; setBusy(false); setError(null);
    try { setStatus(await cancelHostedSignIn()); }
    catch { setError('Could not cancel sign-in. Please try again.'); }
  };

  if (!hostedConfigured) return null;
  const pending = status?.phase === 'pending';
  const signedIn = status?.phase === 'signed_in';
  const message = error ?? status?.error;
  return <section className={compact ? 'account-panel account-panel-compact' : 'setting-group account-panel'} aria-label="Account">
    {!compact && <h3>Account</h3>}
    <div className="account-card">
      <div className="account-summary">
        <span className={`account-indicator ${signedIn ? 'connected' : ''}`} aria-hidden="true">{signedIn ? '✓' : '↗'}</span>
        <div>
          <div className="account-title">{signedIn ? 'You’re connected' : pending ? 'Finish signing in' : 'Connect smart parsing'}</div>
          <p className="account-description">{signedIn ? 'Smart parsing is ready. You’ll stay signed in on this device.' : pending ? 'Approve HammerOverlay in your browser. This window will update automatically.' : 'Sign in securely in your browser to use smart parsing.'}</p>
        </div>
      </div>
      {pending && status.userCode && <div className="account-device">
        <span className="account-device-label">Confirm this code in your browser</span>
        <div className="account-code-row"><code>{status.userCode}</code><button type="button" className="account-link" onClick={() => { void writeText(status.userCode!).catch(() => setError('Could not copy the code.')); }}>Copy code</button></div>
        <span className="account-address">{status.verificationUri}</span>
      </div>}
      {message && <p className="account-error" role="alert">{message}</p>}
      <div className="account-actions">
        {signedIn ? <button type="button" className="secondary-button account-button" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { setStatus(await signOutHostedAuth()); phaseRef.current = 'signed_out'; }
          catch { setError('Could not sign out. Please try again.'); }
          finally { setBusy(false); }
        }}>Sign out</button> : pending ? <>
          <button type="button" className="secondary-button account-button" onClick={() => { void openHostedSignInBrowser(status).catch(() => setError('Could not open your browser. Visit the address above and enter your code.')); }}>Open browser</button>
          <button type="button" className="account-link" onClick={() => { void cancel(); }}>Cancel</button>
        </> : <button type="button" className="secondary-button account-button account-button-primary" disabled={busy || status?.configured === false} onClick={() => { void start(); }}>{busy ? 'Opening sign-in…' : 'Sign in with browser'}<span aria-hidden="true">↗</span></button>}
        {busy && !pending && <button type="button" className="account-link" onClick={() => { void cancel(); }}>Cancel</button>}
      </div>
      {!signedIn && !pending && <p className="account-footnote">Local parsing works without an account.</p>}
      {status?.configured === false && <p className="account-error">Browser sign-in is not configured in this build.</p>}
    </div>
  </section>;
}
