/*
 * When's that tune? mode — two or three teams, one timeline each.
 *
 * The active team hears a song and drops it into a gap in their own timeline.
 * Right, and the card is theirs. Another team may spend a token to challenge
 * the placement; if the placement was wrong and the challenge right, the card
 * is stolen. Turns go round in order. Naming the title and the artist out loud
 * earns a token back. On their own turn a team may also cash in three tokens
 * for a free card, dealt face up straight into their timeline — on top of the
 * turn, not instead of it. First team to `target` cards wins.
 *
 * Each song moves through explicit phases:
 *
 *   placing ──lock in──▶ ask ──a rival steps up──▶ challenge ──confirm──▶ revealed
 *      │                  │  ◀──"Not a challenge"───┘                      │
 *      │                  └──────── let it stand ─────────────────▶ revealed
 *      └── first card, or no rival holds a token ─────────────────▶ revealed
 *   revealed ──Next──▶ handoff (the 1.2 s turn banner) ──▶ placing (next team) … ──▶ over
 *
 * No token changes hands until the reveal, so backing out of a challenge is free.
 *
 * The screen is one viewport tall: a scoreboard header, the hero turn line,
 * the active team's whole timeline (wrapped into rows by layoutTimeline(),
 * which picks the card size that fits), and an action bar at the bottom.
 * Choosing a gap only flips classes, so nothing on screen moves. Once a pick
 * is locked in, the hero line becomes the challenge band: the ask, then the
 * challenger's pick, with one slot under each team's tile. The reveal takes
 * the place of the turn line and the timeline, under the live scoreboard:
 * the song, the outcome, and where the card belonged in the placing team's
 * line. The results rank the teams, tell the story of the game from S.log
 * (steals, the longest run, the winning card) and show every card of every
 * timeline. Quit asks first, with the standings, and so does the browser's
 * Back button: a game keeps a history entry of its own.
 *
 *   MQ.when.start({ teamNames: ['A','B','C'], target: 20 })
 *   MQ.when.snapshot()   // read-only JSON copy of the game, for tests and the console
 */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});
  const { $, show, toast, esc, isTyping, modalOpen, openModal, closeModal, topModal, whenNoModal, nav } = MQ.ui;

  const START_TOKENS = 2;
  const BUY_COST = 3;
  const DECK_SIZE = 80;
  const REMATCH_MIN = 30;   // fewer fresh songs than this and a rematch fetches more
  const MIN_SONGS = 10;     // a game doesn't start on fewer fresh songs than this
  const NEXT_ARM_MS = 450;  // Next ignores clicks and Enter this long after a reveal
  const SLOT_ARM_MS = 400;  // a gap click this soon after a turn starts was aimed at the last screen
  const BANNER_MS = 1200;   // the "you're up" banner between a reveal and the next song

  let S = null;        // game state
  let card = null;     // the song in play
  let onExit = null;
  let lastPrompt = null;
  let bannerTimer = 0;

  const { slotIsCorrect, insertSorted, slotIsOpen, slotLabel } = window.QuizTimeline;

  const now = () => performance.now();
  const songKey = r => `${r.title}|${r.artist}`;
  const brief = c => ({ title: c.title, artist: c.artist, year: c.year });
  const nextIdx = () => (S.active + 1) % S.teams.length;
  const reached = () => S.teams.some(t => t.cards.length >= S.target);
  // "The Vinyl Kids' pick", not "The Vinyl Kids's pick".
  const possessive = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

  // Rivals who can pay for a challenge, in seat order (the order of their tiles).
  function eligibleRivals() {
    return S.teams.map((_, i) => i).filter(i => i !== S.active && S.teams[i].tokens > 0);
  }

  // Gaps that can take a card, in order. Same-year stacks have no gap inside,
  // and in a challenge the defender's gap is already taken.
  function openSlots(cards = S.teams[S.active].cards) {
    const out = [];
    for (let i = 0; i <= cards.length; i++) {
      if (slotIsOpen(cards, i) && !(S.phase === 'challenge' && i === S.placement)) out.push(i);
    }
    return out;
  }

  // Every open gap a card of this year fits. Ties are generous, so a same-year
  // neighbour can make two gaps right.
  function correctSlots(cards, year) {
    const out = [];
    for (let i = 0; i <= cards.length; i++) {
      if (slotIsOpen(cards, i) && slotIsCorrect(cards, i, year)) out.push(i);
    }
    return out;
  }

  // Under the turn banner the next team's screen is already drawn exactly as
  // it will be when the banner lifts (so nothing flickers then); it just
  // can't be used yet. Drawing asks view(); the rules ask S.phase.
  const view = () => (S.phase === 'handoff' ? 'placing' : S.phase);

  const picking = (ph = S.phase) => (ph === 'placing' && S.placement == null) || ph === 'challenge';

  // Skipping swaps a song you're stuck on. Not on a free first card (it can't
  // be wrong), and not once the pick is locked in.
  function canSkip(ph = S && S.phase) {
    if (!S || S.dealing || ph !== 'placing' || S.placement != null) return false;
    const team = S.teams[S.active];
    return team.cards.length > 0 && team.tokens > 0;
  }

  // Buying is allowed any time it's plainly your turn: before you lock in, or
  // once the song is revealed. Not while a challenge is pending (that would
  // shift the gaps out from under the placement being judged), and not once
  // someone has reached the target (a buy then could only muddy the win).
  function canBuy(ph = S && S.phase) {
    if (!S || S.dealing || S.teams[S.active].tokens < BUY_COST || reached()) return false;
    return (ph === 'placing' && S.placement == null) || ph === 'revealed';
  }

  // ---------- rendering ----------
  // Elements are rewritten only when their markup changes, so a click that
  // changes nothing on them leaves them (and everything around) untouched.
  const written = new WeakMap();
  function setHTML(el, html) {
    if (written.get(el) === html) return false;
    written.set(el, html);
    el.innerHTML = html;
    return true;
  }
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setLabel(el, text) {
    if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // The tile's tag: whose turn it is, and (while a challenge is on) who is
  // defending and who is challenging. Words, not just a colour (ACCESS-10).
  // [class, tag, spoken]
  function tileBadge(i) {
    if (S.phase === 'challenge') {
      if (i === S.challenger) return ['challenging', '⚔ Challenging', 'challenging'];
      return i === S.active ? ['defending', 'Defending', 'defending'] : null;
    }
    if (i !== S.active) return null;
    return S.phase === 'ask' ? ['up', 'Locked in', 'locked in'] : ['up', '▶ Up', 'your turn'];
  }

  // Tokens as gold tickets (a count once there are too many to show), with
  // the word, so nobody has to decode an emoji from the sofa (ROOM-13). When
  // the count changed this turn, a +1 / −1 badge takes the word's place.
  function tokensTileHTML(n, d) {
    const tks = !n ? (d ? '<span class="tk-zero">0</span>' : '<span class="tk-none">no</span>')
      : n <= 4 ? `<span class="tks">${'<i class="tk"></i>'.repeat(n)}</span>`
        : `<span class="tks"><i class="tk"></i><b>×${n}</b></span>`;
    return tks + (d ? deltaHTML(d) : `<span class="word">${n === 1 ? 'token' : 'tokens'}</span>`) +
      `<span class="tk-num"><i class="tk"></i>${n}</span>`;
  }

  // What changed on each tile since this team's turn began: the card that
  // landed or was stolen, the bought card, a challenge's token, the bonus, a
  // skip (CHALLENGE-8, ROOM-10, ARC-8). Right on the tile, not in a toast.
  function delta(i) {
    const t = S.teams[i], b = S.base && S.base[i];
    return b ? { cards: t.cards.length - b.cards, tokens: t.tokens - b.tokens } : { cards: 0, tokens: 0 };
  }
  const signed = n => (n > 0 ? `+${n}` : `−${-n}`);
  const deltaHTML = n => `<span class="dl ${n > 0 ? 'up' : 'down'}">${signed(n)}</span>`;

  // One tile: [class, inner HTML].
  function tileParts(i) {
    const t = S.teams[i];
    const n = t.cards.length;
    const badge = tileBadge(i);
    const d = delta(i);
    const pct = Math.min(100, Math.round((n / S.target) * 100));
    const changed = [d.cards && `${signed(d.cards)} ${Math.abs(d.cards) === 1 ? 'card' : 'cards'}`, d.tokens && `${signed(d.tokens)} 🎟`].filter(Boolean);
    const said = `${t.name}: ${n} of ${S.target} cards` + (d.cards ? ` (${signed(d.cards)} this turn)` : '') +
      `, ${plural(t.tokens, 'token')}` + (d.tokens ? ` (${signed(d.tokens)} this turn)` : '') + `${badge ? `, ${badge[2]}` : ''}.`;
    return [`tile t${i}${badge ? ' ' + badge[0] : ''}`,
      `<span class="sr-only">${esc(said)}</span>
        <span class="tile-name" aria-hidden="true">${esc(t.name)}</span>
        <span class="tile-badge" aria-hidden="true">${badge ? esc(badge[1]) : ''}</span>
        <span class="tile-count" aria-hidden="true"><b>${n}</b><span class="of">/ ${S.target}</span>${d.cards ? deltaHTML(d.cards) : '<i class="cg"></i><span class="word">cards</span>'}</span>
        <span class="tile-tokens" aria-hidden="true">${tokensTileHTML(t.tokens, d.tokens)}</span>
        <span class="tile-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
        ${changed.length ? `<span class="tile-delta" aria-hidden="true">${esc(changed.join(' · '))}</span>` : ''}`];
  }

  // The scoreboard: one tile per team, in seat order (keys 1/2/3 follow it).
  // Each tile is rewritten only when it changes, so a badge pops once, on
  // the tile it belongs to.
  function renderTiles() {
    const box = $('hit-teams');
    if (box.children.length !== S.teams.length) {
      box.innerHTML = S.teams.map(() => '<div role="listitem"></div>').join('');
    }
    S.teams.forEach((_, i) => {
      const el = box.children[i];
      const [cls, html] = tileParts(i);
      if (el.className !== cls) el.className = cls;
      setHTML(el, html);
    });
  }

  // i: the card's index in the timeline (the board rings a chosen gap's neighbours by it).
  function cardHTML(c, i) {
    return `<div class="year-card${c === S.bought ? ' bought' : ''}" data-i="${i}">
        <img src="${esc(c.artworkUrl || '')}" alt="">
        <b>${c.year}</b>
        <span>${esc(c.title)}</span>
      </div>`;
  }

  // A line in same-year runs, as [from, to) index pairs. A run of more than
  // one card is a stack: there's no gap inside it.
  function runsOf(cards) {
    const out = [];
    for (let i = 0; i < cards.length;) {
      let j = i + 1;
      while (j < cards.length && !slotIsOpen(cards, j)) j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  }

  // The active team's pick stays on show while a challenge is being weighed
  // and made, so the challenger can see what they're betting against.
  const showsPick = () => S.placement != null && (S.phase === 'ask' || S.phase === 'challenge');

  // The hero line while placing: who's up, the question, and the gap chosen.
  // (Once a pick is locked in, the challenge band takes its place.)
  function heroParts() {
    const team = S.teams[S.active];
    const cards = team.cards;
    let q = cards.length ? 'Where does this song belong?' : 'Free card: it can’t be wrong.';
    let qShort = cards.length ? 'Where does it go?' : '';   // for a phone's narrow line
    let qGold = false;
    if (S.blocked) q = 'Tap the record to hear the song first.';
    else if (S.bought) {
      q = `🎟 Bought “${S.bought.title}” (${S.bought.year}): the gaps moved, pick again`;
      qGold = true;
    }
    if (q !== 'Where does this song belong?') qShort = '';
    return {
      who: team.name, pill: 'Your turn', sr: `${team.name}, your turn. `, q, qShort, qGold,
      range: S.selected == null ? null : cards.length ? slotLabel(cards, S.selected) : 'anywhere'
    };
  }

  // The prompt is a live region: rewrite it only when the words change, or a
  // screen reader reads the same sentence out again on every click.
  function setPrompt(html) {
    if (html === lastPrompt && $('hit-prompt').innerHTML) return;
    lastPrompt = html;
    $('hit-prompt').innerHTML = html;
  }

  function renderHero() {
    const banded = S.phase === 'ask' || S.phase === 'challenge';
    $('hit-band').classList.toggle('hidden', !banded);
    document.querySelector('.wt-hero').classList.toggle('banded', banded);
    if (banded) return renderBand();
    const h = heroParts();
    setText($('hit-who'), h.who);
    $('hit-who').classList.toggle('gold', !!h.gold);
    setText($('hit-turn-pill'), h.pill);
    $('hit-turn-pill').classList.toggle('gold', !!h.gold);
    setPrompt(`<span class="sr-only">${esc(h.sr)}</span>` + (h.qShort
      ? `<span class="q-long has-short">${esc(h.q)}</span><span class="q-short" aria-hidden="true">${esc(h.qShort)}</span>`
      : esc(h.q)));
    $('hit-prompt').classList.toggle('gold', !!h.qGold);
    // One fixed width, whatever it says (styles.css), so choosing a gap moves nothing.
    const range = $('hit-range');
    setText(range, h.range || 'pick a gap');
    range.classList.toggle('quiet', !h.range);
    // The name-it reminder is loud for the first round or two, then steps back.
    $('hit-mic').classList.toggle('hot', S.turns <= S.teams.length * 2);
  }

  // ---------- the challenge band ----------
  // After lock-in the challenge is its own beat on the main screen, at
  // headline size, with the full-size line still below it (CHALLENGE-2).
  // Every team has a slot under its own tile, so a rival's button is in the
  // same place every turn (CHALLENGE-7): the ask shows the placing team's
  // "placed it" and each rival's challenge button; the pick shows the two
  // picks side by side (ROOM-M2).
  function askTextHTML() {
    const cards = S.teams[S.active].cards;
    const rivals = eligibleRivals();
    const others = openSlots().filter(i => i !== S.placement);
    const which = others.length === 1 ? `the only other gap (${esc(slotLabel(cards, others[0]))})` : 'another gap';
    const think = rivals.length === 1 ? `<b>${esc(S.teams[rivals[0]].name)}</b>, think it's wrong?` : "Think it's wrong?";
    // The three-team rule, said out loud: the UI can't referee a shouting match.
    return `<span class="band-long">${think} </span>Spend 🎟 1 and pick ${which}. ` +
      "If they're wrong and you're right, <b>you steal the card</b>. " +
      (rivals.length > 1
        ? 'First to shout “Challenge!” takes it<span class="band-long"> · one challenge per song</span> · the 🎟 is spent win or lose.'
        : 'The 🎟 is spent win or lose.');
  }

  function askSlotsHTML() {
    const rivals = eligibleRivals();
    return S.teams.map((t, i) => {
      if (i === S.active) {
        return `<div class="band-slot placed" data-seat="${i}"><span><b>${esc(t.name)}</b> placed it</span></div>`;
      }
      const ok = rivals.includes(i);
      // The name on top, whole, and no verb to agree with it ("Janis", "The
      // Vinyl Kids" alike): the action word sits with the cost.
      const said = ok ? `Challenge from ${t.name}, ${plural(t.tokens, 'token')} left` : `${t.name} can't challenge: no tokens`;
      return `<button class="band-slot rival t${i}" data-seat="${i}" data-team="${i}" aria-label="${esc(said)}"${ok ? '' : ' disabled'}>
          <span class="bs-name">⚔ ${esc(t.name)}</span>
          <span class="bs-meta">${ok ? `<span class="bs-verb">Challenge</span><span class="cost">🎟 ${t.tokens} left</span><kbd>${i + 1}</kbd>` : '<span class="bs-why">no tokens</span>'}</span>
        </button>`;
    }).join('') + '<button id="btn-challenge-no" class="band-slot stand">Let it stand ▸ <kbd>N</kbd></button>';
  }

  function pickSlotsHTML() {
    const at = slotLabel(S.teams[S.active].cards, S.placement);
    return S.teams.map((t, i) => {
      if (i === S.active) {
        return `<div class="band-slot pick def" data-seat="${i}"><span>${esc(possessive(t.name))} pick</span><b>${esc(at)}</b></div>`;
      }
      if (i === S.challenger) {
        return `<div class="band-slot pick chal" data-seat="${i}"><span>⚔ ${esc(possessive(t.name))} pick</span><b id="hit-band-pick"></b></div>`;
      }
      return `<div class="band-slot none" data-seat="${i}" aria-hidden="true"></div>`;
    }).join('');
  }

  function renderBand() {
    const team = S.teams[S.active];
    const cards = team.cards;
    if (S.phase === 'ask') {
      setHTML($('challenge-title'), `⚔ Challenge ${esc(possessive(team.name))} <span class="gold">${esc(slotLabel(cards, S.placement))}</span>?`);
      setHTML($('challenge-text'), askTextHTML());
      setHTML($('challenge-rivals'), askSlotsHTML());
    } else {
      setHTML($('challenge-title'), `⚔ Challenge from <span class="gold">${esc(S.teams[S.challenger].name)}</span> ` +
        '<span id="hit-band-range" class="range-pill band-range"></span>');
      setHTML($('challenge-text'), `<span class="band-long">Pick where <i>you</i> think it goes in ${esc(possessive(team.name))} timeline. </span>` +
        "🎟 1 on the line: steal it if they're wrong and you're right. " +
        '<span class="band-nb">Wrong team? ✕ Not a challenge costs nothing.</span>');
      setHTML($('challenge-rivals'), pickSlotsHTML());
      // Only words change as the challenger picks; both boxes keep their size.
      const range = S.selected != null ? slotLabel(cards, S.selected) : null;
      for (const el of [$('hit-band-range'), $('hit-band-pick')]) {
        setText(el, range || 'pick a gap');
        el.classList.toggle('quiet', !range);
      }
      $('hit-band-range').classList.toggle('gold', !!range);
    }
    alignBand();
  }

  // Puts each slot under its own team's tile, and "Let it stand" under the
  // tools; where the tiles take the whole width (a phone), it gets a row of
  // its own. Reads only the header, so choosing a gap changes none of this.
  function alignBand() {
    if (!S || $('hit-band').classList.contains('hidden')) return;
    const row = $('challenge-rivals');
    const px = n => `${Math.round(n * 100) / 100}px`;
    const place = (el, ml, w) => {
      if (el.style.marginLeft !== ml) el.style.marginLeft = ml;
      if (el.style.width !== w) el.style.width = w;
    };
    let edge = row.getBoundingClientRect().left;
    [...$('hit-teams').children].forEach((tile, i) => {
      const slot = row.querySelector(`[data-seat="${i}"]`);
      if (!slot) return;
      const r = tile.getBoundingClientRect();
      // A hair narrower than the tile, so rounding can never wrap the row.
      const ml = Math.round((r.left - edge) * 100) / 100;
      const w = Math.floor((r.width - 0.05) * 100) / 100;
      place(slot, `${ml}px`, `${w}px`);
      edge += ml + w;
    });
    const stand = $('btn-challenge-no');
    if (!stand) return;
    const tools = document.querySelector('.wt-tools').getBoundingClientRect();
    const w = Math.max(tools.width, parseFloat(getComputedStyle(stand).minWidth) || 0);
    const gap = parseFloat(getComputedStyle($('hit-teams')).columnGap) || 12;
    const beside = tools.right - w >= edge + gap;
    stand.classList.toggle('wrap', !beside);
    if (beside) place(stand, px(tools.right - w - edge), px(w - 0.05));
    else place(stand, '', '');
  }
  // The tiles resize with the window (and re-flow at the phone breakpoint).
  if (window.ResizeObserver) new ResizeObserver(() => alignBand()).observe($('hit-teams'));

  // The band's heading takes focus when it changes beat, never a rival's
  // button: a stray Enter must not start (or pay for) a challenge.
  function focusBand() {
    $('challenge-title').focus({ preventScroll: true });
  }

  function captionHTML() {
    const team = S.teams[S.active];
    const n = team.cards.length;
    const head = `<b>${esc(possessive(team.name))} timeline</b>`;
    if (S.phase === 'ask') return `${head} · locked in: ${esc(slotLabel(team.cards, S.placement))} · the other gaps are open to a challenge`;
    if (S.phase === 'challenge') return `${head} · ${esc(S.teams[S.challenger].name)}: pick a different gap`;
    if (!n) return `${head} · empty · the first card is free`;
    return `${head} · ${plural(n, 'card')} · oldest → newest`;
  }

  // ---------- the timeline board ----------
  // The line is built only when what's on it changes (a new turn, a card in or
  // out, a pick locked in, the gaps going live or dead). Choosing a gap only
  // flips classes, so nothing on screen moves or resizes (LOOP-4/5, ROOM-1).
  let built = null;        // what the board in the DOM was built for
  let laidOutFor = null;   // the board size layoutTimeline() last fitted
  let held = null;         // { line, size, d, rows } of the last layout: the ask and the pick keep them
  const DENSITIES = ['large', 'full', 'compact', 'tiny'];

  // A gap shows "+", or "?" once chosen. Both always take up the same spot,
  // one of them invisible, so the swap can't nudge anything.
  const SLOT_MARK = '<span class="slot-mark" aria-hidden="true"><span class="slot-plus">+</span><span class="slot-q">?</span></span>';

  function slotButtonHTML(i, cards, live) {
    if (!cards.length) {
      return `<button class="slot first" data-slot="0" aria-pressed="false" ${live ? '' : 'disabled'}>
          ${SLOT_MARK}<span class="slot-first">Your timeline starts here</span>
        </button>`;
    }
    const label = slotLabel(cards, i);
    if (showsPick() && i === S.placement) {
      const who = `${possessive(S.teams[S.active].name)} pick`;
      return `<button class="slot original" data-slot="${i}" disabled aria-label="${esc(`${who}: ${label}`)}">
          <span>${esc(who)}</span><b>${esc(label)}</b><span class="orig-tag">${S.phase === 'ask' ? 'Locked in' : 'Defending'}</span>
        </button>`;
    }
    return `<button class="slot" data-slot="${i}" aria-pressed="false" aria-label="${esc(label)}" ${live ? '' : 'disabled'}>${SLOT_MARK}</button>`;
  }

  // The line in pieces, each tagged with its unit: a row may only break
  // before a card, so every gap rides at the end of the row with the card
  // before it, and a same-year stack is one piece that never splits.
  function boardHTML(cards, live) {
    const tag = (html, unit) => html.replace(/^\s*<(\w+)/, `<$1 data-u="${unit}"`);
    const parts = [tag(slotButtonHTML(0, cards, live), 0)];
    runsOf(cards).forEach(([i, j], u) => {
      const run = cards.slice(i, j).map((c, k) => cardHTML(c, i + k)).join('');
      parts.push(tag(j - i > 1 ? `<div class="year-stack">${run}</div>` : run, u));
      parts.push(tag(slotButtonHTML(j, cards, live), u));
    });
    return `<div class="tl-row">${parts.join('')}</div>`;
  }

  function renderTimeline() {
    const cards = S.teams[S.active].cards;
    const tl = $('hit-timeline');
    const live = picking(view()) && !S.dealing;
    const key = [S.active, cards.map(c => c.seq).join(','), S.phase === 'challenge' ? 'c' : '',
      showsPick() ? S.placement : '', live, S.bought ? S.bought.seq : ''].join('|');
    if (key !== built) {
      built = key;
      // A gap reached with the keyboard keeps focus across a rebuild.
      const f = document.activeElement;
      const refocus = f && tl.contains(f) && f.matches(':focus-visible') ? f.dataset.slot : null;
      tl.dataset.phase = view();
      tl.innerHTML = boardHTML(cards, live);
      layoutTimeline();
      if (refocus != null) tl.querySelector(`.slot[data-slot="${refocus}"]:not(:disabled)`)?.focus({ preventScroll: true });
    }
    markSelection();
  }

  // The chosen gap gets the pink fill and "?", its two neighbours a ring.
  function markSelection() {
    const tl = $('hit-timeline');
    const sel = picking(view()) ? S.selected : null;
    tl.querySelectorAll('.slot:not(.original)').forEach(b => {
      const on = sel != null && parseInt(b.dataset.slot, 10) === sel;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
    tl.querySelectorAll('.year-card[data-i]').forEach(c => {
      const i = parseInt(c.dataset.i, 10);
      c.classList.toggle('nb', sel != null && (i === sel - 1 || i === sel));
    });
  }

  // Picks the biggest cards that let the whole line fit between the hero and
  // the action bar — large → full → compact → tiny (artwork stays while it
  // fits) — and wraps it into rows, centred as a block. Runs when the line is
  // built and when the board changes size; never when a gap is chosen.
  function layoutTimeline() {
    const tl = $('hit-timeline');
    const board = $('hit-board');
    const items = [...tl.querySelectorAll('[data-u]')];
    if (!S || !items.length) return;
    const bs = getComputedStyle(board);
    const cap = $('hit-caption');
    const availW = board.clientWidth - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight);
    const availH = board.clientHeight - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom) -
      cap.offsetHeight - parseFloat(getComputedStyle(cap).marginBottom);
    laidOutFor = `${board.clientWidth}x${board.clientHeight}`;
    // Moving a focused gap between rows would drop its focus; put it back after.
    const focused = tl.contains(document.activeElement) ? document.activeElement : null;

    // Measure every piece in one row, at each density in turn.
    const row = document.createElement('div');
    row.className = 'tl-row';
    items.forEach(el => row.appendChild(el));
    tl.replaceChildren(row);
    if (items.length === 1 && items[0].classList.contains('first')) {
      fitFirst(tl, items[0], availH);
      if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
      return;
    }
    delete tl.dataset.first;
    // The ask and the pick keep the density and the rows this line had in
    // placing on this screen, so the room never has to find the pick again;
    // the taller band may make the board scroll instead (V3).
    const line = `${S.active}|${S.teams[S.active].cards.map(c => c.seq).join(',')}`;
    const size = `${innerWidth}x${innerHeight}`;
    const hold = showsPick() && held && held.line === line && held.size === size ? held : null;
    let pick = null;
    for (const d of hold ? [hold.d] : DENSITIES) {
      tl.dataset.density = d;
      const ts = getComputedStyle(tl);
      const cg = parseFloat(getComputedStyle(row).columnGap) || 0;
      const rg = parseFloat(ts.rowGap) || 0;
      const w = availW - parseFloat(ts.paddingLeft) - parseFloat(ts.paddingRight);
      const unitW = [];
      items.forEach(el => {
        const u = parseInt(el.dataset.u, 10);
        const iw = el.getBoundingClientRect().width;
        unitW[u] = unitW[u] == null ? iw : unitW[u] + cg + iw;
      });
      // Fill rows left to right up to `limit` px wide.
      const breakRows = limit => {
        const out = [];
        let rowW = 0;
        unitW.forEach((uw, u) => {
          if (out.length && rowW + cg + uw <= limit) { out[out.length - 1].push(u); rowW += cg + uw; }
          else { out.push([u]); rowW = uw; }
        });
        return out;
      };
      // Then even them out: the narrowest limit that needs no more rows, so a
      // line never ends on a lonely card.
      const fit = limit => {
        const rows = breakRows(limit);
        if (rows.length < 2) return rows;
        let lo = Math.max(...unitW), hi = limit;
        while (hi - lo > 1) {
          const mid = (lo + hi) / 2;
          if (breakRows(mid).length <= rows.length) hi = mid; else lo = mid;
        }
        return breakRows(hi);
      };
      const widthOf = us => us.reduce((sum, u) => sum + unitW[u], 0) + (us.length - 1) * cg;
      // A held row that the locked pick (wider than a gap) no longer fits in
      // hands its last pieces on to the next: breaks move by the pick, no more.
      const reflow = kept => {
        const rows = kept.map(us => us.slice());
        for (let r = 0; r < rows.length; r++) {
          while (rows[r].length > 1 && widthOf(rows[r]) > w + 0.5) {
            if (r === rows.length - 1) rows.push([]);
            rows[r + 1].unshift(rows[r].pop());
          }
        }
        return rows;
      };
      const rows = hold ? reflow(hold.rows) : fit(w);
      const widest = Math.max(...rows.map(widthOf));
      const h = rows.length * row.getBoundingClientRect().height + (rows.length - 1) * rg +
        parseFloat(ts.paddingTop) + parseFloat(ts.paddingBottom);
      pick = { d, rows };
      if (hold || (h <= availH + 0.5 && widest <= w + 0.5)) break;
    }
    held = { line, size, d: pick.d, rows: pick.rows };
    tl.dataset.density = pick.d;
    tl.replaceChildren(...pick.rows.map((units, r) => {
      const el = document.createElement('div');
      el.className = 'tl-row';
      items.filter(it => units.includes(parseInt(it.dataset.u, 10))).forEach(it => el.appendChild(it));
      // The last gap on a row carries on at the start of the next.
      if (r < pick.rows.length - 1) el.insertAdjacentHTML('beforeend', '<span class="tl-cont" aria-hidden="true">↵</span>');
      return el;
    }));
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  // Turn 1: the line is one gap, a card-sized box (CSS). On a board shorter
  // than that (a landscape phone, 200% zoom) it takes the height there is
  // while the "?" and the words still fit upright, else it lies flat with the
  // "?" beside the words; nothing spills out of it (V4).
  function fitFirst(tl, el, availH) {
    const ts = getComputedStyle(tl);
    const room = Math.floor(availH - parseFloat(ts.paddingTop) - parseFloat(ts.paddingBottom));
    tl.dataset.density = 'large';
    tl.dataset.first = 'up';
    el.style.height = '';
    if (el.offsetHeight <= room) return;
    el.style.aspectRatio = 'auto';
    const need = el.offsetHeight;
    el.style.aspectRatio = '';
    if (need > room) {
      tl.dataset.first = 'flat';
      if (el.offsetHeight >= room) return;
    }
    el.style.height = `${room}px`;
  }

  // After a resize or a rotation, the pick in play stays in sight: the chosen
  // gap (placing, a challenge) or the locked pick (the ask) (V10).
  function keepPickInView() {
    const tl = $('hit-timeline');
    const el = (picking(view()) && tl.querySelector('.slot.selected')) || (showsPick() && tl.querySelector('.slot.original'));
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // A window resize, a turn line that wraps differently, a phone rotated:
  // refit the line to the room it now has.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (!S || S.phase === 'over' || !$('screen-when').classList.contains('active')) return;
      const board = $('hit-board');
      // (The reveal hides the board: nothing to fit until it's back.)
      if (!board.clientWidth) return;
      if (`${board.clientWidth}x${board.clientHeight}` === laidOutFor) return;
      layoutTimeline();
      keepPickInView();
    }).observe($('hit-board'));
  }

  // ---------- the action bar ----------
  function renderBar() {
    const team = S.teams[S.active];
    const cards = team.cards;
    const first = !cards.length;
    const ph = view();
    const locked = ph !== 'placing' || S.placement != null;
    const revealed = ph === 'revealed';
    $('screen-when').querySelector('.wt-bar').classList.toggle('revealing', revealed);

    // Token moves: dead when they can't be used, and they say why (ARC-1).
    // The ask and the pick are the rivals' moment: token moves step aside.
    // On the reveal only Buy stays, and only while the team can afford it.
    const banded = ph === 'ask' || ph === 'challenge';
    const skip = $('btn-hit-skip');
    skip.disabled = !canSkip(ph);
    skip.classList.toggle('hidden', banded || revealed);
    const skipWhy = !skip.disabled || S.dealing ? '' : first ? 'first card is free' : locked ? 'locked in' : !team.tokens ? 'no 🎟 left' : '';
    setHTML(skip, skipWhy ? `⏭ Skip: ${esc(skipWhy)}` : '⏭ Skip<span class="long"> song</span> <span class="cost">🎟 1</span>');
    // The cost in words, not just a ticket emoji (ACCESS-9).
    setLabel(skip, 'Skip song, costs 1 token' + (skipWhy ? `: ${skipWhy.replace('🎟', 'tokens')}` : ''));

    const buy = $('btn-hit-buy');
    const canBuyHere = canBuy(ph);
    const justBought = !canBuyHere && S.bought && (ph === 'placing' || revealed);
    buy.disabled = !canBuyHere;
    buy.classList.toggle('hidden', banded || (revealed && !canBuyHere && !justBought));
    buy.classList.toggle('done', !!justBought);
    // (Phones show the short words: "Buy 🎟 1/3".) On the reveal the button
    // names the team, so it doesn't read as the next team buying (ROOM-8).
    const forTeam = revealed ? ` <span class="for">for ${esc(team.name)}</span>` : '';
    setHTML(buy, canBuyHere ? `<i class="cg"></i>Buy<span class="long"> a card</span>${forTeam} <span class="cost">🎟 ${BUY_COST}</span>`
      : justBought ? `✓ Bought${revealed ? ` ${esc(String(S.bought.year))}` : ''} <span class="cost">🎟 −${BUY_COST}</span>`
        : locked && !S.dealing ? '<i class="cg"></i>Buy: locked in'
          : `<i class="cg"></i>Buy<span class="long"> a card</span> <span class="cost">🎟 ${Math.min(team.tokens, BUY_COST)}` +
            `<span class="long"> of </span><span class="short">/</span>${BUY_COST}</span>`);
    const cost = `costs ${BUY_COST} tokens`;
    setLabel(buy, canBuyHere ? `Buy a card${revealed ? ` for ${team.name}` : ''}, ${cost}`
      : justBought ? `Bought ${S.bought.title} (${S.bought.year}), ${BUY_COST} tokens spent`
        : locked && !S.dealing ? `Buy a card, ${cost}: locked in`
          : `Buy a card, ${cost}, you have ${team.tokens}`);
    $('btn-hit-cancel-challenge').classList.toggle('hidden', ph !== 'challenge');
    document.querySelector('.wt-bar-label').classList.toggle('hidden', banded || (revealed && buy.classList.contains('hidden')));

    // The reveal's own centre and right: "Play it again" sits where Lock
    // was, so a double-click's second half only replays the song; Next sits
    // where Replay was.
    $('btn-hit-confirm').classList.toggle('hidden', revealed);
    $('btn-hit-replay-reveal').classList.toggle('hidden', !revealed);
    $('btn-hit-replay').classList.toggle('hidden', revealed);
    $('btn-hit-next').classList.toggle('hidden', !revealed);
    if (revealed) {
      const next = $('btn-hit-next');
      next.disabled = !!S.dealing;
      const up = S.teams[nextIdx()].name;
      setHTML(next, S.dealing ? '<span class="pb-text">Shuffling more songs…</span>'
        : reached() ? '<span class="pb-text">See who won ▸</span><kbd>⏎</kbd>'
          : `<span class="pb-text"><span class="nx-long">▶ <span class="nx-team">${esc(up)}</span>, you’re up</span>` +
            `<span class="nx-short">Next ▸<small class="nx-team">${esc(up)}</small></span></span><kbd>⏎</kbd>`);
    }

    // The primary button: one fixed width, and it names the gap it will lock.
    const confirm = $('btn-hit-confirm');
    let on = S.selected != null && picking(ph) && !S.dealing;
    let text, html;
    if (ph === 'challenge') {
      // (Narrower bars drop the word "Challenge:" rather than cut the stake off.)
      if (S.selected != null) html = `⚔ <span class="pb-long">Challenge: </span>${esc(slotLabel(cards, S.selected))} · 🎟 1 ▸`;
      else text = 'Pick a different gap';
    } else if (S.phase === 'ask') {
      text = '↑ Challenge or let it stand';   // a signpost: disabled, and it commits nothing
    } else if (S.phase === 'placing' && S.blocked) {
      on = false;   // nobody has heard the song yet (LOOP-11)
      text = '▶ Play the song first';
    } else if (S.selected == null) {
      text = 'Pick a gap first';
    } else {
      text = first ? 'Place it & reveal ▸' : `Lock in: ${slotLabel(cards, S.selected)} ▸`;
    }
    confirm.disabled = !on;
    confirm.classList.toggle('gold', on && S.phase === 'challenge');
    confirm.classList.toggle('ask', S.phase === 'ask');
    setHTML(confirm, `<span class="pb-text">${html || esc(text)}</span>${S.phase === 'ask' ? '' : '<kbd>⏎</kbd>'}`);
  }

  // ---------- the reveal ----------
  // It takes the place of the turn line and the timeline, and the scoreboard
  // stays live above it (ROOM-8): the song, the outcome as the headline in
  // the outcome's colour (CHALLENGE-4), each team's call and the
  // challenger's token (CHALLENGE-8), then where the card belonged in the
  // placing team's line (CHALLENGE-1, LOOP-M3). The song, the outcome and the
  // strip are written once, in reveal(); the bonus and the destination follow
  // the tokens and cards live.
  const tally = n => `${n} / ${S.target}${n >= S.target ? ' 🏆' : ''}`;

  // [tone, words] of the outcome headline. Gold means the challenger, as on
  // the tiles and the band.
  function outcomeHead(o) {
    const A = S.teams[o.entry.team].name;
    if (!o.before.length) return ['ok', `✓ First card for ${A}`];
    if (o.tie) return ['ok', `✓ Both gaps fit a ${o.entry.card.year} song — it stays with ${A}`];
    if (o.activeOk) return ['ok', `✓ ${A} nailed it`];
    if (o.landedIn != null) return ['steal', `⚔ Stolen! It goes to ${S.teams[o.challenge.team].name}`];
    return ['miss', o.challenge ? '✗ Both missed — the card is discarded' : '✗ Missed — the card is discarded'];
  }

  // Each team's call with its gap, why a tie stays, where a missed card
  // belonged, and what the challenge cost — "(2 → 1)" in every case.
  function clausesHTML(o) {
    if (!o.before.length) return 'A first card can’t be wrong: any spot is right.';
    const A = S.teams[o.entry.team].name;
    const ch = o.challenge;
    const said = (name, slot, ok) => [ok ? 'ok' : 'miss', `${ok ? '✓' : '✗'} ${esc(name)} said ${esc(slotLabel(o.before, slot))}`];
    const out = [said(A, o.entry.slot, o.activeOk)];
    if (ch) out.push(said(S.teams[ch.team].name, ch.slot, ch.ok));
    if (o.tie) out.push(['', `${esc(A)} placed first, so it stays`]);
    if (o.landedIn == null) {
      const right = correctSlots(o.before, o.entry.card.year).map(i => esc(slotLabel(o.before, i)));
      out.push(['', `it belonged <b>${right.join('</b> or <b>')}</b>`]);
    }
    if (ch) out.push(['gold', `the challenge cost ${esc(S.teams[ch.team].name)} 🎟 1 (${ch.tokens[0]} → ${ch.tokens[1]})`]);
    // (A phone puts one per line.)
    return out.map(([tone, html]) => `<span class="cl${tone ? ' ' + tone : ''}">${html}</span>`).join('<span class="sep"> · </span>');
  }

  // Where the card went, with the count as it stands now.
  function destHTML(o) {
    if (o.landedIn == null) return '→ Nobody gets it';
    const t = S.teams[o.landedIn];
    const n = t.cards.length;
    return `→ Into ${esc(possessive(t.name))} timeline · now ${n} / ${S.target} <i class="cg"></i>cards` +
      (n >= S.target ? ` · that's ${S.target}! 🏆` : '');
  }

  // The gaps worth marking, by gap index: where the card sits (the gap that
  // won it, or on a miss the first gap it fits), each losing pick as a red
  // ghost, and every other gap it fits — a same-year neighbour can make two
  // gaps right, so there may be two.
  function stripMarks(o) {
    const right = correctSlots(o.before, o.entry.card.year);
    const ch = o.challenge;
    const land = o.landedIn == null ? right[0] : o.landedIn === o.entry.team ? o.entry.slot : ch.slot;
    const marks = new Map([[land, { kind: 'land', team: o.landedIn }]]);
    const picks = [[o.entry.team, o.entry.slot, o.activeOk]];
    if (ch) picks.push([ch.team, ch.slot, ch.ok]);
    for (const [team, slot, ok] of picks) if (slot !== land) marks.set(slot, { kind: ok ? 'fits' : 'miss', team });
    for (const g of right) if (!marks.has(g)) marks.set(g, { kind: 'fits', team: null });
    return marks;
  }

  // The placing team's line as it was before this song, in pieces: a card,
  // or a marked gap.
  function stripUnits(o) {
    const marks = stripMarks(o);
    const units = [];
    for (let k = 0; k <= o.before.length; k++) {
      if (marks.has(k)) units.push({ gap: k, mark: marks.get(k) });
      if (k < o.before.length) units.push({ i: k, c: o.before[k] });
    }
    return units;
  }

  // Which pieces to show when they don't all fit across: every mark and the
  // cards either side of it, then the spare room shared out either side, so
  // the marks sit in the middle. When marks sit too far apart for that, the
  // cards between them fold into a "⋯ 4" piece, and neighbours are let go
  // one by one, farthest from the song first. m: the strip's measures.
  // → { show: [index | { skip: n }], from, to }
  function stripWindow(units, m) {
    const n = units.length;
    const all = units.map((_, i) => i);
    const width = show => show.reduce((w, k) => w + (typeof k === 'number' ? m.item : m.skip), 0) + m.gap * (show.length - 1);
    const fits = show => width(show) <= m.avail + 0.5;
    if (fits(all)) return { show: all, from: 0, to: n - 1 };
    const markAt = all.filter(i => units[i].mark);
    const land = markAt.find(i => units[i].mark.kind === 'land');
    const near = [...new Set(markAt.flatMap(i => [i - 1, i, i + 1]))].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
    let lo = near[0], hi = near[near.length - 1];
    if (fits(all.slice(lo, hi + 1))) {
      for (let left = true; hi - lo + 1 < n; left = !left) {
        const [l, h] = (left && lo > 0) || hi === n - 1 ? [lo - 1, hi] : [lo, hi + 1];
        if (!fits(all.slice(l, h + 1))) break;
        [lo, hi] = [l, h];
      }
      return { show: all.slice(lo, hi + 1), from: lo, to: hi };
    }
    const fold = keep => keep.flatMap((k, j) => {
      const cards = j ? units.slice(keep[j - 1] + 1, k).filter(u => u.c).length : 0;
      return cards ? [{ skip: cards }, k] : [k];
    });
    let keep = near;
    const spare = near.filter(i => !units[i].mark).sort((a, b) => Math.abs(b - land) - Math.abs(a - land));
    for (const c of spare) {
      if (fits(fold(keep))) break;
      keep = keep.filter(k => k !== c);
    }
    const show = fold(keep);
    return { show, from: show[0], to: show[show.length - 1] };
  }

  // The strip's measures at the size it has now: the room for the row, and
  // the width of a card and of a "⋯ 4" piece. (On a phone the "‹ 6 earlier"
  // counts go under the row, not beside it.)
  function stripMeasures(strip) {
    const probe = document.createElement('div');
    probe.className = 'rv-row rv-probe';
    probe.innerHTML = '<span class="rv-more"></span><div class="rv-item"></div><div class="rv-skip">⋯<small>9</small></div>';
    strip.appendChild(probe);
    // Computed sizes, not rects: the card pops in with a scale transform.
    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
    const [more, item, skip] = probe.children;
    const pad = px(probe, 'paddingLeft') + px(probe, 'paddingRight');
    const side = parseFloat(getComputedStyle(strip).getPropertyValue('--rv-side')) ? 2 * px(more, 'width') : 0;
    const m = { avail: strip.clientWidth - side - pad, item: px(item, 'width'), skip: px(skip, 'width'), gap: px(probe, 'columnGap') };
    probe.remove();
    return m;
  }

  // "Where it belonged": a window of the placing team's real line, with the
  // song in its slot (a gold ring, and the team that won it), each losing
  // pick as a red ✗ ghost, every gap it fits marked, and the cards outside
  // the window counted. One row at every size: the window is cut to fit.
  function revealStripHTML(o, m) {
    const units = stripUnits(o);
    const w = stripWindow(units, m);
    const shown = new Set(w.show.filter(k => typeof k === 'number'));
    const song = card || o.entry.card;
    const cardsIn = (from, to) => units.slice(from, to).filter(u => u.c).length;
    const earlier = cardsIn(0, w.from), later = cardsIn(w.to + 1, units.length);
    const piece = k => {
      if (typeof k !== 'number') {
        return `<div class="rv-skip" aria-label="${plural(k.skip, 'more card')}">⋯<small>${k.skip}</small></div>`;
      }
      const u = units[k];
      if (u.c) {
        // Same-year cards sit together, as on the board.
        const joined = u.i > 0 && !slotIsOpen(o.before, u.i) && shown.has(k - 1) && units[k - 1].c;
        return `<div class="rv-item rv-c${joined ? ' sj' : ''}"><img src="${esc(u.c.artworkUrl || '')}" alt=""><b>${u.c.year}</b><span>${esc(u.c.title)}</span></div>`;
      }
      const m = u.mark;
      const label = o.before.length ? slotLabel(o.before, u.gap) : 'anywhere';
      if (m.kind === 'land') {
        const tag = m.team != null ? `<span class="rv-tag ok">✓ ${esc(S.teams[m.team].name)}</span>` : '<span class="rv-tag">belonged here</span>';
        return `<div class="rv-item rv-c rv-land">${tag}<img src="${esc(song.artworkUrl || '')}" alt=""><b>${o.entry.card.year}</b><span>${esc(o.entry.card.title)}</span></div>`;
      }
      const who = m.team != null ? `${possessive(S.teams[m.team].name)} pick` : 'Fits here too';
      return m.kind === 'miss'
        ? `<div class="rv-item rv-ghost miss"><span class="rv-x" aria-hidden="true">✗</span><span class="sr-only">Wrong: </span><b>${esc(who)}</b><span>${esc(label)}</span></div>`
        : `<div class="rv-item rv-ghost fits"><span class="rv-x" aria-hidden="true">✓</span><span class="sr-only">Also right: </span><b>${esc(who)}</b><span>${esc(label)}${m.team != null ? ' · fits too' : ''}</span></div>`;
    };
    return `<span class="rv-more l">${earlier ? `‹ ${earlier} earlier` : ''}</span>` +
      `<div class="rv-row">${w.show.map(piece).join('')}</div>` +
      `<span class="rv-more r">${later ? `${later} later ›` : ''}</span>`;
  }

  function renderStrip() {
    if (!S || S.phase !== 'revealed' || !S.outcome) return;
    const strip = $('hit-strip');
    if (!strip.clientWidth) return;
    setHTML(strip, revealStripHTML(S.outcome, stripMeasures(strip)));
  }
  // A window resize or a phone turned sideways: cut the window again.
  if (window.ResizeObserver) new ResizeObserver(() => renderStrip()).observe($('hit-strip'));

  // Written once per reveal.
  function fillReveal() {
    const o = S.outcome;
    const A = S.teams[o.entry.team].name;
    const [tone, head] = outcomeHead(o);
    $('hit-reveal-card').className = `rv-card tone-${tone}`;
    $('hit-art').src = card.artworkUrl || '';
    $('hit-year').textContent = card.year;
    $('hit-title').textContent = card.title;
    $('hit-artist').textContent = card.artist;
    $('hit-am-link').href = MQ.audio.appleMusicUrl(card);
    $('hit-verdict').innerHTML = `<span class="rv-words">${esc(head)}</span>` +
      (o.count != null ? ` <span class="rv-count">${tally(o.count)}</span>` : '');
    $('hit-clauses').innerHTML = clausesHTML(o);
    $('hit-strip-cap').innerHTML = o.before.length
      ? `<b>Where it belonged</b> · ${esc(possessive(A))} timeline<span class="rv-cap-long"> before this song</span>`
      : `<b>Where it landed</b> · ${esc(possessive(A))} first card`;
    written.delete($('hit-strip'));
    $('hit-strip').replaceChildren();
  }

  // The bonus toggle and the destination follow the tokens and cards live.
  function renderReveal() {
    const btn = $('btn-hit-bonus');
    btn.setAttribute('aria-pressed', String(S.bonus));
    btn.classList.toggle('on', S.bonus);
    setHTML(btn, `<span class="rv-check" aria-hidden="true"></span><span class="rv-bonus-text">🎤 <b>${esc(S.teams[S.active].name)}</b> named title + artist ` +
      `<i>before</i> the reveal</span> <span class="cost">🎟 +1</span> <kbd>B</kbd>`);
    setHTML($('hit-dest'), destHTML(S.outcome));
    renderStrip();
  }

  function render() {
    if (!S || S.phase === 'over') return;
    renderTiles();
    setHTML($('hit-target'), `first to <b>${S.target}</b> cards`);
    // The reveal stands in for the turn line and the line itself.
    const revealed = S.phase === 'revealed';
    $('screen-when').classList.toggle('revealing', revealed);
    $('hit-reveal').classList.toggle('hidden', !revealed);
    // The bar first: its buttons change height between beats, and the line
    // is fitted to whatever room the hero, the band and the bar leave it.
    renderBar();
    if (revealed) {
      renderReveal();
    } else {
      renderHero();
      setHTML($('hit-caption'), captionHTML());
      renderTimeline();
    }
    syncInert();
    watchRing();
  }

  // ---------- the record's progress ring ----------
  // It fills as the clip plays. Not a countdown: there's no clock in this
  // game (LOOP-7). When the clip has run out, Replay is lit up instead.
  let ringFrame = 0;
  function tickRing() {
    ringFrame = 0;
    if (!S || !$('screen-when').classList.contains('active')) return;
    const p = MQ.audio.progress();
    const frac = p.duration ? Math.min(1, p.current / p.duration) : 0;
    const off = String(Math.round((1 - frac) * 1000) / 10);
    const ring = $('hit-ring');
    if (ring.style.strokeDashoffset !== off) ring.style.strokeDashoffset = off;
    $('btn-hit-replay').classList.toggle('promote', p.ended && S.phase !== 'revealed');
    if (p.playing) ringFrame = requestAnimationFrame(tickRing);
  }
  function watchRing() {
    if (!ringFrame) ringFrame = requestAnimationFrame(tickRing);
  }

  // The turn banner owns the screen while it's up: the rest of it takes no
  // clicks and no Tab focus (ACCESS-3). (The challenge band and the reveal
  // are part of the screen, not overlays. Dialogs — Quit, Rules — make the
  // page inert themselves, through MQ.ui.openModal, and own it while open.)
  function syncInert() {
    if (modalOpen()) return;
    const banner = $('hit-banner');
    setInert(S && !banner.classList.contains('hidden') ? banner : null);
  }
  function setInert(top) {
    const scr = $('screen-when');
    for (const el of scr.children) el.inert = !!top && el !== top && !el.classList.contains('modal');
    // The app's top bar too — but never another dialog (Settings, Rules).
    for (const el of document.body.children) {
      if (el === scr || el.classList.contains('modal') || el.id === 'toast' || el.tagName === 'SCRIPT') continue;
      el.inert = !!top;
    }
  }

  // Focus left inside an overlay that just closed would otherwise sit on a
  // hidden control that Enter can still press.
  function dropHiddenFocus() {
    const f = document.activeElement;
    if (f && f !== document.body && !f.getClientRects().length) f.blur();
  }

  function selectSlot(i, { focus = false } = {}) {
    if (!S || S.dealing || !picking() || !openSlots().includes(i)) return;
    S.selected = i;
    render();
    const el = $('hit-timeline').querySelector('.slot.selected');
    if (!el) return;
    // On a phone the line scrolls: keep the pick in view without yanking the
    // line around (LOOP-M2). When it's already in view, nothing moves.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) el.focus({ preventScroll: true });
  }

  // ←/→ step through the open gaps. In a challenge with nothing chosen yet,
  // the step starts from the defender's pick.
  function moveSelection(dir) {
    if (!S || S.dealing || !picking()) return;
    const open = openSlots();
    if (!open.length) return;
    let k;
    if (S.selected != null && open.includes(S.selected)) {
      k = open.indexOf(S.selected) + dir;
    } else if (S.phase === 'challenge') {
      k = dir > 0 ? open.findIndex(i => i > S.placement) : open.map(i => i < S.placement).lastIndexOf(true);
      if (k < 0) k = dir > 0 ? open.length - 1 : 0;
    } else {
      k = dir > 0 ? 0 : open.length - 1;
    }
    selectSlot(open[Math.max(0, Math.min(open.length - 1, k))], { focus: true });
  }

  function clearPick() {
    if (!S || S.phase !== 'placing' || S.placement != null || S.selected == null) return;
    S.selected = null;
    render();
  }

  // ---------- turn flow ----------
  async function drawCard() {
    // Skips, wrong placements and two teams burn cards fast — top the deck up
    // rather than ending a good game early.
    if (S.deckIdx >= S.deck.length) {
      const game = S;
      render();   // S.dealing is set: Next reads "Shuffling more songs…" while we wait
      let fresh = [];
      try {
        const more = await fetchDeck(game.used);
        fresh = more.filter(r => !game.used.has(songKey(r)));
      } catch (e) {
        console.warn('deck refill failed', e);
      }
      if (S !== game || !fresh.length) return null;
      S.deck = fresh;
      S.deckIdx = 0;
    }
    const next = S.deck[S.deckIdx++];
    S.used.add(songKey(next));
    return next;
  }

  // Deals the next song to team `ti`. newTurn is false when the same team
  // just swapped its song (a skip, or a preview that failed to load). After a
  // reveal (banner), the turn opens behind the "you're up" banner.
  async function nextTurn(ti, newTurn, { banner = false } = {}) {
    const game = S;
    S.dealing = true;
    const next = await drawCard();
    // Quit, or ended from the quit dialog, while the deck was refilling.
    if (S !== game || S.phase === 'over') return;
    // A new song never starts behind a dialog (the rules, or Quit opened while
    // the deck refilled): the deal waits until it's closed.
    if (modalOpen()) {
      await new Promise(whenNoModal);
      if (S !== game || S.phase === 'over') return;
    }
    S.dealing = false;
    if (!next) return finish('dry');
    card = next;
    if (newTurn) {
      S.active = ti;
      S.turns++;
      // The tiles' +1 / −1 badges count from here.
      S.base = S.teams.map(t => ({ cards: t.cards.length, tokens: t.tokens }));
    }
    S.phase = banner ? 'handoff' : 'placing';
    S.placement = null;
    S.challenger = null;
    S.challenge = null;
    S.bought = null;
    S.bonus = false;
    S.blocked = false;
    S.outcome = null;
    // The first card can go anywhere, so its only gap is chosen already.
    S.selected = S.teams[S.active].cards.length ? null : 0;
    S.slotsLiveAt = now() + SLOT_ARM_MS;
    showPlayGate(false);
    $('hit-board').scrollTop = 0;   // a turn opens at the start of its own line
    if (banner) {
      MQ.audio.stop();   // "Play it again" may still be going
      showBanner();
    }
    render();
    dropHiddenFocus();
    if (banner) bannerTimer = setTimeout(() => endHandoff(game), BANNER_MS);
    else playSnippet(false);
  }

  // The handoff (ROOM-7): "Bass Face, you're up" across the whole screen for
  // a moment, over the next team's board. It takes every stray click (the
  // second half of a double-click on Next lands on it, not on a gap) and
  // makes the rest inert, and the song starts when it lifts.
  function showBanner() {
    $('hit-banner-text').innerHTML = `<span class="bn-team t${S.active}">${esc(S.teams[S.active].name)}</span>` +
      '<span class="bn-up">, you’re up</span>';
    $('hit-banner').classList.remove('hidden');
  }

  function endHandoff(game) {
    bannerTimer = 0;
    if (S !== game || S.phase !== 'handoff') return;
    // (Back mid-banner opens the quit dialog: the song waits for it.)
    if (modalOpen()) return whenNoModal(() => endHandoff(game));
    $('hit-banner').classList.add('hidden');
    S.phase = 'placing';
    S.slotsLiveAt = now();   // the banner already took the stray clicks
    render();
    playSnippet(false);
  }

  async function playSnippet(replay) {
    const song = card;
    const status = await MQ.audio.play(card, { replay });
    if (!S || card !== song || status === 'stale' || S.phase === 'revealed' || S.phase === 'over') return;
    // Autoplay blocked: the record becomes the play button, and Lock waits
    // until the room has heard the song (LOOP-11).
    const blocked = status === 'blocked';
    showPlayGate(blocked);
    if (S.blocked !== blocked) {
      S.blocked = blocked;
      render();
    }
    watchRing();
  }

  function showPlayGate(on) {
    $('btn-hit-playgate').classList.toggle('hidden', !on);
    $('hit-record').classList.toggle('blocked', on);
  }

  function replay() {
    if (!S || !card || S.dealing || S.phase === 'over' || S.phase === 'handoff') return;
    playSnippet(true);
  }

  // Lock in the selected gap: the active team's pick while placing, or the
  // challenger's in a challenge. Every other phase ignores it, so a stale
  // Enter or click can never judge a card twice (CHALLENGE-M1).
  function confirmPlacement() {
    if (!S || S.dealing || S.selected == null) return;
    if (S.phase === 'placing' && S.blocked) return;   // nobody has heard it yet
    if (S.phase === 'challenge') {
      if (S.selected === S.placement) return;
      S.challenge = { team: S.challenger, slot: S.selected };
      S.selected = null;
      return reveal();
    }
    if (S.phase !== 'placing' || S.placement != null) return;
    S.placement = S.selected;
    S.selected = null;
    // A skip's or a buy's toast is old news once the pick is locked in; on a
    // phone it would sit over the challenge band's line or the reveal's bonus.
    dropToast();
    // A first card can't be misplaced, and a challenge needs someone who can
    // pay for it — otherwise straight to the reveal.
    if (!S.teams[S.active].cards.length || !eligibleRivals().length) return reveal();
    // The ask: the band says whose pick is up for a challenge; rivals with a
    // token may step up (keys 1/2/3 follow the tiles), or let it stand (N).
    S.phase = 'ask';
    render();
    focusBand();
    showPick();
  }

  // On a phone the line scrolls: bring the pick under discussion to the
  // middle, once, as each beat opens. After that the challenger's own choice
  // is kept in view instead (LOOP-M2).
  function showPick() {
    const board = $('hit-board');
    const el = $('hit-timeline').querySelector('.slot.original');
    if (!el || board.scrollHeight <= board.clientHeight) return;
    const b = board.getBoundingClientRect(), r = el.getBoundingClientRect();
    board.scrollTop += (r.top + r.height / 2) - (b.top + b.height / 2);
  }

  function startChallenge(ti) {
    if (!S || S.phase !== 'ask' || !eligibleRivals().includes(ti)) return;
    S.phase = 'challenge';
    S.challenger = ti;
    // With only one other gap the pick is a formality: it's chosen already,
    // and "Not a challenge" still backs out for free (CHALLENGE-5).
    const alts = openSlots();
    S.selected = alts.length === 1 ? alts[0] : null;
    render();
    focusBand();
    showPick();
  }

  // "Not a challenge": back to the ask. Nothing was spent — tokens only move
  // at the reveal — so a mis-click or the wrong team costs nothing.
  function cancelChallenge() {
    if (!S || S.phase !== 'challenge') return;
    S.phase = 'ask';
    S.challenger = null;
    S.selected = null;
    render();
    focusBand();
    showPick();
  }

  function letItStand() {
    if (!S || S.phase !== 'ask') return;
    reveal();
  }

  function skipSong() {
    if (!canSkip()) return;
    const team = S.teams[S.active];
    team.tokens--;
    S.log.push({ type: 'skip', turn: S.turns, team: S.active, card: brief(card) });
    MQ.audio.stop();
    toast(`${team.name} skipped — 🎟 1 spent. Here's a new song.`);
    // Skipping swaps the song, not the turn — the same team plays the new card.
    nextTurn(S.active, false);
  }

  // Cards carry who put them there, how and when, for the results story.
  function place(ti, c, how) {
    const placed = { ...c, how, by: ti, turn: S.turns, seq: ++S.seq };
    insertSorted(S.teams[ti].cards, placed);
    return placed;
  }

  async function buyCard() {
    if (!canBuy()) return;
    const game = S;
    S.dealing = true;
    const free = await drawCard();
    if (S !== game || S.phase === 'over') return;   // quit while the deck was refilling
    S.dealing = false;
    if (!free) {
      toast('The deck is empty — no cards left to buy.');
      return render();
    }
    const team = S.teams[S.active];
    team.tokens -= BUY_COST;
    S.bought = place(S.active, free, 'bought');
    S.log.push({ type: 'buy', turn: S.turns, team: S.active, card: brief(free) });
    // The gaps just shifted, so a half-made pick no longer points where it did.
    if (S.phase === 'placing') S.selected = null;
    // Reaching the target on a buy wins on the spot — nobody gets to tie it
    // with a steal later in the turn (ARC-M1).
    if (team.cards.length >= S.target) return finish('bought');
    toast(`${team.name} bought a card — ${free.title} (${free.year}). 🎟 ${BUY_COST} spent.`);
    render();
    // The line wraps, so the bought card is on screen — except in a phone's
    // scrolling list, where it's brought into view (ARC-2).
    $('hit-timeline').querySelector('.year-card.bought')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function reveal() {
    if (!S || S.placement == null || !['placing', 'ask', 'challenge'].includes(S.phase)) return;
    const ch = S.phase === 'challenge' ? S.challenge : null;
    if (S.phase === 'challenge' && !ch) return;   // a card is judged exactly once
    MQ.audio.stop();
    S.phase = 'revealed';
    S.revealedAt = now();
    S.selected = null;
    S.bonus = false;
    showPlayGate(false);

    const ai = S.active;
    const before = S.teams[ai].cards.slice();
    const activeOk = slotIsCorrect(before, S.placement, card.year);
    const challengerOk = !!ch && slotIsCorrect(before, ch.slot, card.year);
    let challenge = null;
    if (ch) {
      // A challenge costs its token win or lose — and only now, at the reveal.
      const t = S.teams[ch.team];
      const from = t.tokens;
      t.tokens = Math.max(0, from - 1);
      challenge = { team: ch.team, slot: ch.slot, ok: challengerOk, tokens: [from, t.tokens] };
    }
    // Both gaps can be right in a same-year tie; the team that placed first
    // keeps the card (CHALLENGE-13).
    const landedIn = activeOk ? ai : challengerOk ? ch.team : null;
    if (landedIn != null) place(landedIn, card, landedIn !== ai ? 'stolen' : before.length ? 'placed' : 'first');

    const entry = {
      type: 'song', turn: S.turns, team: ai, card: brief(card), slot: S.placement, ok: activeOk,
      challenge: challenge && { team: challenge.team, slot: challenge.slot, ok: challenge.ok },
      stolenBy: landedIn != null && landedIn !== ai ? landedIn : null,
      bonus: false
    };
    S.log.push(entry);
    // count: where the song left the team that got it (the headline's tally).
    S.outcome = { entry, before, activeOk, challenge, landedIn, tie: activeOk && challengerOk,
      count: landedIn != null ? S.teams[landedIn].cards.length : null };

    fillReveal();
    render();
    // Focus the outcome, never a button that spends or awards a token.
    $('hit-verdict').focus({ preventScroll: true });
    $('hit-reveal').scrollTop = 0;
  }

  // The name-it bonus is a toggle that pays out at once, so the tallies and
  // what the team can afford are right while the reveal is still up.
  function toggleBonus() {
    if (!S || S.phase !== 'revealed' || S.dealing) return;
    const team = S.teams[S.active];
    if (S.bonus && team.tokens < 1) {
      toast(`That 🎟 is already spent — ${team.name} bought with it.`);
      return;
    }
    S.bonus = !S.bonus;
    team.tokens += S.bonus ? 1 : -1;
    S.outcome.entry.bonus = S.bonus;
    render();
  }

  async function advance() {
    if (!S || S.phase !== 'revealed' || S.dealing) return;
    if (now() - S.revealedAt < NEXT_ARM_MS) return;   // a double-click's second half, or a held key
    if (reached()) return finish('target');
    // The turn passes: the last turn's toast goes with it (ARC-8).
    dropToast();
    await nextTurn(nextIdx(), true, { banner: true });
  }

  const dropToast = () => $('toast').classList.add('hidden');

  // The team that came last starts the rematch; a tie goes to the later seat.
  function rematchFirst() {
    const fewest = Math.min(...S.teams.map(t => t.cards.length));
    for (let i = S.teams.length - 1; i >= 0; i--) if (S.teams[i].cards.length === fewest) return i;
    return 0;
  }

  // ---------- the standings ----------
  // Most cards first (seat order breaks a tie); tied teams share a rank.
  // → [{ i: team index, rank }]
  function standings() {
    const n = i => S.teams[i].cards.length;
    return S.teams.map((_, i) => i).sort((a, b) => n(b) - n(a) || a - b)
      .map(i => ({ i, rank: 1 + S.teams.filter(t => t.cards.length > n(i)).length }));
  }

  const andList = names => (names.length < 3 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

  // One ranked row: the team's colour down its edge, rank, name, a line
  // under the name, then (on the results) a progress bar and the count. The
  // quit dialog and the results share it (M5, M6).
  function standRowHTML({ i, rank }, sub, { win = false, bar = true } = {}) {
    const t = S.teams[i];
    const n = t.cards.length;
    const pct = Math.min(100, Math.round((n / S.target) * 100));
    return `<li class="st-row t${i}${win ? ' win' : ''}">
        <span class="st-rank">${rank}</span>
        <span class="st-who"><b class="st-name">${win ? '🏆 ' : ''}${esc(t.name)}</b><span class="st-sub">${sub}</span></span>
        ${bar ? `<span class="st-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>` : ''}
        <span class="st-count"><b>${n}</b><span class="st-of"> / ${S.target}</span><span class="sr-only"> cards</span></span>
      </li>`;
  }

  // ---------- the results ----------
  // What the results tell: steals, the longest run of right placements (a
  // team's own calls, in a row), and the card that won it. Every count comes
  // from S.log and the timelines.
  function story() {
    const songs = S.log.filter(e => e.type === 'song');
    const steals = S.teams.map((_, i) => songs.filter(e => e.stolenBy === i).length);
    const runs = S.teams.map((_, i) => {
      let best = 0, run = 0;
      songs.filter(e => e.team === i).forEach(e => { run = e.ok ? run + 1 : 0; best = Math.max(best, run); });
      return best;
    });
    // The leader and anyone level with them; null when nobody has any.
    const top = arr => {
      const max = Math.max(...arr);
      const teams = arr.map((v, i) => i).filter(i => arr[i] === max);
      return max > 0 ? { team: teams[0], teams, count: max, tied: teams.length > 1 } : null;
    };
    let winningCard = null;
    const winner = S.teams.findIndex(t => t.cards.length >= S.target);
    if (winner >= 0) {
      const c = S.teams[winner].cards.reduce((a, b) => (b.seq > a.seq ? b : a));
      winningCard = { ...brief(c), how: c.how, by: c.by, turn: c.turn };
    }
    return { songs: songs.length, challenges: songs.filter(e => e.challenge).length, steals, runs,
      bestThief: top(steals), longestRun: top(runs), winningCard };
  }

  // The headline as pieces: words, and team indexes (names, gold on screen).
  // Team names are free text ("Janis", "The Vinyl Kids"), so no verb has to
  // agree with one: the name follows a label ("Winner:", "in the lead:").
  // winner: the team at the target, or null. → { text, html }
  function headline(reason, winner, leaders, best) {
    let parts;
    if (winner != null) {
      parts = ['🏆 Winner: ', winner, reason === 'bought' ? ', who bought the winning card!' : '!'];
    } else {
      const who = leaders.flatMap((i, k) => (k ? [k === leaders.length - 1 ? ' & ' : ', ', i] : [i]));
      const lead = leaders.length === 1 ? ['in the lead: ', leaders[0], ` with ${best}`]
        : leaders.length === S.teams.length ? [`dead heat on ${best} each`] : [...who, ` tie on ${best}`];
      parts = [reason === 'dry' ? 'Out of songs — ' : '⏸ Called early — ', ...lead];
    }
    return {
      text: parts.map(p => (typeof p === 'number' ? S.teams[p].name : p)).join(''),
      html: parts.map(p => (typeof p === 'number' ? `<span class="gold">${esc(S.teams[p].name)}</span>` : esc(p))).join('')
    };
  }

  // Under the headline: the margin, how long it took, and the target
  // ("Won by 2 cards · 38 turns · first to 15").
  function marginHTML(ranked, best) {
    // Only a lone leader has a margin; level leaders just get the turns.
    const alone = ranked.filter(r => r.rank === 1).length === 1;
    const by = alone ? `<b>${plural(best - S.teams[ranked[1].i].cards.length, 'card')}</b>` : '';
    const won = S.result.winner != null;
    return [by && `${won ? 'Won' : 'Ahead'} by ${by}`, plural(S.turns, 'turn'),
      won ? `first to ${S.target}` : `nobody reached ${S.target}`].filter(Boolean).join(' · ');
  }

  // The line under each team's name in the standings.
  function standSubHTML({ i }, winner, best) {
    const n = S.teams[i].cards.length;
    const won = winner != null;
    if (i === winner && S.result.story.winningCard) {
      const c = S.result.story.winningCard;
      const song = `“${esc(c.title)}” (${c.year})`;
      return c.how === 'bought' ? `bought ${song} to reach ${S.target}`
        : c.how === 'stolen' ? `stole ${song} to reach ${S.target}` : `reached ${S.target} with ${song}`;
    }
    if (won) return n >= S.target ? `reached ${S.target}` : `${plural(S.target - n, 'card')} short`;
    const level = S.teams.filter(t => t.cards.length === best).length > 1;
    return n === best ? (level ? 'level at the top' : 'in the lead') : `${plural(best - n, 'card')} behind`;
  }

  // Two or three big lines of story under the standings (ARC-7). A line
  // with nothing to tell is left out rather than shown as a zero.
  function storyHTML(st) {
    const name = i => esc(S.teams[i].name);
    const items = [];
    if (st.songs) {
      const b = st.bestThief;
      if (b) {
        const others = st.steals.map((n, i) => (n && !b.teams.includes(i) ? `${name(i)} ${n}` : '')).filter(Boolean);
        items.push(['🥷', `Best ${b.tied ? 'thieves' : 'thief'}: ${andList(b.teams.map(name))}`,
          [`${plural(b.count, 'steal')}${b.tied ? ' each' : ''}`, ...others].join(' · ')]);
      } else {
        items.push(['🥷', 'Nobody stole a card',
          st.challenges ? `${plural(st.challenges, 'challenge')}, none paid off` : 'no challenges this game']);
      }
    }
    // A run of one isn't a run.
    const r = st.longestRun;
    if (r && r.count >= 2) {
      items.push(['🔥', `Longest run: ${andList(r.teams.map(name))}`, `${r.count} placed right in a row${r.tied ? ', each' : ''}`]);
    }
    const c = st.winningCard;
    if (c) {
      const how = { bought: 'bought by', stolen: 'stolen by' }[c.how] || 'placed by';
      items.push(['🏁', `Winning card: “${esc(c.title)}”`, `${esc(c.artist)} · ${c.year} · ${how} ${name(c.by)}`]);
    }
    return items.map(([ico, head, sub]) =>
      `<li class="story-item"><span class="story-ico" aria-hidden="true">${ico}</span><span class="story-text"><b>${head}</b><span>${sub}</span></span></li>`).join('');
  }

  // Every card of a final timeline, oldest first, wrapped (ARC-5, ROOM-16).
  // The winning card, bought cards and stolen ones carry a tag (ARC-7).
  function finalCardHTML(c, win) {
    const how = { bought: '🎟 Bought', stolen: '⚔ Stolen' }[c.how];
    const tag = win ? `🏁 Winning card${how ? `<span class="fin-how"> · ${c.how}</span>` : ''}` : how;
    return `<div class="fin-card${win ? ' win' : ''}${how ? ' ' + c.how : ''}" title="${esc(`${c.title} — ${c.artist}`)}">
        ${tag ? `<em class="fin-tag">${tag}</em>` : ''}<img src="${esc(c.artworkUrl || '')}" alt="">
        <b>${c.year}</b><span class="fin-t">${esc(c.title)}</span>
      </div>`;
  }

  function finalTeamHTML({ i, rank }, winner, winCard) {
    const t = S.teams[i];
    const line = runsOf(t.cards).map(([a, z]) => {
      const run = t.cards.slice(a, z).map(c => finalCardHTML(c, c === winCard)).join('');
      return z - a > 1 ? `<div class="fin-stack">${run}</div>` : run;
    }).join('');
    // Leftover tokens no longer count: small print (ROOM-16).
    const n = `${plural(t.cards.length, 'card')}<span class="fin-tk"> · 🎟 ${t.tokens} left</span>`;
    return `<div class="fin-team t${i}${i === winner ? ' win' : ''}">
        <h3 class="fin-team-head"><span class="st-rank">${rank}</span> ${esc(t.name)} <span class="fin-n">${n}</span><i class="fin-mark" aria-hidden="true"></i></h3>
        <div class="fin-line">${line || '<p class="fin-none">No cards — brutal.</p>'}</div>
      </div>`;
  }

  function finish(reason) {
    if (!S || S.phase === 'over') return;
    MQ.audio.stop();
    // The scores decide, not the button that ended it: a team at the target
    // has won, even when the room pressed End here on the winning reveal
    // instead of "See who won". (Only one team can ever get there: a buy or
    // Next ends the game at once.)
    const at = S.teams.findIndex(t => t.cards.length >= S.target);
    if (at >= 0 && reason !== 'bought') reason = 'target';
    S.phase = 'over';
    S.endReason = reason;
    closeModal($('hit-quit-dialog'));
    unguard();
    clearScreen();
    syncInert();
    const ranked = standings();
    const leaders = ranked.filter(r => r.rank === 1).map(r => r.i);
    const best = S.teams[leaders[0]].cards.length;
    const winner = at >= 0 ? at : null;
    const head = headline(reason, winner, leaders, best);
    S.result = { reason, headline: head.text, leaders, best, winner, ranked, story: story() };
    const margin = marginHTML(ranked, best);
    S.result.margin = margin.replace(/<[^>]+>/g, '');
    // The winning card is the last one to join the winner's line.
    const winCard = winner == null ? null : S.teams[winner].cards.reduce((a, c) => (c.seq > a.seq ? c : a));

    $('hit-winner').innerHTML = head.html;
    $('hit-margin').innerHTML = margin;
    $('hit-standings').innerHTML = ranked.map(r => standRowHTML(r, standSubHTML(r, winner, best), { win: r.i === winner })).join('');
    const told = storyHTML(S.result.story);
    $('hit-story').innerHTML = told;
    $('hit-story').classList.toggle('hidden', !told);
    $('screen-when-results').querySelector('.fin-top').classList.toggle('solo', !told);
    // The team that came last starts, with songs nobody has heard yet (ARC-12).
    $('btn-hit-again').innerHTML = `<span class="rm-main">Rematch ▸</span> <span class="rm-sub">fresh songs · first up: ${esc(S.teams[rematchFirst()].name)}</span>`;
    $('hit-final').innerHTML = ranked.map(r => finalTeamHTML(r, winner, winCard)).join('');
    show('screen-when-results');
    window.scrollTo(0, 0);
    // Nothing is focused on the results, so a held key can't start a rematch.
    if (document.activeElement) document.activeElement.blur();
  }

  // ---------- quitting ----------
  // Quit asks first (M6): keep playing, end here with the standings, or leave.
  // On the winning reveal the game is already won, so it says so and offers
  // the results instead of "End here".
  function requestQuit() {
    if (!S || S.phase === 'over') return exit();
    const ranked = standings();
    const top = ranked.filter(r => r.rank === 1).map(r => S.teams[r.i].name);
    const n = S.teams[ranked[0].i].cards.length;
    const won = S.teams.find(t => t.cards.length >= S.target);
    const lead = won ? `${won.name} reached ${S.target} — the game is won`
      : top.length === 1 ? `In the lead: ${top[0]} with ${n} of ${S.target}`
        : `${top.length === S.teams.length ? 'everyone' : andList(top)} level at ${n} of ${S.target}`;
    $('hit-quit-text').textContent = `Turn ${S.turns} · ${lead}. Nothing is saved if you quit to the menu.`;
    $('hit-quit-standings').innerHTML = ranked.map(r =>
      standRowHTML(r, `🎟 ${plural(S.teams[r.i].tokens, 'token')}`, { bar: false })).join('');
    const keep = $('btn-quit-keep'), end = $('btn-quit-end');
    keep.className = won ? 'ghost-btn' : 'primary-btn';
    end.className = won ? 'primary-btn' : 'ghost-btn';
    keep.innerHTML = `${won ? 'Back to the reveal' : 'Keep playing'} <kbd>Esc</kbd>`;
    end.textContent = won ? 'See who won ▸' : 'End here: show the standings';
    keep.parentNode.insertBefore(won ? end : keep, won ? keep : end);   // the main way on comes first
    // Focus starts on Keep playing, the choice that changes nothing.
    openModal($('hit-quit-dialog'), { opener: null, initialFocus: keep, onClose: quitClosed });
  }

  // However it closed (Keep playing, Esc, the backdrop), focus goes back to
  // where the game expects it.
  function quitClosed() {
    if (!S || S.phase === 'over') return;
    if (S.phase === 'revealed') $('hit-verdict').focus({ preventScroll: true });
    else if (S.phase === 'ask' || S.phase === 'challenge') focusBand();
  }

  // ---------- the Back button ----------
  // Back must never throw a game away, in either edition: a game sits on a
  // history entry of its own. Back steps off it; the game puts it back and
  // asks first with the quit dialog (or, with the rules open, just closes
  // them). The entry goes when the game does. A reload or a closed tab still
  // asks through beforeunload (below).
  const GUARD = { mq: 'game' };
  let guarded = false;
  function guard() {
    if (guarded) return;
    guarded = true;
    nav.run(() => history.pushState(GUARD, '', location.href));
  }
  function unguard() {
    if (!guarded) return;
    guarded = false;
    nav.run(() => { if (history.state && history.state.mq === 'game') nav.back(); });
  }
  window.addEventListener('popstate', () => {
    if (!guarded) return;
    nav.run(() => history.pushState(GUARD, '', location.href));
    if (!S || S.phase === 'over') return;
    const d = topModal();
    if (d && d !== $('hit-quit-dialog')) return closeModal(d);
    requestQuit();
  });

  // ---------- entry points ----------
  // The static site (tools/build-site.js) has no server, so it supplies
  // MQ.loadDeck and deals from a pre-resolved deck.json instead.
  // used: the songs already dealt tonight (the site's deck deals the others
  // first; the server just deals at random, and the caller drops repeats).
  async function fetchDeck(used) {
    if (MQ.loadDeck) return (await MQ.loadDeck(DECK_SIZE, used)).filter(r => Number.isInteger(r.year));
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

  // config: { teamNames, target, onExit, deck?, used?, first? }. A rematch
  // passes the old deck, the songs already played (`used`) and who starts.
  async function start(config) {
    onExit = config.onExit;
    const used = new Set(config.used || []);
    const fresh = rounds => (rounds || []).filter(r => !used.has(songKey(r)));
    // A rematch deals the songs nobody has heard yet from the deck it already
    // has, and only waits on the network when those run low (ARC-12).
    let rounds = shuffle(fresh(config.deck));
    let known = config.deck || [];   // every song to hand, heard or not
    let failed = null;
    if (rounds.length < REMATCH_MIN) {
      show('screen-loading');
      $('loading-text').textContent = 'Shuffling the deck… (the first game takes a moment)';
      try {
        const got = await fetchDeck(used);
        known = known.concat(got);
        const more = fresh(got);
        if (more.length > rounds.length) rounds = more;
      } catch (e) {
        failed = e;
      }
    }
    // A long evening hears the whole deck in the end. Rather than stop, deal
    // it all again.
    if (rounds.length < MIN_SONGS && used.size) {
      const all = new Map(known.map(r => [songKey(r), r]));
      if (all.size >= MIN_SONGS) {
        used.clear();
        rounds = shuffle([...all.values()]);
        toast('You’ve heard every song — reshuffling the deck');
      }
    }
    if (rounds.length < MIN_SONGS) {
      toast(failed ? 'Could not deal the deck: ' + failed.message : 'Not enough playable songs to deal a game — try again.');
      return exit();
    }
    const n = config.teamNames.length;
    const first = Number.isInteger(config.first) ? ((config.first % n) + n) % n : 0;
    S = {
      teams: config.teamNames.map(name => ({ name, cards: [], tokens: START_TOKENS })),
      active: first,
      first,
      deck: rounds,
      deckIdx: 0,
      used,              // every song dealt, carried across rematches
      target: config.target,
      phase: 'placing',  // placing | ask | challenge | revealed | handoff | over
      selected: null,    // the gap currently chosen (placing, or the challenger's in a challenge)
      placement: null,   // the active team's locked-in gap
      challenger: null,  // the rival picking a gap (challenge phase)
      challenge: null,   // { team, slot } once the challenger confirms
      bought: null,      // the card bought this turn, highlighted
      dealing: false,    // a card is being drawn: skip, buy, Next and lock-in wait
      blocked: false,    // the browser blocked autoplay: the record is a play button until it plays
      bonus: false,      // the name-it token, toggled on the reveal
      revealedAt: 0,
      slotsLiveAt: 0,
      turns: 0,          // team turns started (a skip doesn't start a new one)
      seq: 0,            // order cards joined any timeline
      log: [],           // one entry per resolved song, buy and skip
      outcome: null,     // how the song on the reveal was judged
      base: null,        // each team's cards and tokens when this turn began (the tiles' +1 / −1)
      endReason: null,   // target | bought | dry | early
      result: null
    };
    clearScreen();
    $('hit-volume').value = String(Math.round(MQ.audio.volume * 100));
    show('screen-when');
    guard();
    nextTurn(first, true);
  }

  function stop() {
    MQ.audio.stop();
    S = null;
    card = null;
    built = null;   // the next game builds its board from scratch
    closeModal($('hit-quit-dialog'));
    unguard();
    clearScreen();
    setInert(null);
  }

  // Nothing of the last reveal or banner may flash up when a game starts.
  function clearScreen() {
    clearTimeout(bannerTimer);
    bannerTimer = 0;
    $('hit-banner').classList.add('hidden');
    $('hit-reveal').classList.add('hidden');
    $('screen-when').classList.remove('revealing');
  }

  function exit() {
    stop();
    if (onExit) onExit();
  }

  // A read-only copy of the game for tests and console debugging.
  function snapshot() {
    if (!S) return null;
    return JSON.parse(JSON.stringify({
      phase: S.phase, active: S.active, first: S.first, target: S.target, turns: S.turns,
      selected: S.selected, placement: S.placement, challenger: S.challenger, challenge: S.challenge,
      rivals: S.phase === 'over' ? [] : eligibleRivals(),
      dealing: S.dealing, blocked: S.blocked, bonus: S.bonus, endReason: S.endReason,
      canSkip: canSkip(), canBuy: canBuy(),
      card: card && brief(card),
      bought: S.bought && brief(S.bought),
      teams: S.teams.map((t, i) => ({
        name: t.name, tokens: t.tokens, years: t.cards.map(c => c.year), delta: delta(i),
        cards: t.cards.map(c => ({ ...brief(c), how: c.how, by: c.by, turn: c.turn, seq: c.seq }))
      })),
      log: S.log,
      outcome: S.outcome && { ...S.outcome, before: S.outcome.before.map(c => c.year) },
      result: S.result,
      used: [...S.used],
      deckLeft: S.deck.length - S.deckIdx
    }));
  }

  // ---------- wiring ----------
  // Buttons that spend a token or move the game on drop focus once they act,
  // so a later Enter can't fire them again (ARC-M2), and ignore the second
  // click of a double-click (ACCESS-4).
  function once(fn) {
    return e => {
      e.currentTarget.blur();
      if (e.detail > 1) return;
      fn();
    };
  }
  // A mouse click on Replay mustn't park focus there either, or the next
  // Enter replays again instead of locking in or moving on.
  const replayClick = e => { if (e.detail) e.currentTarget.blur(); replay(); };
  // Gaps: one listener for the whole board, which is rebuilt as cards arrive.
  $('hit-timeline').addEventListener('click', e => {
    const gap = e.target.closest('.slot');
    if (!S || !gap || gap.disabled) return;
    // The second click of a double-click, or a click landing just as a turn
    // starts, was aimed at a button that has just gone (LOOP-M4). Keyboard
    // clicks (detail 0) are always deliberate.
    if (e.detail > 1 || (e.detail === 1 && now() < S.slotsLiveAt)) return;
    selectSlot(parseInt(gap.dataset.slot, 10));
    // A mouse pick hands the keys back to the page: Enter locks in, Space
    // replays (a focused gap would take both for itself).
    if (e.detail) gap.blur();
  });
  $('btn-hit-confirm').addEventListener('click', e => { if (e.detail <= 1) confirmPlacement(); });
  $('btn-hit-cancel-challenge').addEventListener('click', cancelChallenge);
  $('btn-hit-replay').addEventListener('click', replayClick);
  // "Play it again" sits where Lock was: the second half of a double-click on
  // Lock lands on it. It mustn't replay, nor keep the focus its mousedown
  // took (Enter would then replay instead of moving on).
  $('btn-hit-replay-reveal').addEventListener('click', e => {
    if (e.detail <= 1) return replayClick(e);
    if (S && S.phase === 'revealed') $('hit-verdict').focus({ preventScroll: true });
  });
  $('btn-hit-skip').addEventListener('click', once(skipSong));
  $('btn-hit-buy').addEventListener('click', once(buyCard));
  $('btn-hit-bonus').addEventListener('click', once(toggleBonus));
  $('btn-hit-next').addEventListener('click', once(advance));
  // The gate hides itself once the song plays; don't leave focus on it.
  $('btn-hit-playgate').addEventListener('click', e => { e.currentTarget.blur(); playSnippet(true); });
  // The band's buttons are rebuilt with each beat: one listener for them all.
  // A double-click's second half lands on the pick that replaced the button.
  $('challenge-rivals').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!S || !btn || btn.disabled || e.detail > 1) return;
    if (btn.id === 'btn-challenge-no') return letItStand();
    startChallenge(parseInt(btn.dataset.team, 10));
  });
  // A double-click's second half on the button that opened the reveal
  // mustn't open Apple Music. A mouse click mustn't leave focus on the link
  // either, or the next Enter opens it again instead of moving on.
  $('hit-am-link').addEventListener('click', e => {
    if (e.detail) e.currentTarget.blur();
    if (S && now() - S.revealedAt < NEXT_ARM_MS) e.preventDefault();
  });
  $('btn-hit-quit').addEventListener('click', requestQuit);
  // The rules open over the game and change nothing in it. Opened with the
  // mouse, focus goes back to the page afterwards, so Enter still locks in.
  $('btn-hit-rules').addEventListener('click', e => {
    if (e.detail) e.currentTarget.blur();
    if (MQ.rules) MQ.rules.open();
  });
  // (Keep playing, the backdrop and Esc close it: MQ.ui.openModal.)
  $('btn-quit-end').addEventListener('click', () => finish('early'));   // a team at the target still wins
  $('btn-quit-menu').addEventListener('click', exit);
  // The results open under the pointer that pressed "See who won" or "End
  // here": the second click of a double-click must not leave them at once.
  $('btn-hit-home').addEventListener('click', e => { if (e.detail <= 1) exit(); });
  $('btn-hit-again').addEventListener('click', e => {
    if (!S || S.phase !== 'over' || e.detail > 1) return;
    start({ teamNames: S.teams.map(t => t.name), target: S.target, deck: S.deck, used: S.used, first: rematchFirst(), onExit });
  });
  $('hit-volume').addEventListener('input', e => MQ.audio.setVolume(e.target.value / 100));

  // The keyboard map (see the README). Every key handled here calls
  // preventDefault, so it never also presses whatever has focus. A focused
  // control keeps the keys it acts on natively — Enter or Space on a button
  // presses that button, arrows move the volume slider — except Enter on the
  // selected gap or the primary button. Keys a control ignores (Enter on the
  // slider, letters on a button) still reach the game.
  const NATIVE = {
    Enter: 'button, a[href], summary, [role="button"]',
    ' ': 'button, summary, [role="button"], input[type="checkbox"], input[type="radio"]',
    arrows: 'input, select, textarea'
  };
  document.addEventListener('keydown', e => {
    if (!S || !$('screen-when').classList.contains('active')) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // (An open dialog — Quit, Rules — takes every key itself: MQ.ui.openModal.)
    if (isTyping(e) || modalOpen()) return;
    const t = e.target instanceof Element && e.target !== document.body ? e.target : null;
    const native = sel => (t && t.closest(sel)) || null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const phase = S.phase;
    // A held key repeats: one press, one action.
    const act = fn => { e.preventDefault(); if (!e.repeat) fn(); };
    // Under the turn banner every game key is swallowed: the next song
    // hasn't started, and an Enter meant for the reveal mustn't lock in.
    if (phase === 'handoff') {
      if (/^(Enter| |ArrowLeft|ArrowRight|Escape|r|b|n|[1-9])$/.test(key)) e.preventDefault();
      return;
    }

    if (key === 'Enter') {
      // A held Enter never locks in, confirms or moves on — not even by
      // pressing a focused button again and again.
      if (e.repeat) return e.preventDefault();
      const control = native(NATIVE.Enter);
      if (phase === 'revealed') {
        if (control && control !== $('btn-hit-next')) return;   // e.g. the Apple Music link
        return act(advance);
      }
      if (phase === 'ask') {
        if (control) return;   // a rival's own button, reached on purpose
        return act(() => {});  // "Enter, Enter" must not wipe out the rivals' chance
      }
      if (picking()) {
        const onSelected = control && control.matches('#hit-timeline .slot') &&
          parseInt(control.dataset.slot, 10) === S.selected;
        // Enter on another gap selects that gap natively; it never locks the old one.
        if (control && !onSelected && control !== $('btn-hit-confirm')) return;
        // Just dealt: a second Enter (a double-tap on Start game or Rematch)
        // was meant for the last screen, and nobody has heard the song yet.
        if (now() < S.slotsLiveAt) return e.preventDefault();
        return act(confirmPlacement);
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (!picking() || native(NATIVE.arrows)) return;
      e.preventDefault();
      return moveSelection(key === 'ArrowLeft' ? -1 : 1);
    }
    if (key === ' ') {
      // Space presses a focused button; only from the page does it replay.
      if (native(NATIVE[' ']) || !['placing', 'ask', 'challenge'].includes(phase)) return;
      return act(replay);
    }
    if (key === 'Escape') {
      if (phase === 'challenge') return act(cancelChallenge);   // back to the ask, nothing spent
      if (phase === 'ask') return act(() => {});                // Esc commits nothing
      if (phase === 'placing') return act(clearPick);
      return;
    }
    if (key === 'r') return act(replay);
    if (key === 'b' && phase === 'revealed') return act(toggleBonus);
    if (key === 'n' && phase === 'ask') return act(letItStand);
    if (/^[1-9]$/.test(key) && phase === 'ask' && eligibleRivals().includes(+key - 1)) {
      return act(() => startChallenge(+key - 1));
    }
  });

  // The setup screen, in both editions: Enter in a team name starts the
  // game and Esc goes back, through the shell's own buttons.
  document.addEventListener('keydown', e => {
    if (!$('screen-teams').classList.contains('active') || e.repeat || e.isComposing) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || modalOpen()) return;
    if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('#screen-teams input[type="text"]')) {
      e.preventDefault();
      $('btn-teams-start').click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      $('btn-teams-back').click();
    }
  });

  // A dud preview before the turn is committed costs nothing: deal another
  // song for the same team. Once a pick is locked in, the turn stands — a
  // failed replay must not hand out a free do-over (ACCESS-13).
  MQ.audio.onError(() => {
    if (!S || S.dealing || S.phase === 'over' || S.phase === 'handoff' || !$('screen-when').classList.contains('active')) return;
    if (S.phase === 'placing' && S.placement == null) {
      toast('That preview failed to load — dealing another song.');
      return nextTurn(S.active, false);
    }
    toast(S.phase === 'revealed' ? 'That preview failed to load.' : 'That preview failed to load — the pick stands.');
  });

  // A reload or a closed tab would lose every timeline: ask first.
  window.addEventListener('beforeunload', e => {
    if (!S || S.phase === 'over' || !S.teams.some(t => t.cards.length)) return;
    e.preventDefault();
    e.returnValue = '';
  });

  MQ.when = { start, stop, snapshot };
})();
