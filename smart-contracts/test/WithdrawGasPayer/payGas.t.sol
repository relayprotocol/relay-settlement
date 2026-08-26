// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {stdError} from "forge-std/Test.sol";

import {WithdrawGasPayerBase} from "./WithdrawGasPayerBase.sol";
import {PayGasSig} from "../utils/PayGasSig.sol";
import {RelayAllocator} from "../../contracts/RelayAllocator.sol";
import {RelayOracleMultisig} from "../../contracts/RelayOracleMultisig.sol";
import {Utils} from "../../contracts/Utils.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";

contract WithdrawGasPayerPayGasTest is WithdrawGasPayerBase {
  function test_paysGasWithOracleSignature() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(1))
    );
    bytes32 expectedHash = _withdrawParamsHash(request);
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT);

    vm.expectEmit(true, true, false, true, address(gasPayer));
    emit WithdrawGasPayer.GasPaid(
      expectedHash,
      request.chainId,
      request.depository,
      spenderAlias,
      gasTokenId,
      GAS_FEE_AMOUNT
    );

    // Anyone can submit the payment; the signature is the authority.
    vm.prank(otherAccounts[1]);
    bytes32 withdrawParamsHash = gasPayer.payGas(
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT,
      _signPayGas(request)
    );

    assertEq(withdrawParamsHash, expectedHash);
    assertEq(hub.balanceOf(spenderAlias, gasTokenId), 0);
    assertEq(gasPayer.gasPayments(expectedHash), GAS_FEE_AMOUNT);
    assertEq(gasPayer.gasPayers(expectedHash), spenderAlias);
  }

  function test_paysGasInOracleAuthorizedFeeCurrency() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(2))
    );
    bytes memory feeCurrency = hex"1234";
    uint256 feeTokenId = Utils.generateTokenId(CHAIN_ID, feeCurrency);

    vm.prank(owner);
    hub.mint(spenderAlias, feeTokenId, GAS_FEE_AMOUNT);

    bytes memory signature = PayGasSig.sign(
      oraclePk,
      gasPayer,
      request,
      feeCurrency,
      GAS_FEE_AMOUNT
    );
    gasPayer.payGas(request, feeCurrency, GAS_FEE_AMOUNT, signature);

    assertEq(hub.balanceOf(spenderAlias, feeTokenId), 0);
    assertEq(
      gasPayer.gasPayments(_withdrawParamsHash(request)),
      GAS_FEE_AMOUNT
    );
  }

  function test_rejectsInvalidOracleSignature() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(3))
    );
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT);

    (, uint256 intruderPk) = makeAddrAndKey("intruder");
    bytes memory signature = PayGasSig.sign(
      intruderPk,
      gasPayer,
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidOracleSignature.selector,
        oracle
      )
    );
    gasPayer.payGas(request, NATIVE_CURRENCY, GAS_FEE_AMOUNT, signature);
  }

  function test_rejectsSignatureOverDifferentRequest() public {
    RelayAllocator.WithdrawRequest memory signedRequest = _withdrawRequest(
      bytes32(uint256(4))
    );
    bytes memory signature = _signPayGas(signedRequest);

    // Same signature, tampered request (different amount).
    RelayAllocator.WithdrawRequest memory submitted = _withdrawRequest(
      bytes32(uint256(4))
    );
    submitted.amount = WITHDRAW_AMOUNT + 1;
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT);

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidOracleSignature.selector,
        oracle
      )
    );
    gasPayer.payGas(submitted, NATIVE_CURRENCY, GAS_FEE_AMOUNT, signature);
  }

  function test_rejectsSignatureOverDifferentFeeCurrency() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(5))
    );
    bytes memory signature = _signPayGas(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidOracleSignature.selector,
        oracle
      )
    );
    gasPayer.payGas(
      request,
      abi.encodePacked(bytes32(uint256(1))),
      GAS_FEE_AMOUNT,
      signature
    );
  }

  function test_rejectsSignatureOverDifferentFeeAmount() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(6))
    );
    bytes memory signature = _signPayGas(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidOracleSignature.selector,
        oracle
      )
    );
    gasPayer.payGas(request, NATIVE_CURRENCY, GAS_FEE_AMOUNT + 1, signature);
  }

  function test_rejectsWhenBalanceInsufficient() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(6))
    );
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT - 1);
    bytes memory signature = _signPayGas(request);

    vm.expectRevert(stdError.arithmeticError);
    gasPayer.payGas(request, NATIVE_CURRENCY, GAS_FEE_AMOUNT, signature);
  }

  function test_rejectsDoublePayment() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(7))
    );
    bytes32 expectedHash = _withdrawParamsHash(request);
    bytes memory signature = _signPayGas(request);
    _mintGasFunds(spenderAlias, 2 * GAS_FEE_AMOUNT);

    gasPayer.payGas(request, NATIVE_CURRENCY, GAS_FEE_AMOUNT, signature);

    // Replaying the same signed request reverts: one burn per record.
    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.GasAlreadyPaid.selector,
        expectedHash
      )
    );
    gasPayer.payGas(request, NATIVE_CURRENCY, GAS_FEE_AMOUNT, signature);

    // The second payment reverted before burning: only one fee was burned.
    assertEq(hub.balanceOf(spenderAlias, gasTokenId), GAS_FEE_AMOUNT);
  }

  function test_rejectsZeroGasFeeAmount() public {
    // A zero fee would record an "unpaid-looking" payment and defeat the
    // builders' paid-amount bound, so it is rejected outright.
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(8))
    );
    bytes memory signature = PayGasSig.sign(
      oraclePk,
      gasPayer,
      request,
      NATIVE_CURRENCY,
      0
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidGasFeeAmount.selector,
        CHAIN_ID
      )
    );
    gasPayer.payGas(request, NATIVE_CURRENCY, 0, signature);
  }

  function test_hashWithdrawParamsMatchesEncoding() public view {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(9))
    );
    assertEq(
      gasPayer.hashWithdrawParams(
        request.chainId,
        request.depository,
        _buildParams(request)
      ),
      _withdrawParamsHash(request)
    );
  }
}

