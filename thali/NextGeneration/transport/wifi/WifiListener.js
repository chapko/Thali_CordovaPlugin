'use strict';

var url = require('url');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var Promise = require('bluebird');
var nodessdp = require('node-ssdp');

var thaliConfig = require('../../thaliConfig');
var logger = require('../../../ThaliLogger')('thaliWifiListener');
var ssdpLogger = require('../../../ThaliLogger')('nodeSSDPClient');
var validations = require('../../../validations');
var USN = require('./usn');

function WifiListener() {
  this._isListening = false;
  this._filterMessageFn = null;

  this._client = new nodessdp.Client({
    ssdpIp: thaliConfig.SSDP_IP,
    thaliLogger: ssdpLogger
  });

  Promise.promisifyAll(this._client, {
    filter: function (methodName) {
      return methodName === 'start' || methodName === 'stop';
    }
  });

  this._client.on('advertise-alive', function (data) {
    this._handleMessage(data, true);
  }.bind(this));

  this._client.on('advertise-bye', function (data) {
    this._handleMessage(data, false);
  }.bind(this));
}

inherits(WifiListener, EventEmitter);

WifiListener.prototype.setMessageFilter = function (filterFn) {
  if (typeof filterFn !== 'function') {
    throw new Error('Filter is expected to be a function');
  }
  this._filterMessageFn = filterFn;
};

WifiListener.prototype._handleMessage = function (data, available) {
  // NT header should be correct
  if (data.NT !== thaliConfig.SSDP_NT) {
    return;
  }

  // USN should be valid
  var peer = USN.tryParse(data.USN, null);
  if (peer === null) {
    logger.warn('Invalid USN: ' + data.USN);
    return;
  }

  // LOCATION should be valid
  var parsedLocation = null;
  var portNumber = null;
  // We expect location only in alive messages.
  if (available) {
    parsedLocation = url.parse(data.LOCATION);
    portNumber = Number(parsedLocation.port);
    try {
      validations.ensureValidPort(portNumber);
    } catch (error) {
      logger.warn('Failed to parse a valid port number from location: %s',
        data.LOCATION);
      return;
    }
  }

  // Should pass custom filter
  if (this._filterMessageFn) {
    var passesFilter = this._filterMessageFn(data, available);
    if (!passesFilter) {
      return;
    }
  }

  console.log(data);

  if (available) {
    peer.hostAddress = parsedLocation.hostname;
    peer.portNumber = portNumber;
  } else {
    peer.hostAddress = null;
    peer.portNumber = null;
  }

  logger.silly('Emitting wifiPeerAvailabilityChanged ' + JSON.stringify(peer));
  this.emit('wifiPeerAvailabilityChanged', peer);
};

WifiListener.prototype.start = function () {
  var self = this;
  if (self._isListening) {
    return Promise.resolve();
  }
  self._isListening = true;

  return self._client.startAsync()
    .catch(function (error) {
      self._isListening = false;
      return Promise.reject(error);
    })
    .then(function () {
      self._notifyStateChange();
    });
};

WifiListener.prototype.stop = function () {
  var self = this;
  if (!self._isListening) {
    return Promise.resolve();
  }
  self._isListening = false;

  return self._client.stopAsync().then(function () {
    self._notifyStateChange();
  });
};

WifiListener.prototype._notifyStateChange = function () {
  this.emit('stateChange', {
    listening: this._isListening
  });
};

WifiListener.prototype.isListening = function () {
  return this._isListening;
};

module.exports = WifiListener;
