// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/// @notice Existing deployed interface; buy/sell output goes to msg.sender.
interface IOxleyCurve {
    function quoteBuy(bytes32 marketId, uint256 amountIn, address caller)
        external view returns (uint256 amountOut, uint256 feeAmount);
    function quoteSell(bytes32 marketId, uint256 amountIn, address caller)
        external view returns (uint256 amountOut, uint256 collateralOut, uint256 feeAmount);
    function buy(bytes32 marketId, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        external returns (uint256 amountOut);
    function sell(bytes32 marketId, uint256 amountIn, uint256 minAmountOut,
        uint256 minimumCollateralOut, uint256 deadline)
        external returns (uint256 amountOut, uint256 collateralOut);
}
