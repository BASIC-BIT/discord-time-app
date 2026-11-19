use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const CHANGED: &str = "hosted-auth-changed";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Clone)]
pub struct HostedAuth {
    inner: Arc<Mutex<Inner>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    http: Arc<OnceLock<Result<Client, String>>>,
    service: String,
    issuer: String,
    client_id: String,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    pending: Option<Pending>,
    session: Option<Session>,
    metadata: Option<Metadata>,
    error: Option<String>,
}

#[derive(Clone)]
struct Pending {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    deadline: Instant,
    interval: u64,
    nonce: String,
}

struct Session {
    id_token: String,
    expires_at: u64,
}

#[derive(Clone, Deserialize)]
struct Metadata {
    issuer: String,
    device_authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    grant_types_supported: Vec<String>,
}

#[derive(Deserialize)]
struct DeviceReply {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct TokenReply {
    id_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    configured: bool,
    phase: &'static str,
    user_code: Option<String>,
    verification_uri: Option<String>,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn same_https_origin(value: &str, issuer: &str) -> bool {
    match (Url::parse(value), Url::parse(issuer)) {
        (Ok(url), Ok(base)) => url.scheme() == "https" && url.origin() == base.origin(),
        _ => false,
    }
}

fn valid_device(reply: &DeviceReply) -> bool {
    let valid_url = |value: &str| Url::parse(value).is_ok_and(|url| url.scheme() == "https");
    !reply.device_code.is_empty()
        && !reply.user_code.is_empty()
        && reply.user_code.len() <= 64
        && reply.expires_in > 0
        && reply.expires_in <= 3600
        && (1..=60).contains(&reply.interval.unwrap_or(5))
        && valid_url(&reply.verification_uri)
        && reply
            .verification_uri_complete
            .as_ref()
            .is_none_or(|url| same_https_origin(url, &reply.verification_uri))
}

fn session_from_token(
    token: String,
    issuer: &str,
    client: &str,
    nonce: Option<&str>,
) -> Result<Session, String> {
    // These claims bind the HTTPS token response to this login. Convex verifies the JWT signature.
    let payload = token.split('.').nth(1).ok_or("Invalid sign-in response.")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "Invalid sign-in response.")?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid sign-in response.")?;
    let audience_matches = claims["aud"].as_str() == Some(client)
        || claims["aud"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(client)));
    let expires_at = claims["exp"].as_u64().ok_or("Invalid sign-in expiry.")?;
    if claims["iss"].as_str() != Some(issuer)
        || !audience_matches
        || expires_at <= now() + 30
        || nonce.is_some_and(|expected| claims["nonce"].as_str() != Some(expected))
    {
        return Err("Could not validate this sign-in. Please try again.".into());
    }
    Ok(Session {
        id_token: token,
        expires_at,
    })
}

