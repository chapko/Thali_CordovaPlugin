'use strict';

var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var https = require('https');
var url = require('url');

var Promise = require('bluebird');
var nodessdp = require('node-ssdp');
var ip = require('ip');
var uuid = require('uuid');
var express = require('express');
var validations = require('../validations');
var thaliConfig = require('./thaliConfig');
var thaliMobileNativeWrapper = require('./thaliMobileNativeWrapper');
var logger = require('../ThaliLogger')('thaliWifiInfrastructure');
var makeIntoCloseAllServer = require('./makeIntoCloseAllServer');
var PromiseQueue = require('./promiseQueue');
var USN = require('./utils/usn');
var platform = require('./utils/platform');

var muteRejection = (function () {
  function returnNull () { return null; }
  function returnArg (arg) { return arg; }

  return function muteRejection (promise) {
    return promise.then(returnNull).catch(returnArg);
  };
}());

/** @module ThaliWifiInfrastructure */

/**
 * @file
 *
 * This is the interface used to manage local discover of peers over a Wi-Fi
 * Infrastructure mode access point.
 *
 * All the methods defined in this file are asynchronous. However any time a
 * method is called the invocation will immediately return but the request will
 * actually be put on a queue and all incoming requests will be run out of that
 * queue. This means that if one calls two start methods on say advertising or
 * discovery then the first start method will execute, call back its promise and
 * only then will the second start method start running. This restriction is in
 * place to simplify the state model and reduce testing.
 *
 * All stop methods in this file are idempotent so they can be called multiple
 * times in a row without causing a state change.
 */


/**
 * @class WifiListener
 */
function WifiListener() {
  this._isListening = false;
  this._filterMessageFn = null;

  this._client = new nodessdp.Client({
    ssdpIp: thaliConfig.SSDP_IP,
    thaliLogger: require('../ThaliLogger')('nodeSSDPClientLogger')
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

/**
 * @param {function} filterFn
 */
WifiListener.prototype.setMessageFilter = function (filterFn) {
  if (typeof filterFn !== 'function') {
    throw new Error('Filter is expected to be a function');
  }
  this._filterMessageFn = filterFn;
};

/**
 * @private
 * @param {object} data
 * @param {boolean} available
 * @return {boolean}
 */
WifiListener.prototype._handleMessage = function (data, available) {
  if (this._shouldBeIgnored(data)) {
    return false;
  }

  var usn = data.USN;
  var peer = null;
  try {
    peer = USN.parse(usn);
  } catch (error) {
    logger.warn(error.message);
    return false;
  }

  // We expect location only in alive messages.
  if (available === true) {
    var parsedLocation = url.parse(data.LOCATION);
    var portNumber = parseInt(parsedLocation.port);
    try {
      validations.ensureValidPort(portNumber);
    } catch (error) {
      logger.warn('Failed to parse a valid port number from location: %s',
        data.LOCATION);
      return false;
    }
    peer.hostAddress = parsedLocation.hostname;
    peer.portNumber = portNumber;
  } else {
    peer.hostAddress = peer.portNumber = null;
  }

  logger.silly('Emitting wifiPeerAvailabilityChanged ' + JSON.stringify(peer));
  this.emit('wifiPeerAvailabilityChanged', peer);
  return true;
};

/**
 * Function used to filter out SSDP messages that are not relevant for Thali.
 * @private
 * @param {object} data
 * @return {boolean}
 */
WifiListener.prototype._shouldBeIgnored = function (data) {
  var isUnknownNt = (data.NT !== thaliConfig.SSDP_NT);
  var isFilteredMessage = this._filterMessageFn ?
    !this._filterMessageFn(data) :
    false;
  return (isUnknownNt || isFilteredMessage);
};

/**
 * @return {Promise}
 */
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
      if (platform.isAndroid) {
        return thaliMobileNativeWrapper.lockAndroidWifiMulticast();
      }
    });
};

/**
 * @return {Promise}
 */
WifiListener.prototype.stop = function () {
  var self = this;
  if (!self._isListening) {
    return Promise.resolve();
  }
  self._isListening = false;

  return self._client.stopAsync().then(function () {
    self._notifyStateChange();
    if (platform.isAndroid) {
      return thaliMobileNativeWrapper.unlockAndroidWifiMulticast();
    }
  });
};

