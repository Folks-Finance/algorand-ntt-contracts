import { NetworkType } from "./types.ts";

export const WORMHOLE_CORE_APP_ID = (networkType: NetworkType) =>
  networkType === NetworkType.MAINNET ? 842125965n : 86525623n;

export const OP_UP_APP_ID = (networkType: NetworkType) =>
  networkType === NetworkType.MAINNET ? 3195970572n : 743583150n;

export const TRANSCEIVER_MANAGER_APP_ID = (networkType: NetworkType) =>
  networkType === NetworkType.MAINNET ? 3298383942n : 748800766n;

export const ALGORAND_WORMHOLE_CHAIN_ID = 8;

export const ONE_DAY_IN_SECONDS = 86400n;
export const MAX_UINT64 = 2n ** 64n - 1n;
export const BYTES32_LENGTH = 32;
