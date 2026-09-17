// public/src/net/colyseus.js
// Single import point for the Colyseus client library.
//
// "colyseus.js" resolves via the import map to /vendor-build/colyseus.esm.js —
// OUR browser bundle, generated at `npm install` by scripts/build-vendor.mjs.
// (The npm package ships no browser-clean artifact: its dist UMD dies on
// Node globals — "Buffer is not defined" — and lib/ is CommonJS.)
//
// Keeping every consumer behind this module means swapping the transport
// later (e.g. raw `ws` + binary protocol) touches only this file and the
// call sites' semantics — nothing else imports the library directly.

export { Client, Room } from 'colyseus.js';
