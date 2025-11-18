import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { keccak_256 } from "@noble/hashes/sha3";
import { OnApplicationComplete, getApplicationAddress } from "algosdk";

import { NttManagerFactory } from "../specs/client/NttManager.client.ts";
import { NttTokenNewFactory } from "../specs/client/NttTokenNew.client.ts";
import { TransceiverManagerFactory } from "../specs/client/TransceiverManager.client.ts";
import { WormholeTransceiverFactory } from "../specs/client/WormholeTransceiver.client.ts";
import { convertNumberToBytes } from "../tests/utils/bytes.ts";
import {
  BYTES32_LENGTH,
  ONE_DAY_IN_SECONDS,
  TRANSCEIVER_MANAGER_APP_ID,
  WORMHOLE_CORE_APP_ID,
} from "./helpers/constants.ts";
import { loadDeployedContracts } from "./helpers/contracts.ts";
import { NetworkType, type NttPeerChain } from "./helpers/types.ts";
import { isHex } from "./helpers/utils.ts";
import { getAlgorandWallet } from "./helpers/wallet.ts";
import { getWormholeEmitterLSig } from "./helpers/wormhole.ts";

const MINTER_ROLE = keccak_256(new TextEncoder().encode("MINTER")).slice(0, 16);

function getInboundBucketIdBytes(chainId: number | bigint): Uint8Array {
  return keccak_256(Uint8Array.from([...new TextEncoder().encode("INBOUND_"), ...convertNumberToBytes(chainId, 2)]));
}

function getOutboundBucketIdBytes(): Uint8Array {
  return keccak_256(new TextEncoder().encode("OUTBOUND"));
}