impl HostedAuth {
    pub fn new(instance: &str) -> Self {
        let issuer = option_env!("VITE_CLERK_ISSUER")
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let client_id = option_env!("VITE_CLERK_OAUTH_CLIENT_ID")
            .unwrap_or("")
            .to_string();
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            http: Arc::new(OnceLock::new()),
            service: format!("{instance}:clerk:{client_id}"),
            issuer,
            client_id,
        }
    }

    fn http(&self) -> Result<&Client, String> {
        self.http
            .get_or_init(|| {
                Client::builder()
                    .timeout(Duration::from_secs(10))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "Could not initialize browser sign-in.".into())
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, "refresh-token")
            .map_err(|_| "Secure sign-in storage is unavailable.".into())
    }

    fn stored_refresh(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read secure sign-in storage.".into()),
        }
    }

    fn clear_refresh(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not clear secure sign-in storage.".into()),
        }
    }

    fn status(&self) -> Result<AuthStatus, String> {
        let configured = !self.client_id.is_empty() && self.issuer.starts_with("https://");
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| Instant::now() >= pending.deadline)
        {
            inner.pending = None;
            inner.generation += 1;
            inner.error = Some("This sign-in code expired. Please try again.".into());
        }
        let pending = inner.pending.as_ref();
        let signed_in = configured && (inner.session.is_some() || self.stored_refresh()?.is_some());
        Ok(AuthStatus {
            configured,
            phase: if pending.is_some() {
                "pending"
            } else if signed_in {
                "signed_in"
            } else {
                "signed_out"
            },
            user_code: pending.map(|p| p.user_code.clone()),
            verification_uri: pending.map(|p| p.verification_uri.clone()),
            verification_uri_complete: pending.and_then(|p| p.verification_uri_complete.clone()),
            expires_in: pending.map(|p| {
                p.deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
            }),
            error: inner.error.clone(),
        })
    }

    async fn metadata(&self) -> Result<Metadata, String> {
        if let Some(value) = self
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?
            .metadata
            .clone()
        {
            return Ok(value);
        }
        if self.client_id.is_empty() || !self.issuer.starts_with("https://") {
            return Err("Browser sign-in is not configured in this build.".into());
        }
        let value: Metadata = self
            .http()?
            .get(format!("{}/.well-known/openid-configuration", self.issuer))
            .send()
            .await
            .map_err(|_| "Could not connect to sign-in. Please try again.")?
            .error_for_status()
            .map_err(|_| "Sign-in is temporarily unavailable.")?
            .json()
            .await
            .map_err(|_| "Invalid sign-in configuration.")?;
        if value.issuer != self.issuer
            || !same_https_origin(&value.token_endpoint, &self.issuer)
            || !same_https_origin(&value.device_authorization_endpoint, &self.issuer)
            || !value
                .grant_types_supported
                .iter()
                .any(|grant| grant == DEVICE_GRANT)
            || value
                .revocation_endpoint
                .as_ref()
                .is_some_and(|url| !same_https_origin(url, &self.issuer))
        {
            return Err("Device sign-in is not available for this app.".into());
        }
        self.inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?
            .metadata = Some(value.clone());
        Ok(value)
    }

    fn fail_pending(&self, generation: u64, message: &str, app: &AppHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return;
            }
            inner.pending = None;
            inner.error = Some(message.into());
        }
        let _ = app.emit(CHANGED, ());
    }

    async fn start(&self, app: AppHandle) -> Result<AuthStatus, String> {
        let _guard = self.refresh_lock.lock().await;
        if self.status()?.phase != "signed_out" {
            return self.status();
        }
        let generation = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Sign-in state is unavailable.")?;
            inner.generation += 1;
            inner.error = None;
            inner.generation
        };
        let metadata = self.metadata().await?;
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| "Could not start a secure sign-in.")?;
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let reply: DeviceReply = self
            .http()?
            .post(&metadata.device_authorization_endpoint)
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("scope", "openid offline_access"),
                ("nonce", nonce.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Could not connect to sign-in. Please try again.")?
            .error_for_status()
            .map_err(|_| "Could not start browser sign-in. Please try again.")?
            .json()
            .await
            .map_err(|_| "Invalid sign-in response.")?;
        if !valid_device(&reply) {
            return Err("Invalid device sign-in response.".into());
        }
        let pending = Pending {
            device_code: reply.device_code,
            user_code: reply.user_code,
            verification_uri: reply.verification_uri,
            verification_uri_complete: reply.verification_uri_complete,
            deadline: Instant::now() + Duration::from_secs(reply.expires_in),
            interval: reply.interval.unwrap_or(5),
            nonce,
        };
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Sign-in state is unavailable.")?;
            if inner.generation != generation {
                return Err("Sign-in was cancelled.".into());
            }
            inner.pending = Some(pending.clone());
        }
        let auth = self.clone();
        tauri::async_runtime::spawn(async move {
            auth.poll(generation, pending, metadata, app).await;
        });
        self.status()
    }

    async fn poll(&self, generation: u64, pending: Pending, metadata: Metadata, app: AppHandle) {
        let http = match self.http() {
            Ok(http) => http,
            Err(error) => {
                self.fail_pending(generation, &error, &app);
                return;
            }
        };
        let mut interval = pending.interval;
        loop {
            tokio::time::sleep(
                Duration::from_secs(interval)
                    .min(pending.deadline.saturating_duration_since(Instant::now())),
            )
            .await;
            if self
                .inner
                .lock()
                .map(|inner| inner.generation != generation || inner.pending.is_none())
                .unwrap_or(true)
            {
                return;
            }
            if Instant::now() >= pending.deadline {
                self.fail_pending(
                    generation,
                    "This sign-in code expired. Please try again.",
                    &app,
                );
                return;
            }
            let reply = http
                .post(&metadata.token_endpoint)
                .form(&[
                    ("client_id", self.client_id.as_str()),
                    ("grant_type", DEVICE_GRANT),
                    ("device_code", pending.device_code.as_str()),
                ])
                .send()
                .await;
            let response = match reply {
                Ok(response) if !response.status().is_server_error() => response,
                _ => {
                    interval = interval.saturating_mul(2).min(60).max(pending.interval);
                    continue;
                }
            };
            let reply: TokenReply = match response.json().await {
                Ok(reply) => reply,
                Err(_) => {
                    self.fail_pending(
                        generation,
                        "Invalid sign-in response. Please try again.",
                        &app,
                    );
                    return;
                }
            };
            match reply.error.as_deref() {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    interval = interval.saturating_add(5);
                    continue;
                }
                Some("access_denied") => {
                    self.fail_pending(generation, "Sign-in was declined. You can try again.", &app);
                    return;
                }
                Some("expired_token") => {
                    self.fail_pending(
                        generation,
                        "This sign-in code expired. Please try again.",
                        &app,
                    );
                    return;
                }
                Some(_) => {
                    self.fail_pending(generation, "Sign-in failed. Please try again.", &app);
                    return;
                }
                None => {}
            }
            let saved = self.save_session(generation, reply, None, Some(&pending.nonce));
            if let Err(message) = saved {
                self.fail_pending(generation, &message, &app);
            } else {
                let _ = app.emit(CHANGED, ());
            }
            return;
        }
    }

    fn save_session(
        &self,
        generation: u64,
        reply: TokenReply,
        previous_refresh: Option<String>,
        nonce: Option<&str>,
    ) -> Result<(), String> {
        let session = session_from_token(
            reply
                .id_token
                .ok_or("Sign-in did not return an identity token.")?,
            &self.issuer,
            &self.client_id,
            nonce,
        )?;
        let refresh = reply
            .refresh_token
            .or(previous_refresh)
            .filter(|token| !token.is_empty())
            .ok_or("Sign-in did not return a refresh credential.")?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?;
        if inner.generation != generation {
            return Err("Sign-in was cancelled.".into());
        }
        self.entry()?
            .set_password(&refresh)
            .map_err(|_| "Could not securely save sign-in. Please try again.")?;
        inner.session = Some(session);
        inner.pending = None;
        inner.error = None;
        Ok(())
    }

    async fn token(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let _guard = self.refresh_lock.lock().await;
        let generation = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "Sign-in state is unavailable.")?;
            if let Some(session) = inner
                .session
                .as_ref()
                .filter(|session| session.expires_at > now() + 60)
            {
                return Ok(Some(session.id_token.clone()));
            }
            inner.generation
        };
        let Some(refresh) = self.stored_refresh()? else {
            return Ok(None);
        };
        let metadata = self.metadata().await?;
        let reply: TokenReply = self
            .http()?
            .post(&metadata.token_endpoint)
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Could not refresh sign-in. Check your connection.")?
            .json()
            .await
            .map_err(|_| "Invalid sign-in response.")?;
        if let Some(error) = reply.error.as_deref() {
            if !matches!(error, "invalid_grant" | "invalid_token" | "access_denied") {
                return Err("Could not refresh sign-in. Please try again.".into());
            }
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Sign-in state is unavailable.")?;
            if inner.generation == generation {
                self.clear_refresh()?;
                inner.session = None;
                inner.error = Some("Your sign-in expired. Please sign in again.".into());
            }
            drop(inner);
            let _ = app.emit(CHANGED, ());
            return Ok(None);
        }
        self.save_session(generation, reply, Some(refresh), None)?;
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?
            .session
            .as_ref()
            .map(|session| session.id_token.clone()))
    }
}

