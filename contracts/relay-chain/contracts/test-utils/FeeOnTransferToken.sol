// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only ERC-20 that burns a fixed percentage fee on every transfer,
///         so recipients receive less than the nominal amount. Mints and burns
///         are fee-free. Used to exercise balance-diff accounting in resolvers.
contract FeeOnTransferToken is ERC20 {
  /// @notice Fee taken on each transfer, in basis points
  uint256 public immutable FEE_BPS;

  constructor(uint256 feeBps) ERC20("FeeOnTransferToken", "FOT") {
    FEE_BPS = feeBps;
  }

  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }

  function _update(address from, address to, uint256 value) internal override {
    // Only charge on real transfers, never on mint (from == 0) or burn (to == 0)
    if (from != address(0) && to != address(0)) {
      uint256 fee = (value * FEE_BPS) / 10_000;
      super._update(from, to, value - fee);
      if (fee != 0) {
        super._update(from, address(0), fee);
      }
    } else {
      super._update(from, to, value);
    }
  }
}
