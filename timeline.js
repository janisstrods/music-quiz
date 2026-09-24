/*
 * When's that tune? timeline maths — the one rule the whole mode rests on.
 * Loaded by the browser as a plain script (attaches to window.QuizTimeline)
 * and by Node tests via module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QuizTimeline = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // A timeline is an array of cards sorted by year. Slot i is the gap before
  // cards[i]; slot cards.length is "after everything". An empty timeline has
  // exactly one slot, and anything fits it.
  function slotIsCorrect(cards, slot, year) {
    const before = slot > 0 ? cards[slot - 1].year : -Infinity;
    const after = slot < cards.length ? cards[slot].year : Infinity;
    // Ties are generous: a song from the same year as its neighbour may sit on
    // either side of it, which is how the boxed game plays it at the table.
    return year >= before && year <= after;
  }

  function insertSorted(cards, card) {
    cards.push(card);
    cards.sort((a, b) => a.year - b.year);
    return cards;
  }

  // A gap between two cards of the same year accepts exactly what the gaps on
  // either side of that pair accept, so it's never offered — same-year cards
  // sit together as one stack.
  function slotIsOpen(cards, i) {
    return i <= 0 || i >= cards.length || cards[i - 1].year !== cards[i].year;
  }

  function slotLabel(cards, i) {
    if (!cards.length) return 'Place it here';
    if (i === 0) return `before ${cards[0].year}`;
    if (i === cards.length) return `after ${cards[cards.length - 1].year}`;
    return `${cards[i - 1].year} – ${cards[i].year}`;
  }

  return { slotIsCorrect, insertSorted, slotIsOpen, slotLabel };
});
