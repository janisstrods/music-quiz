/*
 * Shell for the static, When's-that-tune?-only site that tools/build-site.js
 * writes to site/. There is no server: the deck is a pre-resolved deck.json,
 * dealt through the MQ.loadDeck hook that when.js checks for.
 *
 * Screens: start (the splash) → Play → team setup → the game → results, and
 * start → Rules → the rules page. Leaving a game always lands on the start.
 * The browser's Back and Forward move between start, rules and setup.
 */
(function () {
  'use strict';
  const MQ = window.MQ;
  const { $, show, toast, store, nav } = MQ.ui;

  let deck = null;

  function shuffle(a) {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // used: songs already dealt tonight. The others come first, so a long
  // evening works through the whole deck before anything repeats.
  MQ.loadDeck = async (count, used) => {
    if (!deck) {
      // (Revalidated on every visit: the same URL gets a new deck at each publish.)
      const res = await fetch('deck.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('could not load the deck');
      deck = (await res.json()).rounds;
    }
    const heard = r => !!used && used.has(`${r.title}|${r.artist}`);
    return [...shuffle(deck.filter(r => !heard(r))), ...shuffle(deck.filter(heard))].slice(0, count);
  };

  // ---------- navigation ----------
  const TITLE = document.title;
  const active = id => $(id) && $(id).classList.contains('active');
  const modalOpen = () => !!document.querySelector('.modal:not(.hidden)');

  // History: the start is the page's own entry; Rules and setup get one
  // pushed on top of it (#rules, #play), so Back from either is the start
  // and Forward goes there again. Rules → Play swaps #rules for #play rather
  // than stacking. A game pushes an entry of its own (when.js), so Back
  // mid-game asks first. The hash also means a reload or a shared link opens
  // the right page. Screens change at once; the history catches up in order
  // (MQ.ui.nav), and its own steps never re-route.
  const PAGE = { mq: 'page' };
  const url = hash => location.pathname + location.search + hash;
  const onPage = () => !!history.state && history.state.mq === 'page';

  function go(screenId, title) {
    show(screenId);
    document.title = title ? `${title} · ${TITLE}` : TITLE;
    window.scrollTo(0, 0);
    // The button that got us here is hidden now; drop its focus so the next
    // screen's keys (and the browser's own) start from a clean slate.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  // Onto a page from the start: a new entry; from the other page: the same one.
  function enter(hash) {
    nav.run(() => {
      if (location.hash === hash && onPage()) return;
      if (onPage()) history.replaceState(PAGE, '', url(hash));
      else history.pushState(PAGE, '', url(hash));
    });
  }

  function showStart() {
    if (MQ.when) MQ.when.stop();
    go('screen-start', '');
  }
  function showRules() {
    go('screen-rules', 'How to play');
    $('rules-title').focus({ preventScroll: true });
  }
  // From the keyboard, land in the first name box, ready to type. Not on a
  // tap: that would throw a phone's keyboard over the screen unasked.
  function showSetup(fromKeyboard) {
    go('screen-teams', '');
    if (fromKeyboard) $('team-0').focus({ preventScroll: true });
  }

  // Back to the start: step back off the page's entry rather than adding one.
  function goStart() {
    showStart();
    nav.run(() => {
      if (onPage()) nav.back();
      else if (location.hash) history.replaceState(history.state, '', url(''));
    });
  }
  function goRules() {
    showRules();
    enter('#rules');
  }
  function goSetup(fromKeyboard) {
    showSetup(fromKeyboard);
    enter('#play');
  }

  // e.detail is 0 for a click made with Enter or Space on a focused button.
  const byKey = e => !!e && e.detail === 0;

  // Leaving a game lands here under the pointer: the second click of a
  // double-click on Quit to menu or Back to menu mustn't press Play or Rules.
  $('btn-start-play').addEventListener('click', e => { if (e.detail <= 1) goSetup(byKey(e)); });
  $('btn-start-rules').addEventListener('click', e => { if (e.detail <= 1) goRules(); });
  ['btn-rules-play', 'btn-rules-play-end'].forEach(id =>
    $(id).addEventListener('click', e => goSetup(byKey(e))));
  ['btn-rules-back', 'btn-rules-back-end'].forEach(id => $(id).addEventListener('click', goStart));

  // index.html's setup screen has a Back button for the local app's home
  // screen. Here it goes to the start; add one if the markup ever drops it.
  let teamsBack = $('btn-teams-back');
  if (!teamsBack) {
    teamsBack = document.createElement('button');
    teamsBack.id = 'btn-teams-back';
    teamsBack.className = 'ghost-btn';
    teamsBack.type = 'button';
    teamsBack.textContent = '← Back';
    ($('screen-teams').querySelector('.setup-buttons') || $('screen-teams')).appendChild(teamsBack);
  }
  teamsBack.addEventListener('click', goStart);

  // The top bar shows on setup, loading and results. Its title goes to the
  // start (never mid-deal: the game would start behind it), and its Rules
  // button opens the same rules as a dialog.
  $('site-home').addEventListener('click', e => {
    e.preventDefault();
    if (!active('screen-loading')) goStart();
  });
  $('btn-site-rules').addEventListener('click', () => MQ.rules && MQ.rules.open());

  // Start: Enter or P plays, R reads the rules. Rules page: Enter or P plays,
  // Esc goes back. Only when nothing else has focus (a focused button or link
  // keeps its own Enter), P and R also work from the start screen's buttons.
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || modalOpen()) return;
    const onStart = active('screen-start');
    const onRules = active('screen-rules');
    if (!onStart && !onRules) return;
    const a = document.activeElement;
    const idle = !a || a === document.body || a === document.documentElement || a === $('rules-title');
    const own = idle || (onStart && a.closest && !!a.closest('.start-actions'));
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ((key === 'Enter' && idle) || (key === 'p' && own)) {
      e.preventDefault();
      goSetup(true);
    } else if (onStart && key === 'r' && own) {
      e.preventDefault();
      goRules();
    } else if (onRules && key === 'Escape') {
      e.preventDefault();
      goStart();
    }
  });

  // ---------- team setup ----------
  function loadSavedTeams() {
    const teams = store.json('mq_teams', []);
    if (Array.isArray(teams)) teams.forEach((n, i) => { if (i < 3) $('team-' + i).value = n; });
    const target = store.get('mq_target');
    if (target) $('set-target').value = target;
  }

  // The setup's "How to play" names the target chosen and who plays first
  // (no verb to agree with a name: "Janis" and "The Vinyl Kids" both read
  // right); its button opens the full rules as a dialog.
  function syncHowTo() {
    $('how-target').textContent = $('set-target').value;
    $('how-first').textContent = `First up: ${$('team-0').value.trim() || 'Team 1'}`;
  }
  $('set-target').addEventListener('change', syncHowTo);
  $('team-0').addEventListener('input', syncHowTo);
  $('btn-teams-rules').addEventListener('click', () => MQ.rules && MQ.rules.open());

  $('btn-teams-start').addEventListener('click', () => {
    // Teams 1 and 2 always play; team 3 only sits in when it has a name.
    const teamNames = [0, 1].map(i => $('team-' + i).value.trim() || `Team ${i + 1}`);
    const third = $('team-2').value.trim();
    if (third) teamNames.push(third);
    const target = parseInt($('set-target').value, 10);
    store.set('mq_teams', JSON.stringify(teamNames));
    store.set('mq_target', String(target));
    MQ.when.start({ teamNames, target, onExit: goStart });
  });

  // ---------- init ----------
  MQ.rules.render($('rules-page'));
  loadSavedTeams();
  syncHowTo();

  // Back, Forward, or a hash edited in the address bar: show the page the
  // address names. Never mid-game (its own entry guards it: when.js) or
  // mid-deal; from the results, Back goes to the start.
  function route() {
    if (active('screen-loading') || active('screen-when')) return;
    const want = { '#rules': 'screen-rules', '#play': 'screen-teams' }[location.hash] || 'screen-start';
    if (active(want)) return;
    if (MQ.rules && MQ.rules.isOpen) MQ.rules.close();
    if (want === 'screen-rules') showRules();
    else if (want === 'screen-teams') showSetup(false);
    else showStart();
  }
  window.addEventListener('hashchange', route);
  // A link straight to #rules or #play: put the start under it, so Back
  // goes there rather than off the site.
  nav.run(() => {
    const hash = { '#rules': '#rules', '#play': '#play' }[location.hash];
    if (hash && !history.state) {
      history.replaceState(null, '', url(''));
      history.pushState(PAGE, '', url(hash));
    } else if (hash && !onPage()) {
      history.replaceState(PAGE, '', url(hash));   // a reload of a game's own entry
    }
  });
  route();

  MQ.loadDeck(0).catch(() => toast('Could not load the song deck — try reloading the page.'));
})();
