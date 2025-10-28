from algopy import BoxMap, Bytes, Global, GlobalState, Txn, UInt64, gtxn, itxn, op, subroutine
from algopy.arc4 import Address, Bool, DynamicBytes, Struct, UInt8, UInt16, UInt256, abi_call, abimethod, emit

from folks_contracts.library import BytesUtils
from folks_contracts.library.Upgradeable import Upgradeable
from .. import constants as const, errors as err
from ..library import TrimmedAmountLib
from ..ntt_token.interfaces.INttToken import INttToken
from ..transceiver.MessageHandler import MessageHandler
from ..types import (
    ARC4UInt8,
    ARC4UInt16,
    ARC4UInt64,
    Bytes16,
    MessageDigest,
    MessageId,
    MessageReceived,
    MessageToSend,
    TransceiverInstructions,
    TrimmedAmount,
    UniversalAddress,
)
from .interfaces.INttManager import INttManager, NttManagerPeer
from .NttRateLimiter import NttRateLimiter


# Constants
NTT_PAYLOAD_PREFIX = "994E5454"


# Events
class Paused(Struct):
    is_paused: Bool

class TransceiverManagerUpdated(Struct):
    transceiver_manager: ARC4UInt64

class NttManagerPeerSet(Struct):
    peer_chain_id: ARC4UInt16
    peer_contract: UniversalAddress
    peer_decimals: ARC4UInt8
    is_new: Bool

class TransferSent(Struct):
    message_id: MessageId
    recipient: UniversalAddress
    recipient_chain: ARC4UInt16
    amount: ARC4UInt64
    fee: ARC4UInt64


