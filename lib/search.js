'use strict';
// Search that understands more than titles: spelling mistakes ("batmn"), actors ("tom hanks"),
// genres and moods ("funny", "scary"), years and decades ("90s comedy") and words from the story
// ("christmas", "dog"). Every word typed has to be found somewhere in a title's details; where it
// was found decides the order (the title itself first, then the cast, genre, year, the story).
// No AI: it's instant and works the same for every app.

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'at', 'to', 'for', 'is', 'it', 'about', 'that', 'where',
  'movie', 'movies', 'film', 'films', 'show', 'shows', 'series', 'starring', 'from', 'by', 'one', 'some', 'something']);
// Everyday words for genres (TMDB's names, as in the library).
const MOODS = {
  funny: ['comedy'], comedies: ['comedy'], hilarious: ['comedy'], scary: ['horror'], spooky: ['horror'], creepy: ['horror'],
  cartoon: ['animation'], cartoons: ['animation'], animated: ['animation'], anime: ['animation'], kids: ['family', 'kids'],
  family: ['family'], romantic: ['romance'], love: ['romance'], scifi: ['science fiction', 'sci fi fantasy'],
  space: ['science fiction'], superhero: ['action', 'science fiction'], war: ['war', 'war politics'], western: ['western'],
  cowboy: ['western'], musical: ['music'], documentaries: ['documentary'], doc: ['documentary'], mystery: ['mystery'],
  thriller: ['thriller'], action: ['action', 'action adventure'], adventure: ['adventure', 'action adventure'],
  fantasy: ['fantasy', 'sci fi fantasy'], crime: ['crime'], drama: ['drama'], dramas: ['drama'], history: ['history'],
  christmas: ['christmas'], xmas: ['christmas'],
};
// How much a word counts by where it was found.
const W = { title: 10, cast: 7, genre: 5, year: 5, keyword: 4, story: 2 };

/** Lower case, without accents or punctuation ("Pokémon: The Movie" → "pokemon the movie"). */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => (s ? norm(s).split(' ').filter(Boolean) : []);

// One spelling mistake is allowed in words of 4+ letters, two in long ones (letters swapped count as one).
function close(a, b) {
  const max = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
  if (!max || Math.abs(a.length - b.length) > max) return false;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return false;
    prev2 = prev; prev = row;
  }
  return prev[b.length] <= max;
}

/** How well `t` matches a list of words: 1 the same, 0.9 the start of one, 0.7 one spelling mistake away. */
function matchWords(t, list, { typos = true, prefix = true } = {}) {
  let best = 0;
  for (const w of list) {
    if (w === t) return 1;
    if (prefix && t.length >= 2 && w.startsWith(t)) best = Math.max(best, 0.9);
    else if (typos && best < 0.7 && close(t, w)) best = 0.7;
  }
  return best;
}

/** What's searched for each title, made once per change to the library. */
function indexOf(o) {
  const m = o.meta || {};
  const title = norm(o.edits?.title || m.title || o.title);
  return {
    o,
    title,
    joined: title.replace(/ /g, ''), // "spiderman" finds "Spider-Man"
    titleWords: [...new Set([...title.split(' '), ...words(o.title), ...words(m.title), ...words(o.edits?.sortTitle)])].filter(Boolean),
    cast: (m.cast || []).slice(0, 15).map((c) => ({ name: c.name, words: words(c.name) })),
    genres: (m.genres || []).map(norm),
    genreWords: (m.genres || []).flatMap(words),
    keywords: (m.keywords || []).flatMap(words),
    story: [...new Set([...words(m.overview), ...words(m.tagline)])],
    year: Number(o.year || m.year) || null,
  };
}

/** The search as typed, sorted into words to find, decades and years. */
function parse(q) {
  const text = norm(q).replace(/\bsci fi\b/g, 'scifi');
  const tokens = text.split(' ').filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const decade = /^(?:(19|20)?(\d)0s)$/.exec(t);
    if (decade) {
      const from = Number(`${decade[1] || (decade[2] >= '3' ? '19' : '20')}${decade[2]}0`);
      out.push({ t, decade: [from, from + 9] });
    } else out.push({ t, stop: STOP.has(t) });
  }
  return { text, tokens: out };
}

