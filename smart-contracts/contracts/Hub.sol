// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Strings.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./ERC20View.sol";

/// @title IERC20View
/// @author Relay Protocol
/// @notice Interface for ERC20View contract
interface IERC20View {
  /// @notice Emits a transfer event
  /// @param from The sender address
  /// @param to The recipient address
  /// @param value The amount transferred
  function emitTransferEvent(address from, address to, uint256 value) external;
}

/// @title Hub
/// @author Relay Protocol
/// @notice Based on Solmate standard ERC6909 implementation. (https://github.com/transmissions11/solmate/blob/main/src/tokens/ERC6909.sol)
contract Hub is AccessControl {
  using Strings for uint256;

  /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when an operator is set for an owner
  event OperatorSet(
    address indexed owner,
    address indexed operator,
    bool approved
  );

  /// @notice Emitted when an approval is made
  event Approval(
    address indexed owner,
    address indexed spender,
    uint256 indexed id,
    uint256 amount
  );

  /// @notice Emitted when a transfer occurs
  event Transfer(
    address caller,
    address indexed from,
    address indexed to,
    uint256 indexed id,
    uint256 amount
  );

  struct TokenMetadata {
    string name;
    string symbol;
    uint8 decimals;
  }

  /*//////////////////////////////////////////////////////////////
                             ERC6909 STORAGE
    //////////////////////////////////////////////////////////////*/

  mapping(address => mapping(address => bool)) internal _isOperator;

  /// @notice Mapping of owner to token ID to balance
  mapping(address => mapping(uint256 => uint256)) public balanceOf;

  /// @notice Mapping of owner to spender to token ID to allowance
  mapping(address => mapping(address => mapping(uint256 => uint256)))
    public allowance;

  /// @notice Mapping of token ID to total supply
  mapping(uint256 => uint256) public totalSupplies;

  /*//////////////////////////////////////////////////////////////
                          ERC20VIEW STORAGE
    //////////////////////////////////////////////////////////////*/

  // tokenId => ERC20View address
  /// @notice Mapping of token ID to ERC20View contract address
  mapping(uint256 => address) public erc20Views;

  /*//////////////////////////////////////////////////////////////
                        ERC20VIEW EVENTS
    //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when an ERC20View is created
  event ERC20ViewCreated(uint256 indexed tokenId, address indexed erc20View);
  /// @notice Mapping of token ID to token metadata
  mapping(uint256 => TokenMetadata) public tokenMetadata;

  /// @notice Contract URI for metadata
  string public contractURI = "";

  /*//////////////////////////////////////////////////////////////
                             ROLES
    //////////////////////////////////////////////////////////////*/

  /// @notice Role for operators
  bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
  /// @notice Role for editors
  bytes32 public constant EDITOR_ROLE = keccak256("EDITOR_ROLE");
  /// @notice Role for administrators
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

  /// @notice Constructor for Hub contract
  /// @param adminAddress The address to grant admin role
  constructor(address adminAddress) {
    _setRoleAdmin(OPERATOR_ROLE, ADMIN_ROLE);
    _setRoleAdmin(EDITOR_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, adminAddress);
  }

  /*//////////////////////////////////////////////////////////////
                              ERC6909 LOGIC
    //////////////////////////////////////////////////////////////*/

  /// @notice Checks if an address is an operator for an account
  /// @param account The account address
  /// @param operator The operator address
  /// @return True if the operator is authorized
  function isOperator(
    address account,
    address operator
  ) public view returns (bool) {
    return hasRole(OPERATOR_ROLE, operator) || _isOperator[account][operator];
  }

  /// @notice Internal function to set an operator for an account
  /// @param account The account address
  /// @param operator The operator address
  /// @param approved Whether to approve the operator
  /// @return result True if successful
  function _setOperatorFor(
    address account,
    address operator,
    bool approved
  ) internal returns (bool result) {
    _isOperator[account][operator] = approved;
    emit OperatorSet(account, operator, approved);
    return true;
  }

  /// @notice Sets an operator for an account (only callable by OPERATOR_ROLE)
  /// @param account The account address
  /// @param operator The operator address
  /// @param approved Whether to approve the operator
  /// @return result True if successful
  function setOperatorFor(
    address account,
    address operator,
    bool approved
  ) public onlyRole(OPERATOR_ROLE) returns (bool result) {
    return _setOperatorFor(account, operator, approved);
  }

  /// @notice Sets an operator for the caller
  /// @param operator The operator address
  /// @param approved Whether to approve the operator
  /// @return result True if successful
  function setOperator(
    address operator,
    bool approved
  ) public returns (bool result) {
    return _setOperatorFor(msg.sender, operator, approved);
  }

  /// @notice Transfers tokens to another address
  /// @param receiver The recipient address
  /// @param id The token ID
  /// @param amount The amount to transfer
  /// @return result True if successful
  function transfer(
    address receiver,
    uint256 id,
    uint256 amount
  ) public returns (bool result) {
    balanceOf[msg.sender][id] -= amount;

    balanceOf[receiver][id] += amount;

    emit Transfer(msg.sender, msg.sender, receiver, id, amount);
    _emitERC20ViewEvent(id, msg.sender, receiver, amount);

    return true;
  }

  /// @notice Transfers tokens from one address to another
  /// @param sender The sender address
  /// @param receiver The recipient address
  /// @param id The token ID
  /// @param amount The amount to transfer
  /// @return result True if successful
  function transferFrom(
    address sender,
    address receiver,
    uint256 id,
    uint256 amount
  ) public returns (bool result) {
    if (
      msg.sender != sender &&
      !isOperator(sender, msg.sender) &&
      erc20Views[id] != msg.sender
    ) {
      uint256 allowed = allowance[sender][msg.sender][id];
      if (allowed != type(uint256).max)
        allowance[sender][msg.sender][id] = allowed - amount;
    }

    balanceOf[sender][id] -= amount;

    balanceOf[receiver][id] += amount;

    emit Transfer(msg.sender, sender, receiver, id, amount);
    _emitERC20ViewEvent(id, sender, receiver, amount);

    return true;
  }

  /// @notice Approves a spender to spend tokens
  /// @param spender The spender address
  /// @param id The token ID
  /// @param amount The amount to approve
  /// @return result True if successful
  function approve(
    address spender,
    uint256 id,
    uint256 amount
  ) public returns (bool result) {
    allowance[msg.sender][spender][id] = amount;

    emit Approval(msg.sender, spender, id, amount);

    return true;
  }

  /// @notice Mints tokens to a receiver (only callable by OPERATOR_ROLE)
  /// @param receiver The recipient address
  /// @param id The token ID
  /// @param amount The amount to mint
  /// @return result True if successful
  function mint(
    address receiver,
    uint256 id,
    uint256 amount
  ) public onlyRole(OPERATOR_ROLE) returns (bool result) {
    _mint(receiver, id, amount);
    return true;
  }

  /// @notice Burns tokens from a sender (only callable by OPERATOR_ROLE)
  /// @param sender The sender address
  /// @param id The token ID
  /// @param amount The amount to burn
  /// @return result True if successful
  function burn(
    address sender,
    uint256 id,
    uint256 amount
  ) public onlyRole(OPERATOR_ROLE) returns (bool result) {
    _burn(sender, id, amount);
    return true;
  }

  /// @notice Sets token metadata (only callable by EDITOR_ROLE)
  /// @param id The token ID
  /// @param metadata The token metadata
  function setTokenMetadata(
    uint256 id,
    TokenMetadata calldata metadata
  ) public onlyRole(EDITOR_ROLE) {
    tokenMetadata[id] = metadata;
  }

  /// @notice Returns the name of a token
  /// @param id The token ID
  /// @return The token name
  function name(uint256 id) public view returns (string memory) {
    return tokenMetadata[id].name;
  }

  /// @notice Returns the symbol of a token
  /// @param id The token ID
  /// @return The token symbol
  function symbol(uint256 id) public view returns (string memory) {
    return tokenMetadata[id].symbol;
  }

  /// @notice Returns the decimals of a token
  /// @param id The token ID
  /// @return The token decimals
  function decimals(uint256 id) public view returns (uint8) {
    if (tokenMetadata[id].decimals == 0) {
      return 18;
    }
    return tokenMetadata[id].decimals;
  }

  /// @notice Sets the contract URI (only callable by EDITOR_ROLE)
  /// @param uri The contract URI
  function setContractURI(string calldata uri) public onlyRole(EDITOR_ROLE) {
    contractURI = uri;
  }

  /// @notice Returns the token URI
  /// @param id The token ID
  /// @return The token URI
  function tokenURI(uint256 id) public view returns (string memory) {
    return string.concat(contractURI, "/", id.toString());
  }

  /*//////////////////////////////////////////////////////////////
                              ERC165 LOGIC
    //////////////////////////////////////////////////////////////*/

  /// @notice Checks if the contract supports an interface
  /// @param interfaceId The interface ID to check
  /// @return result True if the interface is supported
  function supportsInterface(
    bytes4 interfaceId
  ) public pure override(AccessControl) returns (bool result) {
    return
      interfaceId == 0x01ffc9a7 || // ERC165 Interface ID for ERC165
      interfaceId == 0x0f632fb3; // ERC165 Interface ID for ERC6909
  }

  /*//////////////////////////////////////////////////////////////
                        INTERNAL MINT/BURN LOGIC
    //////////////////////////////////////////////////////////////*/

  /// @notice Internal function to mint tokens
  /// @param receiver The recipient address
  /// @param id The token ID
  /// @param amount The amount to mint
  function _mint(address receiver, uint256 id, uint256 amount) internal {
    balanceOf[receiver][id] += amount;
    if (totalSupplies[id] == 0) {
      _createERC20View(id);
    }
    totalSupplies[id] += amount;

    emit Transfer(msg.sender, address(0), receiver, id, amount);
    _emitERC20ViewEvent(id, address(0), receiver, amount);
  }

  /// @notice Internal function to burn tokens
  /// @param sender The sender address
  /// @param id The token ID
  /// @param amount The amount to burn
  function _burn(address sender, uint256 id, uint256 amount) internal {
    balanceOf[sender][id] -= amount;
    totalSupplies[id] -= amount;

    emit Transfer(msg.sender, sender, address(0), id, amount);
    _emitERC20ViewEvent(id, sender, address(0), amount);
  }

  /*//////////////////////////////////////////////////////////////
                            INTERNAL HELPERS
  //////////////////////////////////////////////////////////////*/

  /// @notice Internal function to emit ERC20View events
  /// @param id The token ID
  /// @param from The sender address
  /// @param to The recipient address
  /// @param amount The amount transferred
  function _emitERC20ViewEvent(
    uint256 id,
    address from,
    address to,
    uint256 amount
  ) internal {
    address erc20ViewAddress = erc20Views[id];
    if (msg.sender != erc20ViewAddress) {
      IERC20View(erc20ViewAddress).emitTransferEvent(from, to, amount);
    }
  }

  /// @notice Internal function to create an ERC20View contract
  /// @param tokenId The token ID
  /// @return The address of the created ERC20View contract
  function _createERC20View(uint256 tokenId) internal returns (address) {
    if (erc20Views[tokenId] != address(0)) {
      return erc20Views[tokenId];
    }

    ERC20View erc20View = new ERC20View(tokenId);

    address erc20ViewAddress = address(erc20View);
    erc20Views[tokenId] = erc20ViewAddress;

    emit ERC20ViewCreated(tokenId, erc20ViewAddress);
    return erc20ViewAddress;
  }
}
