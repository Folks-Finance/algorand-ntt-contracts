import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { type Account, type Address, OnApplicationComplete, getApplicationAddress } from "algosdk";

import {
  MockTransceiverManagerClient,
  MockTransceiverManagerFactory,
} from "../../specs/client/MockTransceiverManager.client.ts";
import {
  SimpleMessageHandlerClient,
  SimpleMessageHandlerFactory,
} from "../../specs/client/SimpleMessageHandler.client.ts";
import { getMessagesExecutedBoxKey } from "../utils/boxes.ts";
import { convertNumberToBytes, getEventBytes, getRandomBytes } from "../utils/bytes.ts";
import { type TransceiverInstruction, getMessageReceived, getRandomMessageToSend } from "../utils/message.ts";
import { MAX_UINT16, MAX_UINT64, getRandomUInt } from "../utils/uint.ts";

describe("MessageHandler", () => {
  const localnet = algorandFixture();

  let transceiverManagerFactory: MockTransceiverManagerFactory;
  let transceiverManagerClient: MockTransceiverManagerClient;
  let transceiverManagerAppId: bigint;

  const THRESHOLD = 2n;
  const TOTAL_DELIVERY_PRICE = (1).algo();
  const transceiverInstructions: TransceiverInstruction[] = [[getRandomUInt(MAX_UINT64), getRandomBytes(10)]];

  let factory: SimpleMessageHandlerFactory;
  let client: SimpleMessageHandlerClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;
  let admin: Address & Account & TransactionSignerAccount;
  let user: Address & Account & TransactionSignerAccount;

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });
    admin = await generateAccount({ initialFunds: (100).algo() });
    user = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(SimpleMessageHandlerFactory, {
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
        args: [THRESHOLD],
      },
    });
    appId = result.appId;
    client = appClient;

    expect(appId).not.toEqual(0n);
    expect(await client.state.global.transceiverManager()).toEqual(undefined);
    expect(await client.state.global.threshold()).toEqual(THRESHOLD);
  });

  describe("set transceiver manager", () => {
    test("fails when trying to set zero threshold", async () => {
      await expect(client.send.setThreshold({ sender: user, args: [0] })).rejects.toThrow("Cannot set zero threshold");
    });

    test("succeeds", async () => {
      const res = await client.send.setTransceiverManager({
        sender: user,
        args: [user.toString(), transceiverManagerAppId],
        extraFee: (1000).microAlgos(),
      });
      expect(await client.state.global.transceiverManager()).toEqual(transceiverManagerAppId);
      expect(res.confirmations[0].innerTxns!.length).toEqual(1);
      expect(res.confirmations[0].innerTxns![0].logs![0]).toEqual(
        getEventBytes("MessageHandlerAdded(uint64,address)", [appId, user.toString()]),
      );
    });
  });

  describe("set threshold", () => {
    test("fails when trying to set zero threshold", async () => {
      await expect(client.send.setThreshold({ sender: user, args: [0] })).rejects.toThrow("Cannot set zero threshold");
    });

    test("succeeds", async () => {
      const newThreshold = 1n;
      expect(newThreshold).not.toEqual(THRESHOLD);

      // set threshold
      const res = await client.send.setThreshold({ sender: user, args: [newThreshold] });
      expect(await client.state.global.threshold()).toEqual(newThreshold);
      expect(res.confirmations[0].logs![0]).toEqual(getEventBytes("ThresholdUpdated(uint64)", [newThreshold]));

      // restore
      await client.send.setThreshold({ sender: user, args: [THRESHOLD] });
      expect(await client.state.global.threshold()).toEqual(THRESHOLD);
    });
  });

  describe("send message", () => {
    beforeAll(async () => {
      await transceiverManagerClient.send.setTotalDeliveryPrice({ args: [TOTAL_DELIVERY_PRICE.microAlgos] });
    });

    test("fails if insufficient balance to pay delivery price", async () => {
      // ensure not enough balance
      const { balance: appAlgoBalanceBefore } = await localnet.algorand.account.getInformation(
        getApplicationAddress(appId),
      );
      expect(appAlgoBalanceBefore.microAlgos).toBeLessThan(TOTAL_DELIVERY_PRICE.microAlgo);

      // send message
      const message = getRandomMessageToSend();
      await expect(
        client.send.sendMessage({
          sender: user,
          args: [message, transceiverInstructions],
          appReferences: [transceiverManagerAppId],
          extraFee: (3000).microAlgos(),
        }),
      ).rejects.toThrow("overspend");
    });

    test("succeeds", async () => {
      const { balance: userAlgoBalanceBefore } = await localnet.algorand.account.getInformation(user);
      const { balance: appAlgoBalanceBefore } = await localnet.algorand.account.getInformation(
        getApplicationAddress(appId),
      );
      const { balance: transceiverManagerAlgoBalanceBefore } = await localnet.algorand.account.getInformation(
        getApplicationAddress(transceiverManagerAppId),
      );

      // send message
      const message = getRandomMessageToSend();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: TOTAL_DELIVERY_PRICE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .sendMessage({
          sender: user,
          args: [message, transceiverInstructions],
          appReferences: [transceiverManagerAppId],
          extraFee: (3000).microAlgos(),
        })
        .send();

      // balance after
      const feeTotal = res.transactions.reduce((acc, txn) => acc + txn.fee, 0n);
      const { balance: userAlgoBalanceAfter } = await localnet.algorand.account.getInformation(user);
      const { balance: appAlgoBalanceAfter } = await localnet.algorand.account.getInformation(
        getApplicationAddress(appId),
      );
      const { balance: transceiverManagerAlgoBalanceAfter } = await localnet.algorand.account.getInformation(
        getApplicationAddress(transceiverManagerAppId),
      );
      expect(userAlgoBalanceAfter.microAlgos).toEqual(
        userAlgoBalanceBefore.microAlgos - TOTAL_DELIVERY_PRICE.microAlgos - feeTotal,
      );
      expect(appAlgoBalanceAfter.microAlgos).toEqual(appAlgoBalanceBefore.microAlgos);
      expect(transceiverManagerAlgoBalanceAfter.microAlgos).toEqual(
        transceiverManagerAlgoBalanceBefore.microAlgos + TOTAL_DELIVERY_PRICE.microAlgos,
      );

      // check events and return
      expect(res.confirmations[1].innerTxns!.length).toEqual(3);
      expect(res.confirmations[1].innerTxns![0].logs![0]).toEqual(
        getEventBytes("InternalQuoteDeliveryPrices(uint64,byte[32],(uint64,byte[])[])", [
          appId,
          message.id,
          transceiverInstructions,
        ]),
      );
      expect(res.confirmations[1].innerTxns![2].logs![0]).toEqual(
        getEventBytes("MessageSentToTransceivers(uint64,uint64,address,byte[32],(uint64,byte[])[])", [
          appId,
          TOTAL_DELIVERY_PRICE.microAlgo,
          getApplicationAddress(transceiverManagerAppId),
          message.id,
          transceiverInstructions,
        ]),
      );
      expect(res.returns).toEqual([TOTAL_DELIVERY_PRICE.microAlgo]);
    });
  });

  describe("is message approved", () => {
    test("returns false when threshold attestations not reached", async () => {
      await transceiverManagerClient.send.setMessageAttestations({ args: [THRESHOLD - 1n] });
      expect(
        await client.isMessageApproved({ sender: user, args: [getRandomBytes(32)], extraFee: (1000).microAlgos() }),
      ).toBeFalsy();
      expect(await client.isMessageExecuted({ sender: user, args: [getRandomBytes(32)] })).toBeFalsy();
    });

    test.each([
      { name: "reached", attestations: THRESHOLD },
      { name: "exceeded", attestations: THRESHOLD + 1n },
    ])("returns true when threshold attestations are $name", async ({ attestations }) => {
      await transceiverManagerClient.send.setMessageAttestations({ args: [attestations] });
      expect(
        await client.isMessageApproved({
          sender: user,
          args: [getRandomBytes(32)],
          extraFee: (1000).microAlgos(),
        }),
      ).toBeTruthy();
      expect(await client.isMessageExecuted({ sender: user, args: [getRandomBytes(32)] })).toBeFalsy();
    });
  });

  describe("execute message", () => {
    const MESSAGE_DIGEST = getRandomBytes(32);

    beforeAll(async () => {
      await transceiverManagerClient.send.setMessageDigest({ args: [MESSAGE_DIGEST] });
    });

    afterEach(async () => {
      await transceiverManagerClient.send.setMessageAttestations({ args: [THRESHOLD] });
    });

    test("fails when message length is less than 132 bytes", async () => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("execute_message").getSelector(), getRandomBytes(131)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow(`invalid tuple encoding`);
    });

    test("fails when message pointer is not to payload", async () => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [
            client.appClient.getABIMethod("execute_message").getSelector(),
            Uint8Array.from([...getRandomBytes(130), ...convertNumberToBytes(0, 2)]),
          ],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow(`invalid tail pointer at index 5`);
    });

    test.each([
      { messagePayloadLengthDelta: -1, arg: "ntt_contracts.types.MessageReceived" },
      { messagePayloadLengthDelta: 1, arg: "ntt_contracts.types.MessageReceived" },
    ])(
      "fails when message payload length delta is $messagePayloadLengthDelta bytes",
      async ({ messagePayloadLengthDelta, arg }) => {
        const payload = getRandomBytes(50);
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("execute_message").getSelector(),
              Uint8Array.from([
                ...getRandomBytes(130),
                ...convertNumberToBytes(132, 2),
                ...convertNumberToBytes(payload.length + messagePayloadLengthDelta, 2),
                ...payload,
              ]),
            ],
            extraFee: (2000).microAlgos(),
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when message handler is not application", async () => {
      const MESSAGE_RECEIVED = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: getRandomBytes(32) }),
      );
      await expect(
        client.send.executeMessage({
          sender: user,
          args: [MESSAGE_RECEIVED],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getMessagesExecutedBoxKey(MESSAGE_DIGEST)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Unsafe conversion of bytes32 to uint64");
    });

    test("fails when message handler is different application", async () => {
      const MESSAGE_RECEIVED = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(transceiverManagerAppId, 32) }),
      );
      await expect(
        client.send.executeMessage({
          sender: user,
          args: [MESSAGE_RECEIVED],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getMessagesExecutedBoxKey(MESSAGE_DIGEST)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Message handler address mismatch");
    });

    test("fails when message not approved", async () => {
      // ensure not approved
      await transceiverManagerClient.send.setMessageAttestations({ args: [THRESHOLD - 1n] });
      expect(
        await client.isMessageApproved({
          sender: user,
          args: [MESSAGE_DIGEST],
          extraFee: (1000).microAlgos(),
        }),
      ).toBeFalsy();

      // execute message
      const MESSAGE_RECEIVED = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(appId, 32) }),
      );
      await expect(
        client.send.executeMessage({
          sender: user,
          args: [MESSAGE_RECEIVED],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getMessagesExecutedBoxKey(MESSAGE_DIGEST)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Message not approved");
    });

    test("succeeds and calls internal handle message", async () => {
      // ensure approved
      expect(
        await client.isMessageApproved({
          sender: user,
          args: [MESSAGE_DIGEST],
          extraFee: (1000).microAlgos(),
        }),
      ).toBeTruthy();

      // execute message
      const APP_MIN_BALANCE = (122_900).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const MESSAGE_RECEIVED = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(appId, 32) }),
      );
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .executeMessage({
          sender: user,
          args: [MESSAGE_RECEIVED],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getMessagesExecutedBoxKey(MESSAGE_DIGEST)],
          extraFee: (2000).microAlgos(),
        })
        .send();
      expect(res.confirmations[1].innerTxns!.length).toEqual(2);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("HandledMessage(byte[32],byte[32])", [MESSAGE_DIGEST, MESSAGE_RECEIVED.id]),
      );
      expect(await client.isMessageExecuted({ sender: user, args: [MESSAGE_DIGEST] })).toBeTruthy();
    });

    test("fails when message already executed", async () => {
      // ensure already executed
      expect(await client.isMessageExecuted({ sender: user, args: [MESSAGE_DIGEST] })).toBeTruthy();

      // execute message
      const MESSAGE_RECEIVED = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(appId, 32) }),
      );
      await expect(
        client.send.executeMessage({
          sender: user,
          args: [MESSAGE_RECEIVED],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getMessagesExecutedBoxKey(MESSAGE_DIGEST)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Message already executed");
    });
  });
});
