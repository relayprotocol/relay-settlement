# Security Assessments

The reports in this directory are historical assessments of the exact
repositories, commits, and files listed in each report. They do not imply that
later commits or unlisted components have been audited.

| Report                                                               | Assessment date | Reviewed revision and scope                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Certora — Relay Depository](./Certora-Relay-Depository.pdf)         | June 2025       | Relay Escrow commit `91b182a`; the Solana relay-depository and relay-forwarder programs listed in the report                                                                         |
| [Zellic — Relay Settlement](./Zellic-Relay-Settlement.pdf)           | November 2025   | Relay Depository commit `aec671d3e3e7b72135cf2d570eb6cc59e757908b` and settlement-contract commit `15ba05ba0ae1e65e1d72c4ddeb18312568802f45`; only the programs listed in the report |
| [Zellic — Relay Protocol Oracle](./Zellic-Relay-Protocol-Oracle.pdf) | April 2026      | External `relay-protocol-oracle` repository commit `7dbe806a9ee9bbc0f32df8bc7e0b6da1de253799`; `src/**/*.ts`                                                                         |

Read each report's scope, non-goals, findings, and remediation notes before
using it to assess the current system. For a new engagement, record the frozen
audit commit and complete in-scope file list separately from this historical
index.
