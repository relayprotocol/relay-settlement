// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ISafe {
  function isOwner(address) external view returns (bool);
}

interface PayloadBuilder {
  function buildPayload(
    uint256 chainId,
    address escrow,
    address currency,
    uint256 amount,
    address receiver,
    bytes calldata data
  ) external view returns (bytes memory);

  function hashPayload(
    uint256 chainId,
    address escrow,
    bytes calldata payload
  ) external pure returns (bytes32);
}

contract Allocator is Ownable, AccessControl {
  bool public enabled;

  event Enabled(bool enabled);
  event DelayChanged(uint256 delay);

  // roles
  bytes32 public constant HUB_ROLE = keccak256("HUB_ROLE");
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  // delay
  uint256 public delay;

  // payload builders mapping
  mapping(uint256 => mapping(address => address)) public payloadBuilders;

  // unsigned payloads
  mapping(bytes32 => bytes) public unsignedPayloads;

  // payload timestamps
  mapping(bytes32 => uint256) public payloadTimestamps;

  // events
  event PayloadBuilderUpdated(
    uint256 indexed chainId,
    address indexed escrow,
    address indexed builder
  );

  event PayloadBuilt(
    bytes32 indexed payloadHash,
    bytes payload,
    uint256 timestamp
  );

  // errors
  error NotMultisigOwner(address account);
  error CallerIsNotHub(address account);
  error NoPayloadBuilder(uint256 chainId, address escrow);

  constructor(address _owner, uint256 _delay) Ownable(_owner) {
    // roles
    _setRoleAdmin(HUB_ROLE, ADMIN_ROLE);
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

  /**
   * @notice submits a withdraw request to the payload builder, store the payload
   * @param chainId chain ID
   * @param escrow address of the escrow contract
   * @param currency address of the currency contract (or zero address for native)
   * @param amount amount to withdraw
   * @param receiver address of the receiver
   * @param data additional data to pass to the payload builder
   */
  function submitWithdrawRequest(
    uint256 chainId,
    address escrow,
    address currency,
    uint256 amount,
    address receiver,
    bytes calldata data
  ) public returns (bytes32 payloadHash) {
    // Check that the calling address has the hub role
    if (!hasRole(HUB_ROLE, msg.sender)) {
      revert CallerIsNotHub(msg.sender);
    }
    // check if the payload builder is set
    address builder = payloadBuilders[chainId][escrow];
    if (builder == address(0)) {
      revert NoPayloadBuilder(chainId, escrow);
    }

    bytes memory payload = PayloadBuilder(builder).buildPayload(
      chainId,
      escrow,
      currency,
      amount,
      receiver,
      data
    );
    payloadHash = keccak256(abi.encodePacked(payload, block.timestamp));
    unsignedPayloads[payloadHash] = payload;
    payloadTimestamps[payloadHash] = block.timestamp + delay;
    emit PayloadBuilt(payloadHash, payload, block.timestamp);
    return payloadHash;
  }
}
