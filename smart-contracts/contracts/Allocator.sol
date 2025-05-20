// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ISafe {
  function isOwner(address) external view returns (bool);
}

contract Allocator is Ownable, AccessControl {
  bool public enabled;

  // solver roles
  bytes32 public constant SOLVER_ORACLE_ROLE = keccak256("SOLVER_ORACLE_ROLE");
  bytes32 public constant SOLVER_ORACLE_ADMIN_ROLE =
    keccak256("SOLVER_ORACLE_ADMIN_ROLE");

  // delay
  uint256 public delay;

  // errors
  error NotMultisigOwner(address account);

  constructor(address _owner, uint256 _delay) Ownable(_owner) {
    // roles
    _setRoleAdmin(SOLVER_ORACLE_ROLE, SOLVER_ORACLE_ADMIN_ROLE);
    _grantRole(SOLVER_ORACLE_ADMIN_ROLE, _owner);

    // enabled by default
    enabled = true;

    // delay
    delay = _delay;

    // TODO:  check if is _owner is a valid multisig
  }

  modifier onlyMultisigOwner() {
    if (!ISafe(owner()).isOwner(msg.sender))
      revert NotMultisigOwner(msg.sender);
    _;
  }

  function disable() public onlyMultisigOwner {
    enabled = false;
  }

  function enable() public onlyOwner {
    enabled = true;
  }
}