/// @notice Exercises payGas against the production oracle setup: a
/// RelayOracleMultisig verifying threshold ECDSA signatures via ERC-1271.
contract WithdrawGasPayerMultisigOracleTest is WithdrawGasPayerBase {
  RelayOracleMultisig internal multisig;
  WithdrawGasPayer internal multisigGasPayer;

  uint256[] internal signerPks;

  function setUp() public override {
    super.setUp();

    // Three signers sorted by address, threshold two — signatures must be
    // concatenated in ascending signer-address order.
    address[] memory signers = new address[](3);
    signerPks = new uint256[](3);
    (signers[0], signerPks[0]) = makeAddrAndKey("multisig-signer-a");
    (signers[1], signerPks[1]) = makeAddrAndKey("multisig-signer-b");
    (signers[2], signerPks[2]) = makeAddrAndKey("multisig-signer-c");
    for (uint256 i; i < signers.length; ++i) {
      for (uint256 j = i + 1; j < signers.length; ++j) {
        if (signers[i] > signers[j]) {
          (signers[i], signers[j]) = (signers[j], signers[i]);
          (signerPks[i], signerPks[j]) = (signerPks[j], signerPks[i]);
        }
      }
    }

    multisig = new RelayOracleMultisig(owner, signers, 2);
    multisigGasPayer = new WithdrawGasPayer(address(hub), address(multisig));

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(multisigGasPayer));
  }

  function _thresholdSign(
    bytes32 digest,
    uint256 firstSigner,
    uint256 secondSigner
  ) internal view returns (bytes memory) {
    (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(
      signerPks[firstSigner],
      digest
    );
    (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(
      signerPks[secondSigner],
      digest
    );
    return abi.encodePacked(r1, s1, v1, r2, s2, v2);
  }

  function test_paysGasWithThresholdSignatures() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(1))
    );
    bytes32 expectedHash = _withdrawParamsHash(request);
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT);

    bytes32 withdrawParamsHash = multisigGasPayer.payGas(
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT,
      _thresholdSign(
        PayGasSig.digest(
          multisigGasPayer,
          request,
          NATIVE_CURRENCY,
          GAS_FEE_AMOUNT
        ),
        0,
        2
      )
    );

    assertEq(withdrawParamsHash, expectedHash);
    assertEq(hub.balanceOf(spenderAlias, gasTokenId), 0);
    assertEq(multisigGasPayer.gasPayments(expectedHash), GAS_FEE_AMOUNT);
  }

  function test_rejectsSingleSignatureBelowThreshold() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(2))
    );
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT);

    bytes32 digest = PayGasSig.digest(
      multisigGasPayer,
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPks[0], digest);

    vm.expectRevert(
      abi.encodeWithSelector(
        WithdrawGasPayer.InvalidOracleSignature.selector,
        address(multisig)
      )
    );
    multisigGasPayer.payGas(
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT,
      abi.encodePacked(r, s, v)
    );
  }
}