class NttManager(INttManager, MessageHandler, NttRateLimiter, Upgradeable):
    def __init__(self) -> None:
        MessageHandler.__init__(self)
        NttRateLimiter.__init__(self)
        Upgradeable.__init__(self)

        self.is_paused = False

        # token
        self.asset_id = GlobalState(UInt64)
        self.ntt_token = GlobalState(UInt64)

        # for messages
        self.message_sequence = UInt64(0)
        self.chain_id = GlobalState(UInt16)

        # peer chain id -> peer chain
        self.ntt_manager_peers = BoxMap(UInt16, NttManagerPeer, key_prefix=b"ntt_manager_peer_")

    @abimethod(create="require")
    def create(self, ntt_token: UInt64, chain_id: UInt16, threshold: UInt64, min_upgrade_delay: UInt64) -> None: # type: ignore[override]
        MessageHandler.create(self, threshold)
        Upgradeable.create(self, min_upgrade_delay)

        # token
        asset_id, txn = abi_call(INttToken.get_asset_id, app_id=ntt_token, fee=0)
        self.asset_id.value = asset_id
        self.ntt_token.value = ntt_token

        # this chain
        self.chain_id.value = chain_id

    @abimethod
    def initialise(self, admin: Address, transceiver_manager: UInt64) -> None: # type: ignore[override]
        # check caller is contract creator, create outbound bucket and grant roles: default admin, rate limiter manager
        NttRateLimiter.initialise(self, admin)
        # not calling Upgradeable.initialise as already initialised

        self._set_transceiver_manager(admin, transceiver_manager)

        self._grant_role(self.upgradable_admin_role(), admin)
        self._grant_role(self.ntt_manager_admin_role(), admin)

    @abimethod
    def pause(self) -> None:
        """Pause incoming and outgoing transfers in case of emergency."""
        self._only_initialised()
        self._check_sender_role(self.pauser_role())

        self._check_is_not_paused()

        # set whether paused or not
        self.is_paused = True
        emit(Paused(Bool(True)))

    @abimethod
    def unpause(self) -> None:
        """Resume incoming and outgoing transfers after previous pause."""
        self._only_initialised()
        self._check_sender_role(self.unpauser_role())

        self._check_is_paused()

        # set whether paused or not
        self.is_paused = False
        emit(Paused(Bool(False)))

    @abimethod
    def set_transceiver_manager(self, admin_in_transceiver_manager: Address, transceiver_manager: UInt64) -> None:
        self._only_initialised()
        self._check_sender_role(self.ntt_manager_admin_role())

        # set transceiver manager
        self._set_transceiver_manager(admin_in_transceiver_manager, transceiver_manager)
        emit(TransceiverManagerUpdated(ARC4UInt64(transceiver_manager)))

    @abimethod
    def set_threshold(self, new_threshold: UInt64) -> None:
        self._only_initialised()
        self._check_sender_role(self.ntt_manager_admin_role())

        # set threshold
        self._set_threshold(new_threshold)

    @abimethod
    def set_ntt_manager_peer(
        self,
        peer_chain_id: UInt16,
        peer_contract: UniversalAddress,
        peer_decimals: UInt8
    ) -> None:
        self._only_initialised()
        self._check_sender_role(self.ntt_manager_admin_role())

        # check peer chain is valid
        assert peer_chain_id != self.chain_id.value, err.PEER_CANNOT_BE_ITSELF
        assert peer_decimals.as_uint64(), err.PEER_DECIMALS_INVALID

        # if new chain, create unlimited inbound bucket
        is_new = Bool(peer_chain_id not in self.ntt_manager_peers)
        if is_new:
            self._add_bucket(self.inbound_bucket_id(peer_chain_id), UInt256(0), UInt64(0))

        # set peer (overriding if needed)
        self.ntt_manager_peers[peer_chain_id] = NttManagerPeer(peer_contract.copy(), peer_decimals)
        emit(NttManagerPeerSet(peer_chain_id, peer_contract, peer_decimals, is_new))

    @abimethod
    def transfer(
        self,
        fee_payment: gtxn.PaymentTransaction,
        send_token: gtxn.AssetTransferTransaction,
        amount: UInt64,
        recipient_chain: UInt16,
        recipient: UniversalAddress
    ) -> MessageId:
        return self._transfer_entry_point(
            fee_payment,
            send_token,
            amount,
            recipient_chain,
            recipient,
            Bool(False),
            TransceiverInstructions()
        )

    @abimethod
    def transfer_full(
        self,
        fee_payment: gtxn.PaymentTransaction,
        send_token: gtxn.AssetTransferTransaction,
        amount: UInt64,
        recipient_chain: UInt16,
        recipient: UniversalAddress,
        should_queue: Bool,
        transceiver_instructions: TransceiverInstructions,
    ) -> MessageId:
        return self._transfer_entry_point(
            fee_payment,
            send_token,
            amount,
            recipient_chain,
            recipient,
            should_queue,
            transceiver_instructions
        )

    @abimethod
    def complete_outbound_queued_transfer(
        self,
        fee_payment: gtxn.PaymentTransaction,
        message_id: MessageId,
    ) -> MessageId:
        self._only_initialised()
        self._check_is_not_paused()

        # find the message in the queue and ensure that sufficient time has elapsed
        can_complete, outbound_queued_transfer = self.get_outbound_queued_transfer(message_id)
        assert can_complete, err.OUTBOUND_QUEUED_TRANSFER_STILL_QUEUED

        # remove transfer from the queue
        self._delete_outbound_transfer(message_id)

        # skip rate limit logic and carry out transfer, also checks fee payment
        self._transfer(
            fee_payment,
            message_id,
            outbound_queued_transfer.amount,
            outbound_queued_transfer.recipient_chain,
            outbound_queued_transfer.recipient.copy(),
            outbound_queued_transfer.sender,
            outbound_queued_transfer.transceiver_instructions.copy(),
        )

        # refund box storage
        self._refund_min_balance_to_caller()

        return message_id

    @abimethod
    def cancel_outbound_queued_transfer(self, message_id: MessageId) -> None:
        self._only_initialised()
        self._check_is_not_paused()

        # find the message in the queue
        outbound_queued_transfer = self.get_outbound_queued_transfer(message_id)[1]

        # check sender initiated the transfer
        assert Address(Txn.sender) == outbound_queued_transfer.sender, err.ONLY_ORIGINAL_SENDER_CAN_CANCEL

        # remove transfer from the queue
        self._delete_outbound_transfer(message_id)

        # return the queued funds to the user
        untrimmed_amount = self._untrim_transfer_amount(outbound_queued_transfer.amount)
        abi_call(INttToken.mint,Address(Txn.sender), untrimmed_amount, app_id=self.ntt_token.value, fee=0)

        # refund box storage
        self._refund_min_balance_to_caller()

    @abimethod
    def complete_inbound_queued_transfer(self, message_digest: MessageDigest) -> None:
        self._only_initialised()
        self._check_is_not_paused()

        # find the message in the queue and ensure that sufficient time has elapsed
        can_complete, inbound_queued_transfer = self.get_inbound_queued_transfer(message_digest)
        assert can_complete, err.INBOUND_QUEUED_TRANSFER_STILL_QUEUED

        # remove transfer from the queue
        self._delete_inbound_transfer(message_digest)

        # carry out transfer
        untrimmed_amount = self._untrim_transfer_amount(inbound_queued_transfer.amount)
        abi_call(INttToken.mint,inbound_queued_transfer.recipient, untrimmed_amount, app_id=self.ntt_token.value, fee=0)

        # refund box storage
        self._refund_min_balance_to_caller()

    @abimethod(readonly=True)
    def ntt_manager_admin_role(self) -> Bytes16:
        return Bytes16.from_bytes(op.extract(op.keccak256(b"NTT_MANAGER_ADMIN"), 0, const.BYTES16_LENGTH))

    @abimethod(readonly=True)
    def pauser_role(self) -> Bytes16:
        return Bytes16.from_bytes(op.extract(op.keccak256(b"PAUSER"), 0, const.BYTES16_LENGTH))

    @abimethod(readonly=True)
    def unpauser_role(self) -> Bytes16:
        return Bytes16.from_bytes(op.extract(op.keccak256(b"UNPAUSER"), 0, const.BYTES16_LENGTH))

    @abimethod(readonly=True)
    def get_ntt_manager_peer(self, chain_id: UInt16) -> NttManagerPeer:
        assert chain_id in self.ntt_manager_peers, err.PEER_CHAIN_UNKNOWN
        return self.ntt_manager_peers[chain_id]

    @subroutine
    def _check_is_not_paused(self) -> None:
        assert not self.is_paused, err.CONTRACT_PAUSED

    @subroutine
    def _check_is_paused(self) -> None:
        assert self.is_paused, err.CONTRACT_NOT_PAUSED

    @subroutine
    def _use_message_id(self) -> MessageId:
        self.message_sequence += 1
        return MessageId.from_bytes(op.keccak256(op.itob(self.message_sequence)))

    @subroutine(inline=False)
    def _transfer_entry_point(
        self,
        fee_payment: gtxn.PaymentTransaction,
        send_token: gtxn.AssetTransferTransaction,
        amount: UInt64,
        recipient_chain: UInt16,
        recipient: UniversalAddress,
        should_queue: Bool,
        transceiver_instructions: TransceiverInstructions,
    ) -> MessageId:
        self._only_initialised()
        self._check_is_not_paused()

        # check payment - amount is checked in _transfer subroutine
        assert fee_payment.receiver == Global.current_application_address, err.FEE_PAYMENT_RECEIVER_UNKNOWN

        # check asset transfer
        ntt_token_address, exists = op.AppParamsGet.app_address(self.ntt_token.value)
        assert exists, err.NTT_TOKEN_ADDRESS_UNKNOWN
        assert send_token.xfer_asset.id == self.asset_id.value, err.ASSET_UNKNOWN
        assert send_token.asset_receiver == ntt_token_address, err.ASSET_RECEIVER_UNKNOWN
        assert send_token.asset_amount == amount, err.ASSET_AMOUNT_INCORRECT

        # check amount and recipient ain't zero
        assert amount, err.ZERO_AMOUNT
        assert recipient.bytes != op.bzero(const.BYTES32_LENGTH), err.RECIPIENT_INVALID

        # also checks if known recipient chain
        ntt_manager_peer = self.get_ntt_manager_peer(recipient_chain)

        # trim amount to common number of decimals
        trimmed_amount = self._trim_transfer_amount(amount, ntt_manager_peer.decimals)

        # get the message id for this transfer
        message_id = self._use_message_id()

        # check if rate limited and either enqueue or carry out transfer
        is_enqueued = self._enqueue_or_consume_outbound_transfer(
            amount,
            recipient_chain,
            recipient,
            should_queue,
            transceiver_instructions,
            trimmed_amount,
            message_id
        )
        if is_enqueued:
            # refund fee payment
            itxn.Payment(amount=fee_payment.amount, receiver=fee_payment.sender, fee=0).submit()
        else:
            # carry out transfer
            self._transfer(
                fee_payment,
                message_id,
                trimmed_amount,
                recipient_chain,
                recipient,
                Address(Txn.sender),
                transceiver_instructions,
            )
        return message_id

    @subroutine(inline=False)
    def _transfer(
        self,
        fee_payment: gtxn.PaymentTransaction,
        message_id: MessageId,
        trimmed_amount: TrimmedAmount,
        recipient_chain: UInt16,
        recipient: UniversalAddress,
        sender: Address,
        transceiver_instructions: TransceiverInstructions,
    ) -> None:
        # also checks if known recipient chain
        ntt_manager_peer = self.get_ntt_manager_peer(recipient_chain)

        # construct message by concatenating underlying bytes
        payload = DynamicBytes(
            Bytes.from_hex(NTT_PAYLOAD_PREFIX) +
            trimmed_amount.decimals.bytes +
            op.itob(trimmed_amount.amount.as_uint64()) +
            BytesUtils.convert_uint64_to_bytes32(self.asset_id.value).bytes +
            recipient.bytes +
            recipient_chain.bytes
        )
        message = MessageToSend(
            id=message_id.copy(),
            user_address=UniversalAddress.from_bytes(sender.bytes),
            source_address=BytesUtils.convert_uint64_to_bytes32(Global.current_application_id.id),
            destination_chain_id=recipient_chain,
            handler_address=ntt_manager_peer.peer_contract.copy(),
            payload=payload.copy(),
        )

        # call transceiver manager to send message through configured transceivers
        total_delivery_price = self._send_message(message, transceiver_instructions)

        # check fee payment and if applicable, refund excess
        assert fee_payment.receiver == Global.current_application_address, err.FEE_PAYMENT_RECEIVER_UNKNOWN
        assert fee_payment.amount >= total_delivery_price, err.FEE_PAYMENT_AMOUNT_INSUFFICIENT
        excess_fee_payment = fee_payment.amount - total_delivery_price
        if excess_fee_payment:
            itxn.Payment(amount=excess_fee_payment, receiver=fee_payment.sender, fee=0).submit()

        emit(TransferSent(
            message_id,
            recipient,
            recipient_chain,
            ARC4UInt64(self._untrim_transfer_amount(trimmed_amount)),
            ARC4UInt64(total_delivery_price),
        ))

    @subroutine
    def _handle_message(self, message_digest: MessageDigest, message: MessageReceived) -> None:
        self._only_initialised()
        self._check_is_not_paused()

        # verify peer
        ntt_manager_peer = self.get_ntt_manager_peer(message.source_chain_id)
        assert message.source_address == ntt_manager_peer.peer_contract, err.PEER_ADDRESS_UNKNOWN

        # parse payload
        payload = message.payload.bytes
        index = UInt64(const.UINT16_LENGTH) # skip payload length
        assert Bytes.from_hex(NTT_PAYLOAD_PREFIX) == op.extract(payload, index, const.BYTES4_LENGTH), err.PREFIX_INCORRECT
        index += const.BYTES4_LENGTH
        from_decimals = ARC4UInt8(op.btoi(op.extract(payload, index, const.UINT8_LENGTH)))
        index += const.UINT8_LENGTH
        from_amount = ARC4UInt64(op.extract_uint64(payload, index))
        index += const.UINT64_LENGTH + const.BYTES32_LENGTH # skip source_token as never used
        recipient = Address(op.extract(payload, index, const.BYTES32_LENGTH))
        index += const.BYTES32_LENGTH
        recipient_chain = op.extract_uint16(payload, index)
        # ignore any additional payload

        # verify that the destination chain is valid
        assert recipient_chain == self.chain_id.value, err.TARGET_CHAIN_INVALID

        # calculate proper amount of tokens to unlock/mint to recipient
        trimmed_amount = TrimmedAmount(from_amount, from_decimals)
        untrimmed_amount = self._untrim_transfer_amount(trimmed_amount)

        # check if rate limited and either enqueue or carry out transfer
        is_enqueued = self._enqueue_or_consume_inbound_transfer(
            untrimmed_amount,
            message.source_chain_id,
            trimmed_amount,
            recipient,
            message_digest
        )
        if not is_enqueued:
            abi_call(INttToken.mint, recipient, untrimmed_amount, app_id=self.ntt_token.value, fee=0)

    @subroutine
    def _get_asset_decimals(self) -> UInt8:
        asset_decimals, exists = op.AssetParamsGet.asset_decimals(self.asset_id.value)
        assert exists, err.ASSET_UNKNOWN
        return UInt8(asset_decimals)

    @subroutine
    def _trim_transfer_amount(self, amount: UInt64, to_decimals: UInt8) -> TrimmedAmount:
        from_decimals = self._get_asset_decimals()

        trimmed_amount = TrimmedAmountLib.trim(amount, from_decimals, to_decimals)
        new_amount = TrimmedAmountLib.untrim(trimmed_amount, from_decimals)
        assert amount == new_amount, err.TRANSFER_AMOUNT_HAS_DUST

        return trimmed_amount

    @subroutine
    def _untrim_transfer_amount(self, trimmed_amount: TrimmedAmount) -> UInt64:
        to_decimals = self._get_asset_decimals()
        return TrimmedAmountLib.untrim(trimmed_amount, to_decimals)

    @subroutine
    def _refund_min_balance_to_caller(self) -> None:
        # this will also send all donated ALGO to the caller
        amount = Global.current_application_address.balance - Global.current_application_address.min_balance
        itxn.Payment(amount=amount, receiver=Txn.sender, fee=0).submit()
