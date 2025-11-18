## Deployment

This folder contains the script to deploy and configure your Wormhole NTT token on Algorand. You should follow the official [Wormhole Documentation](https://wormhole.com/docs/products/token-transfers/native-token-transfers/guides/deploy-to-evm/) as a deployment guide for the other chains.

## Configuration

Create a `.env` file in the root directory with the following variables:

```
# never use production mnemonics in code or version control
ALGORAND_TESTNET_ACCOUNT_MNEMONIC="your_avm_mnemonic_here"
ALGORAND_MAINNET_ACCOUNT_MNEMONIC="your_avm_mnemonic_here"
```

## Scripts

Before running the deployment and configuration scripts, make sure your account is funded with sufficient ALGO. We recommend having at least 10 ALGO spare.

### Deployment

Follow the steps in the specified order:

1. The `TransceiverManager` has already been deployed on Mainnet at 3298383942 and Testnet at 748800766. The scripts will use these values.
2. Deploy the `NttToken` smart contract depending on if this is a new ASA or an exising ASA
   1. For a new ASA run `npm run script deployment/deployNewToken.ts`.
   2. For an existing ASA run `npm run script deployment/deployExistingToken.ts`.
      - After deployment, you should transfer the entire non-circulating supply to the NttToken contract address (named `nttTokenAppAddress` in the `contracts.json` file).
      - (Optional) you can update the ASA reserve address to be the NttToken contract address.
3. Deploy the `NttManager` smart contract `npm run script deployment/deployNttManager.ts`.
4. Deploy the `WormholeTransceiver` smart contract `npm run script deployment/deployWormholeTransceiver.ts`.

The file `deployment/out/contracts.json` will be updated with your deployed contracts.

### Configuration

The scripts we provide is only for Algorand. As the last step, you will need to add Algorand as a peer on all the chains your token is deployed on.

Follow the steps in the specified order:

1. Run `npm run script deployment/configure.ts` to complete the configuration on Algorand.
2. Add Algorand as a WormholeTransceiver peer and NttManager peer, using the generated `nttManager.peerAddress` and `wormholeTransceiver.peerAddress`. Follow the steps specified in the official [Wormhole Documentation](https://wormhole.com/docs/products/token-transfers/native-token-transfers/guides/deploy-to-evm/).
