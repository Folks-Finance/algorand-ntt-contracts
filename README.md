# algorand-ntt-contracts

## Overview

This repository contains the PuyaPy implementation for Wormhole NTT on Algorand. For the Wormhole NTT implementation on other chains, please refer to https://github.com/wormhole-foundation/native-token-transfers.

Wormhole’s Native Token Transfers (NTT) is an open, flexible, and composable framework for transferring tokens across blockchains without liquidity pools. Integrators have full control over how their Natively Transferred Tokens (NTTs) behave on each chain, including the token standard and metadata.

## Requirements

- Linux or macOS
- Python 3.12+
- AlgoKit

## Setup

To install all required packages, run:

```bash
python3 -m venv venv
source venv/bin/activate
python3 -m pip install -r requirements.txt
```

```bash
npm install
```

## Smart Contracts

The `ntt_contracts` folder contains the following:

- `ntt_contracts/external` contains the external smart contracts which are referenced but are not strictly part of the NTT implementation.
- `ntt_contracts/library` contains library smart contracts which are used. Some of these (like OpUp) are used for testing purposes.
- `ntt_contracts/ntt_manager` contains the smart contracts relating to the NTT manager, the entry point for users to transfer and receive tokens between chains.
- `ntt_contracts/ntt_token` contains the smart contracts which are used to make an ASA an NTT token.
- `ntt_contracts/transceiver` contains the smart contracts to send and receive messages between chains.

In addition, there are multiple `test` folders within the `ntt_contracts` folder which are used solely for unit testing. They should not be considered safe to use.

## Compilation

To generate the TEAL code, ARC56 specs and TS clients for the contracts, run the command:

```bash
npm run build
```

## Testing

Start an Algorand localnet with AlgoKit and Docker using:

```bash
algokit localnet start
```

Make sure to run the compilation commands before testing.

Run all tests from root directory using:

```bash
npm run test
```

or single test file using:

```bash
jest <PATH_TO_TEST_FILE>
```

It is not possible to run the tests in parallel so `--runInBand` option is passed.

If the tests are failing then a possible cause is that they are timing out before they are finished. Try increasing the timeout by either:

- Adding the option `--testTimeout=50000` to the `test` command in the `package.json`.
- Adding the option to `jest <PATH_TO_TEST_FILE> --testTimeout=50000`.