async function main() {
  // TODO enter your details here
  const networkType = NetworkType.TESTNET;
  const OUTBOUND_DURATION = ONE_DAY_IN_SECONDS;
  const OUTBOUND_LIMIT = 1_000_000_000_000n;
  const INBOUND_DURATION = ONE_DAY_IN_SECONDS;
  const INBOUND_LIMIT = 1_000_000_000_000n;
  const DECIMALS = 6;
  const peers: NttPeerChain[] = [];

  const wormholeCoreAppId = WORMHOLE_CORE_APP_ID(networkType);
  const transceiverManagerAppId = TRANSCEIVER_MANAGER_APP_ID(networkType);

  // check if deployment exists
  const contracts = loadDeployedContracts();
  const { token, nttManager, wormholeTransceiver } = contracts[networkType];
  if (!token || nttManager === undefined || !wormholeTransceiver) {
    console.log(`Contract not deployed on Algorand ${networkType}`);
    return;
  }

  // connect to contracts
  const { provider, account } = await getAlgorandWallet(networkType);
  const nttTokenClient = provider.client
    .getTypedAppFactory(NttTokenNewFactory, {
      defaultSender: account,
      defaultSigner: account.signer,
    })
    .getAppClientById({ appId: BigInt(token.nttTokenAppId) });
  const nttManagerClient = provider.client
    .getTypedAppFactory(NttManagerFactory, {
      defaultSender: account,
      defaultSigner: account.signer,
    })
    .getAppClientById({ appId: BigInt(nttManager.appId) });
  const transceiverManagerClient = provider.client
    .getTypedAppFactory(TransceiverManagerFactory, {
      defaultSender: account,
      defaultSigner: account.signer,
    })
    .getAppClientById({ appId: transceiverManagerAppId });
  const wormholeTransceiverClient = provider.client
    .getTypedAppFactory(WormholeTransceiverFactory, {
      defaultSender: account,
      defaultSigner: account.signer,
    })
    .getAppClientById({ appId: BigInt(wormholeTransceiver.appId) });

  // grant minter role to ntt manager in ntt token
  const minter = getApplicationAddress(nttManager.appId).toString();
  const hasMinterRole = await nttTokenClient.hasRole({ args: [MINTER_ROLE, minter] });
  if (hasMinterRole) {
    console.log(`Already granted minter role to ntt manager on Algorand ${networkType}`);
  } else {
    const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(27_700);
    const fundingTxn = await provider.createTransaction.payment({
      sender: account,
      receiver: getApplicationAddress(token.nttTokenAppId),
      amount: APP_MIN_BALANCE,
    });
    await nttTokenClient
      .newGroup()
      .addTransaction(fundingTxn)
      .setMinter({ args: [minter] })
      .send();
    console.log(`Granted minter role to ntt manager on Algorand ${networkType}`);
  }

  // set transceiver for ntt manager in transceiver manager
  const isTransceiverSet = await transceiverManagerClient.isTransceiverConfigured({
    args: [nttManager.appId, wormholeTransceiver.appId],
  });
  if (isTransceiverSet) {
    console.log(`Already set transceiver on Algorand ${networkType}`);
  } else {
    const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(3_200);
    const fundingTxn = await provider.createTransaction.payment({
      sender: account,
      receiver: getApplicationAddress(transceiverManagerAppId),
      amount: APP_MIN_BALANCE,
    });
    await transceiverManagerClient
      .newGroup()
      .addTransaction(fundingTxn)
      .addTransceiver({
        sender: account,
        args: [nttManager.appId, wormholeTransceiver.appId],
      })
      .send();
    console.log(`Set transceiver on Algorand ${networkType}`);
  }

  // set outbound rate duration in ntt manager
  const currentOutboundDuration = await nttManagerClient.getRateDuration({ args: [getOutboundBucketIdBytes()] });
  if (currentOutboundDuration === OUTBOUND_DURATION) {
    console.log(`Already set outbound rate duration on Algorand ${networkType}`);
  } else {
    await nttManagerClient.send.setOutboundRateDuration({
      sender: account,
      args: [OUTBOUND_DURATION],
    });
    console.log(`Set outbound rate duration on Algorand ${networkType}`);
  }

  // set outbound rate limit in ntt manager
  const currentOutboundLimit = await nttManagerClient.getRateLimit({ args: [getOutboundBucketIdBytes()] });
  if (currentOutboundLimit === OUTBOUND_LIMIT) {
    console.log(`Already set outbound rate limit on Algorand ${networkType}`);
  } else {
    await nttManagerClient.send.setOutboundRateLimit({
      sender: account,
      args: [OUTBOUND_LIMIT],
    });
    console.log(`Set outbound rate limit on Algorand ${networkType}`);
  }

  // fund emitter lsig and opt into wormhole core
  const emitterLogicSig = await getWormholeEmitterLSig(provider, wormholeTransceiver.appId, wormholeCoreAppId);
  const localStates = await provider.client.indexer.lookupAccountAppLocalStates(emitterLogicSig).do();
  const isOptedIn = localStates.appsLocalStates.some((app) => app.id === wormholeCoreAppId);
  if (isOptedIn) {
    console.log(`Already opted emitter lsig into wormhole core on Algorand ${networkType}`);
  } else {
    const fundingTxn = await provider.createTransaction.payment({
      sender: account,
      receiver: emitterLogicSig,
      amount: AlgoAmount.MicroAlgo(1_002_000),
      extraFee: AlgoAmount.MicroAlgo(1000),
    });
    const optIntoAppTxn = await provider.createTransaction.appCall({
      sender: emitterLogicSig,
      appId: wormholeCoreAppId,
      onComplete: OnApplicationComplete.OptInOC,
      rekeyTo: getApplicationAddress(wormholeCoreAppId),
      staticFee: AlgoAmount.MicroAlgo(0),
    });
    await provider.newGroup().addTransaction(fundingTxn).addTransaction(optIntoAppTxn).send();
    console.log(`Opted emitter lsig into wormhole core on Algorand ${networkType}`);
  }

  // add peers
  for (const peer of peers) {
    if (!isHex(peer.wormholeTransceiver, BYTES32_LENGTH) || !isHex(peer.nttManager, BYTES32_LENGTH)) {
      console.log(`Peer ${peer.wormholeChainId} addresses must be a 32 byte hex`);
      return;
    }

    // set wormhole transceiver peer
    let currentWormholePeer;
    try {
      const wormholePeer = await wormholeTransceiverClient.getWormholePeer({ args: [peer.wormholeChainId] });
      currentWormholePeer = `0x${Buffer.from(wormholePeer).toString("hex")}`;
    } catch (e) {}
    if (currentWormholePeer === peer.wormholeTransceiver) {
      console.log(
        `Already set wormhole transceiver peer for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`,
      );
    } else {
      const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(78_200);
      const fundingTxn = await provider.createTransaction.payment({
        sender: account,
        receiver: getApplicationAddress(wormholeTransceiver.appId),
        amount: APP_MIN_BALANCE,
      });
      await wormholeTransceiverClient
        .newGroup()
        .addTransaction(fundingTxn)
        .setWormholePeer({
          sender: account,
          args: [peer.wormholeChainId, Uint8Array.from(Buffer.from(peer.wormholeTransceiver.slice(2), "hex"))],
        })
        .send();
      console.log(
        `Set wormhole transceiver peer for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`,
      );
    }

    // set ntt manager peer
    let currentNttManagerPeer;
    try {
      const nttManagerPeer = await nttManagerClient.getNttManagerPeer({ args: [peer.wormholeChainId] });
      currentNttManagerPeer = `0x${Buffer.from(nttManagerPeer.peerContract).toString("hex")}`;
    } catch (e) {}
    if (currentNttManagerPeer === peer.nttManager) {
      console.log(`Already set ntt manager peer for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`);
    } else {
      const APP_MIN_BALANCE = AlgoAmount.MicroAlgo(78_200);
      const fundingTxn = await provider.createTransaction.payment({
        sender: account,
        receiver: getApplicationAddress(nttManager.appId),
        amount: APP_MIN_BALANCE,
      });
      await nttManagerClient
        .newGroup()
        .addTransaction(fundingTxn)
        .setNttManagerPeer({
          sender: account,
          args: [peer.wormholeChainId, Uint8Array.from(Buffer.from(peer.nttManager.slice(2), "hex")), DECIMALS],
        })
        .send();
      console.log(`Set ntt manager peer for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`);
    }

    // set inbound rate duration in ntt manager
    const currentInboundDuration = await nttManagerClient.getRateDuration({
      args: [getInboundBucketIdBytes(peer.wormholeChainId)],
    });
    if (currentInboundDuration === INBOUND_DURATION) {
      console.log(
        `Already set inbound rate duration for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`,
      );
    } else {
      await nttManagerClient.send.setInboundRateDuration({
        sender: account,
        args: [peer.wormholeChainId, INBOUND_DURATION],
      });
      console.log(`Set inbound rate duration for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`);
    }

    // set inbound rate limit in ntt manager
    const currentInboundLimit = await nttManagerClient.getRateLimit({
      args: [getInboundBucketIdBytes(peer.wormholeChainId)],
    });
    if (currentInboundLimit === INBOUND_LIMIT) {
      console.log(
        `Already set inbound rate limit for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`,
      );
    } else {
      await nttManagerClient.send.setInboundRateLimit({
        sender: account,
        args: [peer.wormholeChainId, INBOUND_LIMIT],
      });
      console.log(`Set inbound rate limit for wormhole chain ${peer.wormholeChainId} on Algorand ${networkType}`);
    }
  }
}

main().catch(console.error);
