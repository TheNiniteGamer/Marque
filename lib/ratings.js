'use strict';
// Maturity ratings ("PG-13", "TV-14", "12A"…) and what each profile is allowed to see.
// Every rating is turned into an age (the youngest viewers it suits), so ratings from different
// countries compare: a profile limited to 12 sees PG, TV-PG and 12A, but not PG-13 (13).

const AGES = {
  // United States: films, then TV
  G: 0, PG: 7, 'PG-13': 13, R: 17, 'NC-17': 18, X: 18,
  'TV-Y': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-G': 0, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17,
  // United Kingdom
  U: 0, UC: 0, '12A': 12, R18: 18,
  // Australia / New Zealand
  M: 15, MA15: 15, 'MA15+': 15, 'R18+': 18, 'X18+': 18, RP13: 13, RP16: 16, R13: 13, R15: 15, R16: 16,
  // Canada
  '14A': 14, '18A': 18, C: 0, C8: 8, '14+': 14, '18+': 18,
  // Ireland, Netherlands, Germany (FSK numbers are plain ages), others
  '15A': 15, '16': 16, AL: 0, 'ALL': 0, 'TP': 0, 'T': 0,
};

/** The age a rating suits, or null when it isn't known. */
function ageFor(cert) {
  if (!cert) return null;
  const c = String(cert).trim().toUpperCase().replace(/^(FSK|USK|PEGI|KIJKWIJZER)\s*/, '');
  if (c in AGES) return AGES[c];
  const n = /^(\d{1,2})\+?$/.exec(c) || /^[A-Z]{0,2}-?(\d{1,2})\+?$/.exec(c);
  return n ? Math.min(18, Number(n[1])) : null;
}

/** { cert, age } from a certification, or null. */
function rating(cert) {
  const age = ageFor(cert);
  return cert && age != null ? { cert: String(cert).trim(), age } : null;
}

// The choices for a profile's limit (Settings → Users), youngest first. null = everything.
const LIMITS = [
  { age: 7, label: 'Little kids (G, TV-Y7)' },
  { age: 10, label: 'Kids (PG, TV-PG)' },
  { age: 13, label: 'Older kids (PG-13)' },
  { age: 16, label: 'Teens (TV-14, 15)' },
];

/** A title's rating: an edit wins, then the fetched one; episodes and extras follow their show / film. */
function ratingOf(store, obj) {
  if (!obj) return null;
  if (obj.type === 'episode' && obj.showId) return ratingOf(store, store.data.shows[obj.showId]);
  if (obj.type === 'extra' && obj.parentId) return ratingOf(store, store.data.items[obj.parentId] || store.data.shows[obj.parentId]);
  if (obj.edits?.contentRating) return rating(obj.edits.contentRating);
  return obj.meta?.contentRating || null;
}

/** Whether a profile with an age limit may see a title (admins and unlimited profiles see everything). */
function allowedFor(store, user, obj) {
  if (!user || user.role === 'admin' || user.maxAge == null) return true;
  const r = ratingOf(store, obj);
  if (!r) return user.allowUnrated !== false;
  return r.age <= user.maxAge;
}

/** Library access and the profile's age limit together: what "can see this title" means everywhere. */
function canSeeTitle(store, user, obj) {
  const { canSeeLibrary } = require('./auth');
  return !!obj && canSeeLibrary(user, obj.libraryId) && allowedFor(store, user, obj);
}

module.exports = { ageFor, rating, ratingOf, allowedFor, canSeeTitle, LIMITS };
