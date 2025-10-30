// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHub
/// @author Relay Protocol
/// @notice Interface for the Hub contract
interface IHub {
  /// @notice Returns the balance of a token for an owner
  /// @param owner The owner address
  /// @param id The token ID
  /// @return The balance amount
  function balanceOf(address owner, uint256 id) external view returns (uint256);

  /// @notice Transfers tokens from one address to another
  /// @param sender The sender address
  /// @param receiver The receiver address
  /// @param id The token ID
  /// @param amount The amount to transfer
  /// @return True if successful
  function transferFrom(
    address sender,
    address receiver,
    uint256 id,
    uint256 amount
  ) external returns (bool);

  /// @notice Returns the total supply of a token
  /// @param id The token ID
  /// @return The total supply
  function totalSupply(uint256 id) external view returns (uint256);

  /// @notice Returns the name of a token
  /// @param id The token ID
  /// @return The token name
  function name(uint256 id) external view returns (string memory);

  /// @notice Returns the symbol of a token
  /// @param id The token ID
  /// @return The token symbol
  function symbol(uint256 id) external view returns (string memory);

  /// @notice Returns the decimals of a token
  /// @param id The token ID
  /// @return The token decimals
  function decimals(uint256 id) external view returns (uint8);

  /// @notice Returns the token URI of a token
  /// @param id The token ID
  /// @return The token URI
  function tokenURI(uint256 id) external view returns (string memory);

  /// @notice Returns the allowance of a spender for an owner
  /// @param owner The owner address
  /// @param spender The spender address
  /// @param id The token ID
  /// @return The allowance amount
  function allowance(
    address owner,
    address spender,
    uint256 id
  ) external view returns (uint256);

  /// @notice Approves a spender to spend tokens on behalf of owner
  /// @param owner The owner address
  /// @param spender The spender address
  /// @param id The token ID
  /// @param amount The amount to approve
  /// @return True if successful
  function approveFor(
    address owner,
    address spender,
    uint256 id,
    uint256 amount
  ) external returns (bool);
}

/// @title ERC20View
/// @author Relay Protocol
/// @notice ERC20-compatible view contract that interfaces with the Hub
contract ERC20View {
  /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when an approval is made
  event Approval(address indexed owner, address indexed spender, uint256 value);
  /// @notice Emitted when a transfer occurs
  event Transfer(address indexed from, address indexed to, uint256 value);

  /*//////////////////////////////////////////////////////////////
                            CUSTOM ERRORS
    //////////////////////////////////////////////////////////////*/

  error ERC20ViewInsufficientAllowance(
    address spender,
    uint256 allowance,
    uint256 needed
  );

  /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

  /// @notice The Hub contract instance
  IHub public immutable hub;
  /// @notice The token ID this view represents
  uint256 public immutable tokenId;

  /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

  /// @notice Constructor for ERC20View
  /// @param _tokenId The token ID this view represents
  constructor(uint256 _tokenId) {
    hub = IHub(msg.sender);
    tokenId = _tokenId;
  }

  /*//////////////////////////////////////////////////////////////
                          ERC20 IMPLEMENTATION
    //////////////////////////////////////////////////////////////*/

  /// @notice Returns the name of the token
  /// @return The token name
  function name() public view returns (string memory) {
    return hub.name(tokenId);
  }

  /// @notice Returns the symbol of the token
  /// @return The token symbol
  function symbol() public view returns (string memory) {
    return hub.symbol(tokenId);
  }

  /// @notice Returns the decimals of the token
  /// @return The token decimals
  function decimals() public view returns (uint8) {
    return hub.decimals(tokenId);
  }

  /// @notice Returns the token URI
  /// @return The token URI
  function tokenURI() public view returns (string memory) {
    return hub.tokenURI(tokenId);
  }

  /// @notice Returns the total supply of the token
  /// @return The total supply
  function totalSupply() public view returns (uint256) {
    return hub.totalSupply(tokenId);
  }

  /// @notice Returns the balance of an account
  /// @param account The account address
  /// @return The balance amount
  function balanceOf(address account) public view returns (uint256) {
    return hub.balanceOf(account, tokenId);
  }

  /// @notice Returns the allowance amount for a spender
  /// @param owner The owner address
  /// @param spender The spender address
  /// @return The allowance amount
  function allowance(
    address owner,
    address spender
  ) public view returns (uint256) {
    return hub.allowance(owner, spender, tokenId);
  }

  /// @notice Approves a spender to spend tokens
  /// @param spender The spender address
  /// @param value The amount to approve
  /// @return True if successful
  function approve(address spender, uint256 value) public returns (bool) {
    bool success = hub.approveFor(msg.sender, spender, tokenId, value);
    if (success) {
      emit Approval(msg.sender, spender, value);
    }
    return success;
  }

  /// @notice Transfers tokens to another address
  /// @param to The recipient address
  /// @param value The amount to transfer
  /// @return True if successful
  function transfer(address to, uint256 value) public returns (bool) {
    bool success = hub.transferFrom(msg.sender, to, tokenId, value);
    if (success) {
      emit Transfer(msg.sender, to, value);
    }
    return success;
  }

  /// @notice Transfers tokens from one address to another
  /// @param from The sender address
  /// @param to The recipient address
  /// @param value The amount to transfer
  /// @return True if successful
  function transferFrom(
    address from,
    address to,
    uint256 value
  ) public returns (bool) {
    // Check allowance unless the spender is the owner
    if (msg.sender != from) {
      uint256 currentAllowance = hub.allowance(from, msg.sender, tokenId);
      if (currentAllowance < type(uint256).max) {
        if (currentAllowance < value) {
          revert ERC20ViewInsufficientAllowance(
            msg.sender,
            currentAllowance,
            value
          );
        }
        hub.approveFor(from, msg.sender, tokenId, currentAllowance - value);
      }
    }

    // Execute the transfer on the Hub
    bool success = hub.transferFrom(from, to, tokenId, value);
    if (success) {
      emit Transfer(from, to, value);
    }
    return success;
  }

  /*//////////////////////////////////////////////////////////////
                          HUB EVENT EMISSION
    //////////////////////////////////////////////////////////////*/

  /// @notice Emits a transfer event (only callable by the hub)
  /// @param from The sender address
  /// @param to The recipient address
  /// @param value The amount transferred
  function emitTransferEvent(address from, address to, uint256 value) external {
    if (msg.sender == address(hub)) {
      emit Transfer(from, to, value);
    }
  }

  /// @notice Emits an approval event (only callable by the hub)
  /// @param owner The owner address
  /// @param spender The spender address
  /// @param value The approved amount
  function emitApprovalEvent(
    address owner,
    address spender,
    uint256 value
  ) external {
    if (msg.sender == address(hub)) {
      emit Approval(owner, spender, value);
    }
  }
}
