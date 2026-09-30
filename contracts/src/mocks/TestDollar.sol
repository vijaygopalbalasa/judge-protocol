// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A stand-in dollar for demo escrows on test networks. It has no value and anyone can mint it; the name
///         says so, so it is never mistaken for USDC. Six decimals, like USDC.
contract TestDollar is ERC20 {
    constructor() ERC20("Judge Test Dollar (no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
