'use strict';
// Loaded into a test server (NODE_OPTIONS=--require): every connection it takes looks as if it came
// from FAKE_PEER, say another device on the home network, instead of this machine. For the tests of
// which addresses Marquee believes forwarded headers from.

const net = require('node:net');

// (socket.remoteAddress can't be replaced itself; it reads this.)
const peername = net.Socket.prototype._getpeername;
net.Socket.prototype._getpeername = function fakePeer() {
  const real = peername.call(this);
  // (Only the server's side: its own requests to other servers keep their real addresses.)
  return this.server && real.address && process.env.FAKE_PEER ? { ...real, address: process.env.FAKE_PEER, family: 'IPv4' } : real;
};
