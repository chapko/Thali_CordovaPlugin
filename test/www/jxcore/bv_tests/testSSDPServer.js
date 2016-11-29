'use strict';

var tape      = require('../lib/thaliTape');
var testUtils = require('../lib/testUtils.js');

var Promise = require('bluebird');
var sinon   = require('sinon');
var express = require('express');

var ThaliMobile              = require('thali/NextGeneration/thaliMobile');
var ThaliMobileNativeWrapper = require('thali/NextGeneration/thaliMobileNativeWrapper');
var ThaliWifiInfrastructure  = require('thali/NextGeneration/thaliWifiInfrastructure');


var test = tape({
  setup: function (t) {
    t.end();
  },
  teardown: function (t) {
    t.end();
  }
});

test(
  'ssdp server should be restarted when wifi toggled',
  function () {
    return global.NETWORK_TYPE !== ThaliMobile.networkTypes.WIFI;
  },
  function (t) {
    var pskId  = 'I am an id';
    var pskKey = new Buffer('I am a secret');

    function pskIdToSecret (id) {
      return id === pskId ? pskKey : null;
    };

    function toggleWifi(value) {
      ThaliMobileNativeWrapper.emitter.emit('networkChangedNonTCP', {
        wifi:               value? 'on' : 'off',
        bluetooth:          'on',
        bluetoothLowEnergy: 'on',
        cellular:           'on'
      });
    }

    var wifiInfrastructure = new ThaliWifiInfrastructure();
    var serverStartSpy = sinon.spy(wifiInfrastructure._server, 'start');
    var serverStopSpy  = sinon.spy(wifiInfrastructure._server, 'stop');

    wifiInfrastructure.start(express.Router(), pskIdToSecret)
      .then(function () {
        t.ok(wifiInfrastructure.states.started, 'should be in started state');
      })
      .then(function () {
        return wifiInfrastructure.startUpdateAdvertisingAndListening();
      })
      .then(function () {
        t.ok(serverStartSpy.calledOnce, 'server start should be called once');
        t.ok(!serverStopSpy.called,     'server stop should not be called');

        return new Promise(function (resolve) {
          toggleWifi(false);
          setTimeout(function () {
            toggleWifi(true);
            setTimeout(resolve, 100);
          }, 100);
        });
      })
      .then(function () {
        t.ok(serverStartSpy.calledTwice, 'server start should be called twice');
        t.ok(serverStopSpy.calledOnce,   'server stop should be called once');

        return wifiInfrastructure.stop();
      })
      .then(function () {
        t.ok(serverStopSpy.calledTwice, 'server stop should be called twice');
        t.ok(!wifiInfrastructure.states.started, 'should not be in started state');
        t.end();
      });
  }
);