#[tauri::command]
pub fn get_hosted_auth_status(auth: State<'_, HostedAuth>) -> Result<AuthStatus, String> {
    auth.status()
}

#[tauri::command]
pub async fn start_hosted_sign_in(
    app: AppHandle,
    auth: State<'_, HostedAuth>,
) -> Result<AuthStatus, String> {
    auth.start(app).await
}

#[tauri::command]
pub fn cancel_hosted_sign_in(
    app: AppHandle,
    auth: State<'_, HostedAuth>,
) -> Result<AuthStatus, String> {
    {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?;
        inner.generation += 1;
        inner.pending = None;
        inner.error = None;
    }
    let _ = app.emit(CHANGED, ());
    auth.status()
}

#[tauri::command]
pub async fn get_hosted_auth_token(
    app: AppHandle,
    auth: State<'_, HostedAuth>,
) -> Result<Option<String>, String> {
    auth.token(&app).await
}

#[tauri::command]
pub async fn sign_out_hosted_auth(
    app: AppHandle,
    auth: State<'_, HostedAuth>,
) -> Result<AuthStatus, String> {
    let refresh = auth.stored_refresh()?;
    {
        let mut inner = auth
            .inner
            .lock()
            .map_err(|_| "Sign-in state is unavailable.")?;
        inner.generation += 1;
        inner.pending = None;
        inner.session = None;
        inner.error = None;
        auth.clear_refresh()?;
    }
    let _ = app.emit(CHANGED, ());
    if let Some(refresh) = refresh {
        if let Some(endpoint) = auth
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.revocation_endpoint)
        {
            let _ = auth
                .http()?
                .post(endpoint)
                .form(&[
                    ("client_id", auth.client_id.as_str()),
                    ("token", refresh.as_str()),
                    ("token_type_hint", "refresh_token"),
                ])
                .send()
                .await;
        }
    }
    auth.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_http_failure_does_not_prevent_auth_state_or_app_setup() {
        let mut auth = HostedAuth::new("unavailable-http-test");
        assert!(auth.http.get().is_none());
        auth.http
            .set(Err("Could not initialize browser sign-in.".into()))
            .unwrap();
        assert!(auth.http().is_err());
        auth.client_id.clear();
        assert!(!auth.status().unwrap().configured);
    }
    fn token(issuer: &str, audience: &str, nonce: &str, expiry: u64) -> String {
        let payload = serde_json::json!({"iss":issuer,"aud":audience,"nonce":nonce,"exp":expiry});
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }
    #[test]
    fn identity_response_must_match_issuer_client_nonce_and_expiry() {
        let good = token(
            "https://issuer.example",
            "desktop",
            "login-nonce",
            now() + 3600,
        );
        assert!(session_from_token(
            good.clone(),
            "https://issuer.example",
            "desktop",
            Some("login-nonce")
        )
        .is_ok());
        for (issuer, client, nonce) in [
            ("https://wrong.example", "desktop", "login-nonce"),
            ("https://issuer.example", "other", "login-nonce"),
            ("https://issuer.example", "desktop", "other"),
        ] {
            assert!(session_from_token(good.clone(), issuer, client, Some(nonce)).is_err());
        }
        assert!(session_from_token(
            token("https://issuer.example", "desktop", "login-nonce", now()),
            "https://issuer.example",
            "desktop",
            None
        )
        .is_err());
    }
    #[test]
    fn device_response_requires_https_matching_completion_origin_and_finite_expiry() {
        let mut reply = DeviceReply {
            device_code: "private".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://accounts.example/device".into(),
            verification_uri_complete: Some(
                "https://accounts.example/device?user_code=ABCD-EFGH".into(),
            ),
            expires_in: 600,
            interval: Some(5),
        };
        assert!(valid_device(&reply));
        reply.verification_uri_complete = Some("https://evil.example/device".into());
        assert!(!valid_device(&reply));
        reply.verification_uri_complete = None;
        reply.expires_in = 0;
        assert!(!valid_device(&reply));
        reply.expires_in = 600;
        for interval in [0, 61, u64::MAX] {
            reply.interval = Some(interval);
            assert!(!valid_device(&reply));
        }
        for interval in [1, 60] {
            reply.interval = Some(interval);
            assert!(valid_device(&reply));
        }
        assert!(!same_https_origin(
            "http://issuer.example/token",
            "https://issuer.example"
        ));
    }
    #[test]
    fn cancelled_generation_cannot_store_a_late_token() {
        let auth = HostedAuth::new("cancelled-auth-test");
        auth.inner.lock().unwrap().generation = 2;
        let reply = TokenReply {
            id_token: Some(token(&auth.issuer, &auth.client_id, "nonce", now() + 3600)),
            refresh_token: Some("not-a-real-credential".into()),
            error: None,
        };
        assert!(auth.save_session(1, reply, None, Some("nonce")).is_err());
        assert!(auth.inner.lock().unwrap().session.is_none());
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn refresh_credential_survives_native_state_restart_and_is_removed_on_clear() {
        let instance = format!("hammer-overlay-auth-test-{}-{}", std::process::id(), now());
        let first = HostedAuth::new(&instance);
        assert!(first.stored_refresh().unwrap().is_none());
        first
            .entry()
            .unwrap()
            .set_password("synthetic-refresh-test")
            .unwrap();
        let restored = HostedAuth::new(&instance).stored_refresh();
        let cleared = first.clear_refresh();
        assert_eq!(restored.unwrap().as_deref(), Some("synthetic-refresh-test"));
        cleared.unwrap();
        assert!(first.stored_refresh().unwrap().is_none());
    }
}
