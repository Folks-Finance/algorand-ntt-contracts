from algopy import BoxMap, Txn, Global, UInt64, op, subroutine
from algopy.arc4 import Address, Bool, Struct, UInt16, UInt256, abimethod, emit
from typing import Tuple

from folks_contracts.library.extensions.InitialisableWithCreator import InitialisableWithCreator
from folks_contracts.library.AccessControl import AccessControl
from folks_contracts.library.RateLimiter import RateLimiter
from .. import constants as const, errors as err
from ..types import (
    ARC4UInt16,
    ARC4UInt64,
    ARC4UInt256,
    Bytes16,
    Bytes32,
    MessageDigest,
    MessageId,
    TransceiverInstructions,
    TrimmedAmount,
    UniversalAddress
)


# Structs
class OutboundQueuedTransfer(Struct, frozen=True):
    timestamp: ARC4UInt64
    amount: TrimmedAmount
    recipient_chain: ARC4UInt16
    recipient: UniversalAddress
    sender: Address
    transceiver_instructions: TransceiverInstructions

class InboundQueuedTransfer(Struct, frozen=True):
    timestamp: ARC4UInt64
    amount: TrimmedAmount
    source_chain: ARC4UInt16
    recipient: Address


# Events
class OutboundTransferRateLimited(Struct):
    sender: Address
    message_id: MessageId
    current_capacity: ARC4UInt256
    amount: ARC4UInt64

class InboundTransferRateLimited(Struct):
    recipient: Address
    message_digest: MessageDigest
    current_capacity: ARC4UInt256
    amount: ARC4UInt64

class OutboundTransferDeleted(Struct):
    message_id: MessageId

class InboundTransferDeleted(Struct):
    message_digest: MessageDigest


