//
//  Thali CordovaPlugin
//  AppContextTests.swift
//
//  Copyright (C) Microsoft. All rights reserved.
//  Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.
//

import XCTest

class AppContextDelegateMock: NSObject, AppContextDelegate {
    var networkStatusUpdated = false
    var discoveryUpdated = false
    @objc func context(context: AppContext, didChangePeerAvailability peers: String) {}
    @objc func context(context: AppContext, didChangeNetworkStatus status: String) {
        networkStatusUpdated = true
    }
    @objc func context(context: AppContext, didUpdateDiscoveryAdvertisingState
        discoveryAdvertisingState: String) {
        discoveryUpdated = true
    }
    @objc func context(context: AppContext, didFailIncomingConnectionToPort port: UInt16) {}
    @objc func appWillEnterBackground(withContext context: AppContext) {}
    @objc func appDidEnterForeground(withContext context: AppContext) {}
}

class AppContextTests: XCTestCase {
    var context: AppContext! = nil

    override func setUp() {
        context = AppContext(serviceType: "thaliTest")
    }

    override func tearDown() {
        context = nil
    }

    func testUpdateNetworkStatus() {
        let delegateMock = AppContextDelegateMock()
        context.delegate = delegateMock
        let _ = try? context.didRegisterToNative([AppContextJSEvent.networkChanged, NSNull()])
        XCTAssertTrue(delegateMock.networkStatusUpdated, "network status is not updated")
    }

    func testDidRegisterToNative() {
        var error: ErrorType?
        do {
            try context.didRegisterToNative(["test", "test"])
        } catch let err {
            error = err
        }
        XCTAssertNil(error)
        var contextError: AppContextError?
        do {
            try context.didRegisterToNative(["test"])
        } catch let err as AppContextError{
            contextError = err
        } catch _ {
        }
        XCTAssertEqual(contextError, .BadParameters)
    }

    func testGetIOSVersion() {
        XCTAssertEqual(NSProcessInfo().operatingSystemVersionString, context.getIOSVersion())
    }
    
    func testListeningAdvertisingUpdateOnStartAdvertising() {
        let delegateMock = AppContextDelegateMock()
        context.delegate = delegateMock
        let _ = try? context.startUpdateAdvertisingAndListening(withParameters: [42])
        XCTAssertTrue(delegateMock.discoveryUpdated, "network status is not updated")
    }
    
    func testListeningAdvertisingUpdateOnStartListening() {
        let delegateMock = AppContextDelegateMock()
        context.delegate = delegateMock
        let _ = try? context.startListeningForAdvertisements()
        XCTAssertTrue(delegateMock.discoveryUpdated, "network status is not updated")
    }
}