/**
 * @private
 */
WifiListener.prototype._notifyStateChange = function () {
  this.emit('stateChange', {
    listening: this._isListening
  });
};

/**
 * @return {boolean}
 */
WifiListener.prototype.isListening = function () {
  return this._isListening;
};


/**
 * @class WifiAdvertiser
 */
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

/**
 * @private
 */
WifiAdvertiser.prototype._init = function () {
  this._server = new nodessdp.Server({
    ssdpIp: thaliConfig.SSDP_IP,
    adInterval: thaliConfig.SSDP_ADVERTISEMENT_INTERVAL,
    udn: thaliConfig.SSDP_NT,
    thaliLogger: require('../ThaliLogger')('nodeSSDPServerLogger')
  });
  Promise.promisifyAll(this._server, {
    filter: function (methodName) {
      return methodName === 'start' || methodName === 'stop';
    }
  });
  this._updateLocation();
};

/**
 * @private
 */
WifiAdvertiser.prototype._updateLocation = function () {
  var address = this.routerServerAddress;
  var port = this.advertisedPortOverride || this.routerServerPort;
  this._server._location = 'http://' + address + ':' + port;
};

/**
 * @private
 */
WifiAdvertiser.prototype._notifyStateChange = function () {
  this.emit('stateChange', {
    advertising: this._isAdvertising,
  });
};

/**
 * @return {boolean}
 */
WifiAdvertiser.prototype.isStarted = function () {
  return this._isStarted;
};

/**
 * @return {boolean}
 */
WifiAdvertiser.prototype.isAdvertising = function () {
  return this._isAdvertising;
};

/**
 * @param {Object} router
 * @param {module:thaliMobileNativeWrapper~pskIdToSecret} pskIdToSecret
 * @return {Promise}
 */
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

/**
 * @return {Promise}
 */
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

/**
 * @return {Promise}
 */
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

/**
 * @private
 * @param {Object} router
 * @param {module:thaliMobileNativeWrapper~pskIdToSecret} pskIdToSecret
 * @return {Promise}
 */
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

/**
 * @private
 */
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

/**
 * @return {Object[]}
 */
WifiAdvertiser.prototype.getAdvertisedPeerIdentifiers = function () {
  return this._ownPeerIdentifiersHistory;
};

/**
 * This event specifies that a peer was discovered over Wi-Fi Infrastructure.
 * Please keep in mind that IP address bindings can change randomly amongst
 * peers and of course peers can disappear. So this should be considered more of
 * a hint than anything else. If the peer has gone (e.g. ssdp:byebye) then both
 * hostAddress and portNumber MUST be set to null.
 *
 * Note that when sending SSDP queries we MUST use a randomly assigned address
 * for the local UDP port as described in {@link
 * moduleThaliWifiInfrastructure.startUpdateAdvertisingAndListenForIncomingConne
 * ctions}. It is not necessary that this be the same UDP port as used in the
 * previously mentioned function.
 *
 * __Open Issue:__ There is a pretty obvious security hole here that a bad
 * actor could advertise a bunch of IP or DNS addresses of some innocent target
 * on a local network in order to trigger a connection storm. Given the various
 * limitations in place it's unclear how effective this would really be. There
 * are things we can to ameliorate the attack including only accepting IP
 * address that match the local network mask and also rate limiting how quickly
 * we are willing to connect to discovered peers.
 *
 * @event wifiPeerAvailabilityChanged
 * @public
 * @type {Object}
 * @property {string} peerIdentifier This is the UUID part of the USN value.
 * @property {number} generation This is the generation part of the USN value
 * @property {?string} hostAddress This can be either an IP address or a DNS
 * address encoded as a string
 * @property {?number} portNumber The port on the hostAddress to use to connect
 * to the peer
 */

