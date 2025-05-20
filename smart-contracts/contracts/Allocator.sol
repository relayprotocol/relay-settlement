// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ISafe {
  function isOwner(address) external view returns (bool);
}

contract Allocator is Ownable, AccessControl {
  bool public enabled;

  event Enabled(bool enabled);
  event DelayChanged(uint256 delay);

  // solver roles
  bytes32 public constant SOLVER_ROLE = keccak256("SOLVER_ROLE");
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  // delay
  uint256 public delay;

  // payload builders mapping
  mapping(uint256 => mapping(address => address)) public payloadBuilders;

  // events
  event PayloadBuilderUpdated(
    uint256 indexed chainId,
    address indexed escrow,
    address indexed builder
  );

  // errors
  error NotMultisigOwner(address account);

  constructor(address _owner, uint256 _delay) Ownable(_owner) {
    // roles
    _setRoleAdmin(SOLVER_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, _owner);

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
    emit Enabled(enabled);
  }

  function enable() public onlyOwner {
    enabled = true;
    emit Enabled(enabled);
  }

  function setDelay(uint256 _delay) public onlyOwner {
    delay = _delay;
    emit DelayChanged(delay);
  }

  /**
   * @notice sets or updates the payload builder for a specific chain
   * @param chainId chain ID
   * @param builder address of the payload builder contract
   */
  function setPayloadBuilder(
    uint256 chainId,
    address escrow,
    address builder
  ) external onlyOwner {
    payloadBuilders[chainId][escrow] = builder;
    emit PayloadBuilderUpdated(chainId, escrow, builder);
  }
}
