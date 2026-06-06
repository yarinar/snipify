export const VERSION = '3.1.0';
const CLIENT_ID = '05f8b9b243c94d1aa39bef811f03df42';
// Derive the redirect URI from wherever the app is served, so the same code
// works on production (yarinar.github.io/snipify/) and locally (127.0.0.1) as
// long as each origin's callback.html is registered in the Spotify dashboard.
// On callback.html this resolves to the same string used to start the flow.
const REDIRECT_URI = new URL('callback.html', window.location.href).href;
const APP_ROOT = new URL('.', window.location.href).href;

function randomString(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  while (result.length < length) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startLogin() {
  const verifier = randomString();
  const challenge = await sha256(verifier);

  localStorage.setItem('code_verifier', verifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'playlist-read-private streaming user-read-playback-state user-modify-playback-state',
    code_challenge_method: 'S256',
    code_challenge: challenge
  });

  window.location = `https://accounts.spotify.com/authorize?${params}`;
}

export async function finishLogin() {
  const code = new URLSearchParams(window.location.search).get('code');
  const verifier = localStorage.getItem('code_verifier');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await response.json();
  localStorage.setItem('access_token', data.access_token);
  localStorage.setItem('refresh_token', data.refresh_token);

  window.location.href = APP_ROOT;
}

// Exchange the stored refresh_token for a fresh access_token.
// Returns the new access token, or null if refresh isn't possible (caller should re-login).
export async function refreshAccessToken() {
  const refresh_token = localStorage.getItem('refresh_token');
  if (!refresh_token) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: CLIENT_ID
  });

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.access_token) return null;

    localStorage.setItem('access_token', data.access_token);
    // Spotify may or may not rotate the refresh token; persist it when it does.
    if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
    return data.access_token;
  } catch (e) {
    console.warn('Token refresh failed:', e);
    return null;
  }
}
