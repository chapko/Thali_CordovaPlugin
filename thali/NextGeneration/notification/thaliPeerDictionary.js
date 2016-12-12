'use strict';

var assert = require('assert');
var ThaliNotificationAction = require('./thaliNotificationAction.js');

/** @module thaliPeerDictionary */

/**
 * @file
 *
 * Defines a dictionary for use by {@link module:thaliNotificationClient} that
 * makes sure we only track a fixed number of peers and will forget peers in
 * a defined order if we get too many of them.
 */

/**
 * Enum to record the state of trying to get the notification beacons for the
 * associated peerIdentifier
 *
 * @public
 * @readonly
 * @enum {string}
 */
module.exports.peerState = {
  /** The notification beacons for this peerID have been successfully
   * retrieved.
   */
  RESOLVED: 'resolved',
  /** The notification action is under the control of the peer pool so we have
   * to check the notification action to find out its current state.
   */
  CONTROLLED_BY_POOL: 'controlledByPool',
  /** A request to get the notification beacons for this peer failed and we
   * are now waiting before enqueuing a new request.
   */
  WAITING: 'waiting'
};

/**
 * Peer object that used as a dictionary key.
 * @typedef {Object} Peer
 * @property {string} peerIdentifier
 * @property {number} generation
 */


/**
 * @classdesc An entry to be put into the peerDictionary.
 *
 * @public
 * @param {module:thaliPeerDictionary.peerState} peerState The state of the
 * peer.
 * @param {module:thaliNotificationAction~ThaliNotificationAction} notificationAction
 * @constructor
 */
function NotificationPeerDictionaryEntry(peerState, notificationAction) {
  this.peerState = peerState;
  this.notificationAction = notificationAction;
  this.waitingTimeout = null;
  this.retryCounter = 0;
}

/**
 * The current state of the peer
 *
 * @public
 * @type {module:thaliPeerDictionary.peerState}
 */
NotificationPeerDictionaryEntry.prototype.peerState = null;

/**
 * The notification action (if any) associated with the peer.
 *
 * @public
 * @type {?module:thaliNotificationAction~NotificationAction}
 */
NotificationPeerDictionaryEntry.prototype.notificationAction = null;

/**
 * The waiting timeout object is used when the peer is in WAITING
 * state before enqueuing a new request.
 *
 * @public
 * @type {?timeoutObject}
 */
NotificationPeerDictionaryEntry.prototype.waitingTimeout = null;

/**
 * The retry number.
 *
 * @public
 * @type {number}
 */
NotificationPeerDictionaryEntry.prototype.retryCounter = null;

module.exports.NotificationPeerDictionaryEntry =
  NotificationPeerDictionaryEntry;


/**
 * @classdesc Wrapper class for dictionary entries which holds entry and all
 * related metadata
 *
 * @private
 * @param {Peer} peer
 * @param {module:thaliPeerDictionary~NotificationPeerDictionaryEntry} entry
 * @param {Object} metadata
 * @constructor
 */
function EntryContainer(peer, entry, metadata) {
  this.peer = peer;
  this.entry = entry;
  this.metadata = Object(metadata);
}

/**
 * @classdesc This class manages a dictionary of discovered peers. It manages
 * how many entries are in the dictionary so that we don't overflow memory.
 * Therefore once we reach a certain number of entries any new entries
 * will cause old entries to be removed.
 *
 * @public
 * @constructor
 */
function PeerDictionary() {
  this._dictionary = {};
  this._entryCounter = 0;
}

/**
 * Maximum size of the dictionary
 *
 * @public
 * @readonly
 * @type {number}
 */
PeerDictionary.MAXSIZE = 100;

