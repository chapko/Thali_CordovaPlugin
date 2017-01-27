'use strict';

// Issue #419
var ThaliMobile = require('thali/NextGeneration/thaliMobile');
if (global.NETWORK_TYPE === ThaliMobile.networkTypes.NATIVE) {
  return;
}

var https = require('https');
var net = require('net');

var nodessdp = require('node-ssdp');
var express = require('express');
var uuid = require('uuid');
var sinon = require('sinon');
var randomstring = require('randomstring');
var Promise = require('bluebird');
var objectAssign = require('object-assign');

var platform = require('thali/NextGeneration/utils/platform');
var WifiListener = require('thali/NextGeneration/transport/wifi/WifiListener');
var ThaliMobileNativeWrapper = require('thali/NextGeneration/thaliMobileNativeWrapper');
var thaliConfig = require('thali/NextGeneration/thaliConfig');
var tape = require('../lib/thaliTape');
var testUtils = require('../lib/testUtils.js');
var USN = require('thali/NextGeneration/utils/usn');

var wifiListener = null;
var testSSDPServer = null;

var test = tape({
  setup: function (t) {
    t.end();
  },
  teardown: function (t) {
    // Stop everything at the end of tests to make sure
    // the next test starts from clean state
    var results = [];
    if (wifiListener) {
      var stopListener = Promise.resolve(wifiListener.stop())
        .then(function () {
          if (wifiListener.isListening()) {
            return Promise.reject(new Error('Listener not stopped'));
          }
          wifiListener = null;
        });
      results.push(stopListener);
    }
    if (testSSDPServer) {
      var stopSSDPServer = new Promise(function (resolve) {
        // it is safe to stop ssdp server even when it is stopped. And it never
        // calls callback with error
        testSSDPServer.stop(resolve);
        testSSDPServer = null;
      });
      results.push(stopSSDPServer);
    }
    Promise.all(results).asCallback(t.end);
  }
});

var testSeverHostAddress = randomstring.generate({
  charset: 'hex', // to get lowercase chars for the host address
  length: 8
});
var testServerPort = 8080;

function createTestSSDPServer (peerIdentifier) {
  var testLocation = 'http://' + testSeverHostAddress + ':' + testServerPort;
  var testServer = new nodessdp.Server({
    location: testLocation,
    ssdpIp: thaliConfig.SSDP_IP,
    udn: thaliConfig.SSDP_NT,
    adInterval: thaliConfig.SSDP_ADVERTISEMENT_INTERVAL
  });
  var usn = USN.stringify({
    peerIdentifier: peerIdentifier,
    generation: 0
  });
  testServer.setUSN(usn);
  return testServer;
}


test('after #start call listens to SSDP ' +
'advertisements and emit wifiPeerAvailabilityChanged events', function (t) {
  var peerIdentifier = uuid.v4();

  var peerUnavailableListener = function (peer) {
    if (peer.peerIdentifier !== peerIdentifier) {
      return;
    }
    t.equal(peer.generation, 0, 'generation should be 0');
    t.equal(peer.hostAddress, null, 'host address should be null');
    t.equal(peer.portNumber, null, 'port should should be null');
    wifiListener.removeListener(
      'wifiPeerAvailabilityChanged',
      peerUnavailableListener
    );
    t.end();
  };

  var peerAvailableListener = function (peer) {
    if (peer.hostAddress !== testSeverHostAddress) {
      return;
    }
    t.equal(peer.peerIdentifier, peerIdentifier,
      'peer identifier should match');
    t.equal(peer.generation, 0, 'generation should be 0');
    t.equal(peer.hostAddress, testSeverHostAddress,
      'host address should match');
    t.equal(peer.portNumber, testServerPort, 'port should match');
    wifiListener.removeListener('wifiPeerAvailabilityChanged',
      peerAvailableListener);

    wifiListener.on('wifiPeerAvailabilityChanged',
      peerUnavailableListener);
    testSSDPServer.stop(function () {
      // When server is stopped, it shold trigger the byebye messages
      // that emit the wifiPeerAvailabilityChanged that we listen above.
    });
  };

  testSSDPServer = createTestSSDPServer(peerIdentifier);
  wifiListener = new WifiListener();
  wifiListener.on('wifiPeerAvailabilityChanged', peerAvailableListener);

  testSSDPServer.start(function () {
    wifiListener.start().catch(function (error) {
      t.fail('failed to start listening with error: ' + error);
      t.end();
    });
  });
});

