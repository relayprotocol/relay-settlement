pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// SPDX-License-Identifier: MIT
contract MyToken is ERC20 {
  constructor() ERC20("MyToken", "TOK") {
    _mint(msg.sender, 1_000_000_000 * 10 ** decimals());
  }
}
