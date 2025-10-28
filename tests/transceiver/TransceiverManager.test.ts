import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { keccak_256 } from "@noble/hashes/sha3";
import { type Account, type Address, OnApplicationComplete, getApplicationAddress } from "algosdk";

import { MockMessageHandlerClient, MockMessageHandlerFactory } from "../../specs/client/MockMessageHandler.client.ts";
import type { MessageReceived } from "../../specs/client/MockTransceiver.client.js";
import { MockTransceiverFactory } from "../../specs/client/MockTransceiver.client.ts";
import { OpUpClient, OpUpFactory } from "../../specs/client/OpUp.client.ts";
import { TransceiverManagerClient, TransceiverManagerFactory } from "../../specs/client/TransceiverManager.client.ts";
import {
  getAddressRolesBoxKey,
  getHandlerTransceiversBoxKey,
  getNumAttestationsBoxKey,
  getRoleBoxKey,
  getTransceiverAttestationsBoxKey,
} from "../utils/boxes.ts";
import { convertNumberToBytes, enc, getEventBytes, getRandomBytes } from "../utils/bytes.ts";
import {
  type TransceiverInstruction,
  calculateMessageDigest,
  getMessageReceived,
  getRandomMessageToSend,
} from "../utils/message.ts";
import { SECONDS_IN_DAY } from "../utils/time.ts";
import { MAX_UINT16, MAX_UINT64, getRandomUInt } from "../utils/uint.ts";

