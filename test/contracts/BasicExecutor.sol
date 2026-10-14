// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Basic} from "upstream/core/Basic.sol";
import {IERC20} from "@forge-std/interfaces/IERC20.sol";

/// @dev Tests the upstream BASIC action with ordinary funding and final settlement.
/// This wrapper is not a substitute for the chain's complete 0x Settler deployment.
contract BasicExecutor is Basic {
    bytes4 private constant BASIC = bytes4(keccak256("BASIC(address,uint256,address,uint256,bytes)"));

    function execute(address input, uint256 amount, bytes[] calldata actions,
        address output, uint256 minimum, address recipient) external
    {
        uint256 beforeOutput = IERC20(output).balanceOf(address(this));
        require(IERC20(input).transferFrom(msg.sender, address(this), amount), "funding");
        for (uint256 i; i < actions.length; ++i) {
            require(bytes4(actions[i][:4]) == BASIC, "action");
            (address token, uint256 ppm, address pool, uint256 offset, bytes memory data) =
                abi.decode(actions[i][4:], (address, uint256, address, uint256, bytes));
            basicSellToPool(IERC20(token), ppm, pool, offset, data);
        }
        uint256 received = IERC20(output).balanceOf(address(this)) - beforeOutput;
        require(received >= minimum, "final slippage");
        require(IERC20(output).transfer(recipient, received), "recipient");
        require(IERC20(input).balanceOf(address(this)) == 0, "unspent input");
    }
}
