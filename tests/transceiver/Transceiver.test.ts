import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { type Account, type Address, OnApplicationComplete, getApplicationAddress } from "algosdk";

import { MockTransceiverClient, MockTransceiverFactory } from "../../specs/client/MockTransceiver.client.ts";
import {
  MockTransceiverManagerClient,
  MockTransceiverManagerFactory,
} from "../../specs/client/MockTransceiverManager.client.ts";
import {
  convertBytesToNumber,
  convertNumberToBytes,
  getEventBytes,
  getRandomBytes,
  getRoleBytes,
} from "../utils/bytes.ts";
import { getMessageReceived, getRandomMessageToSend } from "../utils/message.ts";
import { SECONDS_IN_DAY } from "../utils/time.ts";
import { MAX_UINT16, getRandomUInt } from "../utils/uint.ts";

describe("Transceiver", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const UPGRADEABLE_ADMIN_ROLE = getRoleBytes("UPGRADEABLE_ADMIN");

  const MIN_UPGRADE_DELAY = SECONDS_IN_DAY;

  let transceiverManagerFactory: MockTransceiverManagerFactory;
  let transceiverManagerClient: MockTransceiverManagerClient;
  let transceiverManagerAppId: bigint;

  const MESSAGE_FEE = 500_000n;
  const MESSAGE_DIGEST = getRandomBytes(32);

  let factory: MockTransceiverFactory;
  let client: MockTransceiverClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;
  let user: Address & Account & TransactionSignerAccount;

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });
    user = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(MockTransceiverFactory, {
      defaultSender: creator,
      defaultSigner: creator.signer,
    });

    // deploy transceiver manager
    {
      transceiverManagerFactory = algorand.client.getTypedAppFactory(MockTransceiverManagerFactory, {
        defaultSender: creator,
        defaultSigner: creator.signer,
      });
      const { appClient, result } = await transceiverManagerFactory.deploy();
      transceiverManagerAppId = result.appId;
      transceiverManagerClient = appClient;

      expect(transceiverManagerAppId).not.toEqual(0n);
    }

    // fund mock transceiver manager so have funds to pay for sending messages
    await localnet.algorand.account.ensureFunded(
      getApplicationAddress(transceiverManagerAppId),
      await localnet.algorand.account.localNetDispenser(),
      (100).algo(),
    );
  });

  test("deploys with correct state", async () => {
    const { appClient, result } = await factory.deploy({
      createParams: {
        sender: creator,
        method: "create",
        args: [transceiverManagerAppId, MESSAGE_FEE, MIN_UPGRADE_DELAY],
      },
    });
    appId = result.appId;
    client = appClient;

    expect(appId).not.toEqual(0n);
    expect(await client.state.global.isInitialised()).toBeFalsy();
    expect(await client.state.global.minUpgradeDelay()).toEqual({
      delay_0: 0n,
      delay_1: MIN_UPGRADE_DELAY,
      timestamp: 0n,
    });
    expect(await client.getActiveMinUpgradeDelay()).toEqual(MIN_UPGRADE_DELAY);
    expect(await client.state.global.scheduledContractUpgrade()).toBeUndefined();
    expect(await client.state.global.version()).toEqual(1n);
    expect(await client.state.global.transceiverManager()).toEqual(transceiverManagerAppId);
    expect(await client.state.global.messageFee()).toEqual(MESSAGE_FEE);

    expect(Uint8Array.from(await client.defaultAdminRole())).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [DEFAULT_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.upgradableAdminRole())).toEqual(UPGRADEABLE_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [UPGRADEABLE_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
  });

  describe("quote delivery price", () => {
    test("succeeds and calls internal quote delivery price", async () => {
      const message = getRandomMessageToSend();
      const transceiverInstruction = getRandomBytes(10);
      const res = await client.send.quoteDeliveryPrice({
        sender: user,
        args: [message, transceiverInstruction],
        appReferences: [appId],
      });
      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("InternalQuoteDeliveryPrice(byte[32],byte[])", [message.id, transceiverInstruction]),
      );
      expect(res.return).toEqual(MESSAGE_FEE);
    });
  });

  describe("send message", () => {
    test("fails when fee payment isn't payment", async () => {
      const feePaymentTxn = await localnet.algorand.createTransaction.assetCreate({
        sender: user,
        total: 0n,
        decimals: 0,
        assetName: "",
        unitName: "",
      });
      await expect(
        localnet.algorand
          .newGroup()
          .addTransaction(feePaymentTxn)
          .addAppCall({
            sender: user,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("send_message").getSelector(),
              getRandomBytes(132),
              convertNumberToBytes(0, 2),
            ],
          })
          .send(),
      ).rejects.toThrow("transaction type is pay");
    });

    test("fails when message length is less than 132 bytes", async () => {
      const feePaymentTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: (0).microAlgo(),
      });
      await expect(
        localnet.algorand
          .newGroup()
          .addTransaction(feePaymentTxn)
          .addAppCall({
            sender: user,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("send_message").getSelector(),
              getRandomBytes(131),
              convertNumberToBytes(0, 2),
            ],
            extraFee: (2000).microAlgos(),
          })
          .send(),
      ).rejects.toThrow(`invalid tuple encoding`);
    });

    test("fails when message pointer is not to payload", async () => {
      const feePaymentTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: (0).microAlgo(),
      });
      await expect(
        localnet.algorand
          .newGroup()
          .addTransaction(feePaymentTxn)
          .addAppCall({
            sender: user,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("send_message").getSelector(),
              Uint8Array.from([...getRandomBytes(130), ...convertNumberToBytes(129, 2)]),
              convertNumberToBytes(0, 2),
            ],
            extraFee: (2000).microAlgos(),
          })
          .send(),
      ).rejects.toThrow(`invalid tail pointer at index 5`);
    });

    test.each([
      { messagePayloadLengthDelta: -1, transceiverInstructionLengthDelta: 0, arg: "ntt_contracts.types.MessageToSend" },
      { messagePayloadLengthDelta: 1, transceiverInstructionLengthDelta: 0, arg: "ntt_contracts.types.MessageToSend" },
      { messagePayloadLengthDelta: 0, transceiverInstructionLengthDelta: -1, arg: "arc4.dynamic_array<arc4.uint8>" },
      { messagePayloadLengthDelta: 0, transceiverInstructionLengthDelta: 1, arg: "arc4.dynamic_array<arc4.uint8>" },
    ])(
      "fails when message payload length delta is $messagePayloadLengthDelta and transceiver instruction length delta is $transceiverInstructionLengthDelta bytes",
      async ({ messagePayloadLengthDelta, transceiverInstructionLengthDelta, arg }) => {
        const feePaymentTxn = await localnet.algorand.createTransaction.payment({
          sender: user,
          receiver: getApplicationAddress(appId),
          amount: (0).microAlgo(),
        });
        const payload = getRandomBytes(50);
        const transceiverInstruction = getRandomBytes(10);
        await expect(
          localnet.algorand
            .newGroup()
            .addTransaction(feePaymentTxn)
            .addAppCall({
              sender: user,
              appId,
              onComplete: OnApplicationComplete.NoOpOC,
              args: [
                client.appClient.getABIMethod("send_message").getSelector(),
                Uint8Array.from([
                  ...getRandomBytes(130),
                  ...convertNumberToBytes(132, 2),
                  ...convertNumberToBytes(payload.length + messagePayloadLengthDelta, 2),
                  ...payload,
                ]),
                Uint8Array.from([
                  ...convertNumberToBytes(transceiverInstruction.length + transceiverInstructionLengthDelta, 2),
                  ...transceiverInstruction,
                ]),
              ],
              extraFee: (2000).microAlgos(),
            })
            .send(),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when caller is not transceiver manager", async () => {
      const feePaymentTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: MESSAGE_FEE.microAlgo(),
      });
      const message = getRandomMessageToSend();
      await expect(
        client.send.sendMessage({
          sender: user,
          args: [feePaymentTxn, message, getRandomBytes(10)],
          appReferences: [transceiverManagerAppId],
        }),
      ).rejects.toThrow("Caller must be TransceiverManager");
    });

    test("fails when payment is not to transceiver", async () => {
      const message = getRandomMessageToSend();
      await expect(
        transceiverManagerClient.send.sendMessageWithIncorrectPayment({
          sender: user,
          args: [appId, MESSAGE_FEE, message, getRandomBytes(10)],
          appReferences: [appId],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("0,1: Unknown fee payment receiver");
    });

    test("fails when payment is too low", async () => {
      const message = getRandomMessageToSend();
      const feeAmount = MESSAGE_FEE - 1n;
      await expect(
        transceiverManagerClient.send.sendMessage({
          sender: user,
          args: [appId, feeAmount, message, getRandomBytes(10)],
          appReferences: [appId],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("0,1: Incorrect fee payment");
    });

    test("fails when payment is too high", async () => {
      const message = getRandomMessageToSend();
      const feeAmount = MESSAGE_FEE + 1n;
      await expect(
        transceiverManagerClient.send.sendMessage({
          sender: user,
          args: [appId, feeAmount, message, getRandomBytes(10)],
          appReferences: [appId],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("0,1: Incorrect fee payment");
    });

    test("succeeds and calls internal send message", async () => {
      const message = getRandomMessageToSend();
      const transceiverInstruction = getRandomBytes(10);
      const res = await transceiverManagerClient.send.sendMessage({
        sender: user,
        args: [appId, MESSAGE_FEE, message, transceiverInstruction],
        appReferences: [appId],
        extraFee: (4000).microAlgos(),
      });
      expect(res.confirmations[0].innerTxns!.length).toEqual(2);
      expect(res.confirmations[0].innerTxns![1].logs![0]).toEqual(
        getEventBytes("InternalQuoteDeliveryPrice(byte[32],byte[])", [message.id, transceiverInstruction]),
      );
      expect(res.confirmations[0].innerTxns![1].logs![1]).toEqual(
        getEventBytes("InternalSendMessage(uint64,byte[32],byte[])", [MESSAGE_FEE, message.id, transceiverInstruction]),
      );
      expect(res.confirmations[0].innerTxns![1].logs![2]).toEqual(getEventBytes("MessageSent(byte[32])", message.id));
    });
  });

  describe("deliver message", () => {
    beforeAll(async () => {
      await transceiverManagerClient.send.setMessageDigest({ args: [MESSAGE_DIGEST] });
    });

    test("succeeds and forwards message to transceiver manager", async () => {
      const emitterChainId = getRandomUInt(MAX_UINT16);
      const message = getMessageReceived(emitterChainId, getRandomMessageToSend());

      const res = await client.send.deliverMessage({
        sender: user,
        args: [message],
        appReferences: [transceiverManagerAppId],
        extraFee: (1000).microAlgos(),
      });

      expect(res.confirmations[0].innerTxns!.length).toEqual(1);
      expect(res.confirmations[0].innerTxns![0].txn.txn.type).toEqual("appl");
      expect(res.confirmations[0].innerTxns![0].txn.txn.applicationCall!.appIndex).toEqual(transceiverManagerAppId);
      expect(res.confirmations[0].innerTxns![0].logs![0]).toEqual(
        getEventBytes("AttestationReceived(byte[32],uint16,byte[32],uint64,byte[32],uint64)", [
          message.id,
          emitterChainId,
          message.sourceAddress,
          convertBytesToNumber(message.handlerAddress),
          MESSAGE_DIGEST,
          1,
        ]),
      );
    });
  });
});
