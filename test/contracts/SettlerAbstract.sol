// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// Test-only base for the unmodified upstream BASIC action. Production Permit2,
// meta-transaction and chain deployment logic is deliberately not simulated here.
abstract contract SettlerAbstract {
    function _isRestrictedTarget(address) internal pure virtual returns (bool) { return false; }
}
