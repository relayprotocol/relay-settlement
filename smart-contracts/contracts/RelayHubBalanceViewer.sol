// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayHub} from "./RelayHub.sol";
import {HubAddressCodec} from "./HubAddressCodec.sol";

/// @title RelayHubBalanceViewer
/// @author Relay Protocol
/// @notice Read-only helper that resolves origin-chain accounts and currencies,
/// given as plain address strings, to Hub aliases, token ids, ERC20Views and
/// balances.
/// @dev The chain id is the Hub chain identifier string, e.g. "arbitrum" or
/// "solana". Addresses are `0x` hex (ethereum-vm family), base58 (solana-vm)
/// or base58check (tron-vm); see `HubAddressCodec` for the exact rules.
contract RelayHubBalanceViewer {
  using HubAddressCodec for string;

  /// @notice The Hub whose state is read
  RelayHub public immutable HUB;

  /// @notice Revert if the hub address is zero
  error HubCannotBeZero();

  /// @notice Deploys the viewer bound to a Hub
  constructor(address _hub) {
    if (_hub == address(0)) {
      revert HubCannotBeZero();
    }
    HUB = RelayHub(_hub);
  }

  /// @notice Encode an origin-chain address into the bytes the Hub hashes
  /// @return encoded The Hub byte form of `addr`
  function encodeAddress(
    string calldata addr
  ) external pure returns (bytes memory encoded) {
    return addr.encode();
  }

  /// @notice Derive the Hub alias that receives deposits made by `account`
  /// @return aliasAddress The derived alias
  function aliasOf(
    string calldata chainId,
    string calldata account
  ) public pure returns (address aliasAddress) {
    return _aliasOf(chainId, account.encode());
  }

  /// @notice Derive the Hub token id for an origin-chain currency
  /// @return tokenId The derived token id
  function tokenIdOf(
    string calldata chainId,
    string calldata token
  ) public pure returns (uint256 tokenId) {
    return uint256(keccak256(abi.encodePacked(chainId, token.encode())));
  }

  /// @notice Resolve an origin-chain currency to its Hub token and metadata
  /// @return tokenId The Hub token id
  /// @return erc20View The ERC20View for `tokenId`, or zero if none exists yet
  /// @return name Token name, empty if unregistered
  /// @return symbol Token symbol, empty if unregistered
  /// @return decimals Token decimals
  /// @return totalSupply Total Hub supply of the token
  function tokenInfo(
    string calldata chainId,
    string calldata token
  )
    external
    view
    returns (
      uint256 tokenId,
      address erc20View,
      string memory name,
      string memory symbol,
      uint8 decimals,
      uint256 totalSupply
    )
  {
    tokenId = tokenIdOf(chainId, token);
    erc20View = HUB.erc20Views(tokenId);
    name = HUB.name(tokenId);
    symbol = HUB.symbol(tokenId);
    decimals = HUB.decimals(tokenId);
    totalSupply = HUB.totalSupply(tokenId);
  }

  /// @notice Read the Hub balances credited for an origin-chain account
  /// @return aliasBalance Balance held by the alias, i.e. not yet claimed
  /// @return accountBalance Balance held directly by the Hub address derived
  /// from `account`, which only exists for 20-byte accounts
  function balanceOf(
    string calldata chainId,
    string calldata account,
    string calldata token
  ) public view returns (uint256 aliasBalance, uint256 accountBalance) {
    bytes memory accountBytes = account.encode();
    uint256 tokenId = tokenIdOf(chainId, token);
    aliasBalance = HUB.balanceOf(_aliasOf(chainId, accountBytes), tokenId);
    if (accountBytes.length == 20) {
      accountBalance = HUB.balanceOf(address(bytes20(accountBytes)), tokenId);
    }
  }

  /// @notice Read the Hub balances of one account across several currencies
  /// @return aliasBalances Balances held by the alias, indexed like `tokens`
  /// @return accountBalances Balances held by `account`, indexed like `tokens`
  function balancesOf(
    string calldata chainId,
    string calldata account,
    string[] calldata tokens
  )
    external
    view
    returns (uint256[] memory aliasBalances, uint256[] memory accountBalances)
  {
    aliasBalances = new uint256[](tokens.length);
    accountBalances = new uint256[](tokens.length);
    for (uint256 i = 0; i < tokens.length; ++i) {
      (aliasBalances[i], accountBalances[i]) = balanceOf(
        chainId,
        account,
        tokens[i]
      );
    }
  }

  /// @notice Derive the Hub alias from a chain id and encoded account
  /// @return The derived alias
  function _aliasOf(
    string calldata chainId,
    bytes memory account
  ) private pure returns (address) {
    return
      address(uint160(uint256(keccak256(abi.encodePacked(chainId, account)))));
  }
}
