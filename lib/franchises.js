'use strict';
// Franchises: big film worlds that span several TMDB collections, standalone films and TV series
// (the Marvel Cinematic Universe, Star Wars, the Wizarding World…), and the animation studios
// behind whole shelves of family films (Pixar, Studio Ghibli…).
//
// They're worked out from what TMDB says about each title: its keywords ("marvel cinematic universe
// (mcu)"), the studios that made it, and the film series it belongs to. A franchise is shown as a
// collection (collections.js, ids "franchise-<id>") once two of its titles are in the library, and
// admins can rename, add to, take from, arrange or hide it like any TMDB collection.
//
// Film series that are a single TMDB collection (James Bond, Mission: Impossible) aren't listed:
// they're already collections of their own.

const { memo, isOtherVersion } = require('./library');

const re = (s) => new RegExp(s, 'i');
// Rules get each title's facts: kw(name) (a TMDB keyword), studio(re), series(re) (its TMDB
// collection's name), title(re), year, show (whether it's a TV show).
const CATALOG = [
  { id: 'mcu', name: 'Marvel Cinematic Universe', kind: 'franchise',
    about: 'Every film and series set in Marvel Studios’ shared universe, from Iron Man on.',
    rule: (f) => f.kw('marvel cinematic universe (mcu)') || f.kw('marvel cinematic universe') || (f.studio(/^Marvel Studios$/) && f.year >= 2008) },
  { id: 'star-wars', name: 'Star Wars', kind: 'franchise',
    about: 'A long time ago in a galaxy far, far away: the Skywalker saga, its stories and its series.',
    rule: (f) => f.kw('star wars') || f.series(/star wars/) || f.title(/^star wars\b|^rogue one\b|^solo: a star wars|\bmandalorian\b|^andor$|^obi-wan kenobi|^ahsoka$|book of boba fett|^the bad batch|^skeleton crew|^the acolyte/) },
  { id: 'dc', name: 'DC', kind: 'franchise',
    about: 'Batman, Superman, Wonder Woman and the rest of DC’s heroes and villains on screen.',
    rule: (f) => f.kw('dc extended universe (dceu)') || f.kw('dc universe (dcu)') || f.studio(/^DC (Comics|Entertainment|Films|Studios)$/) },
  { id: 'x-men', name: 'X-Men', kind: 'franchise',
    about: 'Mutants on screen: the X-Men films, Wolverine and Deadpool.',
    rule: (f) => !f.show && (f.series(/x-men|wolverine|deadpool/) || f.title(/^x-men\b|^x2\b|wolverine|deadpool/)) },
  { id: 'spider-man', name: 'Spider-Man', kind: 'franchise',
    about: 'Every Spider-Man: Raimi’s, the Amazing ones, the MCU’s and the Spider-Verse.',
    rule: (f) => f.series(/spider-man|spider-verse/) || f.title(/spider-man/) },
  { id: 'wizarding-world', name: 'Wizarding World', kind: 'franchise',
    about: 'Harry Potter and Fantastic Beasts.',
    rule: (f) => f.series(/harry potter|fantastic beasts/) || f.kw('wizarding world') || f.title(/^harry potter\b|^fantastic beasts\b/) },
  { id: 'middle-earth', name: 'Middle-earth', kind: 'franchise',
    about: 'Tolkien’s world: The Lord of the Rings, The Hobbit and The Rings of Power.',
    rule: (f) => f.series(/lord of the rings|the hobbit/) || f.title(/lord of the rings|^the hobbit\b|rings of power|war of the rohirrim/) },
  { id: 'star-trek', name: 'Star Trek', kind: 'franchise',
    about: 'To boldly go: every crew, from the original series to the Kelvin films.',
    rule: (f) => f.series(/star trek/) || f.title(/^star trek\b/) },
  { id: 'monsterverse', name: 'MonsterVerse', kind: 'franchise',
    about: 'Legendary’s Godzilla and Kong films, and Monarch.',
    rule: (f) => f.kw('monsterverse') || (f.title(/godzilla|kong|monarch: legacy of monsters/) && f.year >= 2014 && (f.studio(/legendary/) || f.show)) },
  { id: 'conjuring', name: 'The Conjuring Universe', kind: 'franchise',
    about: 'The Warrens’ case files: The Conjuring, Annabelle and The Nun.',
    rule: (f) => f.series(/conjuring|annabelle|^the nun/) || f.kw('the conjuring universe') || f.title(/^the conjuring\b|^annabelle\b|^the nun\b|curse of la llorona/) },
  { id: 'apes', name: 'Planet of the Apes', kind: 'franchise',
    about: 'The original films, the remake and the new saga.',
    rule: (f) => f.series(/planet of the apes/) || f.title(/planet of the apes/) },
  { id: 'rocky', name: 'Rocky & Creed', kind: 'franchise',
    about: 'Rocky Balboa, and Adonis Creed after him.',
    rule: (f) => !f.show && (f.series(/^rocky\b|^creed\b/) || f.title(/^rocky\b|^creed\b/)) },
  { id: 'pixar', name: 'Pixar', kind: 'studio',
    about: 'Every Pixar film, from Toy Story on.',
    rule: (f) => !f.show && f.studio(/^Pixar$/) },
  { id: 'disney-animation', name: 'Walt Disney Animation', kind: 'studio',
    about: 'The Disney animated classics, from Snow White to today.',
    rule: (f) => !f.show && f.studio(/^Walt Disney (Animation Studios|Feature Animation|Productions)$/) && f.animated },
  { id: 'dreamworks', name: 'DreamWorks Animation', kind: 'studio',
    about: 'Shrek, Kung Fu Panda, How to Train Your Dragon and the rest.',
    rule: (f) => !f.show && f.studio(/^DreamWorks Animation$/) },
  { id: 'illumination', name: 'Illumination', kind: 'studio',
    about: 'Despicable Me, the Minions and friends.',
    rule: (f) => !f.show && f.studio(/^Illumination( Entertainment)?$/) },
  { id: 'ghibli', name: 'Studio Ghibli', kind: 'studio',
    about: 'Miyazaki, Takahata and the films of Studio Ghibli.',
    rule: (f) => f.studio(/^Studio Ghibli$/) },
];
const byId = new Map(CATALOG.map((c) => [c.id, c]));

