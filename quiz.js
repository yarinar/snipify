// quiz.js (v3.1)
// Robust‑playback version: retries device transfer & skips tracks on SDK errors.
// Snippets load a track once, then replay locally via the SDK (seek + resume)
// for snappy, precise hint timing.
import { startLogin, refreshAccessToken, VERSION } from './auth.js';

const backBtn       = document.getElementById('back');
const disc          = document.getElementById('disc');
const albumArt      = document.getElementById('albumArt');
const trackNameEl   = document.getElementById('trackName');
const trackArtistEl = document.getElementById('trackArtist');
const waveform      = document.getElementById('waveform');
const roundEl       = document.getElementById('roundCounter');
const buttons       = [...document.querySelectorAll('[data-sec]')];
const fullBtn       = document.getElementById('full');
const revealBtn     = document.getElementById('reveal');
const nextBtn       = document.getElementById('next');

let roundNum = 0;

let access, player, deviceId;
let tracks=[], playQueue=[], queueIdx=0;
let current, revealed=false;
let snippetWatch=null, snippetTimer=null;
let trackLoaded=false;          // is `current` already loaded on the SDK device?
let playerReady = false;
let sdkReady = false, tracksLoaded = false;  // single-init gating
// API throttling
let lastApiCall = 0;
let playerStateCache = null;
let playerStateCacheTime = 0;
let isTransferring = false;

// ─────────── INIT ───────────
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = 'v' + VERSION;

(async()=>{
  access=localStorage.getItem('access_token');
  if(!access) return startLogin();

  const plId=localStorage.getItem('selected_playlist');
  if(!plId)   return location.href='selector.html';

  try{
    await loadTracks(plId);
    tracksLoaded = true;
    // The SDK's onSpotifyWebPlaybackSDKReady may have already fired before this
    // module ran (it's a non-module script in <head>), so check for it directly.
    if (window.Spotify) sdkReady = true;
    maybeSetup();
  }catch(e){ console.error(e); location.href='selector.html'; }
})();

// ─────────── API ───────────
async function api(path,opts={},allowRetry=true){
  // Throttle API calls to avoid rate limiting (≥100ms between calls).
  const wait = 100 - (Date.now() - lastApiCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiCall = Date.now();

  const res = await fetch(`https://api.spotify.com/v1/${path}`,{
    ...opts,
    headers:{Authorization:`Bearer ${access}`,...opts.headers}
  });

  // Token expired mid-session: refresh once and retry transparently.
  if (res.status === 401 && allowRetry) {
    const newToken = await refreshAccessToken();
    if (newToken) { access = newToken; return api(path, opts, false); }
    return startLogin();
  }

  if (res.status === 204) return {};
  return res.json().catch(() => ({}));
}

async function transferHere(){
  // Prevent multiple transfers in parallel
  if (isTransferring) return false;
  
  try {
    isTransferring = true;
    
    // First check current playback state - only check if it's been more than 2 seconds
    // since our last check to reduce API calls
    let currentPlayback = null;
    const now = Date.now();
    
    if (now - playerStateCacheTime > 2000) {
      currentPlayback = await api('me/player').catch(() => null);
      playerStateCache = currentPlayback;
      playerStateCacheTime = now;
    } else {
      currentPlayback = playerStateCache;
    }
    
    // Only transfer if needed (device ID is different or no active device)
    if (!currentPlayback || currentPlayback.device?.id !== deviceId) {
      await api('me/player',{
        method:'PUT',
        body:JSON.stringify({device_ids:[deviceId],play:false})
      });
      
      // Give Spotify a moment to register the device transfer
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Invalidate player state cache after transfer
      playerStateCacheTime = 0;
    }
    return true;
  } catch(e) {
    console.warn('Device transfer failed:', e);
    return false;
  } finally {
    isTransferring = false;
  }
}

// ─────────── PLAYLIST ───────────
async function loadTracks(id){
  // Check if we need to reload tracks or can use cached ones
  const cachedId = localStorage.getItem('cached_playlist_id');
  const cachedTracks = localStorage.getItem('cached_tracks');
  
  if (cachedId === id && cachedTracks) {
    try {
      tracks = JSON.parse(cachedTracks);
      console.log('Using cached tracks');
    } catch (e) {
      tracks = [];
    }
  }
  
  if (!tracks.length) {
    // Page through the whole playlist (Spotify caps each response at 100).
    tracks = [];
    let next = `playlists/${id}/tracks?limit=100`;
    while (next) {
      const res = await api(next);
      const items = res.items || [];
      tracks.push(...items
        .map(i => i.track)
        .filter(t => t?.uri && t.type === 'track' && t.is_playable !== false));
      next = res.next ? res.next.replace('https://api.spotify.com/v1/', '') : null;
    }

    // Cache tracks to reduce API calls on reload
    try {
      localStorage.setItem('cached_playlist_id', id);
      localStorage.setItem('cached_tracks', JSON.stringify(tracks));
    } catch (e) {
      console.warn('Failed to cache tracks:', e);
    }
  }
  
  if(!tracks.length) throw new Error('No playable tracks');
  
  // Reset queue state entirely when loading new tracks
  playQueue=[...tracks];
  queueIdx=0;
  // Defer shuffling and pickNext until player is ready
}
function shuffle(a){for(let i=a.length-1;i;--i){const j=(Math.random()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]]}}

