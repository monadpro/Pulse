// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PulseExchange, IERC20} from "../src/PulseExchange.sol";
import {MockToken} from "../src/MockToken.sol";
import {SimpleAMM} from "../src/SimpleAMM.sol";
import {AttackLab} from "../src/AttackLab.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --account monad-deployer --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the broadcasting account
        MockToken base = new MockToken("Pulse Base", "pMON");
        MockToken quote = new MockToken("Pulse USD", "pUSD");
        PulseExchange ex = new PulseExchange(IERC20(address(base)), IERC20(address(quote)));

        // Attack-comparison demo: an AMM seeded at price 1.00 and a lab contract that holds inventory.
        SimpleAMM amm = new SimpleAMM(IERC20(address(base)), IERC20(address(quote)));
        AttackLab lab = new AttackLab(IERC20(address(base)), IERC20(address(quote)), amm, ex);
        base.mint(deployer, 100_000 ether);
        quote.mint(deployer, 100_000 ether);
        base.approve(address(amm), type(uint256).max);
        quote.approve(address(amm), type(uint256).max);
        amm.addLiquidity(20_000 ether, 20_000 ether);
        base.mint(address(lab), 50_000 ether);
        quote.mint(address(lab), 50_000 ether);
        vm.stopBroadcast();

        console.log("base    ", address(base));
        console.log("quote   ", address(quote));
        console.log("exchange", address(ex));
        console.log("amm     ", address(amm));
        console.log("lab     ", address(lab));

        string memory j = "d";
        vm.serializeAddress(j, "base", address(base));
        vm.serializeAddress(j, "quote", address(quote));
        vm.serializeAddress(j, "amm", address(amm));
        vm.serializeAddress(j, "lab", address(lab));
        string memory out = vm.serializeAddress(j, "exchange", address(ex));
        vm.writeJson(out, "./web/src/deployments.json");
    }
}