/**
 * Adds the entry if the peer isn't yet in the table otherwise updates the
 * existing entry. If the new entry will increase the size of the dictionary
 * beyond the fixed maximum then the oldest resolved entry is removed.
 * If there are no remaining resolved entries to remove then the oldest
 * waiting entry is removed. If there are no remaining resolved entries to
 * remove then kill is called on the oldest CONTROLLED_BY_POOL entry
 * and it is removed.
 *
 * @public
 * @param {Object} peer
 * @param {string} peer.peerIdentifier
 * @param {number} peer.generation
 * @param {module:thaliPeerDictionary~NotificationPeerDictionaryEntry} entry
 * Entry to be added.
  */
PeerDictionary.prototype.addUpdateEntry = function (peer, entry) {
  var peerIdentifier = peer.peerIdentifier;
  var generation = peer.generation;
  assert(peerIdentifier, 'peer.peerIdentifier must be set');
  assert(typeof generation === 'number', 'peer.generation must be a number');

  if (!this._dictionary[peerIdentifier]) {
    this._dictionary[peerIdentifier] = {};
  }

  var peerEntryContainers = this._dictionary[peerIdentifier];
  if (!peerEntryContainers[generation]) {
    this._removeOldestIfOverflow();
    peerEntryContainers[generation] = new EntryContainer({
      peerIdentifier: peerIdentifier,
      generation: generation,
    });
  }

  peerEntryContainers[generation].entry = entry;
  peerEntryContainers
  peerEntryContainers[generation].entryNumber = this._entryCounter++;
};

/**
 * Removes an entry which matches with the peer.
 *
 * @public
 * @param {Object} peer
 * @param {string} peer.peerIdentifier
 * @param {number} peer.generation
 */
PeerDictionary.prototype.remove = function (peer) {
  assert(peer.peerIdentifier, 'peer.peerIdentifier must be set');
  assert(typeof peer.generation === 'number',
    'peer.generation must be a number');

  var entry = this.getPeerGenerationEntry(peer);
  if (!entry) {
    return;
  }
  entry.waitingTimeout && clearTimeout(entry.waitingTimeout);
  entry.notificationAction &&
    entry.notificationAction.eventEmitter.removeAllListeners(
    ThaliNotificationAction.Events.Resolved);
  entry.notificationAction && entry.notificationAction.kill();

  var peerEntries = this._dictionary[peer.peerIdentifier];
  delete peerEntries[peer.generation];
  if (Object.keys(peerEntries).length === 0) {
    delete this._dictionary[peer.peerIdentifier];
  }
};

/**
 * Removes all entries which match with the peerIdentifier.
 *
 * @public
 * @param {string} peerIdentifier
 */
PeerDictionary.prototype.removeAllPeerEntries = function (peerIdentifier) {
  var peerEntries = this._dictionary[peerIdentifier];
  if (!peerEntries) {
    return;
  }
  Object.keys(peerEntries).forEach(function (generation) {
    this.remove({
      peerIdentifier: peerIdentifier,
      generation: Number(generation),
    });
  }, this);
};

/**
 * Removes all entries from the dictionary.
 *
 * @public
 */
PeerDictionary.prototype.removeAll = function () {
  var self = this;
  Object.keys(this._dictionary).forEach(function (peerIdentifier) {
    self.removeAllPeerEntries(peerIdentifier);
  });
};

/**
 * Checks if the entry exists in the dictionary.
 *
 * @public
 * @param {Object} peer
 * @param {string} peer.peerIdentifier
 * @param {number} peer.generation
 * @returns {boolean} Returns true if the entry exists, false otherwise.
 */
PeerDictionary.prototype.exists = function (peer) {
  assert(peer.peerIdentifier, 'peer.peerIdentifier must be set');
  assert(typeof peer.generation === 'number',
    'peer.generation must be a number');

  var peerEntries = this._dictionary[peer.peerIdentifier];
  return (
    peerEntries !== undefined &&
    peerEntries[peer.generation] !== undefined
  );
};