class NttRateLimiter(RateLimiter, AccessControl, InitialisableWithCreator):
    def __init__(self) -> None:
        RateLimiter.__init__(self)
        AccessControl.__init__(self)
        InitialisableWithCreator.__init__(self)

        # message id -> outbound queued transfer
        self.outbound_queued_transfers = BoxMap(MessageId, OutboundQueuedTransfer, key_prefix=b"outbound_queued_transfers_")
        # message digest -> inbound queued transfer
        self.inbound_queued_transfers = BoxMap(MessageDigest, InboundQueuedTransfer, key_prefix=b"inbound_queued_transfers_")

    @abimethod
    def initialise(self, admin: Address) -> None:  # type: ignore[override]
        # check caller is contract creator
        InitialisableWithCreator.initialise(self)

        # create unlimited outbound bucket
        self._add_bucket(self.outbound_bucket_id(), UInt256(0), UInt64(0))

        self._grant_role(self.default_admin_role(), admin)
        self._grant_role(self.rate_limiter_manager_role(), admin)

    @abimethod
    def set_outbound_rate_limit(self, new_limit: UInt256) -> None:
        """Set limit for outbound bucket.

        Args:
            new_limit: The rate limit to set
        """
        self._only_initialised()
        self._check_sender_role(self.rate_limiter_manager_role())

        self._update_rate_limit(self.outbound_bucket_id(), new_limit)

    @abimethod
    def set_outbound_rate_duration(self, new_duration: UInt64) -> None:
        """Set duration for outbound bucket.

        Args:
            new_duration: The duration to set
        """
        self._only_initialised()
        self._check_sender_role(self.rate_limiter_manager_role())

        self._update_rate_duration(self.outbound_bucket_id(), new_duration)

    @abimethod
    def set_inbound_rate_limit(self, chain_id: UInt16, new_limit: UInt256) -> None:
        """Set limit for inbound bucket of the given chain.

        Args:
            chain_id: The chain id to set the limit for
            new_limit: The limit to set
        """
        self._only_initialised()
        self._check_sender_role(self.rate_limiter_manager_role())

        # fails if bucket is unknown i.e. chain not added
        self._update_rate_limit(self.inbound_bucket_id(chain_id), new_limit)

    @abimethod
    def set_inbound_rate_duration(self, chain_id: UInt16, new_duration: UInt64) -> None:
        """Set duration for inbound bucket of the given chain.

        Args:
            chain_id: The chain id to set the duration for
            new_duration: The duration to set
        """
        self._only_initialised()
        self._check_sender_role(self.rate_limiter_manager_role())

        # fails if bucket is unknown i.e. chain not added
        self._update_rate_duration(self.inbound_bucket_id(chain_id), new_duration)

    @abimethod(readonly=True)
    def get_current_outbound_capacity(self) -> UInt256:
        """Returns the current capacity of the outbound."""
        return self.get_current_capacity(self.outbound_bucket_id())

    @abimethod(readonly=True)
    def get_outbound_queued_transfer(self, message_id: MessageId) -> Tuple[Bool, OutboundQueuedTransfer]:
        """Get the details of an outbound queued transfer.

        Args:
            message_id: The Ntt defined identifier for a message to send

        Returns:
            Tuple of whether the transfer can be completed and the details of the transfer request.
        """
        # check if transfer exists
        self._check_outbound_queued_transfer_known(message_id)
        outbound_queued_transfer = self.outbound_queued_transfers[message_id].copy()

        # include whether sufficient time has passed
        delta = Global.latest_timestamp - outbound_queued_transfer.timestamp.as_uint64()
        can_complete = delta >= self.get_rate_duration(self.outbound_bucket_id())

        return Bool(can_complete), outbound_queued_transfer.copy()

    @abimethod(readonly=True)
    def get_current_inbound_capacity(self, chain_id: UInt16) -> UInt256:
        """Returns the current capacity of the inbound bucket of the given chain.

        Args:
            chain_id: The chain id to get the capacity of
        """
        return self.get_current_capacity(self.inbound_bucket_id(chain_id))

    @abimethod(readonly=True)
    def get_inbound_queued_transfer(self, message_digest: MessageDigest) -> Tuple[Bool, InboundQueuedTransfer]:
        """Get the details of an inbound queued transfer.

        Args:
             message_digest: Unique identifier of the message received.

        Returns:
            Tuple of whether the transfer can be completed and the details of the transfer request.
        """
        # check if transfer exists
        self._check_inbound_queued_transfer_known(message_digest)
        inbound_queued_transfer = self.inbound_queued_transfers[message_digest]

        # include whether sufficient time has passed
        delta = Global.latest_timestamp - inbound_queued_transfer.timestamp.as_uint64()
        can_complete = delta >= self.get_rate_duration(self.inbound_bucket_id(inbound_queued_transfer.source_chain))

        return Bool(can_complete), inbound_queued_transfer

    @abimethod(readonly=True)
    def inbound_bucket_id(self, chain_id: UInt16) -> Bytes32:
        return Bytes32.from_bytes(op.keccak256(b"INBOUND_" + chain_id.bytes))

    @abimethod(readonly=True)
    def outbound_bucket_id(self) -> Bytes32:
        return Bytes32.from_bytes(op.keccak256(b"OUTBOUND"))

    @abimethod(readonly=True)
    def rate_limiter_manager_role(self) -> Bytes16:
        return Bytes16.from_bytes(op.extract(op.keccak256(b"RATE_LIMITER_MANAGER"), 0, const.BYTES16_LENGTH))

    @subroutine(inline=False)
    def _enqueue_or_consume_outbound_transfer(
        self,
        untrimmed_amount: UInt64,
        recipient_chain: UInt16,
        recipient: UniversalAddress,
        should_queue: Bool,
        transceiver_instructions: TransceiverInstructions,
        trimmed_amount: TrimmedAmount,
        message_id: MessageId,
    ) -> Bool:
        """If there is insufficient capacity and can be queued then enqueue the transfer to the outbound queue. If there
         is sufficient capacity then consume from the outbound bucket.

        Args:
            untrimmed_amount: The amount to transfer
            recipient_chain: The wormhole chain id to transfer to
            recipient: The recipient address
            should_queue: Whether the transfer should be queued if the outbound limit is hit
            transceiver_instructions: The instructions to use for each transceiver
            trimmed_amount: The amount to transfer trimmed
            message_id: The Ntt defined identifier for a message to send

        Returns:
            Whether the transfer was queued or not
        """
        # check rate limit
        has_capacity = self.has_capacity(self.outbound_bucket_id(), UInt256(untrimmed_amount))
        assert should_queue or has_capacity, err.OUTBOUND_QUEUED_TRANSFER_INSUFFICIENT_CAPACITY

        # enqueue if needed
        if should_queue and not has_capacity:
            # enqueue transfer
            self.outbound_queued_transfers[message_id] = OutboundQueuedTransfer(
                ARC4UInt64(Global.latest_timestamp),
                trimmed_amount,
                recipient_chain,
                recipient.copy(),
                Address(Txn.sender),
                transceiver_instructions.copy()
            )

            # emit event to notify the user that the transfer is rate limited
            current_capacity = self.get_current_outbound_capacity()
            emit(OutboundTransferRateLimited(
                Address(Txn.sender),
                message_id,
                current_capacity,
                ARC4UInt64(untrimmed_amount)
            ))
            return Bool(True)

        # otherwise consume and backfill amount
        self._consume_amount(self.outbound_bucket_id(), UInt256(untrimmed_amount))
        self._fill_amount(self.inbound_bucket_id(recipient_chain), UInt256(untrimmed_amount))
        return Bool(False)

    @subroutine(inline=False)
    def _enqueue_or_consume_inbound_transfer(
        self,
        untrimmed_amount: UInt64,
        source_chain: UInt16,
        trimmed_amount: TrimmedAmount,
        recipient: Address,
        message_digest: MessageDigest,
    ) -> Bool:
        """If there is insufficient capacity then enqueue the transfer to the inbound queue. If there is sufficient
        capacity then consume from the inbound bucket.

        Args:
            untrimmed_amount: The amount to transfer
            source_chain: The wormhole chain id the transfer is coming from
            trimmed_amount: The amount to transfer trimmed
            recipient: The recipient address
            message_digest: Unique identifier of the message received.

        Returns:
            Whether the transfer was queued or not
        """
        # check rate limit
        has_capacity = self.has_capacity(self.inbound_bucket_id(source_chain), UInt256(untrimmed_amount))

        # enqueue if needed
        if not has_capacity:
            # enqueue transfer
            self.inbound_queued_transfers[message_digest] = InboundQueuedTransfer(
                ARC4UInt64(Global.latest_timestamp),
                trimmed_amount,
                source_chain,
                recipient,
            )

            # emit event to notify the user that the transfer is rate limited
            current_capacity = self.get_current_inbound_capacity(source_chain)
            emit(InboundTransferRateLimited(
                recipient,
                message_digest,
                current_capacity,
                ARC4UInt64(untrimmed_amount))
            )
            return Bool(True)

        # otherwise consume and backfill amount
        self._consume_amount(self.inbound_bucket_id(source_chain), UInt256(untrimmed_amount))
        self._fill_amount(self.outbound_bucket_id(), UInt256(untrimmed_amount))
        return Bool(False)

    @subroutine
    def _delete_outbound_transfer(self, message_id: MessageId) -> None:
        """Deletes an outbound transfer from the queue.

         Args:
             message_id: The Ntt defined identifier for a message to send
         """
        self._check_outbound_queued_transfer_known(message_id)
        del self.outbound_queued_transfers[message_id]
        emit(OutboundTransferDeleted(message_id))

    @subroutine
    def _delete_inbound_transfer(self, message_digest: MessageDigest) -> None:
        """Deletes an inbound transfer from the queue.

         Args:
             message_digest: Unique identifier of the message received.
         """
        self._check_inbound_queued_transfer_known(message_digest)
        del self.inbound_queued_transfers[message_digest]
        emit(InboundTransferDeleted(message_digest))

    @subroutine
    def _check_outbound_queued_transfer_known(self, message_id: MessageId) -> None:
        assert message_id in self.outbound_queued_transfers, err.OUTBOUND_QUEUED_TRANSFER_UNKNOWN

    @subroutine
    def _check_inbound_queued_transfer_known(self, message_digest: MessageDigest) -> None:
        assert message_digest in self.inbound_queued_transfers, err.INBOUND_QUEUED_TRANSFER_UNKNOWN
