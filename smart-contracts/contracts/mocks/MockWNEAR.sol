// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract MockWNEAR is ERC20, ERC20Permit {
  constructor() ERC20("Wrapped NEAR", "wNEAR") ERC20Permit("MyToken") {
    _mint(msg.sender, 1_000_000_000 * 10 ** decimals());
  }

  function mint(uint256 amount) external {
    _mint(msg.sender, amount);
  }

  function withdrawToNear(bytes memory /*recipient*/, uint256 amount) external {
    _burn(_msgSender(), amount);
  }
}
