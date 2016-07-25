/*
 * This file needs to be renamed as app.js when we want to run unit tests
 * in order this to get loaded by the jxcore ready event.
 * This effectively acts as main entry point to the unit test app
 */

'use strict';

if (typeof Mobile === 'undefined') {
  global.Mobile = require('./lib/wifiBasedNativeMock.js')();
}

var testUtils = require('./lib/testUtils');
var ThaliMobile = require('thali/NextGeneration/thaliMobile');
var Promise = require('lie');
var isUTExecuted = false;

Mobile('ExecuteNativeTests').callNative(function (result) {
  isUTExecuted = true;
  if (result && result.executed) {
    console.log(result.executed);
    console.log("Total number of executed tests: ", result.total);
    console.log("Number of passed tests: ", result.passed);
    console.log("Number of failed tests: ", result.failed);
    console.log("Number of ignored tests: ", result.ignored);
    console.log("Total duration: ", result.duration);
    console.log('****TEST_LOGGER:[PROCESS_ON_EXIT_SUCCESS]****');
  } else {
    console.log("No UT executed.");
    console.log('****TEST_LOGGER:[PROCESS_ON_EXIT_FAILED]****');
  }
});

// Temporary solution for iOS devices.
if (!isUTExecuted) {
  console.log("No UT executed.");
  console.log('****TEST_LOGGER:[PROCESS_ON_EXIT_FAILED]****');
}

ThaliMobile.getNetworkStatus()
.then(function (networkStatus) {
  var promiseList = [];
  if (networkStatus.wifi === 'off') {
    promiseList.push(testUtils.toggleWifi(true));
  }
  if (networkStatus.bluetooth === 'off') {
    promiseList.push(testUtils.toggleBluetooth(true));
  }
  Promise.all(promiseList)
  .then(function () {
    Mobile('GetDeviceName').callNative(function (name) {
      console.log('My device name is: %s', name);
      testUtils.setName(name);
      // The setImmediate is to avoid this issue:
      // https://github.com/thaliproject/Thali_CordovaPlugin/issues/563
      setImmediate(function () {
        require('./runTests.js');
      });
    });
  });
});

console.log('Unit Test app is loaded');
