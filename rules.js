/*
 * The rules of When's that tune?, written once. The online edition shows them
 * as a page; both editions open them as a dialog over the game (through
 * MQ.ui.openModal, so ui.js must load first).
 *
 *   MQ.rules.render(el)   fill any container with the rules
 *   MQ.rules.open()       show them as a dialog (#rules-modal), focus inside
 *   MQ.rules.close()      close it and hand focus back to whatever opened it
 *   MQ.rules.html         the markup itself
 */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});

  // Small illustrations built from HTML, so they scale with the text and
  // need no image files. Everything here is fixed copy, nothing user-typed.
  const art = hue => `<i class="rules-art" style="--h:${hue}"></i>`;
  const card = (year, hue, extra = '') =>
    `<span class="rules-yc${extra}">${hue == null ? '' : art(hue)}<b>${year}</b></span>`;
  const gap = (label, extra = '') => `<span class="rules-gap${extra}">${label}</span>`;
  const ticket = '<i class="rules-tk" aria-hidden="true"></i>';
  const tickets = n => `<span class="rules-tks" aria-hidden="true">${ticket.repeat(n)}</span>`;
  const k = key => `<kbd>${key}</kbd>`;
  const ok = '<span class="rules-ok" aria-hidden="true">✓</span><span class="rules-sr">right</span>';
  const no = '<span class="rules-no" aria-hidden="true">✗</span><span class="rules-sr">wrong</span>';

  const html = `
<div class="rules-wrap">
<div class="rules-doc">

  <section class="rules-sec rules-goal">
    <h2><span class="rules-ico" aria-hidden="true">🏆</span>The goal</h2>
    <p class="rules-lead">Build a timeline of songs, oldest to newest. The first team to reach the target wins.</p>
    <div class="rules-fig" role="img" aria-label="A timeline: 1965, 1984, a gap marked with a question mark, 1999, 2014">
      <div class="rules-line">${card(1965, 200)}${card(1984, 320)}${gap('?', ' q')}${card(1999, 20)}${card(2014, 140)}</div>
      <p class="rules-cap">Your timeline · oldest → newest</p>
    </div>
    <p>Choose the target on the setup screen: <b>10</b> cards (quick), <b>15</b>, <b>20</b> (standard) or <b>25</b>.
      Every team starts with an empty timeline and <b>2 tokens</b> ${ticket}${ticket}. Team 1 plays first, then turns go round in order.</p>
  </section>

  <section class="rules-sec rules-need">
    <h2><span class="rules-ico" aria-hidden="true">🛋️</span>You'll need</h2>
    <ul class="rules-needs">
      <li><span class="rules-ico" aria-hidden="true">📺</span><span><b>A screen everyone can see</b>, a TV if you have one</span></li>
      <li><span class="rules-ico" aria-hidden="true">🔊</span><span><b>Speakers</b> loud enough for the room</span></li>
      <li><span class="rules-ico" aria-hidden="true">👥</span><span><b>2 or 3 teams</b> of any size</span></li>
      <li><span class="rules-ico" aria-hidden="true">⌨️</span><span><b>Someone at the keyboard</b> to run the screen (a mouse or touch works too)</span></li>
    </ul>
  </section>

  <section class="rules-sec rules-turn">
    <h2><span class="rules-ico" aria-hidden="true">🔁</span>A turn, step by step</h2>
    <ol class="rules-steps">
      <li class="rules-step"><span class="rules-num">1</span><h3>🎧 Listen</h3>
        <p>A song plays, a 30-second preview. ${k('R')} plays it again.</p></li>
      <li class="rules-step"><span class="rules-num">2</span><h3>📍 Place</h3>
        <p>Pick the gap in <b>your</b> timeline where you think it belongs:</p>
        <p class="rules-chips">${gap('before 1975', ' lbl')}${gap('1983 – 1991', ' lbl')}${gap('after 2004', ' lbl')}</p>
        <p>Your first card is free: any spot is right.</p></li>
      <li class="rules-step"><span class="rules-num">3</span><h3>🔒 Lock it in</h3>
        <p>Happy with the gap? Lock it in: that's final. Until then you may still skip the song or buy a card with tokens.</p></li>
      <li class="rules-step"><span class="rules-num">4</span><h3>⚔️ Challenge?</h3>
        <p>Before the reveal, any other team with a token may challenge your pick, or let it stand.</p></li>
      <li class="rules-step"><span class="rules-num">5</span><h3>✨ Reveal</h3>
        <p>${ok} Right: the card joins your timeline.<br>${no} Wrong: it's discarded, unless a challenger steals it.</p>
        <p>Then the next team plays.</p></li>
    </ol>
  </section>

  <section class="rules-sec rules-tokens">
    <h2><span class="rules-ico" aria-hidden="true">🎟️</span>Tokens</h2>
    <p>Every team starts with <b>2</b>. Spend them on your own turn or a rival's; win them back by naming songs on your own turn.</p>
    <table class="rules-table">
      <caption class="rules-sr">What tokens buy and how you earn them</caption>
      <tbody>
        <tr class="rules-th"><th colspan="3" scope="colgroup">Spend</th></tr>
        <tr><th scope="row">⏭ Skip a song</th><td class="rules-cost">${tickets(1)}<b>1</b></td>
          <td>You get another song, still your turn. Not on your free first card, and not after you lock in.</td></tr>
        <tr><th scope="row">⚔️ Challenge</th><td class="rules-cost">${tickets(1)}<b>1</b></td>
          <td>Spent win or lose.</td></tr>
        <tr><th scope="row">🃏 Buy a card</th><td class="rules-cost">${tickets(3)}<b>3</b></td>
          <td>A card is dealt face up straight into your timeline, no guessing. It's on top of your turn: buy before you lock in or after the reveal, not while a challenge is pending.</td></tr>
        <tr class="rules-th"><th colspan="3" scope="colgroup">Earn</th></tr>
        <tr class="rules-earn"><th scope="row">🎤 Name it</th><td class="rules-cost"><span class="rules-plus">+</span>${tickets(1)}<b>1</b></td>
          <td><b>On your turn</b>, say the song's title <b>and</b> artist out loud before the reveal. Whoever runs the screen ticks it on the reveal. Only the team whose turn it is can earn it.</td></tr>
      </tbody>
    </table>
  </section>

  <section class="rules-sec rules-steal">
    <h2><span class="rules-ico" aria-hidden="true">⚔️</span>Challenges and steals</h2>
    <ul class="rules-list">
      <li>After a team locks in, any <b>other</b> team with a token may challenge before the reveal.</li>
      <li>With three teams, the first to shout <b>“Challenge!”</b> takes it. One challenge per song.</li>
      <li>The challenger spends 1 token, win or lose, and picks a <b>different</b> gap in the placing team's timeline.</li>
    </ul>
    <table class="rules-table rules-outcomes">
      <caption class="rules-sr">Who gets the card after a challenge</caption>
      <thead><tr><th scope="col">Placer</th><th scope="col">Challenger</th><th scope="col">The card</th></tr></thead>
      <tbody>
        <tr><td>${ok}</td><td>${no}</td><td>stays with the placer</td></tr>
        <tr class="rules-hot"><td>${no}</td><td>${ok}</td><td><b>stolen!</b> Into the challenger's timeline</td></tr>
        <tr><td>${ok}</td><td>${ok}</td><td>stays with the placer, who placed first (a same-year tie)</td></tr>
        <tr><td>${no}</td><td>${no}</td><td>discarded</td></tr>
      </tbody>
    </table>
    <p>Started one by mistake? <b>Not a challenge</b> <span class="rules-nw">(${k('Esc')})</span> backs out for free before it's confirmed.</p>
  </section>

  <section class="rules-sec rules-same">
    <h2><span class="rules-ico" aria-hidden="true">🟰</span>Same year?</h2>
    <p class="rules-lead">A song from the same year as a neighbouring card fits on either side of it.</p>
    <div class="rules-fig" role="img" aria-label="A new 1984 song is right in the gap before the 1984 card and in the gap after it">
      <div class="rules-line">${card(1979)}${gap('✓', ' good')}${card(1984, null, ' hl')}${gap('✓', ' good')}${card(1991)}</div>
      <p class="rules-cap">A new <b>1984</b> song is right in either gap.</p>
    </div>
    <div class="rules-fig" role="img" aria-label="After it lands, the two 1984 cards sit together as one stack">
      <div class="rules-line">${card(1979)}<span class="rules-stack">${card(1984)}${card(1984)}</span>${card(1991)}</div>
      <p class="rules-cap">Same-year cards sit together as one stack.</p>
    </div>
  </section>

  <section class="rules-sec rules-win">
    <h2><span class="rules-ico" aria-hidden="true">🥇</span>Winning</h2>
    <ul class="rules-list">
      <li>The first team to reach the target wins. It's checked after each reveal.</li>
      <li>A bought card that reaches the target wins on the spot.</li>
      <li>In a rematch the team that came last starts, and the songs are fresh.</li>
      <li>Quit asks first: keep playing, end here and show the standings, or quit to the menu. So does the browser's Back button.</li>
    </ul>
  </section>

  <section class="rules-sec rules-tips">
    <h2><span class="rules-ico" aria-hidden="true">💡</span>Tips</h2>
    <ul class="rules-list">
      <li><b>Use a TV.</b> The timeline is built to be read from the sofa.</li>
      <li><b>Shout the title and artist</b> before the reveal, on your turn. It's the only way to earn tokens (a rival naming your song earns nothing).</li>
      <li><b>Keep a token in hand.</b> A rival's shaky pick is your chance to steal.</li>
      <li><b>Three tokens late in the game</b> can buy the winning card.</li>
    </ul>
  </section>

  <section class="rules-sec rules-keys">
    <h2><span class="rules-ico" aria-hidden="true">⌨️</span>Keyboard shortcuts</h2>
    <div class="rules-keymap">
      <div class="rules-phase"><h3>Placing</h3>
        <ul class="rules-keylist">
          <li><span>${k('←')} ${k('→')}</span><span>choose a gap</span></li>
          <li><span>${k('Enter')}</span><span>lock it in</span></li>
          <li><span>${k('Esc')}</span><span>clear the pick</span></li>
          <li><span>${k('R')}</span><span>replay the song</span></li>
        </ul></div>
      <div class="rules-phase"><h3>Challenge?</h3>
        <ul class="rules-keylist">
          <li><span>${k('1')} ${k('2')} ${k('3')}</span><span>challenge as the 1st, 2nd or 3rd team on the scoreboard</span></li>
          <li><span>${k('N')}</span><span>let it stand</span></li>
        </ul></div>
      <div class="rules-phase"><h3>Challenging</h3>
        <ul class="rules-keylist">
          <li><span>${k('←')} ${k('→')}</span><span>choose a gap</span></li>
          <li><span>${k('Enter')}</span><span>confirm the challenge</span></li>
          <li><span>${k('Esc')}</span><span>not a challenge (nothing spent)</span></li>
        </ul></div>
      <div class="rules-phase"><h3>Reveal</h3>
        <ul class="rules-keylist">
          <li><span>${k('Enter')}</span><span>next team</span></li>
          <li><span>${k('B')}</span><span>named it: +1 token (press again to undo)</span></li>
          <li><span>${k('R')}</span><span>play it again</span></li>
        </ul></div>
    </div>
    <p class="rules-note">Skip and Buy spend tokens, so they have no keys: click them. While the “you’re up” banner shows between turns, keys do nothing. On the setup screen, ${k('Enter')} in a team name starts the game and ${k('Esc')} goes back.</p>
  </section>

</div>
</div>`;

  function render(el) {
    el.innerHTML = html;
    return el;
  }

  // ---------- the dialog ----------
  // MQ.ui.openModal (ui.js) makes the page behind inert, keeps Tab inside,
  // closes it on Esc, the backdrop, ✕ and Got it (data-close), and hands focus
  // back to whatever opened it.
  let modal = null;

  function build() {
    modal = document.createElement('div');
    modal.id = 'rules-modal';
    modal.className = 'modal rules-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'rules-modal-title');
    modal.innerHTML = `
      <div class="modal-card rules-card">
        <div class="rules-card-head">
          <h2 id="rules-modal-title">How to play</h2>
          <button type="button" class="icon-btn rules-close" aria-label="Close the rules" data-close>✕</button>
        </div>
        <div class="rules-card-body" tabindex="-1">
          ${html}
          <div class="rules-card-foot"><button type="button" class="primary-btn rules-done" data-close>Got it</button></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  const isOpen = () => !!modal && !modal.classList.contains('hidden');

  function open() {
    if (!modal) build();
    if (isOpen()) return;
    const body = modal.querySelector('.rules-card-body');
    // The scrolling body takes focus, so arrows and Page Down read on at once.
    MQ.ui.openModal(modal, { initialFocus: body });
    body.scrollTop = 0;
  }

  function close() {
    if (isOpen()) MQ.ui.closeModal(modal);
  }

  MQ.rules = { html, render, open, close, get isOpen() { return isOpen(); } };
})();
