import type { AlgorandClient } from "@algorandfoundation/algokit-utils/types/algorand-client";
import { getApplicationAddress } from "algosdk";
import { readFileSync } from "node:fs";

export async function getWormholeEmitterLSig(
  provider: AlgorandClient,
  emitterAppId: number | bigint,
  wormholeCoreAppId: number | bigint,
) {
  const { compiledBase64ToBytes: compiledEmitterLogicSig } = await provider.app.compileTealTemplate(
    readFileSync("ntt_contracts/external/wormhole/TmplSig.teal").toString(),
    {
      ADDR_IDX: 0,
      EMITTER_ID: getApplicationAddress(emitterAppId).publicKey,
      APP_ID: wormholeCoreAppId,
      APP_ADDRESS: getApplicationAddress(wormholeCoreAppId).publicKey,
    },
  );
  return provider.account.logicsig(compiledEmitterLogicSig);
}