/* eslint-disable max-len */
/**
 * For the definition of this event please see {@link
 * module:thaliMobileNativeWrapper~discoveryAdvertisingStateUpdateEvent}
 *
 * This notifies the listener whenever the state of discovery or advertising
 * changes. In {@link module:thaliMobileNativeWrapper} the equivalent of this
 * event is fired from the native layer and then works its way through {@link
 * module:thaliMobileNative} to {@link module:thaliMobileNativeWrapper}. But in
 * the case of Wifi there is no native layer. Therefore if there is a call to
 * start/stop discovery/advertising or if a network change event forces a change
 * in status (e.g. someone turned off Wifi) then this class MUST issue this
 * event itself. That is, it must have hooked into the start/stop methods,
 * start/stop discovery/advertising methods, {@link
 * module:thaliMobileNativeWrapper.nonTCPPeerAvailabilityChangedEvent} events
 * when we are on mobile devices and {@link
 * module:ThaliWifiInfrastructure.networkChangedWifi} when we are on desktop to
 * figure out when status has changed and this event needs to be fired.
 *
 * @public
 * @event discoveryAdvertisingStateUpdateWifiEvent
 * @type {Object}
 * @property {module:thaliMobileNative~discoveryAdvertisingStateUpdate} discoveryAdvertisingStateUpdateValue
 */
/* eslint-enable max-len */

/**
 * [NOT IMPLEMENTED]
 *
 * For the definition of this event please see {@link
 * module:thaliMobileNativeWrapper~networkChangedNonTCP}.
 *
 * The WiFi layer MUST NOT emit this event unless we are running on Linux,
 * macOS or Windows. In the case that we are running on those platforms then If
 * we are running on those platforms then bluetoothLowEnergy and bluetooth MUST
 * both return radioState set to `doNotCare`. Also note that these platforms
 * don't generally support a push based way to detect WiFi state (at least not
 * without writing native code). So for now we can use polling and something
 * like [network-scanner](https://www.npmjs.com/package/network-scanner) to give
 * us some sense of the system's state.
 *
 * @public
 * @event networkChangedWifi
 * @type {Object}
 * @property {module:thaliMobileNative~networkChanged} networkChangedValue
 *
 */

/**
 * This creates an object to manage a WiFi instance. During production we will
 * have exactly one instance running but for testing purposes it's very useful
 * to be able to run multiple instances. So long as the SSDP code uses a
 * different port to advertise for responses for each instance and as the router
 * instances are already specified to use whatever ports are available the
 * different instances should not run into each other.
 *
 * @public
 * @constructor
 * @fires event:wifiPeerAvailabilityChanged
 * @fires event:networkChangedWifi
 * @fires discoveryAdvertisingStateUpdateWifiEvent
 */
function ThaliWifiInfrastructure() {
  // Represent target states (the state after promise queue is completed)
  this._isStarted = false;
  this._isAdvertising = false;
  this._isListening = false;

  this._promiseQueue = new PromiseQueue();

  this._lastNetworkStatus = null;

  var advertiser = new WifiAdvertiser();
  var listener = new WifiListener();

  // make listener ignore advertiser's messages
  listener.setMessageFilter(function (data) {
    var ignorePeers = advertiser.getAdvertisedPeerIdentifiers();
    var peer = USN.tryParse(data.USN, null);
    return (peer !== null) && (ignorePeers.indexOf(peer.peerIdentifier) === -1);
  });

  this.advertiser = advertiser;
  this.listener = listener;

  this._setUpEvents();
}

ThaliWifiInfrastructure.prototype._setUpEvents = function() {
  var self = this;
  var states = { advertising: false, listening: false };

  // bind networkChanged listener
  this._networkChangedHandler = function (networkChangedValue) {
    this._handleNetworkChanges(networkChangedValue);
  }.bind(this);

  var emitStateUpdate = function () {
    self.emit('discoveryAdvertisingStateUpdateWifiEvent', {
      discoveryActive: states.listening,
      advertisingActive: states.advertising,
    });
  };
  self.advertiser.on('stateChange', function (newState) {
    states.advertising = newState.advertising;
    emitStateUpdate();
  });
  self.listener.on('stateChange', function (newState) {
    states.listening = newState.listening;
    emitStateUpdate();
  });

  self.listener.on('wifiPeerAvailabilityChanged', function (peer) {
    self.emit('wifiPeerAvailabilityChanged', peer);
  });
};

inherits(ThaliWifiInfrastructure, EventEmitter);

