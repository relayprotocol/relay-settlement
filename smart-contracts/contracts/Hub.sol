// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";


/// @notice Minimalist and gas efficient standard ERC6909 implementation.
/// @author Solmate (https://github.com/transmissions11/solmate/blob/main/src/tokens/ERC6909.sol)
contract Hub is AccessControl {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event OperatorSet(address indexed owner, address indexed operator, bool approved);

    event Approval(address indexed owner, address indexed spender, uint256 indexed id, uint256 amount);

    event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                             ERC6909 STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address => mapping(address => bool)) internal _isOperator;

    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    mapping(address => mapping(address => mapping(uint256 => uint256))) public allowance;

    /*//////////////////////////////////////////////////////////////
                             ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant HUB_ORACLE_ROLE = keccak256("HUB_ORACLE_ROLE");

    bytes32 public constant HUB_ORACLE_ADMIN_ROLE = keccak256("HUB_ORACLE_ADMIN_ROLE");
    
    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address adminAddress) {
        _setRoleAdmin(HUB_ORACLE_ROLE, HUB_ORACLE_ADMIN_ROLE);
        _grantRole(HUB_ORACLE_ADMIN_ROLE, adminAddress);
    }

    /*//////////////////////////////////////////////////////////////
                        ROLES LOGIC
    //////////////////////////////////////////////////////////////*/
    function addOracle(address account) public onlyRole(HUB_ORACLE_ADMIN_ROLE) {
        _grantRole(HUB_ORACLE_ROLE, account);
    }

    function removeOracle(address account) public onlyRole(HUB_ORACLE_ADMIN_ROLE) {
        _revokeRole(HUB_ORACLE_ROLE, account);
    }

    /*//////////////////////////////////////////////////////////////

                              ERC6909 LOGIC
    //////////////////////////////////////////////////////////////*/

    function isOperator(address account, address operator) public view returns (bool) {
        return hasRole(HUB_ORACLE_ROLE, account) || _isOperator[account][operator];
    }


    // @notice Internal function to set an operator for an account    
    function _setOperatorFor(address account, address operator, bool approved) internal returns (bool result) {
        _isOperator[account][operator] = approved;
        emit OperatorSet(account, operator, approved);
        return true;
    }

    function setOperatorFor(address account, address operator, bool approved) public onlyRole(HUB_ORACLE_ROLE) returns (bool result) {
        return _setOperatorFor(account, operator, approved);
    }

    function setOperator(address operator, bool approved) public returns (bool result) {
        return _setOperatorFor(msg.sender, operator, approved);
    }

    function transfer(
        address receiver,
        uint256 id,
        uint256 amount
    ) public returns (bool result) {
        balanceOf[msg.sender][id] -= amount;

        balanceOf[receiver][id] += amount;

        emit Transfer(msg.sender, msg.sender, receiver, id, amount);

        return true;
    }

    function transferFrom(
        address sender,
        address receiver,
        uint256 id,
        uint256 amount
    ) public returns (bool result) {
        if (msg.sender != sender && !isOperator(sender, msg.sender)) {
            uint256 allowed = allowance[sender][msg.sender][id];
            if (allowed != type(uint256).max) allowance[sender][msg.sender][id] = allowed - amount;
        }

        balanceOf[sender][id] -= amount;

        balanceOf[receiver][id] += amount;

        emit Transfer(msg.sender, sender, receiver, id, amount);

        return true;
    }

    function approve(
        address spender,
        uint256 id,
        uint256 amount
    ) public returns (bool result) {
        allowance[msg.sender][spender][id] = amount;

        emit Approval(msg.sender, spender, id, amount);

        return true;
    }

    

    function mint(
        address receiver,
        uint256 id,
        uint256 amount
    ) public onlyRole(HUB_ORACLE_ROLE) returns (bool result) {
        _mint(receiver, id, amount);
        return true;
    }

    function burn(
        address sender,
        uint256 id,
        uint256 amount
    ) public onlyRole(HUB_ORACLE_ROLE) returns (bool result) {
        _burn(sender, id, amount);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                              ERC165 LOGIC
    //////////////////////////////////////////////////////////////*/


    function supportsInterface(bytes4 interfaceId) public pure override(AccessControl) returns (bool result) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165 Interface ID for ERC165
            interfaceId == 0x0f632fb3; // ERC165 Interface ID for ERC6909
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL MINT/BURN LOGIC
    //////////////////////////////////////////////////////////////*/

    function _mint(
        address receiver,
        uint256 id,
        uint256 amount
    ) internal {
        balanceOf[receiver][id] += amount;

        emit Transfer(msg.sender, address(0), receiver, id, amount);
    }

    function _burn(
        address sender,
        uint256 id,
        uint256 amount
    ) internal {
        balanceOf[sender][id] -= amount;

        emit Transfer(msg.sender, sender, address(0), id, amount);
    }
}