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

  // Keyboard shortcuts must never steal keystrokes from a text field. Sliders,
  // checkboxes and buttons aren't text fields: touching the volume must not
  // switch the shortcuts off. The target isn't always an element (events
  // dispatched on document aren't), so this can't just call .matches().
  function isTyping(e) {
    const t = e.target;
    if (!t || !t.matches) return false;
    return t.isContentEditable || t.matches('textarea, select, ' +
      'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button])');
  }

  // Game shortcuts stand down while any dialog (Settings, Quit, Rules) is up,
  // so a key meant for the dialog never also acts on the game behind it.
  const modalOpen = () => !!document.querySelector('.modal:not(.hidden)');

  // ---------- storage ----------
  // A browser can refuse site data (even reading localStorage then throws),
  // so every read and write goes through here and the game plays on without.
  const store = {
    get(key, fallback = null) {
      try {
        const v = window.localStorage.getItem(key);
        return v == null ? fallback : v;
      } catch (_) { return fallback; }
    },
    json(key, fallback) {
      try { return JSON.parse(store.get(key)) ?? fallback; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (_) {}
    }
  };

  // ---------- dialogs ----------
  // Every dialog (Quit, Rules, Settings) behaves the same: the page behind
  // goes inert, focus moves in and Tab stays inside, Esc closes it, and focus
  // goes back to whatever opened it. Its backdrop and its close buttons
  // (marked data-close) close it, but it opens under the pointer that opened
  // it: for a moment those ignore mouse clicks (the second half of a
  // double-click would land on them), they always ignore double-clicks, and
  // the backdrop counts only a press that started on it too, so a press that
  // slides off a button onto it doesn't close anything.
  const MODAL_ARM_MS = 450;
  const open = [];   // the open dialogs, top last
  const top = () => open[open.length - 1] || null;

  function focusables(el) {
    return [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(f => !f.disabled && f.getClientRects().length);
  }

  // Capture phase on window, so nothing behind the dialog (a game's Enter,
  // Esc or letter keys, the shell's) ever sees a key pressed while it's open.
  // Default actions still run: a focused button still clicks, arrows scroll.
  function onKey(e) {
    const d = top();
    if (!d) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(d.el);
    } else if (e.key === 'Tab') {
      const f = focusables(d.el);
      if (!f.length) return e.preventDefault();
      const first = f[0], last = f[f.length - 1];
      const a = document.activeElement;
      if (!d.el.contains(a) || (e.shiftKey && a === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && a === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  const wired = new WeakSet();
  function wire(el) {
    wired.add(el);
    let downOnBackdrop = false;
    el.addEventListener('mousedown', e => {
      downOnBackdrop = e.target === el;
      // Neither a press on the backdrop nor the second half of the double-click
      // that opened it takes focus out of the dialog.
      const d = open.find(x => x.el === el);
      if (downOnBackdrop || (d && e.detail > 1 && performance.now() < d.armedAt)) e.preventDefault();
    });
    el.addEventListener('click', e => {
      const d = open.find(x => x.el === el);
      const closer = e.target === el ? (downOnBackdrop ? el : null) : e.target.closest('[data-close]');
      downOnBackdrop = false;
      if (!d || !closer) return;
      // Keyboard clicks (detail 0) are always meant.
      if (e.detail > 1 || (e.detail === 1 && performance.now() < d.armedAt)) return;
      closeModal(el);
    });
  }

  // el: a .modal. opener: where focus goes on close (default: what has focus
  // now; null blurs). onClose runs after it has closed, however it closed.
  // initialFocus: the element to focus (default: the first control in it).
  function openModal(el, { opener = document.activeElement, onClose = null, initialFocus = null } = {}) {
    if (open.some(d => d.el === el)) return;
    if (!wired.has(el)) wire(el);
    // Everything but the dialog (and its ancestors) goes inert: every
    // sibling on the way up. Only what this changed is put back.
    const changed = [];
    for (let node = el; node && node !== document.body && node.parentElement; node = node.parentElement) {
      if (node.inert) { node.inert = false; changed.push([node, true]); }
      for (const sib of node.parentElement.children) {
        if (sib === node || sib.inert || sib.tagName === 'SCRIPT') continue;
        sib.inert = true;
        changed.push([sib, false]);
      }
    }
    open.push({ el, opener, onClose, changed, armedAt: performance.now() + MODAL_ARM_MS });
    el.classList.remove('hidden');
    if (open.length === 1) window.addEventListener('keydown', onKey, true);
    const f = initialFocus || focusables(el)[0];
    if (f) f.focus({ preventScroll: true });
  }

  function closeModal(el) {
    const k = open.findIndex(d => d.el === el);
    if (k < 0) return;
    const [d] = open.splice(k, 1);
    el.classList.add('hidden');
    for (const [node, was] of d.changed.reverse()) node.inert = was;
    if (!open.length) window.removeEventListener('keydown', onKey, true);
    const back = d.opener;
    if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
    } else if (document.activeElement && document.activeElement !== document.body && !top()) {
      document.activeElement.blur();
    }
    if (d.onClose) d.onClose();
    if (!open.length) afterModals.splice(0).forEach(fn => fn());
  }

  // Runs fn now if no dialog is open, else once the last one has closed (a
  // new song mustn't start behind the rules or the quit dialog).
  const afterModals = [];
  function whenNoModal(fn) {
    if (!modalOpen()) fn(); else afterModals.push(fn);
  }

  // ---------- history ----------
  // The site's pages and a game's Back guard share the browser's history.
  // history.back() lands later, on popstate, so everything queued here waits
  // for it, and those pops never reach anyone else's popstate handler.
  const queue = [];
  let popping = 0;
  let popTimer = 0;
  function settle() {
    while (!popping && queue.length) {
      try { queue.shift()(); } catch (_) {}
    }
  }
  const nav = {
    // fn runs once every earlier step has landed.
    run(fn) { queue.push(fn); settle(); },
    // Only from inside run(): one entry back, quietly.
    back() {
      popping++;
      history.back();
      clearTimeout(popTimer);
      popTimer = setTimeout(() => { popping = 0; settle(); }, 1000);   // a pop that never landed
    }
  };
  window.addEventListener('popstate', e => {
    if (!popping) return;
    popping--;
    e.stopImmediatePropagation();
    settle();
  });

  MQ.ui = {
    $, show, toast, esc, playingVisual, isTyping, modalOpen, store,
    openModal, closeModal, topModal: () => (top() ? top().el : null), whenNoModal, nav
  };

  // Shared game settings (the settings modal in app.js writes them back).
  MQ.settings = {
    snippet: parseInt(store.get('mq_snippet', '20'), 10) || 20,
    rounds: parseInt(store.get('mq_rounds', '10'), 10) || 10,
    save() {
      store.set('mq_snippet', String(this.snippet));
      store.set('mq_rounds', String(this.rounds));
    }
  };
})();
