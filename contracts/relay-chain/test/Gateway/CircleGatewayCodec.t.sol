// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {CircleGatewayCodec} from "../../contracts/payload-builders/gateway/CircleGatewayCodec.sol";
import {
    BurnIntent,
    CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION,
    TransferSpec
} from "../../contracts/payload-builders/gateway/CircleGatewayTypes.sol";

contract CircleGatewayCodecTest is Test {
    bytes32 private constant EXPECTED_TRANSFER_SPEC_HASH =
        0xdca3027e5353d3d5bd6253173825372fdc9016574c3f08bb51016b8eda4700dc;
    bytes32 private constant EXPECTED_TRANSFER_SPEC_TYPED_DATA_HASH =
        0xef0fdfc0531748f728bbc81db98db30cf75a26a5c8517b10cb9023bea2dbb19f;
    bytes32 private constant EXPECTED_BURN_INTENT_ENCODING_HASH =
        0xe4ae596b7d300867bdabd419f62dc6f9944466c0f5dfe90afdaf6415fa60de04;
    bytes32 private constant EXPECTED_BURN_INTENT_TYPED_DATA_HASH =
        0xd7ae9aa4bad3a5f4f81357787dd6d1b8ebb3ecb9626777d8407072d9fc5ffb01;
    bytes32 private constant EXPECTED_BURN_INTENT_DIGEST =
        0xbb30b9d60658934f6f82a772df59b2a2cc95884bd317058bcd8ca9cf98223a70;

    function test_encodesAndHashesCircleReferenceVector() public pure {
        BurnIntent memory intent = _burnIntent();
        bytes memory encodedSpec = CircleGatewayCodec.encodeTransferSpec(intent.spec);
        bytes memory encodedIntent = CircleGatewayCodec.encodeBurnIntent(intent);

        assertEq(encodedSpec.length, 346);
        assertEq(bytes4(encodedSpec), bytes4(0xca85def7));
        assertEq(keccak256(encodedSpec), EXPECTED_TRANSFER_SPEC_HASH);
        assertEq(CircleGatewayCodec.hashTransferSpec(intent.spec), EXPECTED_TRANSFER_SPEC_HASH);
        assertEq(encodedIntent.length, 418);
        assertEq(bytes4(encodedIntent), bytes4(0x070afbc2));
        assertEq(keccak256(encodedIntent), EXPECTED_BURN_INTENT_ENCODING_HASH);
    }

    function test_hashesCircleEip712ReferenceVector() public pure {
        BurnIntent memory intent = _burnIntent();

        assertEq(CircleGatewayCodec.hashTransferSpecTypedData(intent.spec), EXPECTED_TRANSFER_SPEC_TYPED_DATA_HASH);
        assertEq(CircleGatewayCodec.hashBurnIntentTypedData(intent), EXPECTED_BURN_INTENT_TYPED_DATA_HASH);
        assertEq(CircleGatewayCodec.hashBurnIntent(intent), EXPECTED_BURN_INTENT_DIGEST);
    }

    function test_convertsAddressToCircleBytes32() public pure {
        address value = 0x1111111111111111111111111111111111111111;

        assertEq(
            CircleGatewayCodec.addressToBytes32(value),
            0x0000000000000000000000001111111111111111111111111111111111111111
        );
    }

    function _burnIntent() private pure returns (BurnIntent memory) {
        return BurnIntent({
            maxBlockHeight: 22_000_000,
            maxFee: 50_000,
            spec: TransferSpec({
                version: CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION,
                sourceDomain: 3,
                destinationDomain: 6,
                sourceContract: CircleGatewayCodec.addressToBytes32(0x1111111111111111111111111111111111111111),
                destinationContract: CircleGatewayCodec.addressToBytes32(0x2222222222222222222222222222222222222222),
                sourceToken: CircleGatewayCodec.addressToBytes32(0x3333333333333333333333333333333333333333),
                destinationToken: CircleGatewayCodec.addressToBytes32(0x4444444444444444444444444444444444444444),
                sourceDepositor: CircleGatewayCodec.addressToBytes32(0x5555555555555555555555555555555555555555),
                destinationRecipient: CircleGatewayCodec.addressToBytes32(0x6666666666666666666666666666666666666666),
                sourceSigner: CircleGatewayCodec.addressToBytes32(0x7777777777777777777777777777777777777777),
                destinationCaller: CircleGatewayCodec.addressToBytes32(0x8888888888888888888888888888888888888888),
                value: 123_456_789,
                salt: 0x9999999999999999999999999999999999999999999999999999999999999999,
                hookData: hex"deadbeef0102"
            })
        });
    }
}