test('ignores invalid or unrecognized ssdp messages', function (t) {
  var peerIdentifier = uuid.v4();
  var generation = 12;
  var validUsn = USN.stringify({
    peerIdentifier: peerIdentifier,
    generation: generation
  });
  var validMessage = {
    NT: thaliConfig.SSDP_NT,
    USN: validUsn,
    LOCATION: 'https://example.com:9999'
  };
  var invalidNtMessage = objectAssign({}, validMessage, {
    NT: thaliConfig.SSDP_NT + 'hehe'
  });
  var invalidUsnMessage = objectAssign({}, validMessage, {
    USN: 'hehe'
  });
  var invalidLocationMessage = objectAssign({}, validMessage, {
    LOCATION: 'http://example.com:900000'
  });

  wifiListener = new WifiListener();
  var emitSpy = sinon.spy(wifiListener, 'emit');

  wifiListener._handleMessage(invalidNtMessage, true);
  wifiListener._handleMessage(invalidUsnMessage, true);
  wifiListener._handleMessage(invalidLocationMessage, true);

  t.equals(emitSpy.callCount, 0, 'listener did not emit any events');

  wifiListener._handleMessage(invalidLocationMessage, false);
  wifiListener._handleMessage(validMessage, true);

  t.equals(emitSpy.callCount, 2, 'listener emitted two events');
  // location ignored in bye-bye message
  t.deepEqual(emitSpy.firstCall.args, [
    'wifiPeerAvailabilityChanged',
    {
      peerIdentifier: peerIdentifier,
      generation: generation,
      hostAddress: null,
      portNumber: null
    }
  ], 'first event is correct');
  t.deepEqual(emitSpy.secondCall.args, [
    'wifiPeerAvailabilityChanged',
    {
      peerIdentifier: peerIdentifier,
      generation: generation,
      hostAddress: 'example.com',
      portNumber: 9999,
    }
  ], 'second event is correct');

  emitSpy.restore();
  t.end();
});

test('invokes custom filter with ssdp message and ', function (t) {
  var peerIdentifier = uuid.v4();
  var generation = 12;
  var validUsn = USN.stringify({
    peerIdentifier: peerIdentifier,
    generation: generation
  });
  var validMessage = {
    NT: thaliConfig.SSDP_NT,
    USN: validUsn,
    LOCATION: 'https://example.com:9999'
  };
  var filteredMessage = objectAssign({}, validMessage, {
    SERVER: 'malicious-server/1.0.0'
  });

  var filterMock = sinon.mock();
  filterMock.

  wifiListener = new WifiListener();
  wifiListener.set
  var emitSpy = sinon.spy(wifiListener, 'emit');

  wifiListener._handleMessage(validMessage, true);
  wifiListener._handleMessage(filteredMessage, true);


  t.end();
});

test('filters messages with custom filter', function (t) {
  var peerIdentifier = uuid.v4();
  var generation = 12;
  var validUsn = USN.stringify({
    peerIdentifier: peerIdentifier,
    generation: generation
  });
  var validMessage = {
    NT: thaliConfig.SSDP_NT,
    USN: validUsn,
    LOCATION: 'https://example.com:9999'
  };
  var filteredMessage = objectAssign({}, validMessage, {
    SERVER: 'malicious-server/1.0.0'
  });

  var filterMock = sinon.mock();
  filterMock.

  wifiListener = new WifiListener();
  wifiListener.set
  var emitSpy = sinon.spy(wifiListener, 'emit');

  wifiListener._handleMessage(validMessage, true);
  wifiListener._handleMessage(filteredMessage, true);


  t.end();
});