describe("TransceiverManager", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const MESSAGE_HANDLER_ADMIN_ROLE = (appId: number | bigint) =>
    keccak_256(Uint8Array.from([...enc.encode("MESSAGE_HANDLER_ADMIN_"), ...convertNumberToBytes(appId, 8)])).slice(
      0,
      16,
    );
  const MESSAGE_HANDLER_PAUSER_ROLE = (appId: number | bigint) =>
    keccak_256(Uint8Array.from([...enc.encode("MESSAGE_HANDLER_PAUSER_"), ...convertNumberToBytes(appId, 8)])).slice(
      0,
      16,
    );
  const MESSAGE_HANDLER_UNPAUSER_ROLE = (appId: number | bigint) =>
    keccak_256(Uint8Array.from([...enc.encode("MESSAGE_HANDLER_UNPAUSER_"), ...convertNumberToBytes(appId, 8)])).slice(
      0,
      16,
    );

  const NUM_TRANSCEIVERS_ADDED = 3;
  const MAX_TRANSCEIVERS = 32n;

  let transceiverFactory: MockTransceiverFactory;
  const transceiverAppIds: bigint[] = [];

  let opUpFactory: OpUpFactory;
  let opUpClient: OpUpClient;
  let opUpAppId: bigint;

  let messageHandlerFactory: MockMessageHandlerFactory;
  let messageHandlerClient: MockMessageHandlerClient;
  let messageHandlerAppId: bigint;
  let messageHandlerAppIdWithNoTransceivers: bigint;

  let factory: TransceiverManagerFactory;
  let client: TransceiverManagerClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;
  let admin: Address & Account & TransactionSignerAccount;
  let pauser: Address & Account & TransactionSignerAccount;
  let unpauser: Address & Account & TransactionSignerAccount;
  let user: Address & Account & TransactionSignerAccount;

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });
    admin = await generateAccount({ initialFunds: (100).algo() });
    pauser = await generateAccount({ initialFunds: (100).algo() });
    unpauser = await generateAccount({ initialFunds: (100).algo() });
    user = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(TransceiverManagerFactory, {
      defaultSender: creator,
      defaultSigner: creator.signer,
    });

    // deploy op up
    {
      opUpFactory = localnet.algorand.client.getTypedAppFactory(OpUpFactory, {
        defaultSender: creator,
        defaultSigner: creator.signer,
      });
      const { appClient, result } = await opUpFactory.deploy();
      opUpAppId = result.appId;
      opUpClient = appClient;

      expect(opUpAppId).not.toEqual(0n);
    }

    // deploy message handler
    {
      messageHandlerFactory = localnet.algorand.client.getTypedAppFactory(MockMessageHandlerFactory, {
        defaultSender: creator,
        defaultSigner: creator.signer,
      });
      const { appClient, result } = await messageHandlerFactory.deploy();
      messageHandlerAppId = result.appId;
      messageHandlerClient = appClient;

      expect(messageHandlerAppId).not.toEqual(0n);
    }

    // fund mock message handler so have funds to pay for sending messages
    await localnet.algorand.account.ensureFunded(
      getApplicationAddress(messageHandlerAppId),
      await localnet.algorand.account.localNetDispenser(),
      (100).algo(),
    );

    // deploy second message handler
    {
      const { result } = await messageHandlerFactory.send.create.bare({ sender: creator });
      messageHandlerAppIdWithNoTransceivers = result.appId;

      expect(messageHandlerAppIdWithNoTransceivers).not.toEqual(0n);
    }

    // prepare transceivers
    {
      transceiverFactory = localnet.algorand.client.getTypedAppFactory(MockTransceiverFactory, {
        defaultSender: creator,
        defaultSigner: creator.signer,
      });
    }
  });

  test("deploys with correct state", async () => {
    const { appClient, result } = await factory.deploy({
      createParams: {
        sender: creator,
      },
    });
    appId = result.appId;
    client = appClient;

    expect(appId).not.toEqual(0n);
    expect(await client.state.global.maxTransceivers()).toEqual(MAX_TRANSCEIVERS);
    expect(Uint8Array.from(await client.defaultAdminRole())).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [DEFAULT_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
  });

  test("message handler admin role returns correct value", async () => {
    const messageHandler = getRandomUInt(MAX_UINT64);
    expect(await client.messageHandlerAdminRole({ args: [messageHandler] })).toEqual(
      MESSAGE_HANDLER_ADMIN_ROLE(messageHandler),
    );
  });

  test("message handler pauser role returns correct value", async () => {
    const messageHandler = getRandomUInt(MAX_UINT64);
    expect(await client.messageHandlerPauserRole({ args: [messageHandler] })).toEqual(
      MESSAGE_HANDLER_PAUSER_ROLE(messageHandler),
    );
  });

  test("message handler unpauser role returns correct value", async () => {
    const messageHandler = getRandomUInt(MAX_UINT64);
    expect(await client.messageHandlerUnpauserRole({ args: [messageHandler] })).toEqual(
      MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandler),
    );
  });

  test("calculate message digest returns correct value", async () => {
    const message = getMessageReceived(getRandomUInt(MAX_UINT16), getRandomMessageToSend());
    const messageDigest = calculateMessageDigest(message);
    expect(await client.calculateMessageDigest({ args: [message] })).toEqual(messageDigest);
  });

  test("get handler transceivers fails when message handler unknown", async () => {
    expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppId] })).toBeFalsy();
    await expect(client.getHandlerTransceivers({ sender: user, args: [messageHandlerAppId] })).rejects.toThrow(
      "Message handler unknown",
    );
  });

  describe("add message handler", () => {
    test.each([
      { adminLength: 30, arg: "arc4.static_array<arc4.uint8, 32>" },
      { adminLength: 34, arg: "arc4.static_array<arc4.uint8, 32>" },
    ])(`fails when admin is $adminLength bytes`, async ({ adminLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("add_message_handler").getSelector(), getRandomBytes(adminLength)],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("fails when caller is not an application", async () => {
      await expect(client.send.addMessageHandler({ sender: user, args: [admin.toString()] })).rejects.toThrow(
        "Caller must be an application",
      );
    });

    test("succeeds and returns true when new message handler", async () => {
      // check not added before
      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppId] })).toBeFalsy();

      // add message handler
      const APP_MIN_BALANCE = (194_500).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await messageHandlerClient
        .newGroup()
        .addTransaction(fundingTxn)
        .setTransceiverManager({
          sender: user,
          args: [admin.toString(), appId],
          extraFee: (1000).microAlgos(),
        })
        .send();

      expect(res.returns).toEqual([true]);
      const messageHandlerAdminRole = MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId);
      const messageHandlerPauserRole = MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId);
      const messageHandlerUnpauserRole = MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId);
      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppId] })).toBeTruthy();
      expect(await client.hasRole({ args: [messageHandlerAdminRole, admin.toString()] })).toBeTruthy();
      expect(await client.getRoleAdmin({ args: [messageHandlerAdminRole] })).toEqual(messageHandlerAdminRole);
      expect(await client.getRoleAdmin({ args: [messageHandlerPauserRole] })).toEqual(messageHandlerAdminRole);
      expect(await client.getRoleAdmin({ args: [messageHandlerUnpauserRole] })).toEqual(messageHandlerAdminRole);
      expect(await client.getHandlerTransceivers({ args: [messageHandlerAppId] })).toEqual([]);

      expect(res.confirmations[1].innerTxns!.length).toEqual(1);
      expect(res.confirmations[1].innerTxns![0].txn.txn.type).toEqual("appl");
      expect(res.confirmations[1].innerTxns![0].txn.txn.applicationCall!.appIndex).toEqual(appId);
      expect(res.confirmations[1].innerTxns![0].logs!.length).toEqual(6);
      expect(res.confirmations[1].innerTxns![0].logs![0]).toEqual(
        getEventBytes("RoleGranted(byte[16],address,address)", [
          messageHandlerAdminRole,
          admin.publicKey,
          getApplicationAddress(messageHandlerAppId),
        ]),
      );
      expect(res.confirmations[1].innerTxns![0].logs![1]).toEqual(
        getEventBytes("RoleAdminChanged(byte[16],byte[16],byte[16])", [
          messageHandlerAdminRole,
          DEFAULT_ADMIN_ROLE,
          messageHandlerAdminRole,
        ]),
      );
      expect(res.confirmations[1].innerTxns![0].logs![2]).toEqual(
        getEventBytes("RoleAdminChanged(byte[16],byte[16],byte[16])", [
          messageHandlerPauserRole,
          DEFAULT_ADMIN_ROLE,
          messageHandlerAdminRole,
        ]),
      );
      expect(res.confirmations[1].innerTxns![0].logs![3]).toEqual(
        getEventBytes("RoleAdminChanged(byte[16],byte[16],byte[16])", [
          messageHandlerUnpauserRole,
          DEFAULT_ADMIN_ROLE,
          messageHandlerAdminRole,
        ]),
      );
      expect(res.confirmations[1].innerTxns![0].logs![4]).toEqual(
        getEventBytes("MessageHandlerAdded(uint64,address)", [messageHandlerAppId, admin.toString()]),
      );
    });

    test("succeeds and returns true for second message handler", async () => {
      // check not added before
      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppIdWithNoTransceivers] })).toBeFalsy();

      // add message handler
      const APP_MIN_BALANCE = (94_500).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await messageHandlerFactory
        .getAppClientById({ appId: messageHandlerAppIdWithNoTransceivers })
        .newGroup()
        .addTransaction(fundingTxn)
        .setTransceiverManager({
          sender: user,
          args: [admin.toString(), appId],
          extraFee: (1000).microAlgos(),
        })
        .send();

      // check added after
      expect(res.returns).toEqual([true]);
      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppIdWithNoTransceivers] })).toBeTruthy();
    });

    test("succeeds and returns false when existing message handler", async () => {
      // check already added
      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppId] })).toBeTruthy();

      // add message handler
      const res = await messageHandlerClient.send.setTransceiverManager({
        sender: user,
        args: [admin.toString(), appId],
        extraFee: (1000).microAlgos(),
      });

      expect(await client.isMessageHandlerKnown({ args: [messageHandlerAppId] })).toBeTruthy();
      expect(res.return).toBeFalsy();
      expect(res.confirmations[0].innerTxns![0].logs!.length).toEqual(1);
    });
  });

  describe("pause and unpause", () => {
    beforeAll(async () => {
      const APP_MIN_BALANCE = (55_400).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      await client
        .newGroup()
        .addTransaction(fundingTxn)
        .grantRole({
          sender: admin,
          args: [MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.toString()],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.publicKey),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, admin.publicKey),
          ],
        })
        .grantRole({
          sender: admin,
          args: [MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.toString()],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.publicKey),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, admin.publicKey),
          ],
        })
        .send();
      expect(
        await client.hasRole({ args: [MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.toString()] }),
      ).toBeTruthy();
      expect(
        await client.hasRole({ args: [MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.toString()] }),
      ).toBeTruthy();
    });

    test.each([
      { messageHandlerLength: 4, arg: "arc4.uint64" },
      { messageHandlerLength: 16, arg: "arc4.uint64" },
    ])(`pause fails when message handler is $messageHandlerLength bytes`, async ({ messageHandlerLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("pause").getSelector(), convertNumberToBytes(0, messageHandlerLength)],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test.each([
      { messageHandlerLength: 6, arg: "arc4.uint64" },
      { messageHandlerLength: 10, arg: "arc4.uint64" },
    ])(`unpause fails when message handler is $messageHandlerLength bytes`, async ({ messageHandlerLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("unpause").getSelector(), convertNumberToBytes(0, messageHandlerLength)],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("pause fails when caller is not pauser", async () => {
      await expect(
        client.send.pause({
          sender: user,
          args: [messageHandlerAppId],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), user.publicKey),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("unpause fails when caller is not unpauser", async () => {
      await expect(
        client.send.unpause({
          sender: user,
          args: [messageHandlerAppId],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), user.publicKey),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("unpause fails when not paused", async () => {
      await expect(
        client.send.unpause({
          sender: unpauser,
          args: [messageHandlerAppId],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.publicKey),
          ],
        }),
      ).rejects.toThrow("Message handler is not paused");
    });

    test("pause succeeds", async () => {
      const APP_MIN_BALANCE = (12_100).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .pause({
          sender: pauser,
          args: [messageHandlerAppId],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.publicKey),
          ],
        })
        .send();
      expect(await client.isMessageHandlerPaused({ sender: user, args: [messageHandlerAppId] })).toBeTruthy();
      expect(res.confirmations[1].logs![0]).toEqual(getEventBytes("Paused(uint64,bool)", [messageHandlerAppId, true]));
    });

    test("pause fails when already paused", async () => {
      await expect(
        client.send.pause({
          sender: pauser,
          args: [messageHandlerAppId],
          boxReferences: [
            getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
            getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.publicKey),
          ],
        }),
      ).rejects.toThrow("Message handler is paused");
    });

    test("unpause succeeds", async () => {
      const res = await client.send.unpause({
        sender: unpauser,
        args: [messageHandlerAppId],
        boxReferences: [
          getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
          getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.publicKey),
        ],
      });
      expect(await client.isMessageHandlerPaused({ sender: user, args: [messageHandlerAppId] })).toBeFalsy();
      expect(res.confirmations[0].logs![0]).toEqual(getEventBytes("Paused(uint64,bool)", [messageHandlerAppId, false]));
    });
  });

  describe("add transceiver", () => {
    beforeAll(async () => {
      // deploy MAX_TRANSCEIVERS + 1 unique transceivers
      for (let i = 0; i <= MAX_TRANSCEIVERS; i++) {
        const messageFee = getRandomUInt(900_000) + 100_000n; // between 0.1 and 1 ALGO
        const { result } = await transceiverFactory.send.create.create({
          sender: creator,
          args: [appId, messageFee, SECONDS_IN_DAY],
        });
        expect(result.appId).not.toEqual(0n);
        transceiverAppIds.push(result.appId);
      }

      // check they are unique
      expect(new Set(transceiverAppIds).size).toEqual(Number(MAX_TRANSCEIVERS) + 1);
    });

    test.each([
      { messageHandlerLength: 4, transceiverLength: 8, arg: "arc4.uint64" },
      { messageHandlerLength: 16, transceiverLength: 8, arg: "arc4.uint64" },
      { messageHandlerLength: 8, transceiverLength: 4, arg: "arc4.uint64" },
      { messageHandlerLength: 8, transceiverLength: 16, arg: "arc4.uint64" },
    ])(
      `unpause fails when message handler is $messageHandlerLength and transceiver is $transceiverLength bytes`,
      async ({ messageHandlerLength, transceiverLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("add_transceiver").getSelector(),
              convertNumberToBytes(0, messageHandlerLength),
              convertNumberToBytes(0, transceiverLength),
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when message handler is unknown", async () => {
      const transceiverAppId = transceiverAppIds[0];
      expect(await client.isMessageHandlerKnown({ args: [transceiverAppId] })).toBeFalsy();
      await expect(
        client.send.addTransceiver({
          sender: admin,
          args: [transceiverAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(transceiverAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(transceiverAppId),
          ],
        }),
      ).rejects.toThrow("Message handler unknown");
    });

    test("fails when caller is not message handler admin", async () => {
      const transceiverAppId = transceiverAppIds[0];
      await expect(
        client.send.addTransceiver({
          sender: user,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), user.publicKey)],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    // use is_transceiver_configured and get_handler_transceivers within tests
    test("succeeds when adding one transceiver", async () => {
      const transceiverAppId = transceiverAppIds[0];
      const APP_MIN_BALANCE = (3_200).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .addTransceiver({
          sender: admin,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(messageHandlerAppId),
          ],
        })
        .send();

      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeTruthy();
      expect(await client.getHandlerTransceivers({ args: [messageHandlerAppId] })).toEqual([transceiverAppId]);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("TransceiverAdded(uint64,uint64)", [messageHandlerAppId, transceiverAppId]),
      );
    });

    test("fails when already added", async () => {
      // check already added
      const transceiverAppId = transceiverAppIds[0];
      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeTruthy();

      // add transceiver
      await expect(
        client.send.addTransceiver({
          sender: admin,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(messageHandlerAppId),
          ],
        }),
      ).rejects.toThrow("Transceiver was already added");
    });

    test("succeeds when adding MAX_TRANSCEIVERS transceivers", async () => {
      // prefund with min balance
      const APP_MIN_BALANCE = (3_200 * (Number(MAX_TRANSCEIVERS) - 1)).microAlgos();
      await localnet.algorand.send.payment({
        sender: admin,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });

      // add transceivers
      for (let i = 1; i < MAX_TRANSCEIVERS; i++) {
        const transceiverAppId = transceiverAppIds[i];

        const {
          transactions: [opUpTxn],
        } = await opUpClient.createTransaction.ensureBudget({
          sender: admin,
          args: [7000],
          extraFee: (9000).microAlgos(),
        });
        const res = await client
          .newGroup()
          .addTransaction(opUpTxn)
          .addTransceiver({
            sender: admin,
            args: [messageHandlerAppId, transceiverAppId],
            boxReferences: [
              getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
              getHandlerTransceiversBoxKey(messageHandlerAppId),
            ],
          })
          .send();

        expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeTruthy();
        expect(res.confirmations[1].logs![0]).toEqual(
          getEventBytes("TransceiverAdded(uint64,uint64)", [messageHandlerAppId, transceiverAppId]),
        );
      }

      // check MAX_TRANSCEIVERS added total
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(added.length).toEqual(Number(MAX_TRANSCEIVERS));
      expect(added).toEqual(transceiverAppIds.slice(0, Number(MAX_TRANSCEIVERS)));
    });

    test("fails when max transceivers exceeded", async () => {
      // check MAX_TRANSCEIVERS added
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(added.length).toEqual(Number(MAX_TRANSCEIVERS));

      // add transceiver
      const transceiverAppId = transceiverAppIds[Number(MAX_TRANSCEIVERS)];
      await expect(
        client.send.addTransceiver({
          sender: admin,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(messageHandlerAppId),
          ],
        }),
      ).rejects.toThrow("Maximum transceivers exceeded");
    });
  });

  describe("remove transceiver", () => {
    test.each([
      { messageHandlerLength: 4, transceiverLength: 8, arg: "arc4.uint64" },
      { messageHandlerLength: 16, transceiverLength: 8, arg: "arc4.uint64" },
      { messageHandlerLength: 8, transceiverLength: 4, arg: "arc4.uint64" },
      { messageHandlerLength: 8, transceiverLength: 16, arg: "arc4.uint64" },
    ])(
      `unpause fails when message handler is $messageHandlerLength and transceiver is $transceiverLength bytes`,
      async ({ messageHandlerLength, transceiverLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("remove_transceiver").getSelector(),
              convertNumberToBytes(0, messageHandlerLength),
              convertNumberToBytes(0, transceiverLength),
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when message handler is unknown", async () => {
      const transceiverAppId = transceiverAppIds[0];
      expect(await client.isMessageHandlerKnown({ args: [transceiverAppId] })).toBeFalsy();
      await expect(
        client.send.removeTransceiver({
          sender: admin,
          args: [transceiverAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(transceiverAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(transceiverAppId),
          ],
        }),
      ).rejects.toThrow("Message handler unknown");
    });

    test("fails when caller is not message handler admin", async () => {
      const transceiverAppId = transceiverAppIds[0];
      await expect(
        client.send.removeTransceiver({
          sender: user,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), user.publicKey)],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("fails when transceiver was not added for message handler", async () => {
      // check not added
      const transceiverAppId = transceiverAppIds[Number(MAX_TRANSCEIVERS)];
      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeFalsy();

      // remove transceiver
      const {
        transactions: [opUpTxn],
      } = await opUpClient.createTransaction.ensureBudget({
        sender: admin,
        args: [7000],
        extraFee: (9000).microAlgos(),
      });
      await expect(
        client
          .newGroup()
          .addTransaction(opUpTxn)
          .removeTransceiver({
            sender: admin,
            args: [messageHandlerAppId, transceiverAppId],
            boxReferences: [
              getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
              getHandlerTransceiversBoxKey(messageHandlerAppId),
            ],
          })
          .send(),
      ).rejects.toThrow("Unknown transceiver");
    });

    test("succeeds when removing one transceiver", async () => {
      // check added
      const transceiverAppId = transceiverAppIds[0];
      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeTruthy();
      const addedBefore = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(addedBefore.some((appId) => appId === transceiverAppId)).toBeTruthy();

      // remove transceiver
      const {
        transactions: [opUpTxn],
      } = await opUpClient.createTransaction.ensureBudget({
        sender: admin,
        args: [7000],
        extraFee: (9000).microAlgos(),
      });
      const res = await client
        .newGroup()
        .addTransaction(opUpTxn)
        .removeTransceiver({
          sender: admin,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(messageHandlerAppId),
          ],
        })
        .send();

      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeFalsy();
      const addedAfter = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(addedAfter.some((appId) => appId === transceiverAppId)).toBeFalsy();
      expect(addedAfter.length).toEqual(addedBefore.length - 1);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("TransceiverRemoved(uint64,uint64)", [messageHandlerAppId, transceiverAppId]),
      );
    });

    test("succeeds when removing multiple transceivers", async () => {
      const addedBefore = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(addedBefore.length).toBeGreaterThan(1);

      // remove all
      for (const transceiverAppId of addedBefore) {
        const {
          transactions: [opUpTxn],
        } = await opUpClient.createTransaction.ensureBudget({
          sender: admin,
          args: [7000],
          extraFee: (9000).microAlgos(),
        });
        const res = await client
          .newGroup()
          .addTransaction(opUpTxn)
          .removeTransceiver({
            sender: admin,
            args: [messageHandlerAppId, transceiverAppId],
            boxReferences: [
              getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
              getHandlerTransceiversBoxKey(messageHandlerAppId),
            ],
          })
          .send();

        expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeFalsy();
        expect(res.confirmations[1].logs![0]).toEqual(
          getEventBytes("TransceiverRemoved(uint64,uint64)", [messageHandlerAppId, transceiverAppId]),
        );
      }

      // check all removed
      const addedAfter = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(addedAfter.length).toEqual(0);
    });
  });

  describe("quote delivery price", () => {
    beforeAll(async () => {
      for (let i = 0; i < NUM_TRANSCEIVERS_ADDED; i++) {
        const transceiverAppId = transceiverAppIds[i];
        await client.send.addTransceiver({
          sender: admin,
          args: [messageHandlerAppId, transceiverAppId],
          boxReferences: [
            getAddressRolesBoxKey(MESSAGE_HANDLER_ADMIN_ROLE(messageHandlerAppId), admin.publicKey),
            getHandlerTransceiversBoxKey(messageHandlerAppId),
          ],
        });
      }

      // ensure added
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      expect(added.length).toEqual(NUM_TRANSCEIVERS_ADDED);
    });

    test("fails when message handler is unknown", async () => {
      const transceiverAppId = transceiverAppIds[0];
      const message = getRandomMessageToSend();
      await expect(
        client.quoteDeliveryPrices({
          sender: user,
          args: [transceiverAppId, message, []],
          boxReferences: [getHandlerTransceiversBoxKey(transceiverAppId)],
        }),
      ).rejects.toThrow("Message handler unknown");
    });

    test("fails when 0 transceivers configured", async () => {
      const message = getRandomMessageToSend();
      await expect(
        client.quoteDeliveryPrices({
          sender: user,
          args: [messageHandlerAppIdWithNoTransceivers, message, []],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
        }),
      ).rejects.toThrow("Message handler has zero transceivers");
    });

    test("fails when unknown transceiver in instructions is passed", async () => {
      const message = getRandomMessageToSend();
      const transceiverInstructions: TransceiverInstruction[] = [[messageHandlerAppId, getRandomBytes(10)]];
      await expect(
        client.quoteDeliveryPrices({
          sender: user,
          args: [messageHandlerAppId, message, transceiverInstructions],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (NUM_TRANSCEIVERS_ADDED * 1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect order or unknown transceiver in instructions");
    });

    test("fails when incorrect order of transceivers in instructions is passed", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend();
      const transceiverInstructions: TransceiverInstruction[] = [
        [added[1], getRandomBytes(10)],
        [added[0], getRandomBytes(10)],
      ];
      await expect(
        client.quoteDeliveryPrices({
          sender: user,
          args: [messageHandlerAppId, message, transceiverInstructions],
          appReferences: added,
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (NUM_TRANSCEIVERS_ADDED * 1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect order or unknown transceiver in instructions");
    });

    test("succeeds", async () => {
      // prepare message with transceiver instructions
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend();
      const transceiverInstructions: TransceiverInstruction[] = [
        [added[0], getRandomBytes(10)],
        [added[NUM_TRANSCEIVERS_ADDED - 1], getRandomBytes(30)],
      ];

      // quote delivery prices
      const res = await client.send.quoteDeliveryPrices({
        sender: user,
        args: [messageHandlerAppId, message, transceiverInstructions],
        appReferences: added,
        boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
        extraFee: (NUM_TRANSCEIVERS_ADDED * 1000).microAlgos(),
      });

      // check each transceiver was called
      let expectedTotalQuote = 0n;
      expect(res.confirmations[0].innerTxns!.length).toEqual(added.length);
      for (let i = 0; i < added.length; i++) {
        const transceiverAppId = added[i];
        const transceiverInstruction =
          transceiverInstructions.find(([appId]) => appId === transceiverAppId)?.[1] ?? getRandomBytes(0);
        expectedTotalQuote +=
          (await transceiverFactory.getAppClientById({ appId: transceiverAppId }).state.global.messageFee()) ?? 0n;

        expect(res.confirmations[0].innerTxns![i].txn.txn.type).toEqual("appl");
        expect(res.confirmations[0].innerTxns![i].txn.txn.applicationCall!.appIndex).toEqual(transceiverAppId);
        expect(res.confirmations[0].innerTxns![i].logs![0]).toEqual(
          getEventBytes("InternalQuoteDeliveryPrice(byte[32],byte[])", [message.id, transceiverInstruction]),
        );
      }

      // check total quote
      expect(res.return).toEqual(expectedTotalQuote);
    });
  });

  describe("send message to transceivers", () => {
    let TOTAL_QUOTE: bigint;

    beforeAll(async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: getApplicationAddress(messageHandlerAppId).publicKey });
      TOTAL_QUOTE = await client.quoteDeliveryPrices({
        sender: user,
        args: [messageHandlerAppId, message, []],
        appReferences: added,
        boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
        extraFee: (NUM_TRANSCEIVERS_ADDED * 1000).microAlgos(),
      });
    });

    test("fails when fee payment isn't payment", async () => {
      const {
        transactions: [feePaymentTxn],
      } = await opUpClient.createTransaction.ensureBudget({
        sender: user,
        args: [0],
      });
      await expect(
        localnet.algorand
          .newGroup()
          .addTransaction(feePaymentTxn)
          .addAppCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("send_message_to_transceivers").getSelector(),
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
              client.appClient.getABIMethod("send_message_to_transceivers").getSelector(),
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
              client.appClient.getABIMethod("send_message_to_transceivers").getSelector(),
              Uint8Array.from([...getRandomBytes(130), ...convertNumberToBytes(129, 2)]),
              convertNumberToBytes(0, 2),
            ],
            extraFee: (2000).microAlgos(),
          })
          .send(),
      ).rejects.toThrow(`invalid tail pointer at index 5`);
    });

    test.each([
      { messagePayloadLengthDelta: -1, arg: "ntt_contracts.types.MessageToSend" },
      { messagePayloadLengthDelta: 1, arg: "ntt_contracts.types.MessageToSend" },
    ])(
      "fails when message payload length delta is $messagePayloadLengthDelta bytes",
      async ({ messagePayloadLengthDelta, arg }) => {
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
                client.appClient.getABIMethod("send_message_to_transceivers").getSelector(),
                Uint8Array.from([
                  ...getRandomBytes(130),
                  ...convertNumberToBytes(132, 2),
                  ...convertNumberToBytes(payload.length + messagePayloadLengthDelta, 2),
                  ...payload,
                ]),
                convertNumberToBytes(0, 2),
              ],
              extraFee: (2000).microAlgos(),
            })
            .send(),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when caller is not an application", async () => {
      const feePaymentTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: (0).microAlgos(),
      });
      const message = getRandomMessageToSend();
      await expect(
        client.send.sendMessageToTransceivers({
          sender: user,
          args: [feePaymentTxn, message, []],
          boxReferences: [],
        }),
      ).rejects.toThrow("Caller must be an application");
    });

    test("fails when message handler is unknown", async () => {
      const { result } = await messageHandlerFactory.send.create.bare({ sender: creator });
      const unknownMessageHandlerAppId = result.appId;

      const message = getRandomMessageToSend();
      await expect(
        messageHandlerFactory.getAppClientById({ appId: unknownMessageHandlerAppId }).send.sendMessageToTransceivers({
          sender: user,
          args: [0n, getApplicationAddress(appId).toString(), appId, message, []],
          appReferences: [appId],
          boxReferences: [getHandlerTransceiversBoxKey(unknownMessageHandlerAppId)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Message handler unknown");
    });

    test("fails when message handler is paused", async () => {
      // pause
      await client.send.pause({
        sender: pauser,
        args: [messageHandlerAppId],
        boxReferences: [
          getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
          getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.publicKey),
        ],
      });

      // send message
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: getApplicationAddress(messageHandlerAppId).publicKey });
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [TOTAL_QUOTE, getApplicationAddress(appId).toString(), appId, message, []],
          appReferences: [appId, ...added],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Message handler is paused");

      // unpause
      await client.send.unpause({
        sender: unpauser,
        args: [messageHandlerAppId],
        boxReferences: [
          getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
          getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.publicKey),
        ],
      });
    });

    test("fails when message source address doesn't match caller", async () => {
      const transceiverAppId = transceiverAppIds[0];
      const message = getRandomMessageToSend({ sourceAddress: user.publicKey });
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [0n, getApplicationAddress(appId).toString(), appId, message, []],
          appReferences: [appId],
          boxReferences: [getHandlerTransceiversBoxKey(transceiverAppId)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("Caller must be message source address");
    });

    test("fails when 0 transceivers configured", async () => {
      const message = getRandomMessageToSend({
        sourceAddress: convertNumberToBytes(messageHandlerAppIdWithNoTransceivers, 32),
      });
      await expect(
        messageHandlerFactory
          .getAppClientById({ appId: messageHandlerAppIdWithNoTransceivers })
          .send.sendMessageToTransceivers({
            sender: user,
            args: [0n, getApplicationAddress(appId).toString(), appId, message, []],
            appReferences: [appId],
            boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppIdWithNoTransceivers)],
            extraFee: (2000).microAlgos(),
          }),
      ).rejects.toThrow("Message handler has zero transceivers");
    });

    test("fails when unknown transceiver in instructions is passed", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });
      const transceiverInstructions: TransceiverInstruction[] = [[messageHandlerAppId, getRandomBytes(10)]];

      // send message
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [TOTAL_QUOTE, getApplicationAddress(appId).toString(), appId, message, transceiverInstructions],
          appReferences: [appId, ...added],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect order or unknown transceiver in instructions");
    });

    test("fails when incorrect order of transceivers in instructions is passed", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });
      const transceiverInstructions: TransceiverInstruction[] = [
        [added[1], getRandomBytes(10)],
        [added[0], getRandomBytes(10)],
      ];

      // send message
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [TOTAL_QUOTE, getApplicationAddress(appId).toString(), appId, message, transceiverInstructions],
          appReferences: [appId, ...added],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect order or unknown transceiver in instructions");
    });

    test("fails when fee payment receiver isn't contract", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });

      // send message
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: getApplicationAddress(appId),
        amount: TOTAL_QUOTE.microAlgo(),
      });
      await expect(
        messageHandlerClient
          .newGroup()
          .addTransaction(fundingTxn)
          .sendMessageToTransceivers({
            sender: user,
            args: [TOTAL_QUOTE, user.toString(), appId, message, []],
            appReferences: [appId, ...added],
            boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
            extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
          })
          .send(),
      ).rejects.toThrow("Unknown fee payment receiver");
    });

    test("fails when fee payment is too low", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });

      // send message
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [TOTAL_QUOTE - 1n, getApplicationAddress(appId).toString(), appId, message, []],
          appReferences: [appId, ...added],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect fee payment amount");
    });

    test("fails when fee payment is too high", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });

      // send message
      await expect(
        messageHandlerClient.send.sendMessageToTransceivers({
          sender: user,
          args: [TOTAL_QUOTE + 1n, getApplicationAddress(appId).toString(), appId, message, []],
          appReferences: [appId, ...added],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect fee payment amount");
    });

    test("succeeds", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const message = getRandomMessageToSend({ sourceAddress: convertNumberToBytes(messageHandlerAppId, 32) });
      const transceiverInstructions: TransceiverInstruction[] = [
        [added[0], getRandomBytes(10)],
        [added[1], getRandomBytes(30)],
      ];

      // send message
      const res = await messageHandlerClient.send.sendMessageToTransceivers({
        sender: user,
        args: [TOTAL_QUOTE, getApplicationAddress(appId).toString(), appId, message, transceiverInstructions],
        appReferences: [appId, ...added],
        boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
        extraFee: (2000 + NUM_TRANSCEIVERS_ADDED * 3000).microAlgos(),
      });

      // check each transceiver was called
      expect(res.confirmations[0].innerTxns![1].innerTxns!.length).toEqual(added.length * 3);
      for (let i = 0; i < added.length; i++) {
        const transceiverAppId = added[i];
        const transceiverInstruction =
          transceiverInstructions.find(([appId]) => appId === transceiverAppId)?.[1] ?? getRandomBytes(0);
        const quote = await transceiverFactory.getAppClientById({ appId: transceiverAppId }).state.global.messageFee();

        // get quote
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3].txn.txn.type).toEqual("appl");
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3].txn.txn.applicationCall!.appIndex).toEqual(
          transceiverAppId,
        );
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3].logs![0]).toEqual(
          getEventBytes("InternalQuoteDeliveryPrice(byte[32],byte[])", [message.id, transceiverInstruction]),
        );

        // payment for send message
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 1].txn.txn.type).toEqual("pay");
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 1].txn.txn.payment!.amount).toEqual(quote);
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 1].txn.txn.payment!.receiver).toEqual(
          getApplicationAddress(transceiverAppId),
        );

        // send message
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 2].txn.txn.type).toEqual("appl");
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 2].txn.txn.applicationCall!.appIndex).toEqual(
          transceiverAppId,
        );
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 2].logs![0]).toEqual(
          getEventBytes("InternalQuoteDeliveryPrice(byte[32],byte[])", [message.id, transceiverInstruction]),
        );
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 2].logs![1]).toEqual(
          getEventBytes("InternalSendMessage(uint64,byte[32],byte[])", [quote!, message.id, transceiverInstruction]),
        );
        expect(res.confirmations[0].innerTxns![1].innerTxns![i * 3 + 2].logs![2]).toEqual(
          getEventBytes("MessageSent(byte[32])", [message.id]),
        );
      }
    });
  });

  describe("attestation received", () => {
    let messageReceived: MessageReceived;
    let messageDigest: Uint8Array;

    beforeAll(async () => {
      messageReceived = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(messageHandlerAppId, 32) }),
      );
      messageDigest = await client.calculateMessageDigest({ args: [messageReceived] });
    });

    test("fails when message length is less than 132 bytes", async () => {
      await expect(
        localnet.algorand.send.appCall({
          sender: user,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("attestation_received").getSelector(), getRandomBytes(131)],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow(`invalid tuple encoding`);
    });

    test("fails when message pointer is not to payload", async () => {
      await expect(
        localnet.algorand.send.appCall({
          sender: user,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [
            client.appClient.getABIMethod("attestation_received").getSelector(),
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
            sender: user,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("attestation_received").getSelector(),
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

    test("fails when caller is not an application", async () => {
      await expect(
        client.send.attestationReceived({
          sender: user,
          args: [messageReceived],
          boxReferences: [getHandlerTransceiversBoxKey(messageHandlerAppId)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Caller must be an application");
    });

    test("fails when message handler is unknown", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const transceiverAppId = added[0];
      const messageReceived = getMessageReceived(
        getRandomUInt(MAX_UINT16),
        getRandomMessageToSend({ handlerAddress: convertNumberToBytes(appId, 32) }),
      );
      await expect(
        transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
          sender: user,
          args: [messageReceived],
          appReferences: [appId],
          boxReferences: [getHandlerTransceiversBoxKey(appId)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Message handler unknown");
    });

    test("fails when caller is not configured transceiver", async () => {
      // check not added
      const transceiverAppId = transceiverAppIds[Number(MAX_TRANSCEIVERS)];
      expect(await client.isTransceiverConfigured({ args: [messageHandlerAppId, transceiverAppId] })).toBeFalsy();

      // deliver message
      await expect(
        transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
          sender: user,
          args: [messageReceived],
          appReferences: [appId],
          boxReferences: [
            getHandlerTransceiversBoxKey(messageHandlerAppId),
            getTransceiverAttestationsBoxKey(messageDigest, transceiverAppId),
            getNumAttestationsBoxKey(messageDigest),
          ],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Transceiver not configured");
    });

    test("fails when message handler is paused", async () => {
      // pause
      await client.send.pause({
        sender: pauser,
        args: [messageHandlerAppId],
        boxReferences: [
          getRoleBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId)),
          getAddressRolesBoxKey(MESSAGE_HANDLER_PAUSER_ROLE(messageHandlerAppId), pauser.publicKey),
        ],
      });

      // deliver message
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const transceiverAppId = added[NUM_TRANSCEIVERS_ADDED - 1];
      await expect(
        transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
          sender: user,
          args: [messageReceived],
          appReferences: [appId],
          boxReferences: [
            getHandlerTransceiversBoxKey(messageHandlerAppId),
            getTransceiverAttestationsBoxKey(messageDigest, transceiverAppId),
            getNumAttestationsBoxKey(messageDigest),
          ],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Message handler is paused");

      // unpause
      await client.send.unpause({
        sender: unpauser,
        args: [messageHandlerAppId],
        boxReferences: [
          getRoleBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId)),
          getAddressRolesBoxKey(MESSAGE_HANDLER_UNPAUSER_ROLE(messageHandlerAppId), unpauser.publicKey),
        ],
      });
    });

    test("succeeds on first attestation", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const transceiverAppId = added[NUM_TRANSCEIVERS_ADDED - 1];

      // deliver message (has sufficient min balance from the past transceivers)
      const res = await transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
        sender: user,
        args: [messageReceived],
        appReferences: [appId],
        boxReferences: [
          getHandlerTransceiversBoxKey(messageHandlerAppId),
          getTransceiverAttestationsBoxKey(messageDigest, transceiverAppId),
          getNumAttestationsBoxKey(messageDigest),
        ],
        extraFee: (1000).microAlgos(),
      });

      expect(await client.messageAttestations({ args: [messageDigest] })).toEqual(1n);
      expect(await client.hasTransceiverAttested({ args: [messageDigest, transceiverAppId] })).toBeTruthy();
      expect(res.confirmations[0].innerTxns![0].logs![0]).toEqual(
        getEventBytes("AttestationReceived(byte[32],uint16,byte[32],uint64,byte[32],uint64)", [
          messageReceived.id,
          messageReceived.sourceChainId,
          messageReceived.sourceAddress,
          messageHandlerAppId,
          messageDigest,
          1,
        ]),
      );
    });

    test("succeeds on second attestation", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const transceiverAppId = added[0];

      // deliver message (has sufficient min balance from the past transceivers)
      const res = await transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
        sender: user,
        args: [messageReceived],
        appReferences: [appId],
        boxReferences: [
          getHandlerTransceiversBoxKey(messageHandlerAppId),
          getTransceiverAttestationsBoxKey(messageDigest, transceiverAppId),
          getNumAttestationsBoxKey(messageDigest),
        ],
        extraFee: (1000).microAlgos(),
      });

      expect(await client.messageAttestations({ args: [messageDigest] })).toEqual(2n);
      expect(await client.hasTransceiverAttested({ args: [messageDigest, transceiverAppId] })).toBeTruthy();
      expect(res.confirmations[0].innerTxns![0].logs![0]).toEqual(
        getEventBytes("AttestationReceived(byte[32],uint16,byte[32],uint64,byte[32],uint64)", [
          messageReceived.id,
          messageReceived.sourceChainId,
          messageReceived.sourceAddress,
          messageHandlerAppId,
          messageDigest,
          2,
        ]),
      );
    });

    test("fails when already attested to same message", async () => {
      const added = await client.getHandlerTransceivers({ args: [messageHandlerAppId] });
      const transceiverAppId = added[NUM_TRANSCEIVERS_ADDED - 1];

      // check already attested
      expect(await client.hasTransceiverAttested({ args: [messageDigest, transceiverAppId] })).toBeTruthy();

      // deliver message
      await expect(
        transceiverFactory.getAppClientById({ appId: transceiverAppId }).send.deliverMessage({
          sender: user,
          args: [messageReceived],
          appReferences: [appId],
          boxReferences: [
            getHandlerTransceiversBoxKey(messageHandlerAppId),
            getTransceiverAttestationsBoxKey(messageDigest, transceiverAppId),
            getNumAttestationsBoxKey(messageDigest),
          ],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Attestation already received");
    });
  });
});