/** How well one title matches (0: not at all), and why. */
function score(ix, query) {
  const { text, tokens } = query;
  let total = 0;
  const why = new Set();
  const people = new Set();
  // The whole search in the title: best of all, an exact title most of all.
  if (text && ix.title === text) total += 60;
  else if (text && ix.title.startsWith(`${text} `)) total += 40;
  else if (text.length >= 3 && (` ${ix.title} `.includes(` ${text} `) || (text.length >= 5 && ix.joined.includes(text.replace(/ /g, ''))))) total += 30;
  if (total) why.add('title');
  let needed = 0, inTitle = 0;
  for (const tok of tokens) {
    const { t } = tok;
    let best = 0, where = null, person = null;
    const take = (s, w, p = null) => { if (s > best) { best = s; where = w; person = p; } };
    if (tok.decade) {
      if (ix.year >= tok.decade[0] && ix.year <= tok.decade[1]) take(W.year, 'year');
    } else {
      const typos = tok.typos;
      take(W.title * matchWords(t, ix.titleWords, { typos }), 'title');
      if (t.length >= 3 && best < W.title && ix.joined.includes(t)) take(W.title * 0.8, 'title');
      if (/^\d{4}$/.test(t) && ix.year === Number(t)) take(W.year, 'year');
      for (const c of ix.cast) { const s = W.cast * matchWords(t, c.words, { typos }); if (s) take(s, 'cast', c.name); }
      const moods = MOODS[t];
      if (moods && ix.genres.some((g) => moods.includes(g))) take(W.genre, 'genre');
      take(W.genre * matchWords(t, ix.genreWords, { typos: typos && t.length >= 5 }), 'genre');
      take(W.keyword * matchWords(t, ix.keywords, { typos: false }), 'keyword');
      for (const g of moods || []) take(W.keyword * matchWords(g, ix.keywords, { typos: false, prefix: false }), 'keyword');
      if (t.length >= 3) take(W.story * matchWords(t, ix.story, { typos: false }), 'story');
    }
    if (tok.stop) { total += best / 2; continue; } // ("the", "with"… count if found, but aren't needed)
    needed++;
    if (!best) return null;
    total += best;
    if (where === 'title') inTitle++;
    why.add(where);
    if (person) people.add(person);
  }
  // Only small words typed ("it", "up"): only that very title.
  if (!needed && ix.title !== text) return null;
  // The more of the title the search covers, the closer it is ("A Minecraft Movie" before
  // "Asgard Minecraft Treetopia Ep 30").
  total += 5 * Math.min(1, inTitle / (ix.title.split(' ').length || 1));
  return { score: total, why, people };
}

// Made again after each change to the library: what's searched per title, and every word in the
// library. A word that's in the library is taken as typed ("christmas" isn't a misspelt
// "Christian"); only ones that aren't are looked for with spelling mistakes ("batmn").
const caches = new WeakMap();
function cacheFor(store) {
  let c = caches.get(store);
  if (c?.rev !== store.rev) { c = { rev: store.rev, index: new Map(), vocab: null }; caches.set(store, c); }
  return c;
}
function vocabulary(c, all) {
  if (c.vocab) return c.vocab;
  c.vocab = new Set();
  for (const o of all) {
    const ix = indexed(c, o);
    for (const list of [ix.titleWords, ix.genreWords, ix.keywords, ix.story]) for (const w of list) c.vocab.add(w);
    for (const p of ix.cast) for (const w of p.words) c.vocab.add(w);
  }
  return c.vocab;
}
const indexed = (c, o) => { let x = c.index.get(o); if (!x) { x = indexOf(o); c.index.set(o, x); } return x; };

/**
 * Titles (films, shows) and episodes matching `q`, best first: [{ o, score, why, people }] each,
 * and what the search was understood as ("with Tom Hanks", "1990s"), for the page's heading.
 */
function find(store, titles, episodes, q, limit = 30) {
  const query = parse(q);
  if (!query.tokens.length) return { titles: [], episodes: [], understood: [] };
  const c = cacheFor(store);
  const vocab = vocabulary(c, [...Object.values(store.data?.items || {}), ...Object.values(store.data?.shows || {})]);
  for (const tok of query.tokens) tok.typos = !vocab.has(tok.t);
  const run = (list) => list.map((o) => { const ix = indexed(c, o); return { o, ix, ...(score(ix, query) || { score: 0 }) }; })
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.ix.title.localeCompare(b.ix.title)).slice(0, limit);
  const t = run(titles);
  // Episodes by their own title or story (not their show's cast, which would list every episode).
  const e = run(episodes).filter((r) => [...r.why].every((w) => w === 'title' || w === 'story'));
  const understood = [];
  const person = mostCommon(t.flatMap((r) => [...r.people]));
  if (person) understood.push(`with ${person}`);
  for (const tok of query.tokens) {
    if (tok.decade) understood.push(`the ${tok.decade[0]}s`);
    else if (MOODS[tok.t] && t.some((r) => r.why.has('genre'))) understood.push(MOODS[tok.t][0].replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return { titles: t, episodes: e, understood: [...new Set(understood)] };
}
function mostCommon(list) {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

module.exports = { find, norm, close, parse };