// ─────────── UI ───────────
function refresh(){
  albumArt.hidden=!revealed;
  if(revealed){
    albumArt.src=current.album?.images?.[0]?.url||'';
    trackNameEl.textContent=current.name;
    trackArtistEl.textContent=current.artists.map(a=>a.name).join(', ');
  }else{
    albumArt.src=''; trackNameEl.textContent=trackArtistEl.textContent='';
  }
  waveform.style.opacity=0;
  fullBtn.textContent='Play full';
  fullBtn.classList.remove('is-playing');
  revealBtn.textContent = revealed ? 'Hide 🎵' : 'Reveal 🎵';
  disc && disc.classList.toggle('revealed', revealed);
  buttons.forEach(b=>b.classList.remove('used'));
}
function pickNext(){
  if(!playQueue.length) return;
  clearTimeout(snippetTimer);
  clearInterval(snippetWatch);
  current=playQueue[queueIdx];
  roundNum++;
  if(roundEl) roundEl.textContent=roundNum;
  queueIdx++;
  if(queueIdx>=playQueue.length){
    queueIdx=0;
    // Don't re-shuffle on wrap - only shuffle once when the game starts.
  }
  revealed=false;
  trackLoaded=false;       // new track isn't loaded on the device yet
  player && player.pause();
  refresh();
}

