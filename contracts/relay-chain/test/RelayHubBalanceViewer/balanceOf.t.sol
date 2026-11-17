// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "../Hub/HubBase.sol";
import {Utils} from "../../contracts/Utils.sol";
import {Base58} from "solady/utils/Base58.sol";
import {HubAddressCodec} from "../../contracts/HubAddressCodec.sol";
import {RelayHubBalanceViewer} from "../../contracts/RelayHubBalanceViewer.sol";

contract RelayHubBalanceViewerTest is HubBase {
  // Safe on Arbitrum used as a reference depositor; alias computed
  // independently with `cast keccak` over ("arbitrum" ++ address).
  address internal constant DEPOSITOR =
    0x2170D9549653DD6523e26e256A789eA247C53669;
  string internal constant DEPOSITOR_STR =
    "0x2170D9549653DD6523e26e256A789eA247C53669";
  address internal constant EXPECTED_ALIAS =
    0x5267a7E52058F662d874f344261611D1a57CE57d;
  string internal constant CHAIN = "arbitrum";
  string internal constant NATIVE =
    "0x0000000000000000000000000000000000000000";

  // Expected values below come from the SDK's encodeAddress, generateTokenId
  // and generateAddress for the same inputs.
  string internal constant SOL_USDC =
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  bytes internal constant SOL_USDC_BYTES =
    hex"c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61";
  uint256 internal constant SOL_USDC_TOKEN_ID =
    0xa09361e65480ee9ecad8863fdceef346cb004c0cb4ee7f28d7e282e2d9aa7e40;
  string internal constant SOL_ACCOUNT =
    "CE77Fp4qdUMnVzRMyAtFyMhVEweoiuDugQjykFAKTYLn";
  bytes internal constant SOL_ACCOUNT_BYTES =
    hex"a6cc034bec30bf2aeee9b814131c2b57b77ab34152b691a71db04f1d952f1ca7";
  address internal constant SOL_EXPECTED_ALIAS =
    0x1d97c0cbfA6ee09Ced4e4F4fAc3aFD50A35Ec1d1;
  string internal constant SOL_NATIVE = "11111111111111111111111111111111";
  uint256 internal constant SOL_NATIVE_TOKEN_ID =
    0x5c27dede7502c8a2617b1fc85b0c20e7169ceda3c24b8992ba6aad64b3578ae7;

  string internal constant TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  bytes internal constant TRON_USDT_BYTES =
    hex"41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
  uint256 internal constant TRON_USDT_TOKEN_ID =
    0x4af40ace5ed80952e0dfc827a06adb4517ac32a775d22f137812d19f8af6bec7;
  string internal constant TRON_ACCOUNT = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
  address internal constant TRON_EXPECTED_ALIAS =
    0x08b09C39B2D99c239B49013eb699aC6cE66ef9fE;
  string internal constant TRON_NATIVE = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
  bytes internal constant TRON_NATIVE_BYTES =
    hex"410000000000000000000000000000000000000000";

  // Bitcoin: legacy P2PKH and P2SH get a 0xff discriminator before the
  // 21-byte payload; segwit returns witness version followed by the program.
  string internal constant BTC_P2PKH = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  bytes internal constant BTC_P2PKH_BYTES =
    hex"ff0062e907b15cbf27d5425399ebf6f0fb50ebb88f18";
  string internal constant BTC_P2SH = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
  bytes internal constant BTC_P2SH_BYTES =
    hex"ff05b472a266d0bd89c13706a4132ccfb16f7c3b9fcb";
  string internal constant BTC_P2WPKH =
    "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
  bytes internal constant BTC_P2WPKH_BYTES =
    hex"00e8df018c7e326cc253faac7e46cdc51e68542c42";
  string internal constant BTC_P2TR =
    "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";
  bytes internal constant BTC_P2TR_BYTES =
    hex"01a37c3903c8d0db6512e2b40b0dffa05e5a3ab73603ce8c9c4b7771e5412328f9";

  RelayHubBalanceViewer internal viewer;
  address internal operatorUser;
  address internal erc20;
  string internal erc20Str;
  uint256 internal nativeTokenId;
  uint256 internal erc20TokenId;

  function setUp() public virtual override {
    super.setUp();
    operatorUser = otherAccounts[0];
    erc20 = otherAccounts[3];
    erc20Str = vm.toString(erc20);
    vm.prank(admin);
    hub.grantRole(OPERATOR_ROLE, operatorUser);
    viewer = new RelayHubBalanceViewer(address(hub));
    nativeTokenId = Utils.generateTokenId(CHAIN, abi.encodePacked(address(0)));
    erc20TokenId = Utils.generateTokenId(CHAIN, abi.encodePacked(erc20));
  }

  function _mint(address to, uint256 tokenId, uint256 amount) internal {
    vm.prank(operatorUser);
    hub.mint(to, tokenId, amount);
  }

  // ---------------------------------------------------------------------------
  // Address encoding
  // ---------------------------------------------------------------------------

  function test_encodeHexAddress() public view {
    assertEq(viewer.encodeAddress(DEPOSITOR_STR), abi.encodePacked(DEPOSITOR));
    assertEq(viewer.encodeAddress(NATIVE), abi.encodePacked(address(0)));
    // Case-insensitive prefix and digits, arbitrary length (pre-encoded bytes)
    assertEq(viewer.encodeAddress("0XaBcD"), hex"abcd");
    assertEq(viewer.encodeAddress("0x"), hex"");
  }

  function test_encodeSolanaAddress() public view {
    assertEq(viewer.encodeAddress(SOL_USDC), SOL_USDC_BYTES);
    assertEq(viewer.encodeAddress(SOL_ACCOUNT), SOL_ACCOUNT_BYTES);
    assertEq(viewer.encodeAddress(SOL_NATIVE), new bytes(32));
  }

  function test_encodeTronAddress() public view {
    assertEq(viewer.encodeAddress(TRON_USDT), TRON_USDT_BYTES);
    assertEq(viewer.encodeAddress(TRON_NATIVE), TRON_NATIVE_BYTES);
  }

  function test_encodeBitcoinLegacyAddress() public view {
    assertEq(viewer.encodeAddress(BTC_P2PKH), BTC_P2PKH_BYTES);
    assertEq(viewer.encodeAddress(BTC_P2SH), BTC_P2SH_BYTES);
  }

  function test_encodeBitcoinSegwitAddress() public view {
    assertEq(viewer.encodeAddress(BTC_P2WPKH), BTC_P2WPKH_BYTES);
    assertEq(viewer.encodeAddress(BTC_P2TR), BTC_P2TR_BYTES);
    // BIP-173 allows an all-uppercase form
    assertEq(
      viewer.encodeAddress("BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ"),
      BTC_P2WPKH_BYTES
    );
  }

  function test_encodeRejectsBadSegwitChecksum() public {
    string memory tampered = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdp";
    // Not valid bech32, so it falls through to base58 where "0" is illegal
    vm.expectRevert(Base58.Base58DecodingError.selector);
    viewer.encodeAddress(tampered);
  }

  function test_encodeRejectsUnknownBase58CheckVersion() public {
    // Litecoin P2PKH: valid base58check, version 0x30, no Hub family
    string memory ltc = "LM2WMpR1Rp6j3Sa59cMXMs1SPzj9eXpGc1";
    vm.expectRevert(
      abi.encodeWithSelector(HubAddressCodec.UnsupportedAddress.selector, ltc)
    );
    viewer.encodeAddress(ltc);
  }

  function test_encodeRejectsOddHex() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        HubAddressCodec.InvalidHexAddress.selector,
        "0xabc"
      )
    );
    viewer.encodeAddress("0xabc");
  }

  function test_encodeRejectsOversizedHex() public {
    string memory long = string.concat("0x", new string(66));
    vm.expectRevert(
      abi.encodeWithSelector(HubAddressCodec.InvalidHexAddress.selector, long)
    );
    viewer.encodeAddress(long);
  }

  function test_encodeRejectsNonHexDigit() public {
    vm.expectRevert(
      abi.encodeWithSelector(HubAddressCodec.InvalidHexAddress.selector, "0xzz")
    );
    viewer.encodeAddress("0xzz");
  }

  function test_encodeRejectsBase58Character() public {
    // "0", "O", "I" and "l" are not in the base58 alphabet
    vm.expectRevert(Base58.Base58DecodingError.selector);
    viewer.encodeAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtOv");
  }

  function test_encodeRejectsBadTronChecksum() public {
    string memory tampered = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u";
    vm.expectRevert(
      abi.encodeWithSelector(
        HubAddressCodec.InvalidBase58Checksum.selector,
        tampered
      )
    );
    viewer.encodeAddress(tampered);
  }

  function test_encodeRejectsUnsupportedLength() public {
    vm.expectRevert(
      abi.encodeWithSelector(HubAddressCodec.UnsupportedAddress.selector, "abc")
    );
    viewer.encodeAddress("abc");
  }

  // ---------------------------------------------------------------------------
  // Derivation
  // ---------------------------------------------------------------------------

  function test_revertsOnZeroHub() public {
    vm.expectRevert(RelayHubBalanceViewer.HubCannotBeZero.selector);
    new RelayHubBalanceViewer(address(0));
  }

  function test_exposesHub() public view {
    assertEq(address(viewer.HUB()), address(hub));
  }

  function test_aliasOfMatchesUtilsAndReference() public view {
    address aliasAddress = viewer.aliasOf(CHAIN, DEPOSITOR_STR);
    assertEq(aliasAddress, EXPECTED_ALIAS);
    assertEq(
      aliasAddress,
      Utils.generateAddress(CHAIN, abi.encodePacked(DEPOSITOR))
    );
  }

  function test_tokenIdOfMatchesUtils() public view {
    assertEq(viewer.tokenIdOf(CHAIN, NATIVE), nativeTokenId);
    assertEq(viewer.tokenIdOf(CHAIN, erc20Str), erc20TokenId);
    assertTrue(nativeTokenId != erc20TokenId);
  }

  function test_solanaDerivationMatchesSdk() public view {
    assertEq(viewer.tokenIdOf("solana", SOL_USDC), SOL_USDC_TOKEN_ID);
    assertEq(viewer.tokenIdOf("solana", SOL_NATIVE), SOL_NATIVE_TOKEN_ID);
    assertEq(viewer.aliasOf("solana", SOL_ACCOUNT), SOL_EXPECTED_ALIAS);
  }

  function test_tronDerivationMatchesSdk() public view {
    assertEq(viewer.tokenIdOf("tron", TRON_USDT), TRON_USDT_TOKEN_ID);
    assertEq(viewer.aliasOf("tron", TRON_ACCOUNT), TRON_EXPECTED_ALIAS);
  }

  // ---------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------

  function test_tokenInfoBeforeAnyMint() public view {
    (
      uint256 tokenId,
      address erc20View,
      string memory name,
      string memory symbol,
      uint8 decimals,
      uint256 totalSupply
    ) = viewer.tokenInfo(CHAIN, NATIVE);
    assertEq(tokenId, nativeTokenId);
    assertEq(erc20View, address(0));
    assertEq(bytes(name).length, 0);
    assertEq(bytes(symbol).length, 0);
    assertEq(decimals, 18);
    assertEq(totalSupply, 0);
  }

  function test_tokenInfoAfterMint() public {
    _mint(EXPECTED_ALIAS, nativeTokenId, 42);
    (uint256 tokenId, address erc20View, , , , uint256 totalSupply) = viewer
      .tokenInfo(CHAIN, NATIVE);
    assertEq(erc20View, hub.erc20Views(tokenId));
    assertTrue(erc20View != address(0));
    assertEq(totalSupply, 42);
  }

  function test_balanceOfReturnsZeroesWhenNothingMinted() public view {
    (uint256 aliasBalance, uint256 accountBalance) = viewer.balanceOf(
      CHAIN,
      DEPOSITOR_STR,
      NATIVE
    );
    assertEq(aliasBalance, 0);
    assertEq(accountBalance, 0);
  }

  function test_balanceOfSplitsAliasAndAccount() public {
    _mint(EXPECTED_ALIAS, nativeTokenId, 1_000_000_000_000);
    _mint(DEPOSITOR, nativeTokenId, 500);

    (uint256 aliasBalance, uint256 accountBalance) = viewer.balanceOf(
      CHAIN,
      DEPOSITOR_STR,
      NATIVE
    );
    assertEq(aliasBalance, 1_000_000_000_000);
    assertEq(accountBalance, 500);
  }

  function test_balanceOfDistinguishesTokens() public {
    _mint(EXPECTED_ALIAS, erc20TokenId, 7);

    (uint256 nativeBalance, ) = viewer.balanceOf(CHAIN, DEPOSITOR_STR, NATIVE);
    (uint256 erc20Balance, ) = viewer.balanceOf(CHAIN, DEPOSITOR_STR, erc20Str);
    assertEq(nativeBalance, 0);
    assertEq(erc20Balance, 7);
  }

  function test_solanaBalanceOf() public {
    _mint(SOL_EXPECTED_ALIAS, SOL_USDC_TOKEN_ID, 1_000_000);

    (uint256 aliasBalance, uint256 accountBalance) = viewer.balanceOf(
      "solana",
      SOL_ACCOUNT,
      SOL_USDC
    );
    assertEq(aliasBalance, 1_000_000);
    assertEq(accountBalance, 0);
  }

  function test_balancesOfBatchesTokens() public {
    _mint(EXPECTED_ALIAS, nativeTokenId, 10);
    _mint(DEPOSITOR, erc20TokenId, 20);

    string[] memory tokens = new string[](2);
    tokens[0] = NATIVE;
    tokens[1] = erc20Str;
    (uint256[] memory aliasBalances, uint256[] memory accountBalances) = viewer
      .balancesOf(CHAIN, DEPOSITOR_STR, tokens);

    assertEq(aliasBalances.length, 2);
    assertEq(accountBalances.length, 2);
    assertEq(aliasBalances[0], 10);
    assertEq(accountBalances[0], 0);
    assertEq(aliasBalances[1], 0);
    assertEq(accountBalances[1], 20);
  }

  function test_balancesOfEmptyInput() public view {
    string[] memory tokens = new string[](0);
    (uint256[] memory aliasBalances, uint256[] memory accountBalances) = viewer
      .balancesOf(CHAIN, DEPOSITOR_STR, tokens);
    assertEq(aliasBalances.length, 0);
    assertEq(accountBalances.length, 0);
  }
}
