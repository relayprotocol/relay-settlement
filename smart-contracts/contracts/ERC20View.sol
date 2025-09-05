// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHub {
  function balanceOf(address owner, uint256 id) external view returns (uint256);
  function transferFrom(
    address sender,
    address receiver,
    uint256 id,
    uint256 amount
  ) external returns (bool);
  function totalSupplies(uint256 id) external view returns (uint256);
  function name(uint256 id) external view returns (string memory);
  function symbol(uint256 id) external view returns (string memory);
  function decimals(uint256 id) external view returns (uint8);
  function tokenURI(uint256 id) external view returns (string memory);
}

contract ERC20View {
  /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

  event Approval(address indexed owner, address indexed spender, uint256 value);
  event Transfer(address indexed from, address indexed to, uint256 value);

  /*//////////////////////////////////////////////////////////////
                            CUSTOM ERRORS
    //////////////////////////////////////////////////////////////*/

  error ERC20ViewTransferFailed(
    address from,
    address to,
    uint256 tokenId,
    uint256 value
  );
  error ERC20ViewInsufficientAllowance(
    address spender,
    uint256 allowance,
    uint256 needed
  );

  /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

  IHub public immutable hub;
  uint256 public immutable tokenId;

  // ERC20 allowances mapping: owner => spender => amount
  mapping(address => mapping(address => uint256)) public allowance;

  /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

  constructor(uint256 _tokenId) {
    hub = IHub(msg.sender);
    tokenId = _tokenId;
  }

  /*//////////////////////////////////////////////////////////////
                          ERC20 IMPLEMENTATION
    //////////////////////////////////////////////////////////////*/

  function name() public view returns (string memory) {
    return hub.name(tokenId);
  }

  function symbol() public view returns (string memory) {
    return hub.symbol(tokenId);
  }

  function decimals() public view returns (uint8) {
    return hub.decimals(tokenId);
  }

  function tokenURI() public view returns (string memory) {
    return hub.tokenURI(tokenId);
  }

  function totalSupply() public view returns (uint256) {
    return hub.totalSupplies(tokenId);
  }

  function balanceOf(address account) public view returns (uint256) {
    return hub.balanceOf(account, tokenId);
  }

  function approve(address spender, uint256 value) public returns (bool) {
    allowance[msg.sender][spender] = value;
    emit Approval(msg.sender, spender, value);
    return true;
  }

  function transfer(address to, uint256 value) public returns (bool) {
    bool success = hub.transferFrom(msg.sender, to, tokenId, value);
    if (success) {
      emit Transfer(msg.sender, to, value);
    }
    return success;
  }

  function transferFrom(
    address from,
    address to,
    uint256 value
  ) public returns (bool) {
    // Check allowance unless the spender is the owner
    if (msg.sender != from) {
      uint256 currentAllowance = allowance[from][msg.sender];
      if (currentAllowance < type(uint256).max) {
        if (currentAllowance < value) {
          revert ERC20ViewInsufficientAllowance(
            msg.sender,
            currentAllowance,
            value
          );
        }
        unchecked {
          _approve(from, msg.sender, currentAllowance - value, false);
        }
      }
    }

    // Execute the transfer on the Hub
    bool success = hub.transferFrom(from, to, tokenId, value);
    if (!success) {
      revert ERC20ViewTransferFailed(from, to, tokenId, value);
    }

    emit Transfer(from, to, value);
    return success;
  }

  /**
   * @dev Sets `value` as the allowance of `spender` over the `owner`'s tokens.
   *
   * This internal function is equivalent to `approve`, and can be used to
   * e.g. set automatic allowances for certain subsystems, etc.
   *
   * Emits an {Approval} event when emitEvent is true.
   */
  function _approve(
    address owner,
    address spender,
    uint256 value,
    bool emitEvent
  ) internal {
    allowance[owner][spender] = value;
    if (emitEvent) {
      emit Approval(owner, spender, value);
    }
  }

  /*//////////////////////////////////////////////////////////////
                          HUB EVENT EMISSION
    //////////////////////////////////////////////////////////////*/

  function emitTransferEvent(address from, address to, uint256 value) external {
    if (msg.sender == address(hub)) {
      emit Transfer(from, to, value);
    }
  }
}
