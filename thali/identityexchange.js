/* jshint node: true */
'use strict';

var http = require('http');
var crypto = require('crypto');
var request = require('request');

global.isInIdentityExchange = false;

module.exports = function identityExchange (app, replicationManager) {

  var
    pkMineBuffer,         // My private key hash
    pkOtherBuffer,        // Other private key hash
    rnMine,               // My random bytes
    exchangeCb,           // Callback for if my hash is larger
    originalDeviceHash,   // Original device hash before changing it for identity exchange
    newDeviceHash,        // New device hash after the change for identity exchange
    localPeerIdentifier,  // Peer identifier for remote device
    cbValue;              // Cb value used for identity exchange

  function resetState() {
    pkMineBuffer = null;
    pkOtherBuffer = null;
    rnMine = null;
    exchangeCb = null;
    localPeerIdentifier = null;
    cbValue = null;
  }

  replicationManager._emitter.on('peerAvailabilityChanged', function (peers) {
    peers.forEach(function (peer) {
      if (peer.peerName.indexOf(';') !== -1 && peer.peerAvailable) {
        var split = peer.peerName.split(';');
        peer.peerFriendlyName = split[1];
        peer.peerName = split[0];

        replicationManager.emit('peerIdentityExchange', peer);
      }
    });
  });

  function startIdentityExchange(myFriendlyName, cb) {
    if (global.isInIdentityExchange) {
      return cb(new Error('Already in identity exchange'));
    }

    global.isInIdentityExchange = true;

    replicationManager.getDeviceIdentity(function (err, deviceName) {
      if (err) { return cb(err); }

      originalDeviceHash = deviceName;
      newDeviceHash = deviceName + ';' + myFriendlyName;

      replicationManager.once('stopped', function () {

        replicationManager.once('started', function () {
          cb(null, newDeviceHash);
        });

        replicationManager.once('startError', cb);
        replicationManager.start(
          replicationManager._port,
          replicationManager._dbName,
          newDeviceHash);
      });

      replicationManager.once('stopError', cb);
      replicationManager.stop();
    });
  }

  function stopIdentityExchange(cb) {
    global.isInIdentityExchange = false;

    replicationManager.once('stopped', function () {

      replicationManager.once('started', function () {
        cb(null, originalDeviceHash);
      });

      replicationManager.once('startError', cb);
      replicationManager.start(
        replicationManager._port,
        replicationManager._dbName,
        originalDeviceHash);
    });

    replicationManager.once('stopError', cb);
    replicationManager.stop();
  }

  function executeIdentityExchange(peerIdentifier, pkOther, pkMine, cb) {
    if (!global.isInIdentityExchange) {
      return cb(new Error('Identity Exchange not started'));
    }

    localPeerIdentifier = peerIdentifier;
    pkMineBuffer = new Buffer(pkMine);
    pkOtherBuffer = new Buffer(pkOther);

    rnMine = crypto.randomBytes(32);

    replicationManager._emitter.connect(peerIdentifier, function (err, port) {
      if (err) {
        return cleanupStopIdentityExchange(function () {
          cb(err);
          resetState();
        });
      }

      var compared = pkMineBuffer.compare(pkOtherBuffer);

      if (compared < 0) {
        // My hash is smaller
        var concatHash = Buffer.concat([pkMineBuffer, pkOtherBuffer]);
        var cbHash = crypto.createHmac('sha256', rnMine);
        var cbBuffer = cbHash.update(concatHash);
        var cbValue = cbBuffer.toString('base64');

        var rnOtherReq = request.post({
          url: 'http://localhost:' + port + '/identity/cb',
          body: {
            cbValue: cbValue,
            pkMine: pkMine
          }
        });

        rnOtherReq.once('response', function (response) {
          if (response.status !== 200) {
            return cleanupIdentityExchange(function () {
              cb(new Error('Invalid exchange'));
              resetState();
            });
          }

          var rnOther = new Buffer(response.body.rnOther);
          var pkO = new Buffer(response.body.pkOther);

          if (!pkO.equals(pkOtherBuffer)) {
            return cleanupIdentityExchange(function () {
              cb(new Error('Invalid exchange'));
              resetState();
            });
          }

          var rnMineReq = request.post({
            url: 'http://localhost:' + port + '/identity/rnmine',
            body: {
              rnMine: rnMine.toString('base64'),
              pkMine: pkMine
            }
          });

          rnMineReq.once('response', function (response) {
            if (response.status !== 200) {
              return cleanupIdentityExchange(function () {
                cb(new Error('Invalid exchange'));
                resetState();
              });
            }

            var value = createIdentityExchangeValue(rnOther, Buffer.concat([pkOtherBuffer, pkMineBuffer, rnMine]));
            disconnectExchange(function () {
              cb(null, value);
              resetState();
            });
          });
        });
      } else if (compared > 0) {
        // My hash is bigger and rest is done in cb express endpoint
        exchangeCb = cb;
      } else {
        cb(new Error('Hashes cannot be equal'));
      }
    });
  }

  app.post('/identity/cb', function (req, res) {
    if (!global.isInIdentityExchange) { return res.sendStatus(400); }

    if (!req.body) { return res.sendStatus(400); }
    if (typeof req.body.cbValue !== 'string' || req.body.cbValue.length === 0) {
      return res.sendStatus(400);
    }
    if (typeof req.body.pkMine !== 'string' || req.body.pkMine.length === 0) {
      return res.sendStatus(400);
    }

    cbValue = new Buffer(req.body.cbValue);
    var buf = new Buffer(req.body.pkMine);
    if (!buf.equals(pkOtherBuffer)) { return res.sendStatus(400); }

    res.sendStatus(200).json({
      pkOther: pkMineBuffer.toString('base64'),
      rnOther: rnMine.toString('base64')
    });
  });

  app.post('/identity/rnmine', function (req, res) {
    if (!global.isInIdentityExchange) { return res.sendStatus(400); }

    if (!req.body) { return res.sendStatus(400); }
    if (typeof req.body.pkMine !== 'string' || req.body.pkMine.length === 0) {
      return res.sendStatus(400);
    }
    if (typeof req.body.rnMine !== 'string' || req.body.rnMine.length !== 44) {
      return res.sendStatus(400);
    }

    // Test if we're under attack
    var testBuff = new Buffer(req.body.pkMine);
    if (!testBuff.equals(pkOtherBuffer)) { return res.sendStatus(400); }

    var rnOther = new Buffer(req.body.rnMine);
    var newBuff = Buffer.concat([pkOtherBuffer, pkMineBuffer]);
    var hmac = crypto.createHmac('sha256', rnOther);
    hmac.update(newBuff);
    var ret = hmac.digest();

    // No match
    if (!ret.equals(cbValue)) { return res.sendStatus(400); }

    res.sendStatus(200);

    var value = createIdentityExchangeValue(rnMine, Buffer.concat([pkMineBuffer, pkOtherBuffer, rnOther]));
    cleanupIdentityExchange(function () {
      exchangeCb(null, value);
      resetState();
    });
  });

  /* Create identity exchange value */
  function createIdentityExchangeValue(key, buffer) {
    var hmac = crypto.createHmac('sha256', key);
    hmac.update(buffer);
    return parseInt(hmac.digest().toString('hex'), 16) % Math.pow(10, 6);
  }

  /* Cleanup functions */
  function cleanupIdentityExchange(cb) {
    disconnectExchange(function () {
      cleanupStopIdentityExchange(function (cb) {
        cb();
      });
    });
  }

  function cleanupStopIdentityExchange(cb) {
    stopIdentityExchange(function (innerError) {
      console.log('Stop Identity Exchange Error %s', innerError);
      cb();
    });
  }

  function disconnectExchange(cb) {
    replicationManager._emitter.disconnect(localPeerIdentifier, function (err) {
      console.log('Disconnect error %s', err);
      cb();
    });
  }

  return {
    startIdentityExchange: startIdentityExchange,
    executeIdentityExchange: executeIdentityExchange,
    stopIdentityExchange: stopIdentityExchange
  };
};
