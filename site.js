/*
 * Shell for the static, When's-that-tune?-only site that tools/build-site.js
 * writes to site/. There is no server: the deck is a pre-resolved deck.json,
 * dealt through the MQ.loadDeck hook that when.js checks for.
 */
(function () {
  'use strict';
  const MQ = window.MQ;
  const { $, show, toast } = MQ.ui;

  let deck = null;

  function shuffle(a) {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  MQ.loadDeck = async count => {
    if (!deck) {
      const res = await fetch('deck.json');
      if (!res.ok) throw new Error('could not load the deck');
      deck = (await res.json()).rounds;
    }
    return shuffle(deck).slice(0, count);
  };

  function loadSavedTeams() {
    try {
      const teams = JSON.parse(localStorage.getItem('mq_teams') || '[]');
      teams.forEach((n, i) => { if (i < 3) $('team-' + i).value = n; });
    } catch (_) {}
    const target = localStorage.getItem('mq_target');
    if (target) $('set-target').value = target;
  }

  $('btn-teams-start').addEventListener('click', () => {
    // Teams 1 and 2 always play; team 3 only sits in when it has a name.
    const teamNames = [0, 1].map(i => $('team-' + i).value.trim() || `Team ${i + 1}`);
    const third = $('team-2').value.trim();
    if (third) teamNames.push(third);
    const target = parseInt($('set-target').value, 10);
    try {
      localStorage.setItem('mq_teams', JSON.stringify(teamNames));
      localStorage.setItem('mq_target', String(target));
    } catch (_) {}
    MQ.when.start({ teamNames, target, onExit: () => show('screen-teams') });
  });

  $('hit-volume').value = String(Math.round(MQ.audio.volume * 100));

  loadSavedTeams();
  MQ.loadDeck(0).catch(() => toast('Could not load the song deck — try reloading the page.'));
})();
