// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

contract MockSafe {
  mapping(address => bool) public owners;

  function addOwner(address owner) external {
    owners[owner] = true;
  }

  function removeOwner(address owner) external {
    owners[owner] = false;
  }

  function isOwner(address account) external view returns (bool) {
    return owners[account];
  }

  function execute(
    address payable to,
    uint256 value,
    bytes calldata data
  ) external {
    bool success;
    bytes memory response;
    (success, response) = to.call{value: value}(data);
    if (!success) {
      revert("Safe: call failed");
    }
  }
}
