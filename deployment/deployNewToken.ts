import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { getApplicationAddress } from "algosdk";

import { NttTokenNewFactory } from "../specs/client/NttTokenNew.client.ts";
import { MAX_UINT64, ONE_DAY_IN_SECONDS } from "./helpers/constants.ts";
import { loadDeployedContracts, storeDeployedContracts } from "./helpers/contracts.ts";
import { NetworkType } from "./helpers/types.ts";
import { getAlgorandWallet } from "./helpers/wallet.ts";

async function main() {
  // TODO enter your details here
  const networkType = NetworkType.TESTNET;
  const MIN_UPGRADE_DELAY = ONE_DAY_IN_SECONDS;
  const TOTAL = MAX_UINT64;
  const DECIMALS = 6;
  const ASSET_NAME = "ASSET_NAME";
  const UNIT_NAME = "UNIT";
  const URL = "https://url.com";
  const METADATA_HASH = new Uint8Array(32);

  // check if existing deployment already
  const contracts = loadDeployedContracts();
  if (contracts[networkType].token !== undefined) {
    console.log(`Already deployed token on Algorand ${networkType}`);
    return;
  }

  // deploy ntt token
  const { provider, account } = await getAlgorandWallet(networkType);
  const factory = provider.client.getTypedAppFactory(NttTokenNewFactory, {
    defaultSender: account,
    defaultSigner: account.signer,
  });
  const { appClient, result } = await factory.send.create.create({
    sender: account,
    args: [MIN_UPGRADE_DELAY],
    schema: {
      globalInts: 32,
      globalByteSlices: 32,
      localInts: 8,
      localByteSlices: 8,
    },
    extraProgramPages: 3,
  });
  const nttTokenAppId = Number(result.appId);

  // initialise, setting deployer account as the admin
  const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(255_400);
  const fundingTxn = await provider.createTransaction.payment({
    sender: account,
    receiver: getApplicationAddress(nttTokenAppId),
    amount: APP_MIN_BALANCE,
  });
  const { returns } = await appClient
    .newGroup()
    .addTransaction(fundingTxn)
    .initialise({
      args: [account.toString(), TOTAL, DECIMALS, ASSET_NAME, UNIT_NAME, URL, METADATA_HASH],
      extraFee: AlgoAmount.MicroAlgo(1000),
    })
    .send();
  const assetId = Number(returns[0]);

  // write result
  contracts[networkType].token = {
    assetId,
    nttTokenAppId,
    nttTokenAppAddress: getApplicationAddress(nttTokenAppId).toString(),
  };
  storeDeployedContracts(contracts);
}

main().catch(console.error);
