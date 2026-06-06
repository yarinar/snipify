# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Snipify is a "guess the song" web game built on the Spotify Web Playback SDK. It is a pure static site (no build step, no package.json) hosted on GitHub Pages at `https://yarinar.github.io/snipify/`. All JS is ES modules loaded directly by `<script type="module">`.

## Running / Deploying

- No build, no tests, no linter.
- Local dev: serve the directory over HTTP (e.g. `python -m http.server`) — `file://` won't work because of ES modules and the Spotify SDK.
- The Spotify OAuth redirect URI is hardcoded to `https://yarinar.github.io/snipify/callback.html` in [auth.js](auth.js). Local testing of the auth flow requires either editing that URL or adding a matching redirect URI in the Spotify developer dashboard.
- Deployment is just `git push` to `main` — GitHub Pages serves the repo root.
- The version string shown in the UI lives in [index.html](index.html) (`<div id="version">`); bump it when shipping user-visible changes.

## Architecture

Three-page flow, with state passed between pages via `localStorage`:

1. **[selector.html](selector.html) + [selector.js](selector.js)** — entry point. If no `access_token` in localStorage, kicks off Spotify PKCE login via `startLogin()`. Otherwise paginates `me/playlists`, renders a grid, and on click stores `selected_playlist` and navigates to `index.html`. Also injects a "Shuffle songs" checkbox that writes `shuffle` (`'1'`/`'0'`) to localStorage.
2. **[callback.html](callback.html) + `finishLogin()` in [auth.js](auth.js)** — Spotify OAuth redirect target. Exchanges the `code` for tokens using the stored `code_verifier`, saves `access_token` / `refresh_token`, and bounces back to the app root. Expired access tokens are refreshed on demand: `api()` (both pages) catches a `401`, calls `refreshAccessToken()`, and retries; only if the refresh itself fails does it fall through to `startLogin()`.
3. **[index.html](index.html) + [quiz.js](quiz.js)** — the game. Loads the selected playlist's tracks, sets up a Spotify Web Playback SDK player, and exposes snippet buttons (0.3s / 0.6s / 1s / 2s / 4s), full play, reveal, and next.

### Auth (auth.js)

PKCE flow against `accounts.spotify.com`. Client ID is public and committed. Scopes: `playlist-read-private streaming user-read-playback-state user-modify-playback-state`. Tokens live in `localStorage` (`access_token`, `refresh_token`, `code_verifier`).

### Quiz player (quiz.js)

Key invariants and gotchas — read this before changing playback code:

- **Single init (`maybeSetup`)**: `setupPlayer()` must run exactly once, only after *both* the SDK is ready (`onSpotifyWebPlaybackSDKReady` or `window.Spotify` already present) and the playlist has loaded (`tracksLoaded`). `maybeSetup()` gates on both flags plus `!player`. Don't call `setupPlayer()` directly from the IIFE — that caused a double-init race (two players, two `ready` listeners).
- **`playerReady` gate**: nothing should call `playTrack` / `playSnippet` / `toggleFull` before the SDK's `ready` listener fires. The first `pickNext()` is intentionally deferred until then (not called from the IIFE).
- **Load-once snippets**: a track is loaded onto the device *once* (via REST `me/player/play`, in `playTrack`, flagged by `trackLoaded`). Every subsequent hint / full-play replays it locally through the SDK (`startCurrent` → `player.seek(0)` + `player.resume()`) — no reload, no re-transfer, no extra API call. `pickNext()` resets `trackLoaded=false`. This is what makes repeated hints feel instant; don't go back to re-issuing `play` per hint.
- **Snippet cut**: once playback is *confirmed* started (`waitUntilPlaying`), a single `setTimeout(sec*1000)` (`snippetTimer`) pauses it. Don't reintroduce a polling loop to stop snippets — the old 250ms poll overshot short hints.
- **Shuffle timing**: shuffling happens exactly once, inside the `ready` listener, before the first `pickNext()`. Do *not* re-shuffle when the queue wraps — past bugs were caused by that.
- **Device transfer (`transferHere`)**: Spotify requires the SDK device to be the active one. `transferHere()` is idempotent-guarded with `isTransferring` and caches `me/player` state for 2s to avoid hammering the API. `playTrack` retries the transfer + play up to 3 times.
- **API throttling + token refresh**: the `api()` helper enforces ≥100ms between calls and, on a `401`, refreshes the access token once (`refreshAccessToken` in [auth.js](auth.js)) and retries transparently before falling back to `startLogin()`. `getPlayerState()` caches `player.getCurrentState()` for 100ms. Don't tighten these without a reason — they exist because earlier versions hit rate limits / SDK race conditions.
- **Playlist loading**: `loadTracks` pages through *all* tracks (`?limit=100` + follow `next`), filtering to playable `type === 'track'` items with a `uri`. Tracks are cached in localStorage under `cached_playlist_id` + `cached_tracks`; the selector clears those keys when you pick a playlist so content changes aren't masked by a stale cache.
- **Error recovery**: SDK `playback_error` and failed snippet attempts both fall through to `nextBtn.click()` — i.e. skip the track rather than surface the error.

### localStorage keys (the implicit contract between pages)

`access_token`, `refresh_token`, `code_verifier`, `selected_playlist`, `shuffle`, `cached_playlist_id`, `cached_tracks`.