ThaliWifiInfrastructure.prototype._handleNetworkChanges =
function (networkStatus) {
  var isWifiUnchanged = this._lastNetworkStatus &&
      networkStatus.wifi === this._lastNetworkStatus.wifi;

  this._lastNetworkStatus = networkStatus;

  // If we are stopping or the wifi state hasn't changed,
  // we are not really interested.
  if (!this._isStarted || isWifiUnchanged) {
    return;
  }

  var actionResults = [];
  if (networkStatus.wifi === 'on') {
    // If the wifi state turned on, try to get into the target states
    if (this._isListening) {
      actionResults.push(
        muteRejection(this.startListeningForAdvertisements())
      );
    }
    if (this._isAdvertising) {
      actionResults.push(
        muteRejection(this.startUpdateAdvertisingAndListening())
      );
    }
  } else {
    // If wifi didn't turn on, it was turned into a state where we want
    // to stop our actions
    actionResults.push(
      muteRejection(
        this._pauseAdvertisingAndListening()
      ),
      muteRejection(
        this._pauseListeningForAdvertisements()
      )
    );
  }
  Promise.all(actionResults).then(function (results) {
    results.forEach(function (result) {
      if (result) {
        logger.warn('Error when reacting to wifi state changes: %s',
                    result.toString());
      }
    });
  });
};

ThaliWifiInfrastructure.prototype.getCurrentState = function () {
  return {
    started: this._isStarted,
    listening: this.listener.isListening(),
    advertising: this.advertiser.isAdvertising(),
  };
};

ThaliWifiInfrastructure.prototype.getTargetState = function () {
  return {
    started: this._isStarted,
    listening: this._isListening,
    advertising: this._isAdvertising,
  };
};

ThaliWifiInfrastructure.prototype.getCurrentPeer = function () {
  return this.advertiser.peer;
};

ThaliWifiInfrastructure.prototype.getSSDPServer = function () {
  return this.advertiser._server;
};

ThaliWifiInfrastructure.prototype.getSSDPClient = function () {
  return this.listener._client;
};

ThaliWifiInfrastructure.prototype.overrideAdvertisedPort = function (port) {
  this.wifi.advertisedPortOverride = port;
};

ThaliWifiInfrastructure.prototype.restoreAdvertisedPort = function () {
  this.wifi.advertisedPortOverride = null;
};

ThaliWifiInfrastructure.prototype.getOverridenAdvertisedPort = function () {
  return this.wifi.advertisedPortOverride;
};

