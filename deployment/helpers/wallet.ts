import { AlgorandClient } from "@algorandfoundation/algokit-utils/types/algorand-client";

import { NetworkType } from "./types.ts";

export async function getAlgorandWallet(networkType: NetworkType) {
  const provider = networkType === NetworkType.MAINNET ? AlgorandClient.mainNet() : AlgorandClient.testNet();
  const account = await provider.account.fromEnvironment(
    networkType === NetworkType.MAINNET ? "ALGORAND_MAINNET_ACCOUNT" : "ALGORAND_TESTNET_ACCOUNT",
  );
  return { provider, account };
}
