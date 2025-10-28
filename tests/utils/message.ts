import { keccak_256 } from "@noble/hashes/sha3";

import type { MessageReceived, MessageToSend } from "../../specs/client/MockTransceiver.client.ts";
import { convertNumberToBytes, getRandomBytes } from "./bytes.ts";
import { unixTime } from "./time.ts";
import { MAX_UINT16, MAX_UINT64, getRandomUInt } from "./uint.ts";

export type TransceiverInstruction = [number | bigint, Uint8Array];

export function getRandomMessageToSend(override?: Partial<MessageToSend>): MessageToSend {
  return {
    id: getRandomBytes(32),
    userAddress: getRandomBytes(32),
    sourceAddress: getRandomBytes(32),
    destinationChainId: Number(getRandomUInt(MAX_UINT16)),
    handlerAddress: convertNumberToBytes(getRandomUInt(MAX_UINT64), 32),
    payload: getRandomBytes(100),
    ...(override ?? {}),
  };
}

export const WORMHOLE_TRANSCEIVER_PAYLOAD_PREFIX = Uint8Array.from(Buffer.from("9945FF10", "hex"));

export function encodeMessageToSend(message: MessageToSend): Uint8Array {
  const handlerPayload = Uint8Array.from([
    ...message.id,
    ...message.userAddress,
    ...convertNumberToBytes(message.payload.length, 2),
    ...message.payload,
  ]);
  return Uint8Array.from([
    ...WORMHOLE_TRANSCEIVER_PAYLOAD_PREFIX,
    ...message.sourceAddress,
    ...message.handlerAddress,
    ...convertNumberToBytes(handlerPayload.length, 2),
    ...handlerPayload,
    ...convertNumberToBytes(0, 2),
  ]);
}

export type WormholeVAA = {
  header: Uint8Array;
  body: Uint8Array;
  vaaBytes: Uint8Array;
  vaaDigest: Uint8Array;
};

export function getWormholeVAA(
  emitterChainId: number | bigint,
  emitterAddress: Uint8Array,
  sequence: number | bigint,
  payload: Uint8Array,
): WormholeVAA {
  const numSignatures = 13;
  const header = Uint8Array.from([
    ...convertNumberToBytes(1, 1), // version
    ...convertNumberToBytes(4, 4), // guardian set index
    ...convertNumberToBytes(numSignatures, 1), // len_signatures
    ...getRandomBytes(66 * numSignatures), // signatures
  ]);
  const body = Uint8Array.from([
    ...convertNumberToBytes(unixTime(), 4), // timestamp
    ...convertNumberToBytes(0, 4), // nonce
    ...convertNumberToBytes(emitterChainId, 2), // emitter chain
    ...emitterAddress, // emitter address
    ...convertNumberToBytes(sequence, 8), // sequence
    ...convertNumberToBytes(15, 1), // consistency level
    ...payload, // payload
  ]);
  const vaaBytes = Uint8Array.from([...header, ...body]);
  const digest = keccak_256(keccak_256(body));
  return { header, body, vaaBytes, vaaDigest: digest };
}

export function getMessageReceived(emitterChainId: number | bigint, message: MessageToSend): MessageReceived {
  return {
    id: message.id,
    userAddress: message.sourceAddress,
    sourceChainId: Number(emitterChainId),
    sourceAddress: message.sourceAddress,
    handlerAddress: message.handlerAddress,
    payload: message.payload,
  };
}

export function calculateMessageDigest(message: MessageReceived): Uint8Array {
  return keccak_256(
    Uint8Array.from([
      ...message.id,
      ...message.userAddress,
      ...convertNumberToBytes(message.sourceChainId, 2),
      ...message.sourceAddress,
      ...message.handlerAddress,
      ...convertNumberToBytes(message.payload.length, 2),
      ...message.payload,
    ]),
  );
}

const NTT_PAYLOAD_PREFIX = Uint8Array.from(Buffer.from("994E5454", "hex"));

export function getNttPayload(
  fromDecimals: number | bigint,
  fromAmount: number | bigint,
  sourceTokenAddress: Uint8Array,
  recipient: Uint8Array,
  recipientChain: number | bigint,
): Uint8Array {
  return Uint8Array.from([
    ...NTT_PAYLOAD_PREFIX,
    ...convertNumberToBytes(fromDecimals, 1),
    ...convertNumberToBytes(fromAmount, 8),
    ...sourceTokenAddress,
    ...recipient,
    ...convertNumberToBytes(recipientChain, 2),
  ]);
}
