/* This build's release: a number, and a name — a song that fits what the
   release did. Bump both with every publish. Both editions show it on their
   main screen, in each .app-version element. */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});

  // 1.0 went public (2026-09-24) · 2.0 the Stage redesign, the site's start
  // and rules screens · 2.1 the deck grew to 625 songs · 2.1.1 "Should I Stay
  // or Should I Go": a chosen gap stays chosen when a card is bought, unless
  // the card lands inside it · 2.1.2 the reveal shows cards bought that turn,
  // tagged in gold as on the board · 2.2 "The One That Got Away": the results
  // list the skipped songs, to hear now.
  MQ.version = { number: '2.2', name: 'The One That Got Away', artist: 'Katy Perry' };

  const { number, name, artist } = MQ.version;
  document.querySelectorAll('.app-version').forEach(el => {
    el.textContent = `v${number} · “${name}” · ${artist}`;
    el.title = `Version ${number}, named after “${name}” by ${artist}`;
  });
})();
