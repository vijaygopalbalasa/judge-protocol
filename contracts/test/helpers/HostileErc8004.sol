// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A reputation registry that refuses every write.
contract RevertingReputation {
    fallback() external {
        revert("no");
    }
}

/// @notice A reputation registry that burns all the gas it is given.
contract GasBurningReputation {
    fallback() external {
        while (true) {}
    }
}

/// @notice An identity registry whose raw answer to every call is set by the test: honest-looking first, then
///         anything (garbage words, short answers, a megabyte of data).
contract SwitchableIdentity {
    bytes public answer;
    bool public reverts;

    function setAnswer(bytes calldata a) external {
        answer = a;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        if (reverts) revert("down");
        return answer;
    }
}

/// @notice An identity registry that answers honestly but slowly: every call burns `burn` gas before returning the
///         configured answer (and fails if it is given less).
contract SlowIdentity {
    bytes public answer;
    uint256 public burn;

    function set(bytes calldata a, uint256 b) external {
        answer = a;
        burn = b;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        uint256 start = gasleft();
        uint256 target = start > burn ? start - burn : 0;
        while (gasleft() > target) {}
        return answer;
    }
}
