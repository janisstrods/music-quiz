/*
 * Playback engine: official 30-second Apple Music preview clips, streamed
 * straight from Apple. Attaches to window.MQ.audio.
 *
 *   await MQ.audio.play(round, { limitSeconds: 20 })  // -> 'playing'|'blocked'|'stale'
 *   MQ.audio.pause() / .stop()
 *   MQ.audio.progress()   // -> { current, duration, playing, ended }, read-only
 */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});
  const { playingVisual, store } = MQ.ui;

  const el = new Audio();
  el.preload = 'auto';

  const saved = parseFloat(store.get('mq_volume', '0.8'));
  let volume = saved >= 0 && saved <= 1 ? saved : 0.8;
  let stopHandle = null;
  let gen = 0;              // bumped on every stop — stale async callbacks bail
  const errorCbs = [];      // each mode subscribes; only the active one reacts

  el.volume = volume;

  function setVolume(v) {
    volume = v;
    el.volume = v;
    store.set('mq_volume', String(v));
  }

  function stop() {
    gen++;
    clearTimeout(stopHandle);
    el.pause();
    el.removeAttribute('src');
    el.load();
    playingVisual(false);
  }

  // Freeze playback where it is (the quiz "buzz"), without tearing the source
  // down — unlike stop(), this does not invalidate the generation.
  function pause() {
    clearTimeout(stopHandle);
    el.pause();
    playingVisual(false);
  }

  function scheduleEnd(seconds) {
    clearTimeout(stopHandle);
    if (!seconds) return;
    stopHandle = setTimeout(pause, seconds * 1000);
  }

  async function play(round, opts) {
    const { limitSeconds = 0 } = opts || {};
    stop();
    const myGen = gen;

    el.src = round.previewUrl;
    el.volume = volume;
    try {
      await el.play();
      if (myGen !== gen) { el.pause(); return 'stale'; }
      playingVisual(true);
      scheduleEnd(limitSeconds);
      return 'playing';
    } catch (e) {
      if (myGen !== gen) return 'stale';
      return 'blocked';  // autoplay policy — the caller must offer a click
    }
  }

  el.addEventListener('ended', () => playingVisual(false));
  el.addEventListener('error', () => {
    // Only a real, still-current source counts as a failure worth reporting.
    if (el.getAttribute('src')) errorCbs.forEach(cb => cb());
  });

  // Where the clip is, for a progress ring. Read-only: nothing here counts
  // down or cuts the song short.
  function progress() {
    const d = el.duration;
    return {
      current: el.currentTime || 0,
      duration: Number.isFinite(d) ? d : 0,
      playing: !!el.getAttribute('src') && !el.paused && !el.ended,
      ended: !!el.getAttribute('src') && el.ended
    };
  }

  // Apple's preview terms ask for a link back to the track on Apple Music.
  function appleMusicUrl(round) {
    return round && round.trackId ? `https://music.apple.com/song/${round.trackId}` : '';
  }

  MQ.audio = {
    play, pause, stop, setVolume, appleMusicUrl, progress,
    get volume() { return volume; },
    onError(cb) { errorCbs.push(cb); }
  };
})();
