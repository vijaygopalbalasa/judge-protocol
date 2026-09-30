// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice Stands in for erc-8004-contracts' MinimalUUPS, the placeholder implementation their proxies start on:
///         initializer version 1 sets the owner, who then upgrades to the real registry and calls its
///         `reinitializer(2)` initialize. (MinimalUUPS itself calls __UUPSUpgradeable_init, which OpenZeppelin
///         removed after 5.4, so it does not compile against this repo's 5.7.)
contract Erc8004Placeholder is OwnableUpgradeable, UUPSUpgradeable {
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) public initializer {
        __Ownable_init(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
