from abc import ABC, abstractmethod
from algopy import ARC4Contract, BoxMap, Global, GlobalState, UInt64, itxn, op, subroutine
from algopy.arc4 import Address, Bool, Struct, abi_call, abimethod, emit

from folks_contracts.library import BytesUtils
from .. import errors as err
from ..types import ARC4UInt64, Bytes32, MessageDigest, MessageReceived, MessageToSend, TransceiverInstructions
from .interfaces.ITransceiverManager import ITransceiverManager


# Events
class ThresholdUpdated(Struct):
    threshold: ARC4UInt64


class MessageHandler(ARC4Contract, ABC):
    """The MessageHandler is an abstract contract to inherit from to gain functionality for cross-chain communication.

    The abstract smart contract provides the common implementation to execute a message.

    The concrete MessageHandler should call `_set_transceiver_manager` and must implement the subroutine
    `_handle_message`. It is also able to decide the threshold required for attestations before a message is allowed to
    be executed.
    """
    def __init__(self) -> None:
        self.transceiver_manager = GlobalState(UInt64)
        self.threshold = GlobalState(UInt64)

        # message digest -> whether it has been executed
        self.messages_executed = BoxMap(MessageDigest, Bool, key_prefix=b"messages_executed_")

    @abimethod(create="require")
    def create(self, threshold: UInt64) -> None:
        self._set_threshold(threshold)

    @abimethod
    def execute_message(self, message: MessageReceived) -> None:
        """Execute a message once the threshold number of attestations has been reached.

        Args:
            message: The message to execute

        Raises:
            AssertionError: If the message hasn't been approved
            AssertionError: If the message has already been executed
        """
        # calculate unique id for message to check for replay attacks
        message_digest, txn = abi_call(
            ITransceiverManager.calculate_message_digest,
            message,
            app_id=self.transceiver_manager.value,
            fee=0,
        )

        # check if handler is correct
        assert (BytesUtils.safe_convert_bytes32_to_uint64(message.handler_address.copy())
                == Global.current_application_id.id), err.MESSAGE_HANDLER_ADDRESS_MISMATCH

        # check if required attestations have been met
        assert self.is_message_approved(message_digest), err.MESSAGE_NOT_APPROVED

        # protect against replay attacks
        assert not self.is_message_executed(message_digest), err.MESSAGE_ALREADY_EXECUTED
        self.messages_executed[message_digest] = Bool(True)

        # handle message
        self._handle_message(message_digest, message)

    @abimethod(readonly=True)
    def is_message_approved(self, message_digest: MessageDigest) -> Bool:
        """Returns whether a message has been approved.

        Args:
            message_digest: The message digest
        """
        message_attestations, txn = abi_call(
            ITransceiverManager.message_attestations,
            message_digest,
            app_id=self.transceiver_manager.value,
            fee=0,
        )
        return Bool(message_attestations > 0 and message_attestations >= self.threshold.value)

    @abimethod(readonly=True)
    def is_message_executed(self, message_digest: MessageDigest) -> Bool:
        """Returns whether a message has been executed.

        Note that a message can be executed without being approved if the threshold is increased after execution.

        Args:
            message_digest: The message digest
        """
        return Bool(message_digest in self.messages_executed) and self.messages_executed[message_digest]

    @subroutine
    def _set_transceiver_manager(self, admin_in_transceiver_manager: Address, transceiver_manager: UInt64) -> None:
        """Set new transceiver manager.

        Care should be taken when setting the transceiver manager to avoid a scenario where in-flight messages can't
        be executed. If the configured transceiver is connected to the old transceiver manager then the messages will
        be attested in that old transceiver manager. Then the threshold for the messages' attestations would not be
        met in the new transceiver, so they would never be able to get executed.

        Args:
            admin_in_transceiver_manager: The admin to set in the transceiver manager for the message handler
            transceiver_manager: The new transceiver manager
        """
        self.transceiver_manager.value = transceiver_manager
        abi_call(
            ITransceiverManager.add_message_handler,
            admin_in_transceiver_manager,
            app_id=self.transceiver_manager.value,
            fee=0,
        )

    @subroutine
    def _set_threshold(self, new_threshold: UInt64) -> None:
        """Set new threshold for the number of attestations required for a message.

        Care should be taken when increasing the threshold to avoid a scenario where in-flight messages can't be
        executed. For example: assume there is 1 transceiver and the threshold is 1. If we were to add a new
        transceiver, the threshold would increase to 2. However, all messages that are either in-flight or that are
        sent on a source chain that does not yet have 2 transceivers will only have been sent from a single
        transceiver, so they would never be able to get executed.

        Instead, we leave it up to the owner to manually update the threshold after some period of time, ideally once
        all chains have the new transceiver and messages that were sent via the old configuration are all complete.

        Args:
            new_threshold: The new threshold
        """
        assert new_threshold, err.ZERO_THRESHOLD
        self.threshold.value = new_threshold
        emit(ThresholdUpdated(ARC4UInt64(new_threshold)))

    @subroutine(inline=False)
    def _send_message(self, message: MessageToSend, transceiver_instructions: TransceiverInstructions) -> UInt64:
        """Send a message through the configured transceivers in the TransceiverManager. Takes ALGO payment from the
        application address to pay for the delivery.

        Args:
            message: The message to send
            transceiver_instructions: The instructions to use for each transceiver. Must follow the same order as
                                      it's stored in the transceiver manager

        Returns:
            Total delivery price paid in ALGO
        """

        # quote total delivery price
        total_delivery_price, txn = abi_call(
            ITransceiverManager.quote_delivery_prices,
            Global.current_application_id.id,
            message,
            transceiver_instructions,
            app_id=self.transceiver_manager.value,
            fee=0,
        )

        # send message
        transceiver_manager_address, exists = op.AppParamsGet.app_address(self.transceiver_manager.value)
        assert exists, err.TRANSCEIVER_MANAGER_ADDRESS_UNKNOWN
        abi_call(
            ITransceiverManager.send_message_to_transceivers,
            itxn.Payment(amount=total_delivery_price, receiver=transceiver_manager_address, fee=0),
            message,
            transceiver_instructions,
            app_id=self.transceiver_manager.value,
            fee=0,
        )

        # return total
        return total_delivery_price

    @abstractmethod
    @subroutine
    def _handle_message(self, message_digest: MessageDigest, message: MessageReceived) -> None:
        """Implement this method with custom logic needed to carry out message execution.

        It is assumed the correct message digest is passed for the given message.

        Args:
            message_digest: Unique identifier of the message received
            message: The message received to handle
        """
        pass
