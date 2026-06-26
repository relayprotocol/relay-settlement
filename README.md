# Relay Settlement Protocol

In this repo, you will find contracts and related libraries that are powering the Relay Decentralized Settlement protocol, with the exception of the [Relay Depository contracts](https://github.com/relayprotocol/relay-depository).

In this Settlement protocol, users are depositing funds in a depository contract on an origin chain. This deposit transaction is "tied" to a specific order id, corresponding to a unique user intent. An oracle "witnesses" this deposit and updates a ledger of all deposits that we call the Hub (`RelayHub.sol`). The oracle mints a token representing the currency deposited by the user to an account representing the user intent.

Once the user intent has been filled, the Relay solver will prompt the oracle to attest it. If the intent was successfully filled, the oracle will sign a message that the solver can then submit onchain to update the corresponding Hub balances. The funds that were allocated to the intent are transfered to the solver's address on the Hub. If the intent could not successfully filled, the funds that were allocated to the intent will be transferred back to the intent's refund address.

Eventually, the solver will withdraw funds from the Depository contracts by initiating a transfer from their balance of a given token on the Hub to a "withdrawal" address. The oracle witnesses that transfer and submits a withdrawal request on behalf of the user to the Allocator (`Allocator.sol`).

Depending on the destination chain from which the user wants to withdraw, the Allocator uses the appropriate PayloadBuilder to provides the signature for the user to finalize their withdrawal on the destination chain.