/**
 * Returns an entry from the dictionary which matches with the peer.
 *
 * @public
 * @param {Object} peer
 * @param {string} peer.peerIdentifier
 * @param {number} peer.generation
 * @returns {module:thaliPeerDictionary~NotificationPeerDictionaryEntry}
 * Returns an entry that matches with the peer. If the entry is not found
 * returns null.
 */
PeerDictionary.prototype.getPeerGenerationEntry = function (peer) {
  assert(peer.peerIdentifier, 'peer.peerIdentifier must be set');
  assert(typeof peer.generation === 'number',
    'peer.generation must be a number');

  var peerEntries = this._dictionary[peer.peerIdentifier];
  var entryObject = peerEntries ? peerEntries[peer.generation] : null;
  return entryObject ? entryObject.entry : null;
};

/**
 * Returns an array of all entries from the dictionary which match with the
 * peerIdentifier.
 *
 * @public
 * @param {string} peerIdentifier
 * @returns {module:thaliPeerDictionary~NotificationPeerDictionaryEntry[]}
 */
PeerDictionary.prototype.getPeerEntries = function (peerIdentifier) {
  assert(peerIdentifier, 'peerIdentifier must be set');

  var peerEntryObjects = this._dictionary[peerIdentifier];
  var entries = [];
  if (peerEntryObjects) {
    entries = Object.keys(peerEntryObjects).map(function (k) {
      return peerEntryObjects[k].entry;
    });
  }
  return entries;
};

/**
 * Returns the size of the dictionary.
 *
 * @public
 * @returns {number} Size of the dictionary
 */
PeerDictionary.prototype.size = function () {
  var dict = this._dictionary;
  return Object.keys(dict).reduce(function (total, peerIdentifier) {
    return total + Object.keys(dict[peerIdentifier]).length;
  }, 0);
};

/**
 * Returns an array of all entries in the dictionary.
 *
 * @private
 * @returns {module:thaliPeerDictionary~NotificationPeerDictionaryEntry[]}
 */
PeerDictionary.prototype._values = function () {
  var dict = this._dictionary;
  return Object.keys(dict).reduce(function (result, peerIdentifier) {
    var peerEntries = dict[peerIdentifier];
    var entryObjects = Object.keys(peerEntries).map(function (generation) {
      return peerEntries[generation];
    });
    return result.concat(entryObjects);
  }, []);
};

/**
 * If the dictionary is full this function removes an entry
 * in the following order. Removes the oldest resolved entry.
 * If there are no remaining resolved entries to remove then
 * the oldest waiting entry is removed. If there are no
 * remaining resolved entries to remove then kills the
 * oldest CONTROLLED_BY_POOL entry and removes it.
 *
 * @private
 */
PeerDictionary.prototype._removeOldestIfOverflow = function () {
  var self = this;

  if (this.size() < PeerDictionary.MAXSIZE) {
    return;
  }

  var search = function (state) {
    var smallestEntryNumber = self._entryCounter;
    var oldestEntryObject = null;

    self._values().filter(function (entryObject) {
      return entryObject.entry.peerState === state;
    }).forEach(function (entryObject) {
      if (entryObject.entryNumber < smallestEntryNumber) {
        oldestEntryObject = entryObject;
        smallestEntryNumber = entryObject.entryNumber;
      }
    });
    if (!oldestEntryObject) {
      return null;
    }
    return {
      peerIdentifier: oldestEntryObject.peerIdentifier,
      generation: oldestEntryObject.generation
    };
  };

  var oldestPeer =
    // First search for the oldest RESOLVED entry
    search(exports.peerState.RESOLVED) ||
    // Next search for the oldest WAITING entry
    search(exports.peerState.WAITING) ||
    // As a last search for the oldest CONTROLLED_BY_POOL entry
    search(exports.peerState.CONTROLLED_BY_POOL);

  if (oldestPeer) {
    self.remove(oldestPeer);
  }
};

module.exports.PeerDictionary = PeerDictionary;
