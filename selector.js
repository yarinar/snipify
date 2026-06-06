// selector.js (v3.1)
import { startLogin, refreshAccessToken, VERSION } from './auth.js';

const grid = document.getElementById('grid'); // matches <div id="grid"> in selector.html
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'v' + VERSION;

let access = localStorage.getItem('access_token');
if (!access) {
  // redirect user to Spotify login flow
  startLogin();
} else {
  init();
}

async function init() {
  try {
    const user = await api('me');
    console.log('✅ Logged in as', user.display_name || user.id);

    // fetch *all* playlists (pagination)
    let next = 'me/playlists?limit=50';
    const playlists = [];
    while (next) {
      const data = await api(next);
      playlists.push(...data.items);
      next = data.next ? data.next.replace('https://api.spotify.com/v1/', '') : null;
    }

    renderGrid(playlists);
    setupShuffleToggle();
  } catch (err) {
    console.error('Auth/playlist error', err);
    startLogin();
  }
}

async function api(path, opts = {}, allowRetry = true) {
  const r = await fetch(`https://api.spotify.com/v1/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${access}`, ...opts.headers }
  });

  // Token expired: refresh once and retry transparently.
  if (r.status === 401 && allowRetry) {
    const newToken = await refreshAccessToken();
    if (newToken) { access = newToken; return api(path, opts, false); }
    return startLogin();
  }

  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return {};
  return r.json();
}

function renderGrid(playlists) {
  grid.innerHTML = '';
  const list = playlists.filter(Boolean);

  if (!list.length) {
    grid.innerHTML = '<div class="state">No playlists found on your account.</div>';
    return;
  }

  list.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'playlist';
    card.style.animationDelay = Math.min(i * 0.03, 0.5) + 's';

    // Build with textContent (not innerHTML) so playlist names can't inject markup.
    const img = document.createElement('img');
    img.src = p.images?.[0]?.url || '';
    img.alt = p.name || '';
    img.loading = 'lazy';

    const name = document.createElement('div');
    name.className = 'playlist-name';
    name.textContent = p.name || 'Untitled';

    card.append(img, name);
    card.onclick = () => {
      localStorage.setItem('selected_playlist', p.id);
      // Drop any cached tracks from a previous playlist so the new one loads fresh.
      localStorage.removeItem('cached_playlist_id');
      localStorage.removeItem('cached_tracks');
      window.location.href = 'index.html';
    };
    grid.appendChild(card);
  });
}

function setupShuffleToggle() {
  const label = document.createElement('label');
  label.className = 'switch';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'shuffleToggle';

  // Default ON when the user hasn't chosen yet; persist it so the game agrees.
  const savedShuffle = localStorage.getItem('shuffle');
  checkbox.checked = savedShuffle === null ? true : savedShuffle === '1';
  if (savedShuffle === null) localStorage.setItem('shuffle', '1');

  checkbox.addEventListener('change', () => {
    localStorage.setItem('shuffle', checkbox.checked ? '1' : '0');
  });

  // Order matters: the CSS track is the input's next sibling.
  const track = document.createElement('span');
  track.className = 'switch__track';
  const text = document.createElement('span');
  text.textContent = 'Shuffle songs';

  label.append(checkbox, track, text);
  (document.getElementById('toolbar') || document.body).appendChild(label);
}
