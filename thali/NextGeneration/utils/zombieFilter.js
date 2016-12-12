'use strict';

var cache = null;

// max possible age of the zombie (in ms);
var zombieTime = null;

// how much time it takes for native layer to update generation (in ms)
var generationUpdateWindow = null;

// how much time it takes to make complete cycle over 256 available generations
// (generation is 8-bit integer on Android)
var wrapAroundTime = null;

function cachePeer (peerIdentifier, realGeneration, fakeGeneration) {
  cache[peerIdentifier] = {
    realGeneration: realGeneration,
    fakeGeneration: fakeGeneration,
    time: Date.now(),
  };
}

function shouldIgnoreAnnouncement (nativePeer) {
  var peerIdentifier = nativePeer.peerIdentifier;
  var cachedPeer = cache[peerIdentifier];

  if (!cachedPeer || !nativePeer.peerAvailable) {
    return false;
  }

  var elapsedTime = Date.now() - cachedPeer.time;
  var maxPossibleGenerationUpdates = elapsedTime * generationMaxUpdateSpeed;
  if (elapsedTime > )
}

function zombieFilter (handleNonTCPPeer, config) {
  cache = {};
  zombieTime = config.zombieTime;
  generationUpdateWindow = config.generationUpdateWindow;
  wrapAroundTime = generationUpdateWindow * 255;

  return function (nativePeer) {
    var peerIdentifier = nativePeer.peerIdentifier;
    var peerAvailable = nativePeer.peerAvailable;
    var generation = nativePeer.generation;

    // just pass through recreated events
    if (nativePeer.recreated) {
      handleNonTCPPeer(nativePeer);
      return;
    }

    if (!peerAvailable) {
      delete cache[peerIdentifier];
      handleNonTCPPeer(nativePeer);
      return;
    }

    var cachedPeer = cache[peerIdentifier];

    if (!cachedPeer) {
      cachePeer(peerIdentifier, nativePeer.generation, 0);
      handleNonTCPPeer(nativePeer);
      return;
    }

    if (shouldIgnoreAnnouncement(nativePeer)) {
      return;
    }

    cachePeer(peerIdentifier, generation, cachedPeer.fakeGeneration + 1);
  };
}

zombieFilter.clearCache = function () {
  cache = {};
};

module.exports = zombieFilter;