// What a title's rules are checked against.
function facts(o, isShow) {
  const m = o.meta || {};
  const kws = new Set(m.keywords || []);
  const companies = m.companies || [];
  const seriesName = m.collection?.name || '';
  const title = String(m.title || o.title || '');
  return {
    kw: (k) => kws.has(k),
    studio: (r) => companies.some((c) => re(r.source).test(c)),
    series: (r) => !!seriesName && re(r.source).test(seriesName),
    title: (r) => re(r.source).test(title),
    year: Number(m.year || o.year) || 0,
    show: isShow,
    animated: (m.genres || o.genres || []).some((g) => /animation/i.test(g)),
  };
}

/** Franchises found in the library: [{ id: "franchise-mcu", name, about, kind, members: [ids] }]. */
const groups = (store) => memo(store, 'franchises', () => {
  const found = new Map();
  const consider = (o, isShow) => {
    const f = facts(o, isShow);
    for (const c of CATALOG) {
      let hit = false;
      try { hit = c.rule(f); } catch { /* (a rule tripping over odd data just doesn't match) */ }
      if (!hit) continue;
      if (!found.has(c.id)) found.set(c.id, { id: `franchise-${c.id}`, name: c.name, about: c.about, studio: c.kind === 'studio', members: [] });
      found.get(c.id).members.push(o.id);
    }
  };
  for (const it of Object.values(store.data.items)) if (it.type === 'movie' && !isOtherVersion(store, it)) consider(it, false);
  for (const s of Object.values(store.data.shows)) consider(s, true);
  // Franchises first, studios after; each in the catalogue's order.
  return [...found.values()].sort((a, b) => a.studio - b.studio || CATALOG.indexOf(byId.get(a.id.slice(10))) - CATALOG.indexOf(byId.get(b.id.slice(10))));
});

/** The catalogue entry for "franchise-<id>". */
const info = (id) => byId.get(String(id).replace(/^franchise-/, '')) || null;

module.exports = { groups, info, facts, CATALOG };