// ─────────── PLAYER ───────────
window.onSpotifyWebPlaybackSDKReady = ()=>{ sdkReady = true; maybeSetup(); };
// setupPlayer must run exactly once, and only after BOTH the SDK is ready and
// the playlist has loaded - regardless of which happens first.
function maybeSetup(){ if(sdkReady && tracksLoaded && !player) setupPlayer(); }
function setupPlayer(){
  player=new Spotify.Player({name:'Snipify Player',getOAuthToken:cb=>cb(access),volume:0.8});

  player.addListener('ready',async e=>{
    deviceId=e.device_id; 
    await transferHere();
    playerReady = true;
    
    // Explicitly reset queue index to ensure we start at the first track
    queueIdx = 0;
    
    // Only shuffle if explicitly enabled, and do it *before* picking the first track
    if(localStorage.getItem('shuffle')==='1') {
      shuffle(playQueue);
    }
    
    // Now pick the first track after player is ready
    pickNext();
  });
  player.addListener('not_ready',()=>console.warn('Web player went offline'));
  player.addListener('playback_error',e=>{console.warn('SDK playback error',e); nextBtn.click();});
  player.connect();
  document.body.addEventListener('click',()=>player.activateElement(),{once:true});

  buttons.forEach(b=>b.onclick=()=>{b.classList.add('used'); playSnippet(+b.dataset.sec);});
  fullBtn.onclick=toggleFull;
  nextBtn.onclick =()=>{
    player.pause();
    revealed = false;
    pickNext();
  };
  revealBtn.onclick=()=>{
    revealed=!revealed;
    refresh();   // refresh() now sets the Reveal/Hide label from `revealed`
  };
  backBtn.onclick  =()=>{player.pause(); location.href='selector.html';};

  // Desktop keyboard shortcuts: 1-5 = hints, R = reveal, Space = play full, N/→ = next.
  document.addEventListener('keydown', e=>{
    if(e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if(k>='1' && k<='5'){
      const b = buttons[(+k)-1];
      if(b){ b.classList.add('used'); playSnippet(+b.dataset.sec); }
    } else if(k==='r'){
      revealBtn.click();
    } else if(k===' '){
      e.preventDefault(); toggleFull();
    } else if(k==='n' || k==='arrowright'){
      nextBtn.click();
    } else { return; }
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}
async function toggleFull(){
  if(!current?.uri || !playerReady) return;
  clearTimeout(snippetTimer);
  clearInterval(snippetWatch);
  if(fullBtn.textContent==='Stop'){
    await player.pause();
    waveform.style.opacity=0;
    fullBtn.textContent='Play full';
    fullBtn.classList.remove('is-playing');
    return;
  }
  await startCurrent(0);   // start from the beginning
  waveform.style.opacity=1;
  fullBtn.textContent='Stop';
  fullBtn.classList.add('is-playing');
}

// ─────────── PLAYBACK HELPERS ───────────
async function playTrack(uri,pos=0){
  if(!playerReady) return;
  
  // Try transferring device up to 3 times
  let attempts = 0;
  let success = false;
  while (!success && attempts < 3) {
    try {
      await transferHere();
      await api(`me/player/play?device_id=${deviceId}`,{
        method:'PUT',body:JSON.stringify({uris:[uri],position_ms:pos})
      });
      success = true;
    } catch (err) {
      console.warn('Playback error, attempt:', attempts, err);
      attempts++;
      // Short delay before retry
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  if (!success) {
    console.error('Failed to play track after multiple attempts');
  }
}

// Begin playback of `current` from `pos` ms. The first time, the track is
// loaded onto the SDK device via REST; after that we just seek + resume
// locally through the SDK - no reload, no device transfer, no rate-limit hit.
// This is what makes repeated hints feel instant.
async function startCurrent(pos=0){
  if(!trackLoaded){
    await playTrack(current.uri, pos);
    trackLoaded = true;
  }else{
    await player.seek(pos);
    await player.resume();
  }
}

// Cache player state to reduce getCurrentState calls
let lastStateCheck = 0;
let cachedState = null;

async function getPlayerState() {
  const now = Date.now();
  // Only refresh state if it's been more than 100ms since last check
  if (now - lastStateCheck > 100 || !cachedState) {
    lastStateCheck = now;
    cachedState = await player.getCurrentState().catch(() => null);
  }
  return cachedState;
}

async function playSnippet(sec){
  if(!current?.uri || !playerReady) return;
  clearTimeout(snippetTimer);
  clearInterval(snippetWatch);
  fullBtn.textContent='Play full';   // a hint supersedes an in-progress full play
  fullBtn.classList.remove('is-playing');

  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    try{
      await startCurrent(0);
      const playing = await waitUntilPlaying(3000);

      if (!playing) {
        console.warn('Track failed to start playing within timeout');
        trackLoaded = false;        // force a fresh load on the next attempt
        attempts++;
        continue;
      }

      waveform.style.opacity=1;
      // The track is buffered and confirmed playing, so a single timer cuts the
      // snippet far more precisely than the old 250ms polling loop did.
      snippetTimer=setTimeout(async()=>{
        await player.pause().catch(()=>{});
        waveform.style.opacity=0;
      }, sec*1000);
      return;

    } catch(e){
      console.error('Snippet playback error:', e);
      trackLoaded = false;
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  // If we got here, all attempts failed - skip the track rather than hang.
  console.error('Failed to play snippet after multiple attempts');
  nextBtn.click();
}

function waitUntilPlaying(timeout=2500){
  return new Promise(res=>{
    const s=Date.now();
    (async function p(){
      // Use cached player state function
      const st = await getPlayerState();
      if(st && !st.paused && st.position > 0) return res(st);
      if(Date.now()-s > timeout) return res(null);
      setTimeout(p, 100); // Increased polling interval from 60ms to 100ms
    })();
  });
}
