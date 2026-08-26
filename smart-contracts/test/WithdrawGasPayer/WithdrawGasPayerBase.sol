// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {PayGasSig} from "../utils/PayGasSig.sol";
import {
  BuildPayloadParams,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";

/// @notice Shared fixture for the WithdrawGasPayer Foundry tests.
abstract contract WithdrawGasPayerBase is BaseTest {
  string internal constant CHAIN_ID = "ton";
  string internal constant SPENDER_CHAIN_ID = "ethereum-mainnet";

  /// @notice Encoded native TON currency: the 32-byte all-zero address hash.
  bytes internal constant NATIVE_CURRENCY =
    hex"0000000000000000000000000000000000000000000000000000000000000000";

  uint256 internal constant GAS_FEE_AMOUNT = 1000000000; // 1 TON in nanotons
  uint256 internal constant WITHDRAW_AMOUNT = 5000000000;

  bytes32 internal constant RECIPIENT_HASH =
    0x1122334455667788990011223344556677889900112233445566778899001122;
  bytes32 internal constant DEPOSITORY_HASH =
    0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899;

  RelayHub internal hub;
  WithdrawGasPayer internal gasPayer;

  address internal spender;
  address internal spenderAlias;

  address internal oracle;
  uint256 internal oraclePk;

  uint256 internal gasTokenId;

  function setUp() public virtual override {
    super.setUp();

    spender = makeAddr("spender");
    (oracle, oraclePk) = makeAddrAndKey("oracle");

    hub = new RelayHub(owner);
    gasPayer = new WithdrawGasPayer(address(hub), oracle);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, address(gasPayer));
    hub.grantRole(operatorRole, owner);
    vm.stopPrank();

    spenderAlias = Utils.generateAddress(
      SPENDER_CHAIN_ID,
      abi.encodePacked(spender)
    );
    gasTokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);
  }

  function _withdrawRequest(
    bytes32 nonce
  ) internal view returns (RelayAllocator.WithdrawRequest memory) {
    return
      RelayAllocator.WithdrawRequest({
        chainId: CHAIN_ID,
        depository: abi.encodePacked(DEPOSITORY_HASH),
        currency: NATIVE_CURRENCY,
        amount: WITHDRAW_AMOUNT,
        spenderChainId: SPENDER_CHAIN_ID,
        spender: abi.encodePacked(spender),
        receiver: abi.encodePacked(RECIPIENT_HASH),
        data: "",
        nonce: nonce
      });
  }

  function _buildParams(
    RelayAllocator.WithdrawRequest memory request
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: request.currency,
        amount: request.amount,
        receiver: request.receiver,
        nonce: uint256(request.nonce),
        data: request.data
      });
  }

  function _withdrawParamsHash(
    RelayAllocator.WithdrawRequest memory request
  ) internal pure returns (bytes32) {
    return
      keccak256(
        abi.encode(request.chainId, request.depository, _buildParams(request))
      );
  }

  function _signPayGas(
    RelayAllocator.WithdrawRequest memory request
  ) internal view returns (bytes memory) {
    return
      PayGasSig.sign(
        oraclePk,
        gasPayer,
        request,
        NATIVE_CURRENCY,
        GAS_FEE_AMOUNT
      );
  }

  function _mintGasFunds(address account, uint256 amount) internal {
    vm.prank(owner);
    hub.mint(account, gasTokenId, amount);
  }
}
