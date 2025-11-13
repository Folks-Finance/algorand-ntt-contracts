import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { bytesToHex, getApplicationAddress } from "algosdk";

import { NttManagerFactory } from "../specs/client/NttManager.client.ts";
import { OpUpFactory } from "../specs/client/OpUp.client.ts";
import { convertNumberToBytes } from "../tests/utils/bytes.ts";
import {
  ALGORAND_WORMHOLE_CHAIN_ID,
  BYTES32_LENGTH,
  ONE_DAY_IN_SECONDS,
  OP_UP_APP_ID,
  TRANSCEIVER_MANAGER_APP_ID,
} from "./helpers/constants.ts";
import { loadDeployedContracts, storeDeployedContracts } from "./helpers/contracts.ts";
import { NetworkType } from "./helpers/types.ts";
import { getAlgorandWallet } from "./helpers/wallet.ts";

async function main() {
  // TODO enter your details here
  const networkType = NetworkType.TESTNET;
  const MIN_UPGRADE_DELAY = ONE_DAY_IN_SECONDS;
  const THRESHOLD = 1;

  const opUpAppId = OP_UP_APP_ID(networkType);
  const transceiverManagerAppId = TRANSCEIVER_MANAGER_APP_ID(networkType);

  // check if existing deployment already
  const contracts = loadDeployedContracts();
  if (contracts[networkType].nttManager !== undefined) {
    console.log(`Already deployed ntt manager on Algorand ${networkType}`);
    return;
  }

  // check if ntt token is deployed
  const nttTokenAppId = contracts[networkType].token?.nttTokenAppId;
  if (nttTokenAppId === undefined) {
    console.log(`Ntt token not deployed on Algorand ${networkType}`);
    return;
  }

  // fund transceiver manager
  const { provider, account } = await getAlgorandWallet(networkType);
  await provider.send.payment({
    sender: account,
    receiver: getApplicationAddress(transceiverManagerAppId),
    amount: AlgoAmount.MicroAlgo(94_500),
  });

  // connect opup
  const opUpFactory = provider.client.getTypedAppFactory(OpUpFactory, {
    defaultSender: account,
    defaultSigner: account.signer,
  });
  const opUpAppClient = opUpFactory.getAppClientById({ appId: opUpAppId });

  // deploy ntt manager
  const factory = provider.client.getTypedAppFactory(NttManagerFactory, {
    defaultSender: account,
    defaultSigner: account.signer,
  });
  const { appClient, result } = await factory.send.create.create({
    sender: account,
    args: [nttTokenAppId, ALGORAND_WORMHOLE_CHAIN_ID, THRESHOLD, MIN_UPGRADE_DELAY],
    schema: {
      globalInts: 32,
      globalByteSlices: 32,
      localInts: 8,
      localByteSlices: 8,
    },
    extraProgramPages: 3,
    extraFee: AlgoAmount.MicroAlgo(1000),
  });
  const nttManagerAppId = Number(result.appId);

  // initialise, setting deployer account as the admin
  const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(265_700);
  const fundingTxn = await provider.createTransaction.payment({
    sender: account,
    receiver: getApplicationAddress(nttManagerAppId),
    amount: APP_MIN_BALANCE,
  });
  const {
    transactions: [opUpTxn],
  } = await opUpAppClient.createTransaction.ensureBudget({
    sender: account,
    args: [0],
  });
  await appClient
    .newGroup()
    .addTransaction(opUpTxn)
    .addTransaction(fundingTxn)
    .initialise({
      args: [account.toString(), transceiverManagerAppId],
      extraFee: AlgoAmount.MicroAlgo(1000),
    })
    .send();

  // write result
  contracts[networkType].nttManager = {
    appId: nttManagerAppId,
    peerAddress: bytesToHex(convertNumberToBytes(nttManagerAppId, BYTES32_LENGTH)),
  };
  storeDeployedContracts(contracts);
}

main().catch(console.error);
