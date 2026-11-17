// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {RelayMultisigSigner} from "../RelayMultisigSigner.sol";

// Contract used for testing to expose internal methods
contract RelayMultisigSignerHarness is RelayMultisigSigner {
  constructor(
    address _multisig,
    string memory _nearSigner,
    address _wNEAR
  ) RelayMultisigSigner(_multisig, _nearSigner, _wNEAR) {}

  function __setSignature(
    bytes32 hashToSign,
    string memory curve,
    bytes calldata signature
  ) external {
    signatures[hashToSign][curve] = signature;
  }

  function __setPendingTimestamp(
    bytes32 hashToSign,
    string memory curve,
    uint256 timestamp
  ) external {
    pendingSignatures[hashToSign][curve] = timestamp;
  }

  function __tryMarkPendingSignature(
    bytes32 hashToSign,
    string memory curve
  ) external returns (bool) {
    if (signatures[hashToSign][curve].length != 0) {
      return false;
    }
    if (pendingSignatures[hashToSign][curve] > block.timestamp - 60 * 5) {
      return false;
    }
    pendingSignatures[hashToSign][curve] = block.timestamp;
    return true;
  }
}
