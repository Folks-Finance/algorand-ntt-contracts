from algopy.arc4 import (
    Byte,
    DynamicArray,
    DynamicBytes,
    StaticArray,
    Struct,
    UInt8 as ARC4UInt8,
    UInt16 as ARC4UInt16,
    UInt64 as ARC4UInt64,
    UInt256 as ARC4UInt256,
)
from typing import Literal, NamedTuple, TypeAlias

Bytes8: TypeAlias = StaticArray[Byte, Literal[8]]
Bytes16: TypeAlias = StaticArray[Byte, Literal[16]]
Bytes32: TypeAlias = StaticArray[Byte, Literal[32]]

# wormhole formatted address
UniversalAddress: TypeAlias = Bytes32

# keccak256(keccak256(vaa_body))
VaaDigest: TypeAlias = Bytes32

# keccak256(message_received)
MessageDigest: TypeAlias = Bytes32

# custom defined by MessageHandler so no guarantees
MessageId: TypeAlias = Bytes32

class TrimmedAmount(Struct, frozen=True):
    amount: ARC4UInt64
    decimals: ARC4UInt8

class TransceiverInstruction(Struct, frozen=True):
    transceiver: ARC4UInt64
    instruction: DynamicBytes

TransceiverInstructions: TypeAlias = DynamicArray[TransceiverInstruction]

class MessageToSend(NamedTuple):
    id: MessageId # used to group messages from different transceivers
    user_address: UniversalAddress
    source_address: UniversalAddress
    destination_chain_id: ARC4UInt16
    handler_address: UniversalAddress
    payload: DynamicBytes

class MessageReceived(NamedTuple):
    id: MessageId # used to group messages from different transceivers
    user_address: UniversalAddress
    source_chain_id: ARC4UInt16
    source_address: UniversalAddress
    handler_address: UniversalAddress
    payload: DynamicBytes
