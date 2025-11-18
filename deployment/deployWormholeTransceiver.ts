import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { bytesToHex, getApplicationAddress } from "algosdk";

import { WormholeTransceiverFactory } from "../specs/client/WormholeTransceiver.client.ts";
import {
  ALGORAND_WORMHOLE_CHAIN_ID,
  ONE_DAY_IN_SECONDS,
  TRANSCEIVER_MANAGER_APP_ID,
  WORMHOLE_CORE_APP_ID,
} from "./helpers/constants.ts";
import { loadDeployedContracts, storeDeployedContracts } from "./helpers/contracts.ts";
import { NetworkType } from "./helpers/types.ts";
import { getAlgorandWallet } from "./helpers/wallet.ts";

async function main() {
  // TODO enter your details here
  const networkType = NetworkType.TESTNET;
  const MIN_UPGRADE_DELAY = ONE_DAY_IN_SECONDS;

  const wormholeCoreAppId = WORMHOLE_CORE_APP_ID(networkType);
  const transceiverManagerAppId = TRANSCEIVER_MANAGER_APP_ID(networkType);

  // check if existing deployment already
  const contracts = loadDeployedContracts();
  if (contracts[networkType].wormholeTransceiver !== undefined) {
    console.log(`Already deployed wormhole transceiver on Algorand ${networkType}`);
    return;
  }

  // deploy wormhole transceiver
  const { provider, account } = await getAlgorandWallet(networkType);
  const factory = provider.client.getTypedAppFactory(WormholeTransceiverFactory, {
    defaultSender: account,
    defaultSigner: account.signer,
  });

  const { appClient, result } = await factory.send.create.create({
    sender: account,
    args: [transceiverManagerAppId, wormholeCoreAppId, ALGORAND_WORMHOLE_CHAIN_ID, MIN_UPGRADE_DELAY],
    schema: {
      globalInts: 32,
      globalByteSlices: 32,
      localInts: 8,
      localByteSlices: 8,
    },
    extraProgramPages: 3,
  });
  const wormholeTransceiverAppId = Number(result.appId);

  // initialise, setting deployer account as the admin
  const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(183_100);
  const fundingTxn = await provider.createTransaction.payment({
    sender: account,
    receiver: getApplicationAddress(wormholeTransceiverAppId),
    amount: APP_MIN_BALANCE,
  });
  await appClient
    .newGroup()
    .addTransaction(fundingTxn)
    .initialise({
      args: [account.toString()],
    })
    .send();

  // write result
  contracts[networkType].wormholeTransceiver = {
    appId: wormholeTransceiverAppId,
    peerAddress: bytesToHex(getApplicationAddress(wormholeTransceiverAppId).publicKey),
  };
  storeDeployedContracts(contracts);
}

main().catch(console.error);
