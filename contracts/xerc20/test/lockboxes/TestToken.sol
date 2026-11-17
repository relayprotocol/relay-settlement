// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

contract TestToken is ERC20 {
  uint8 private immutable precision;

  constructor(
    uint8 d
  ) ERC20('Test asset', 'TEST') {
    precision = d;
  }

  function decimals() public view override returns (uint8) {
    return precision;
  }

  function mint(
    address to,
    uint256 amount
  ) external {
    _mint(to, amount);
  }
}
