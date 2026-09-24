/* Shared DOM helpers. Attaches to window.MQ.ui — no bundler, plain scripts. */
(function () {
  'use strict';
  const MQ = (window.MQ = window.MQ || {});

  const $ = id => document.getElementById(id);

  function show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(screenId).classList.add('active');
  }

  let toastHandle = null;
  function toast(msg, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => t.classList.add('hidden'), ms);
  }

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Only one screen is visible at a time, so driving every disc/equalizer at
  // once keeps the modes from each having to know about their own markup.
  function playingVisual(on) {
    document.querySelectorAll('.disc').forEach(d => d.classList.toggle('spinning', on));
    document.querySelectorAll('.equalizer').forEach(e => e.classList.toggle('paused', !on));
  }

  // Keyboard shortcuts must never steal keystrokes from a text field. The
  // target isn't always an element (events dispatched on document aren't), so
  // this can't just call .matches().
  function isTyping(e) {
    const t = e.target;
    return !!(t && t.matches && t.matches('input, textarea, select'));
  }

  MQ.ui = { $, show, toast, esc, playingVisual, isTyping };

  // Shared game settings (the settings modal in app.js writes them back).
  MQ.settings = {
    snippet: parseInt(localStorage.getItem('mq_snippet') || '20', 10),
    rounds: parseInt(localStorage.getItem('mq_rounds') || '10', 10),
    save() {
      localStorage.setItem('mq_snippet', String(this.snippet));
      localStorage.setItem('mq_rounds', String(this.rounds));
    }
  };
})();
