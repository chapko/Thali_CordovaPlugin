'use strict';

var express = require('express');
var https = require('https');
var ip = require('ip');
var nodessdp = require('node-ssdp');
var Promise = require('bluebird');
var uuid = require('uuid');

var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

var logger = require('../../../ThaliLogger')('thaliWifiAdvertiser');
var ssdpLogger = require('../../../ThaliLogger')('nodeSSDPServer')
var makeIntoCloseAllServer = require('../../makeIntoCloseAllServer');
var thaliConfig = require('../../thaliConfig');
var USN = require('./usn');

function WifiAdvertiser () {
  EventEmitter.call(this);

  this.peer = null;
  // Store previously used own peerIdentifiers so ssdp client can ignore some
  // delayed ssdp messages after our server has changed uuid part of usn
  this._ownPeerIdentifiersHistory = [];
  // Can be used in tests to override the port
  // advertised in SSDP messages.
  this.advertisedPortOverride = null;
  this.expressApp = null;
  this.router = null;
  this.routerServer = null;
  this.routerServerPort = 0;
  this.routerServerAddress = ip.address();
  this.routerServerErrorListener = null;
  this.pskIdToSecret = null;

  this._isStarted = false;
  this._isAdvertising = false;

  this._init();
}

inherits(WifiAdvertiser, EventEmitter);

WifiAdvertiser.prototype._init = function () {
  this._server = new nodessdp.Server({
    ssdpIp: thaliConfig.SSDP_IP,
    adInterval: thaliConfig.SSDP_ADVERTISEMENT_INTERVAL,
    udn: thaliConfig.SSDP_NT,
    thaliLogger: ssdpLogger
  });
  Promise.promisifyAll(this._server, {
    filter: function (methodName) {
      return methodName === 'start' || methodName === 'stop';
    }
  });
  this._updateLocation();
};

WifiAdvertiser.prototype._updateLocation = function () {
  var address = this.routerServerAddress;
  var port = this.advertisedPortOverride || this.routerServerPort;
  this._server._location = 'http://' + address + ':' + port;
};

WifiAdvertiser.prototype._notifyStateChange = function () {
  this.emit('stateChange', {
    advertising: this._isAdvertising,
  });
};

WifiAdvertiser.prototype.isStarted = function () {
  return this._isStarted;
};

WifiAdvertiser.prototype.isAdvertising = function () {
  return this._isAdvertising;
};

WifiAdvertiser.prototype.start = function (router, pskIdToSecret) {
  var self = this;
  if (self._isStarted) {
    return Promise.reject(new Error('Call Stop!'));
  }
  self._isStarted = true;

  return self._setUpExpressApp(router, pskIdToSecret)
    .catch(function (error) {
      self._isStarted = false;
      return Promise.reject(error);
    });
};

WifiAdvertiser.prototype.update = function () {
  var self = this;

  if (!self._isStarted) {
    return Promise.reject(new Error('Call Start!'));
  }


  function startSSDPServer () {
    self._updateAdvertisingPeer();
    var usn = USN.stringify(self.peer);
    self._server.setUSN(usn);
    return self._server.startAsync();
  }

  var promise;
  if (self._isAdvertising) {
    // If we were already advertising, we need to restart the server so that a
    // byebye is issued for the old USN and alive message for the new one.
    promise = self._server.stopAsync().then(startSSDPServer);
  } else {
    self._isAdvertising = true;
    promise = startSSDPServer().then(function () {
      self._notifyStateChange();
    });
  }

  return promise.catch(function (error) {
    self._isAdvertising = false;
    return Promise.reject(error);
  });
};

WifiAdvertiser.prototype.stop = function () {
  var self = this;

  if (!self._isStarted) {
    return Promise.resolve();
  }
  self._isStarted = false;

  var promise;
  if (self._isAdvertising) {
    self._isAdvertising = false;
    promise = self._server.stopAsync().then(function () {
      self.peer = null;
    });
  } else {
    promise = Promise.resolve();
  }

  return promise.then(function () {
    return self.routerServer.closeAllPromise();
  }).then(function () {
    // The port needs to be reset, because
    // otherwise there is no guarantee that
    // the same port is available next time
    // we start the router server.
    self.routerServerPort = 0;
    self.routerServer.removeListener('error', self.routerServerErrorListener);
    self.routerServer = null;
    self._notifyStateChange();
  });
};

WifiAdvertiser.prototype._setUpExpressApp = function (router, pskIdToSecret) {
  var self = this;
  self.expressApp = express();
  try {
    self.expressApp.use('/', router);
  } catch (error) {
    logger.error('Unable to use the given router: %s', error.toString());
    return Promise.reject(new Error('Bad Router'));
  }

  self.routerServerErrorListener = function (error) {
    // Error is only logged, because it was determined this should
    // not occur in normal use cases and it wasn't worthwhile to
    // specify a custom error that the upper layers should listen to.
    // If this error is seen in real scenario, a proper error handling
    // should be specified and implemented.
    logger.error('Router server emitted an error: %s', error.toString());
  };

  var options = {
    ciphers: thaliConfig.SUPPORTED_PSK_CIPHERS,
    pskCallback: pskIdToSecret,
    key: thaliConfig.BOGUS_KEY_PEM,
    cert: thaliConfig.BOGUS_CERT_PEM
  };

  function listen (server, port) {
    return new Promise(function (resolve, reject) {
      function onError (error) {
        reject(error); cleanup();
      }
      function onListening () {
        resolve(); cleanup();
      }
      function cleanup () {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
      }
      server.on('error', onError);
      server.on('listening', onListening);
      server.listen(port);
    });
  }

  self.routerServer = https.createServer(options, self.expressApp);
  self.routerServer = makeIntoCloseAllServer(self.routerServer);
  return listen(self.routerServer, self.routerServerPort)
    .catch(function (listenError) {
      logger.error(
        'Router server emitted an error: %s',
        listenError.toString()
      );
      self.routerServer = null;
      var error = new Error('Unspecified Error with Radio infrastructure');
      return Promise.reject(error);
    })
    .then(function () {
      self.routerServerPort = self.routerServer.address().port;
      logger.debug('listening', self.routerServerPort);
      self.routerServer.on('error', self.routerServerErrorListener);
      // We need to update the location string, because the port
      // may have changed when we re-start the router server.
      self._updateLocation();
    });
};

WifiAdvertiser.prototype._updateAdvertisingPeer = function () {
  if (!this.peer) {
    this.peer = {
      peerIdentifier: uuid.v4(),
      generation: 0
    };

    // Update own peers history
    var history = this._ownPeerIdentifiersHistory;
    history.push(this.peer.peerIdentifier);
    if (history.length > thaliConfig.SSDP_OWN_PEERS_HISTORY_SIZE) {
      var overflow = history.length - thaliConfig.SSDP_OWN_PEERS_HISTORY_SIZE;
      history.splice(0, overflow);
    }
  } else {
    this.peer.generation++;
  }
};

WifiAdvertiser.prototype.getAdvertisedPeerIdentifiers = function () {
  return this._ownPeerIdentifiersHistory;
};

module.exports = WifiAdvertiser;
