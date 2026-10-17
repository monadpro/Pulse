// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PulseExchange, IERC20} from "../src/PulseExchange.sol";
import {MockToken} from "../src/MockToken.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --account monad-deployer --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        MockToken base = new MockToken("Pulse Base", "pMON");
        MockToken quote = new MockToken("Pulse USD", "pUSD");
        PulseExchange ex = new PulseExchange(IERC20(address(base)), IERC20(address(quote)));
        vm.stopBroadcast();

        console.log("base    ", address(base));
        console.log("quote   ", address(quote));
        console.log("exchange", address(ex));

        string memory j = "d";
        vm.serializeAddress(j, "base", address(base));
        vm.serializeAddress(j, "quote", address(quote));
        string memory out = vm.serializeAddress(j, "exchange", address(ex));
        vm.writeJson(out, "./web/src/deployments.json");
    }
}