/**
 * This method MUST be called before any other method here other than
 * registering for events on the emitter. This method only registers the router
 * object but otherwise doesn't really do anything. It's just here to mirror how
 * {@link module:thaliMobileNativeWrapper} works.
 *
 * If the start fails then the object is not in start state.
 *
 * This method is not idempotent (even though it could be). If called two
 * times in a row without an intervening stop a "Call Stop!" Error MUST be
 * returned.
 *
 * This method can be called after stop since this is a singleton object.
 *
 * @param {Object} router This is an Express Router object (for example,
 * express-pouchdb is a router object) that the caller wants the WiFi
 * connections to be terminated with. This code will put that router at '/' so
 * make sure your paths are set up appropriately.
 * @param {module:thaliMobileNativeWrapper~pskIdToSecret} pskIdToSecret
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.start = function (router, pskIdToSecret) {
  var self = this;
  thaliMobileNativeWrapper.emitter
    .on('networkChangedNonTCP', self._networkChangedHandler);

  if (this._isStarted) {
    return Promise.reject(new Error('Call Stop!'));
  }

  this._isStarted = true;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    thaliMobileNativeWrapper.getNonTCPNetworkStatus()
      .then(function (networkStatus) {
        if (!self._lastNetworkStatus) {
          self._lastNetworkStatus = networkStatus;
        }
        self._router = router;
        self._pskIdToSecret = pskIdToSecret;
      })
      .then(resolve, reject);
  });
};

/**
 * This method will call all the stop methods and stop the TCP server hosting
 * the router.
 *
 * Once called the object is in the stop state.
 *
 * This method is idempotent and so MUST be able to be called multiple timex
 * in a row without changing state.
 *
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.stop = function () {
  thaliMobileNativeWrapper.emitter
    .removeListener('networkChangedNonTCP', this._networkChangedHandler);
  this._lastNetworkStatus = null;

  if (!this._isStarted) {
    return Promise.resolve();
  }
  this._isStarted = false;
  this._isAdvertising = false;
  this._isListening = false;
  var self = this;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    Promise.all([
      self.advertiser.stop(),
      self.listener.stop()
    ]).then(resolve, reject);
  });
};

/**
 * This will start the local Wi-Fi Infrastructure Mode discovery mechanism
 * (currently SSDP). Calling this method will trigger {@link
 * event:wifiPeerAvailabilityChanged} to fire. This method only causes SSDP
 * queries to be fired and cause us to listen to other service's SSDP:alive and
 * SSDP:byebye messages. It doesn't advertise the service itself.
 *
 * If this method is called on the Android platform then the
 * {@link external:"Mobile('lockAndroidWifiMulticast')".callNative} method
 * MUST be called.
 *
 * This method is idempotent so multiple consecutive calls without an
 * intervening call to stop will not cause a state change.
 *
 * | Error String | Description |
 * |--------------|-------------|
 * | No Wifi radio | This device doesn't support Wifi |
 * | Radio Turned Off | Wifi is turned off. |
 * | Unspecified Error with Radio infrastructure | Something went wrong trying to use WiFi. Check the logs. |
 * | Call Start! | The object is not in start state. |
 *
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.startListeningForAdvertisements =
function () {
  var self = this;
  self._isListening = true;
  if (!self._isStarted) {
    return Promise.reject(new Error('Call Start!'));
  }
  return self._promiseQueue.enqueue(function (resolve, reject) {
    if (self._lastNetworkStatus && self._lastNetworkStatus.wifi === 'off') {
      self._rejectPerWifiState().then(resolve, reject);
      return;
    }
    self.listener.start().then(resolve, reject);
  });
};

/**
 * This will stop the local Wi-Fi Infrastructure Mode discovery mechanism
 * (currently SSDP). Calling this method will stop {@link
 * event:wifiPeerAvailabilityChanged} from firing. That is, we will not issue
 * any further SSDP queries nor will we listen for other service's SSDP:alive or
 * SSDP:byebye messages.
 *
 * If this method is called on the Android platform then the {@link
 * external:"Mobile('unlockAndroidWifiMulticast')".callNative} method MUST be
 * called.
 *
 * Note that this method does not affect any existing TCP connections. Not
 * that we could really do anything with them since they are handled directly by
 * Node, not us.
 *
 * | Error String | Description |
 * |--------------|-------------|
 * | Failed | Somehow the stop method couldn't do its job. Check the logs. |
 *
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.stopListeningForAdvertisements =
function () {
  this._isListening = false;

  var listener = this.listener;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    listener.stop().then(resolve, reject);
  });
};

ThaliWifiInfrastructure.prototype._pauseListeningForAdvertisements =
function () {
  var listener = this.listener;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    listener.stop().then(resolve, reject);
  });
};

/**
 * This method will start advertising the peer's presence over the local Wi-Fi
 * Infrastructure Mode discovery mechanism (currently SSDP). When creating the
 * UDP socket for SSDP the socket MUST be "udp4". When socket.bind is called to
 * bind the socket the SSDP multicast address 239.255.255.250 and port 1900 MUST
 * be chosen as they are the reserved address and port for SSDP.
 *
 * __OPEN ISSUE:__ What happens on Android or iOS or the desktop OS's for that
 * matter if multiple apps all try to bind to the same UDP multicast address?
 * It should be fine. But it's important to find out so that other apps can't
 * block us.
 *
 * Also note that the implementation of SSDP MUST recognize advertisements from
 * its own instance and ignore them. However it is possible to have multiple
 * independent instances of ThaliWiFiInfrastructure on the same device and we
 * MUST process advertisements from other instances of ThaliWifiInfrastructure
 * on the same device.
 *
 * This method will also cause the Express app passed in to be hosted in a HTTP
 * server configured with the device's local IP. In other words, the externally
 * available HTTP server is not actually started and made externally available
 * until this method is called. This is different than {@link
 * module:thaliMobileNative} where the server is started on 127.0.0.1 as soon as
 * {@link module:thaliMobileNativeWrapper.start} is called but isn't made
 * externally available over the non-TCP transport until the equivalent of this
 * method is called. If the device switches access points (e.g. the BSSID
 * changes) or if WiFi is lost then the server will be shut down. It is up to
 * the caller to catch the networkChanged event and to call start advertising
 * again.
 *
 * __OPEN ISSUE:__ If we have a properly configured multiple AP network then
 * all the APs will have different BSSID values but identical SSID values and
 * the device should be able to keep the same IP. In that case do we want to
 * specify that if the BSSID changes but the SSID does not then we shouldn't
 * shut down the server?
 *
 * Each time this method is called it will cause the local advertisement to
 * change just enough to notify other peers that this peer has new data to
 * retrieve. No details will be provided about the peer on who the changes are
 * for. All that is provided is a flag just indicating that something has
 * changed. It is up to other peer to connect and retrieve details on what has
 * changed if they are interested. The way this flag MUST be implemented is by
 * creating a UUID the first time startUpdateAdvertisingAndListening is called
 * and maintaining that UUID until stopAdvertisingAndListening is called. When
 * the UUID is created a generation counter MUST be set to 0. Every subsequent
 * call to startUpdateAdvertisingAndListening until the counter is reset MUST
 * increment the counter by 1. The USN set by a call to
 * startUpdateAdvertisingAndListening MUST be of the form `data:` + uuid.v4() +
 * `:` + generation.
 *
 * By design this method is intended to be called multiple times without
 * calling stop as each call causes the currently notification flag to change.
 *
 * | Error String | Description |
 * |--------------|-------------|
 * | Bad Router | router is null or otherwise wasn't accepted by Express |
 * | No Wifi radio | This device doesn't support Wifi |
 * | Radio Turned Off | Wifi is turned off. |
 * | Unspecified Error with Radio infrastructure | Something went wrong trying to use WiFi. Check the logs. |
 * | Call Start! | The object is not in start state. |
 *
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.startUpdateAdvertisingAndListening =
function () {
  var self = this;
  var advertiser = self.advertiser;

  if (!self._isStarted) {
    return Promise.reject(new Error('Call Start!'));
  }

  self._isAdvertising = true;

  return self._promiseQueue.enqueue(function (resolve, reject) {
    if (self._lastNetworkStatus && self._lastNetworkStatus.wifi === 'off') {
      self._rejectPerWifiState().then(resolve, reject);
      return;
    }
    var promise = advertiser.isStarted() ?
      Promise.resolve() :
      advertiser.start(self._router, self._pskIdToSecret);

    promise.then(function () {
      return advertiser.update();
    }).then(resolve, reject);
  });
};

/**
 * This method MUST stop advertising the peer's presence over the local Wi-Fi
 * Infrastructure Mode discovery mechanism (currently SSDP). This method MUST
 * also stop the HTTP server started by the start method.
 *
 * So long as the device isn't advertising the peer and the server is stopped
 * (even if the system was always in that state) then this method MUST succeed.
 *
 * | Error String | Description |
 * |--------------|-------------|
 * | Failed | Somehow the stop method couldn't do its job. Check the logs. |
 *
 * @returns {Promise<?Error>}
 */
ThaliWifiInfrastructure.prototype.stopAdvertisingAndListening = function () {
  this._isAdvertising = false;

  var advertiser = this.advertiser;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    advertiser.stop().then(resolve, reject);
  });
};

ThaliWifiInfrastructure.prototype._pauseAdvertisingAndListening = function () {
  var advertiser = this.advertiser;
  return this._promiseQueue.enqueue(function (resolve, reject) {
    advertiser.stop().then(resolve, reject);
  });
};


ThaliWifiInfrastructure.prototype._rejectPerWifiState = function () {
  var errorMessage;
  switch (this._lastNetworkStatus.wifi) {
    case 'off': {
      errorMessage = 'Radio Turned Off';
      break;
    }
    case 'notHere': {
      errorMessage = 'No Wifi radio';
      break;
    }
    default: {
      logger.warn('Got unexpected Wifi state: %s',
        this.states.networkStatus.wifi);
      errorMessage = 'Unspecified Error with Radio infrastructure';
    }
  }
  return Promise.reject(new Error(errorMessage));
};

ThaliWifiInfrastructure.prototype.getNetworkStatus = function () {
  return thaliMobileNativeWrapper.getNonTCPNetworkStatus();
};

module.exports = ThaliWifiInfrastructure;
