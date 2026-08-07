// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import "../src/JudgeEvaluator.sol";
import "../src/JudgeReputationHook.sol";
import "../src/mocks/MockACP.sol";
import "../src/mocks/MockUSDC.sol";

contract DeployLocal is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        MockACP acp = new MockACP(address(usdc));
        address deployer = msg.sender;
        address[] memory signers = new address[](1);
        signers[0] = deployer;
        JudgeEvaluator judge = new JudgeEvaluator(address(acp), deployer, signers);
        JudgeReputationHook hook = new JudgeReputationHook(address(acp), address(0));
        console2.log("USDC:", address(usdc));
        console2.log("ACP:", address(acp));
        console2.log("JUDGE:", address(judge));
        console2.log("HOOK:", address(hook));
        console2.log("DEPLOYER:", deployer);
        vm.stopBroadcast();
    }
}
