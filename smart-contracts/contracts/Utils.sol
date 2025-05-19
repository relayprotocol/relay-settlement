pragma solidity ^0.8.28;
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

library Utils {
  /**
   * @notice Generates a unique ID for a  based on the family (type of chain), chain ID, and account
   * @param family The blockchain family ('evm', 'solana', 'bitcoin')
   * @param chainId The ID of the blockchain network
   * @param token The token address or identifier
   * @dev We pass the token as a string to support identifiers from non-EVM chains.
   * EVM-chains addresses are casted to address type.
   * @return A bytes32 hash representing the unique token ID
   */
  function generateTokenId(
    string memory family,
    uint256 chainId,
    string memory token
  ) external pure returns (uint256) {
    if (Strings.equal(family, "evm")) {
      return
        uint256(
          keccak256(
            abi.encodePacked(family, chainId, Strings.parseAddress(token))
          )
        );
    }
    return uint256(keccak256(abi.encodePacked(family, chainId, token)));
  }


  /**
   * @notice Generates a virtual address for a given family, chain ID, and account
   * @param family The blockchain family ('evm', 'solana', 'bitcoin')
   * @param chainId The ID of the blockchain network
   * @param account The account address or identifier
   * @return A virtual address derived from the token ID
   */
  function generateAddress(string memory family, uint256 chainId, string memory account) external pure returns (address) {
     bytes32 addressHash = Strings.equal(family, "evm") ?
      keccak256(
        abi.encodePacked(family, chainId, Strings.parseAddress(account))
      )
      :
      keccak256(abi.encodePacked(family, chainId, account));

     return address(uint160(uint256(addressHash)));
  }
}
