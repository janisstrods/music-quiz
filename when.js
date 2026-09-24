/*
 * When's that tune? mode — two or three teams, one timeline each.
 *
 * The active team hears a song and drops it into a gap in their own timeline.
 * Right, and the card is theirs. Another team may spend a token to challenge
 * the placement; a correct challenge steals the card. Turns go round in order. Naming the title and the
 * artist out loud earns a token back. On their own turn a team may also cash in
 * three tokens for a free card, dealt face up straight into their timeline —
 * on top of the turn, not instead of it. First team to `target` cards wins.
 *
 *   MQ.when.start({ teamNames: ['A','B','C'], target: 20 })
 */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});
  const { $, show, toast, esc, isTyping } = MQ.ui;

  const START_TOKENS = 2;
  const BUY_COST = 3;
  const DECK_SIZE = 80;

  let S = null;        // game state
  let card = null;     // the song in play
  let onExit = null;

  const { slotIsCorrect, insertSorted, slotIsOpen, slotLabel } = window.QuizTimeline;

  const nextIdx = () => (S.active + 1) % S.teams.length;

  // Buying is allowed any time it's plainly your turn: before you lock in, or
  // once the song is revealed. Not while a challenge is pending — that would
  // shift the gaps out from under the placement being judged.
  function canBuy() {
    if (!S || S.buying || S.teams[S.active].tokens < BUY_COST) return false;
    return (S.phase === 'placing' && S.placement == null) || S.phase === 'revealed';
  }

  // ---------- rendering ----------
  function teamsHTML() {
    return S.teams.map((t, i) => `
      <div class="team-card${i === S.active ? ' active' : ''}">
        <span class="team-name">${esc(t.name)}</span>
        <span class="team-cards">🃏 ${t.cards.length} / ${S.target}</span>
        <span class="team-tokens">🎟 ${t.tokens}</span>
      </div>`).join('');
  }

  // Compact token tally for the overlays, which cover the team strip.
  function tokensHTML(eligible) {
    return S.teams.map((t, i) => `
      <span class="token-chip${i === S.active ? ' active' : ''}${eligible && !eligible(i) ? ' dim' : ''}">
        ${esc(t.name)} <b>🎟 ${t.tokens}</b>
      </span>`).join('');
  }

  function cardHTML(c) {
    return `<div class="year-card${c === S.bought ? ' bought' : ''}">
        <img src="${esc(c.artworkUrl || '')}" alt="">
        <b>${c.year}</b>
        <span>${esc(c.title)}</span>
      </div>`;
  }

  // A timeline with same-year cards stacked together. slotHTML(i) renders the
  // gap before cards[i]; it's only asked for gaps that are open.
  function timelineHTML(cards, slotHTML) {
    const parts = [];
    for (let i = 0; i <= cards.length;) {
      parts.push(slotHTML(i));
      if (i === cards.length) break;
      let j = i + 1;
      while (j < cards.length && !slotIsOpen(cards, j)) j++;
      const run = cards.slice(i, j).map(cardHTML).join('');
      parts.push(j - i > 1 ? `<div class="year-stack">${run}</div>` : run);
      i = j;
    }
    return parts.join('');
  }

  // The active team's pick stays on show while a challenge is being weighed
  // and made, so the challenger can see what they're betting against.
  const showsPick = () => S.placement != null && (S.phase === 'placing' || S.phase === 'challenge');

  function render() {
    $('hit-teams').innerHTML = teamsHTML();
    $('hit-reveal-tokens').innerHTML = tokensHTML();
    $('hit-target').textContent = `first to ${S.target}`;

    const cards = S.teams[S.active].cards;
    $('hit-prompt').innerHTML = S.phase === 'challenge'
      ? `<b>${esc(S.teams[S.challenger].name)}</b> — pick a different gap in ${esc(S.teams[S.active].name)}'s timeline.`
      : cards.length === 0
        ? `<b>${esc(S.teams[S.active].name)}</b> — your first card goes down for free. Drop it anywhere.`
        : `<b>${esc(S.teams[S.active].name)}</b> — where does this song belong?`;

    const pickName = esc(S.teams[S.active].name);
    const tl = $('hit-timeline');
    tl.innerHTML = timelineHTML(cards, i => {
      if (showsPick() && i === S.placement) {
        return `<button class="slot original" data-slot="${i}" disabled>
            <span class="slot-caret">▾</span><span class="slot-label">${pickName}'s pick<br>${esc(slotLabel(cards, i))}</span>
          </button>`;
      }
      const locked = S.phase === 'placing' && S.placement != null;
      return `<button class="slot${S.selected === i ? ' selected' : ''}" data-slot="${i}" ${locked ? 'disabled' : ''}>
          <span class="slot-caret">▾</span><span class="slot-label">${esc(slotLabel(cards, i))}</span>
        </button>`;
    });
    tl.querySelectorAll('.slot').forEach(b =>
      b.addEventListener('click', () => selectSlot(parseInt(b.dataset.slot, 10))));
    if (S.phase === 'challenge') tl.querySelector('.slot.original')?.scrollIntoView({ block: 'nearest', inline: 'center' });

    $('btn-hit-confirm').disabled = S.selected == null;
    $('btn-hit-confirm').textContent = S.phase === 'challenge' ? 'Challenge with this gap ▸' : 'Lock it in ▸';
    const canSkip = S.phase === 'placing' && S.teams[S.active].tokens > 0;
    $('btn-hit-skip').disabled = !canSkip;
    $('btn-hit-skip').classList.toggle('hidden', S.phase === 'challenge');
    $('btn-hit-buy').disabled = !canBuy();
    $('btn-hit-buy').classList.toggle('hidden', S.phase !== 'placing');
    $('btn-hit-buy-reveal').classList.toggle('hidden', S.phase !== 'revealed' || S.bonusPending || !canBuy());
    $('btn-hit-next').textContent = S.teams.some(t => t.cards.length >= S.target)
      ? 'See who won ▸' : `${S.teams[nextIdx()].name}'s turn ▸`;
  }

  function selectSlot(i) {
    if (S.phase !== 'placing' && S.phase !== 'challenge') return;
    if (S.phase === 'challenge' && i === S.placement) return;
    S.selected = i;
    render();
  }

  // ---------- turn flow ----------
  async function drawCard() {
    // Skips, wrong placements and two teams burn cards fast — top the deck up
    // rather than ending a good game early.
    if (S.deckIdx >= S.deck.length) {
      let fresh = [];
      try {
        const more = await fetchDeck();
        fresh = more.filter(r => !S.used.has(`${r.title}|${r.artist}`));
      } catch (e) {
        console.warn('deck refill failed', e);
      }
      if (!fresh.length) return null;
      S.deck = fresh;
      S.deckIdx = 0;
    }
    const next = S.deck[S.deckIdx++];
    S.used.add(`${next.title}|${next.artist}`);
    return next;
  }

  async function nextTurn() {
    card = await drawCard();
    if (!card) {
      toast('The deck ran dry — calling it here.');
      return finish();
    }
    S.phase = 'placing';
    S.selected = null;
    S.placement = null;
    S.challenge = null;
    S.bought = null;
    $('hit-reveal').classList.add('hidden');
    $('hit-challenge').classList.add('hidden');
    render();
    playSnippet(false);
  }

  async function playSnippet(replay) {
    const status = await MQ.audio.play(card, { replay });
    $('btn-hit-playgate').classList.toggle('hidden', status !== 'blocked');
  }

  // Only a live pick counts. The confirm button keeps keyboard focus behind the
  // reveal overlay, so a stray Enter lands here after the song is decided —
  // without these guards it re-deals the same card into a second timeline.
  function confirmPlacement() {
    if (!S || S.selected == null) return;
    if (S.phase === 'challenge') {
      S.challenge = { team: S.challenger, slot: S.selected };
      S.selected = null;
      return reveal();
    }
    if (S.phase !== 'placing' || S.placement != null) return;
    S.placement = S.selected;
    S.selected = null;
    // Everyone else who can afford it gets a shot, starting with whoever is up
    // next — with three teams, the first to shout claims the challenge.
    const rivals = [];
    for (let k = 1; k < S.teams.length; k++) {
      const i = (S.active + k) % S.teams.length;
      if (S.teams[i].tokens > 0) rivals.push(i);
    }
    // A team's first card can't be misplaced, so there is nothing to challenge.
    if (S.teams[S.active].cards.length === 0 || !rivals.length) return reveal();
    render();
    const cards = S.teams[S.active].cards;
    const name = esc(S.teams[S.active].name);
    const others = cards.length - cards.slice(1).filter((_, k) => !slotIsOpen(cards, k + 1)).length;
    const who = S.teams.length === 2 ? `<b>${esc(S.teams[rivals[0]].name)}</b>, do you` : 'Does anyone';
    $('challenge-text').innerHTML =
      `${name} put it <b>${esc(slotLabel(cards, S.placement))}</b>. ${who} think they got it wrong?
       Spend 🎟 1 to pick one of the other ${others} gap${others === 1 ? '' : 's'} — if you're right, the card is yours.`;
    const mini = $('challenge-timeline');
    mini.innerHTML = timelineHTML(cards, i => i === S.placement
      ? `<span class="slot original"><span class="slot-caret">▾</span><span class="slot-label">${name}'s pick</span></span>`
      : `<span class="slot open"><span class="slot-label">${esc(slotLabel(cards, i))}</span></span>`);
    $('challenge-tokens').innerHTML = tokensHTML(i => rivals.includes(i));
    $('challenge-rivals').innerHTML = rivals.map(i =>
      `<button class="primary-btn" data-team="${i}">🎟 ${S.teams.length === 2 ? 'Challenge' : esc(S.teams[i].name)}</button>`).join('');
    $('challenge-rivals').querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => startChallenge(parseInt(b.dataset.team, 10))));
    $('hit-challenge').classList.remove('hidden');
    mini.querySelector('.original')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function startChallenge(team) {
    S.phase = 'challenge';
    S.challenger = team;
    S.selected = null;
    $('hit-challenge').classList.add('hidden');
    render();
  }

  function skipSong() {
    if (S.phase !== 'placing' || S.teams[S.active].tokens < 1) return;
    S.teams[S.active].tokens--;
    MQ.audio.stop();
    toast(`${S.teams[S.active].name} skipped — 🎟 1 spent. Here's a new song.`);
    // Skipping swaps the song, not the turn — the same team plays the new card.
    nextTurn();
  }

  async function buyCard() {
    if (!canBuy()) return;
    const game = S;
    S.buying = true;
    render();
    const free = await drawCard();
    if (S !== game) return; // quit while the deck was refilling
    S.buying = false;
    if (!free) {
      toast('The deck is empty — no cards left to buy.');
      return render();
    }
    const team = S.teams[S.active];
    team.tokens -= BUY_COST;
    insertSorted(team.cards, free);
    S.bought = free;
    // The gaps just shifted, so a half-made pick no longer points where it did.
    S.selected = null;
    toast(`${team.name} bought a card — ${free.title} (${free.year}). 🎟 ${BUY_COST} spent.`);
    render();
  }

  function reveal() {
    if (S.phase === 'revealed') return;   // a card is judged exactly once
    MQ.audio.stop();
    S.phase = 'revealed';
    // Whatever button started this sits hidden behind the overlay now.
    if (document.activeElement) document.activeElement.blur();
    $('hit-challenge').classList.add('hidden');
    $('btn-hit-playgate').classList.add('hidden');

    const active = S.teams[S.active];
    const cards = active.cards;
    const activeOk = slotIsCorrect(cards, S.placement, card.year);
    let verdict;

    if (S.challenge) S.teams[S.challenge.team].tokens--;

    if (activeOk) {
      insertSorted(cards, card);
      verdict = S.challenge
        ? `<span class="ok">✓ ${esc(active.name)} nailed it</span> — and the challenge cost ${esc(S.teams[S.challenge.team].name)} a token.`
        : `<span class="ok">✓ ${esc(active.name)} nailed it</span> — card added.`;
    } else if (S.challenge && slotIsCorrect(cards, S.challenge.slot, card.year)) {
      const thief = S.teams[S.challenge.team];
      insertSorted(thief.cards, card);
      verdict = `<span class="miss">✗ ${esc(active.name)} missed</span> — <span class="ok">${esc(thief.name)} steals the card!</span>`;
    } else {
      verdict = S.challenge
        ? `<span class="miss">✗ ${esc(active.name)} and ${esc(S.teams[S.challenge.team].name)} both missed</span> — the card is discarded.`
        : `<span class="miss">✗ ${esc(active.name)} missed</span> — the card is discarded.`;
    }

    $('hit-art').src = card.artworkUrl || '';
    $('hit-year').textContent = card.year;
    $('hit-song').innerHTML = `${esc(card.title)}<br><small>${esc(card.artist)}</small>`;
    $('hit-verdict').innerHTML = verdict;
    $('hit-am-link').href = MQ.audio.appleMusicUrl(card);
    $('hit-bonus-q').innerHTML = `Did <b>${esc(active.name)}</b> say the title <i>and</i> the artist?`;
    S.bonusPending = true;
    $('hit-bonus').classList.remove('hidden');
    $('btn-hit-next').classList.add('hidden');
    render();
    $('hit-reveal').classList.remove('hidden');
  }

  function bonus(earned) {
    if (earned) {
      S.teams[S.active].tokens++;
      toast(`${S.teams[S.active].name} earns 🎟 1.`);
    }
    S.bonusPending = false;
    $('hit-bonus').classList.add('hidden');
    $('btn-hit-next').classList.remove('hidden');
    render();
    $('btn-hit-next').focus();
  }

  function advance() {
    const winner = S.teams.find(t => t.cards.length >= S.target);
    if (winner) return finish();
    S.active = nextIdx();
    nextTurn();
  }

  function finish() {
    MQ.audio.stop();
    S.phase = 'over';
    const best = Math.max(...S.teams.map(t => t.cards.length));
    const leaders = S.teams.filter(t => t.cards.length === best);
    $('hit-winner').textContent = leaders.length === 1 ? `🏆 ${leaders[0].name} wins!`
      : leaders.length === S.teams.length ? `🤝 Dead heat — ${best} cards each!`
        : `🤝 ${leaders.map(t => t.name).join(' & ')} tie on ${best} cards!`;
    $('hit-final').innerHTML = S.teams.map(t => `
      <div class="final-team">
        <h3>${esc(t.name)} — ${t.cards.length} cards · 🎟 ${t.tokens}</h3>
        <div class="timeline final">${timelineHTML(t.cards, () => '') || '<p class="hint">No cards — brutal.</p>'}</div>
      </div>`).join('');
    show('screen-when-results');
  }

  // ---------- entry points ----------
  // The static site (tools/build-site.js) has no server, so it supplies
  // MQ.loadDeck and deals from a pre-resolved deck.json instead.
  async function fetchDeck() {
    if (MQ.loadDeck) return (await MQ.loadDeck(DECK_SIZE)).filter(r => Number.isInteger(r.year));
    const res = await fetch(`/api/when?count=${DECK_SIZE}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'server error');
    return (data.rounds || []).filter(r => Number.isInteger(r.year));
  }

  function shuffle(a) {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  async function start(config) {
    onExit = config.onExit;
    let rounds = config.deck;
    // A rematch reshuffles the deck it already has — no reason to make the
    // table wait on the network twice.
    if (!rounds || rounds.length < 30) {
      show('screen-loading');
      $('loading-text').textContent = 'Shuffling the deck… (the first game takes a moment)';
      try {
        rounds = await fetchDeck();
      } catch (e) {
        toast('Could not deal the deck: ' + e.message);
        return exit();
      }
    } else {
      rounds = shuffle(rounds);
    }
    if (rounds.length < 10) {
      toast('Not enough playable songs right now — try again in a minute.');
      return exit();
    }
    S = {
      teams: config.teamNames.map(name => ({ name, cards: [], tokens: START_TOKENS })),
      active: 0,
      deck: rounds,
      deckIdx: 0,
      used: new Set(),
      target: config.target,
      phase: 'placing',
      selected: null,
      placement: null,
      challenger: null,
      challenge: null,
      bought: null,
      buying: false,
      bonusPending: false
    };
    show('screen-when');
    nextTurn();
  }

  function stop() {
    MQ.audio.stop();
    S = null;
    card = null;
  }

  function exit() {
    stop();
    if (onExit) onExit();
  }

  // ---------- wiring ----------
  $('btn-hit-confirm').addEventListener('click', confirmPlacement);
  $('btn-hit-replay').addEventListener('click', () => card && playSnippet(true));
  $('btn-hit-skip').addEventListener('click', skipSong);
  $('btn-hit-buy').addEventListener('click', buyCard);
  $('btn-hit-buy-reveal').addEventListener('click', buyCard);
  $('btn-hit-playgate').addEventListener('click', () => playSnippet(true));
  $('btn-challenge-no').addEventListener('click', reveal);
  $('btn-bonus-yes').addEventListener('click', () => bonus(true));
  $('btn-bonus-no').addEventListener('click', () => bonus(false));
  $('btn-hit-next').addEventListener('click', advance);
  $('btn-hit-quit').addEventListener('click', exit);
  $('btn-hit-home').addEventListener('click', exit);
  $('btn-hit-again').addEventListener('click', () => {
    if (!S) return;
    start({ teamNames: S.teams.map(t => t.name), target: S.target, deck: S.deck, onExit });
  });
  $('hit-volume').addEventListener('input', e => MQ.audio.setVolume(e.target.value / 100));

  document.addEventListener('keydown', e => {
    if (!S || !$('screen-when').classList.contains('active')) return;
    if (isTyping(e)) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (card && S.phase !== 'revealed') playSnippet(true);
    }
    if (e.key === 'Enter' && S.phase === 'placing' && S.selected != null) confirmPlacement();
  });

  // A dud preview must not cost the active team a token — quietly deal another
  // card and let them play the turn they were owed.
  MQ.audio.onError(() => {
    if (!S || S.phase !== 'placing' || !$('screen-when').classList.contains('active')) return;
    toast('That preview failed to load — dealing another song.');
    nextTurn();
  });

  MQ.when = { start, stop };
})();
