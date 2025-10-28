import { type ABIStruct, getABIEncodedValue } from "@algorandfoundation/algokit-utils/types/app-arc56";
import { sha512_256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { type ABIValue } from "algosdk";

export const enc = new TextEncoder();

export function getRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function convertNumberToBytes(num: number | bigint, length: number): Uint8Array {
  // handle edge case of zero length
  if (length === 0) return Uint8Array.from([]);

  // insert 0s at the beginning if data is smaller than length bytes
  const buf = Buffer.alloc(length, 0);

  // convert num to bytes
  const hex = num.toString(16);
  const isEven = hex.length % 2 === 0;
  const bytes = Buffer.from(isEven ? hex : "0" + hex, "hex");

  // write bytes to fixed length buf
  bytes.copy(buf, buf.length - bytes.length);
  return Uint8Array.from(buf);
}

export function convertBytesToNumber(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

export function convertBooleanToByte(bool: boolean): Uint8Array {
  return Uint8Array.from([bool ? 1 : 0]);
}

export function getRoleBytes(identifier: string): Uint8Array {
  return keccak_256(enc.encode(identifier)).slice(0, 16);
}

export function getInboundBucketIdBytes(chainId: number | bigint): Uint8Array {
  return keccak_256(Uint8Array.from([...enc.encode("INBOUND_"), ...convertNumberToBytes(chainId, 2)]));
}
export function getOutboundBucketIdBytes(): Uint8Array {
  return keccak_256(enc.encode("OUTBOUND"));
}

export function useMessageId(sequence: number | bigint): Uint8Array {
  return keccak_256(convertNumberToBytes(BigInt(sequence) + 1n, 8));
}

export function getArc4Signature(signature: string): Uint8Array {
  return sha512_256(signature).slice(0, 4);
}

export function getEventBytes(signature: string, value: Uint8Array | ABIValue | ABIStruct): Uint8Array {
  const argsType = signature.match(/\(.*\)/);
  if (argsType === null) throw Error("Invalid signature");
  return Uint8Array.from([...getArc4Signature(signature), ...getABIEncodedValue(value, argsType[0], {})]);
}
