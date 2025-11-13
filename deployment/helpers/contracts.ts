import { readFileSync, writeFileSync } from "node:fs";

import type { NetworkType } from "./types.ts";

const DEPLOYED_CONTRACTS_FILE_PATH = "deployment/out/contracts.json";

type NetworkContracts = {
  token?: {
    assetId: number;
    nttTokenAppId: number;
    nttTokenAppAddress: string;
  };
  nttManager?: {
    appId: number;
    peerAddress: string;
  };
  wormholeTransceiver?: {
    appId: number;
    peerAddress: string;
  };
};

type Contracts = Record<NetworkType, NetworkContracts>;

export function loadDeployedContracts(): Contracts {
  return JSON.parse(readFileSync(DEPLOYED_CONTRACTS_FILE_PATH, { encoding: "utf-8" }));
}

export function storeDeployedContracts(contents: Contracts) {
  writeFileSync(DEPLOYED_CONTRACTS_FILE_PATH, JSON.stringify(contents, null, 2) + "\n");
}
