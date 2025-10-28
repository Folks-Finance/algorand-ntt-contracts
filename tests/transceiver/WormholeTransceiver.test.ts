import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { keccak_256 } from "@noble/hashes/sha3";
import { type Account, type Address, OnApplicationComplete, getApplicationAddress } from "algosdk";

import {
  MockTransceiverManagerClient,
  MockTransceiverManagerFactory,
} from "../../specs/client/MockTransceiverManager.client.ts";
import {
  WormholeTransceiverClient,
  WormholeTransceiverFactory,
} from "../../specs/client/WormholeTransceiver.client.ts";
import { getAddressRolesBoxKey, getRoleBoxKey, getVAAsConsumedBoxKey, getWormholePeersBoxKey } from "../utils/boxes.ts";
import {
  convertBooleanToByte,
  convertBytesToNumber,
  convertNumberToBytes,
  enc,
  getEventBytes,
  getRandomBytes,
  getRoleBytes,
} from "../utils/bytes.ts";
import { deployWormholeCore, getWormholeEmitterLSig } from "../utils/contract.ts";
import {
  WORMHOLE_TRANSCEIVER_PAYLOAD_PREFIX,
  encodeMessageToSend,
  getRandomMessageToSend,
  getWormholeVAA,
} from "../utils/message.ts";
import { SECONDS_IN_DAY } from "../utils/time.ts";
import { MAX_UINT16, getRandomUInt } from "../utils/uint.ts";

describe("WormholeTransceiver", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const UPGRADEABLE_ADMIN_ROLE = getRoleBytes("UPGRADEABLE_ADMIN");
  const MANAGER_ROLE = getRoleBytes("MANAGER");

  const MIN_UPGRADE_DELAY = SECONDS_IN_DAY;

  let transceiverManagerFactory: MockTransceiverManagerFactory;
  let transceiverManagerClient: MockTransceiverManagerClient;
  let transceiverManagerAppId: bigint;

  const WORMHOLE_CORE_MESSAGE_FEE = 500_000n;
  let wormholeCoreAppId: bigint;

  let factory: WormholeTransceiverFactory;
  let client: WormholeTransceiverClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;
  let admin: Address & Account & TransactionSignerAccount;
  let user: Address & Account & TransactionSignerAccount;

  const SOURCE_CHAIN_ID = 123n;
  const PEER_CHAIN_ID = 56n;
  const PEER_CONTRACT_ADDRESS = getRandomBytes(32);
  const MESSAGE_DIGEST = getRandomBytes(32);

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });
    admin = await generateAccount({ initialFunds: (100).algo() });
    user = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(WormholeTransceiverFactory, {
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

    // deploy wormhole core
    {
      wormholeCoreAppId = await deployWormholeCore(localnet, creator, WORMHOLE_CORE_MESSAGE_FEE);

      expect(wormholeCoreAppId).not.toEqual(0n);
      const appState = await localnet.algorand.app.getGlobalState(wormholeCoreAppId);
      expect(appState["MessageFee"].value).toEqual(WORMHOLE_CORE_MESSAGE_FEE);
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
        args: [transceiverManagerAppId, wormholeCoreAppId, SOURCE_CHAIN_ID, MIN_UPGRADE_DELAY],
        appReferences: [wormholeCoreAppId],
      },
    });
    appId = result.appId;
    client = appClient;

    const emitterLogicSig = await getWormholeEmitterLSig(localnet, appId, wormholeCoreAppId);

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
    expect(await client.state.global.wormholeCore()).toEqual(wormholeCoreAppId);
    expect(await client.state.global.chainId()).toEqual(Number(SOURCE_CHAIN_ID));
    expect(await client.state.global.emitterLsig()).toEqual(emitterLogicSig.toString());

    expect(Uint8Array.from(await client.defaultAdminRole())).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [DEFAULT_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.upgradableAdminRole())).toEqual(UPGRADEABLE_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [UPGRADEABLE_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.managerRole())).toEqual(MANAGER_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [MANAGER_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
  });

  describe("when uninitialised", () => {
    test("fails to set wormhole peer", async () => {
      await expect(client.send.setWormholePeer({ sender: user, args: [5, getRandomBytes(32)] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    // fails to send message not possible to test as it first fails on "Unknown peer chain"

    test("fails to receive message manually", async () => {
      const vaaBytes = getRandomBytes(100);
      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({ sender: user, args: [verifyVAATxn], appReferences: [transceiverManagerAppId] }),
      ).rejects.toThrow("Uninitialised contract");
    });

    test.each([
      { adminLength: 30, arg: "arc4.static_array<arc4.uint8, 32>" },
      { adminLength: 34, arg: "arc4.static_array<arc4.uint8, 32>" },
    ])(`fails to initialise when admin is bytes`, async ({ adminLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("initialise").getSelector(), getRandomBytes(adminLength)],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("succeeds to initialise and sets correct state", async () => {
      const APP_MIN_BALANCE = (183_100).microAlgos();

      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      await client
        .newGroup()
        .addTransaction(fundingTxn)
        .initialise({
          args: [admin.toString()],
          boxReferences: [
            getRoleBoxKey(DEFAULT_ADMIN_ROLE),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, admin.publicKey),
            getRoleBoxKey(MANAGER_ROLE),
            getAddressRolesBoxKey(MANAGER_ROLE, admin.publicKey),
          ],
        })
        .send();
      expect(await client.state.global.isInitialised()).toBeTruthy();
      expect(await client.hasRole({ args: [DEFAULT_ADMIN_ROLE, admin.toString()] })).toBeTruthy();
      expect(await client.hasRole({ args: [MANAGER_ROLE, admin.toString()] })).toBeTruthy();
    });
  });

  test("get wormhole peer fails when peer chain unknown", async () => {
    await expect(client.getWormholePeer({ args: [PEER_CHAIN_ID] })).rejects.toThrow("Unknown peer chain");
  });

  test("get transceiver type returns wormhole", async () => {
    const transceiverType = await client.getTransceiverType();
    expect(transceiverType).toEqual("wormhole");
  });

  describe("set wormhole peer", () => {
    test.each([
      { chainIdLength: 1, contractLength: 32, arg: "arc4.uint16" },
      { chainIdLength: 4, contractLength: 32, arg: "arc4.uint16" },
      { chainIdLength: 2, contractLength: 30, arg: "arc4.static_array<arc4.uint8, 32>" },
      { chainIdLength: 2, contractLength: 34, arg: "arc4.static_array<arc4.uint8, 32>" },
    ])(
      `fails when chain id is $chainIdLength and contract is $contractLength bytes`,
      async ({ chainIdLength, contractLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("set_wormhole_peer").getSelector(),
              convertNumberToBytes(0, chainIdLength),
              getRandomBytes(contractLength),
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when caller is not manager", async () => {
      await expect(
        client.send.setWormholePeer({
          sender: user,
          args: [5, getRandomBytes(32)],
          boxReferences: [getRoleBoxKey(MANAGER_ROLE), getAddressRolesBoxKey(MANAGER_ROLE, user.publicKey)],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("fails when caller is not manager", async () => {
      await expect(
        client.send.setWormholePeer({
          sender: admin,
          args: [SOURCE_CHAIN_ID, getRandomBytes(32)],
          boxReferences: [getAddressRolesBoxKey(MANAGER_ROLE, admin.publicKey), getWormholePeersBoxKey(PEER_CHAIN_ID)],
        }),
      ).rejects.toThrow("Cannot set itself as peer chain");
    });

    test("succeeds when new chain", async () => {
      const APP_MIN_BALANCE = (21_700).microAlgos();

      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .setWormholePeer({
          sender: admin,
          args: [PEER_CHAIN_ID, PEER_CONTRACT_ADDRESS],
          boxReferences: [getAddressRolesBoxKey(MANAGER_ROLE, admin.publicKey), getWormholePeersBoxKey(PEER_CHAIN_ID)],
        })
        .send();
      expect(res.confirmations[1].logs).toBeDefined();
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("WormholePeerSet(uint16,byte[32])", [PEER_CHAIN_ID, PEER_CONTRACT_ADDRESS]),
      );
      const wormholePeer = await client.state.box.wormholePeers.value(PEER_CHAIN_ID);
      expect(wormholePeer).toBeDefined();
      expect(Uint8Array.from(wormholePeer!)).toEqual(PEER_CONTRACT_ADDRESS);
      expect(Uint8Array.from(await client.getWormholePeer({ args: [PEER_CHAIN_ID] }))).toEqual(PEER_CONTRACT_ADDRESS);
    });

    test("succeeds when existing chain", async () => {
      // temporarily override
      const peerContractAddress = getRandomBytes(32);
      const res = await client.send.setWormholePeer({
        sender: admin,
        args: [PEER_CHAIN_ID, peerContractAddress],
        boxReferences: [getAddressRolesBoxKey(MANAGER_ROLE, admin.publicKey), getWormholePeersBoxKey(PEER_CHAIN_ID)],
      });
      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("WormholePeerSet(uint16,byte[32])", [PEER_CHAIN_ID, peerContractAddress]),
      );
      const wormholePeer = await client.state.box.wormholePeers.value(PEER_CHAIN_ID);
      expect(wormholePeer).toBeDefined();
      expect(Uint8Array.from(wormholePeer!)).toEqual(peerContractAddress);
      expect(Uint8Array.from(await client.getWormholePeer({ args: [PEER_CHAIN_ID] }))).toEqual(peerContractAddress);

      // restore
      await client.send.setWormholePeer({
        sender: admin,
        args: [PEER_CHAIN_ID, PEER_CONTRACT_ADDRESS],
        boxReferences: [getAddressRolesBoxKey(MANAGER_ROLE, admin.publicKey), getWormholePeersBoxKey(PEER_CHAIN_ID)],
      });
      expect(Uint8Array.from(await client.getWormholePeer({ args: [PEER_CHAIN_ID] }))).toEqual(PEER_CONTRACT_ADDRESS);
    });
  });

  describe("quote delivery price", () => {
    test("fails when destination chain is unknown", async () => {
      const destinationChainId = 1;
      expect(destinationChainId).not.toEqual(PEER_CHAIN_ID);

      const message = getRandomMessageToSend({ destinationChainId });
      await expect(
        client.quoteDeliveryPrice({
          sender: user,
          args: [message, getRandomBytes(10)],
          appReferences: [appId, wormholeCoreAppId],
          boxReferences: [{ appId, name: getWormholePeersBoxKey(destinationChainId) }],
        }),
      ).rejects.toThrow("Unknown peer chain");
    });

    test("returns correct amount for manual relaying", async () => {
      const message = getRandomMessageToSend({ destinationChainId: Number(PEER_CHAIN_ID) });
      const instruction = convertBooleanToByte(true);
      const res = await client.send.quoteDeliveryPrice({
        sender: user,
        args: [message, instruction],
        appReferences: [appId, wormholeCoreAppId],
        boxReferences: [{ appId, name: getWormholePeersBoxKey(PEER_CHAIN_ID) }],
      });
      expect(res.confirmations[0].innerTxns).toBeUndefined();
      expect(res.return).toEqual(WORMHOLE_CORE_MESSAGE_FEE);
    });
  });

  describe("send message", () => {
    beforeAll(async () => {
      // fund emitter lsig and opt into wormhole core
      const emitterLogicSig = await getWormholeEmitterLSig(localnet, appId, wormholeCoreAppId);
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: emitterLogicSig,
        amount: (250_000).microAlgos(),
        extraFee: (1000).microAlgos(),
      });
      const optIntoAppTxn = await localnet.algorand.createTransaction.appCall({
        sender: emitterLogicSig,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.OptInOC,
        args: [enc.encode("optIn")],
        rekeyTo: getApplicationAddress(wormholeCoreAppId),
        staticFee: (0).microAlgos(),
      });
      await localnet.algorand.newGroup().addTransaction(fundingTxn).addTransaction(optIntoAppTxn).send();

      const appState = await localnet.algorand.app.getLocalState(wormholeCoreAppId, emitterLogicSig);
      expect((appState["\x00"] as any).valueRaw).toEqual(convertNumberToBytes(0, 127));
    });

    test("fails when destination chain is unknown", async () => {
      const destinationChainId = 1;
      expect(destinationChainId).not.toEqual(PEER_CHAIN_ID);

      const message = getRandomMessageToSend({ destinationChainId });
      await expect(
        transceiverManagerClient.send.sendMessage({
          sender: user,
          args: [appId, WORMHOLE_CORE_MESSAGE_FEE, message, getRandomBytes(10)],
          appReferences: [appId, wormholeCoreAppId],
          boxReferences: [{ appId, name: getWormholePeersBoxKey(destinationChainId) }],
          extraFee: (2000).microAlgos(),
        }),
      ).rejects.toThrow("0,1: Unknown peer chain");
    });

    test("succeeds and publishes message with manual relaying", async () => {
      const message = getRandomMessageToSend({ destinationChainId: Number(PEER_CHAIN_ID) });
      const instruction = convertBooleanToByte(true);
      const sequence = 1n;
      const emitterLsig = await client.state.global.emitterLsig();

      const res = await transceiverManagerClient.send.sendMessage({
        sender: user,
        args: [appId, WORMHOLE_CORE_MESSAGE_FEE, message, instruction],
        accountReferences: [emitterLsig!],
        appReferences: [appId, wormholeCoreAppId],
        boxReferences: [{ appId, name: getWormholePeersBoxKey(PEER_CHAIN_ID) }],
        extraFee: (4000).microAlgos(),
      });
      expect(res.confirmations[0].innerTxns!.length).toEqual(2);
      expect(res.confirmations[0].innerTxns![1].logs![0]).toEqual(getEventBytes("MessageSent(byte[32])", message.id));
      expect(res.confirmations[0].innerTxns![1].innerTxns!.length).toEqual(2);
      expect(res.confirmations[0].innerTxns![1].innerTxns![1].logs![0]).toEqual(
        getEventBytes("MessagePublished(byte[],uint64,uint64)", [encodeMessageToSend(message), 0, sequence]),
      );

      const appState = await localnet.algorand.app.getLocalState(wormholeCoreAppId, emitterLsig!);
      const bytes = convertNumberToBytes(0, 127);
      bytes.set(convertNumberToBytes(sequence, 8), 0);
      expect((appState["\x00"] as any).valueRaw).toEqual(bytes);
    });
  });

  describe("receive message", () => {
    beforeAll(async () => {
      await transceiverManagerClient.send.setMessageDigest({ args: [MESSAGE_DIGEST] });
    });

    test("fails when verify vaa call isn't app call", async () => {
      const verifyVAATxn = await localnet.algorand.createTransaction.payment({
        sender: user,
        receiver: user,
        amount: (0).microAlgo(),
      });
      await expect(
        localnet.algorand
          .newGroup()
          .addTransaction(verifyVAATxn)
          .addAppCall({
            sender: user,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [client.appClient.getABIMethod("receive_message").getSelector()],
          })
          .send(),
      ).rejects.toThrow("transaction type is appl");
    });

    test("fails when verify vaa call not to wormhole core", async () => {
      const fakeWormholeCoreAppId = await deployWormholeCore(localnet, creator, WORMHOLE_CORE_MESSAGE_FEE);
      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        PEER_CHAIN_ID,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: fakeWormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect app call id");
    });

    test("fails when verify vaa call isn't a noop", async () => {
      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        PEER_CHAIN_ID,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.OptInOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect app call on completion");
    });

    test("fails when verify vaa call isn't verifyVAA", async () => {
      const emitterLsig = await client.state.global.emitterLsig();
      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("publishMessage"), getRandomBytes(100), convertNumberToBytes(0, 8)],
        accountReferences: [emitterLsig!],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect app call method");
    });

    test("fails when payload doesn't have correct prefix", async () => {
      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { header, body } = getWormholeVAA(
        PEER_CHAIN_ID,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      // replace prefix directly and re-calculate
      body.set(getRandomBytes(4), 51);
      const vaaBytes = Uint8Array.from([...header, ...body]);
      const digest = keccak_256(keccak_256(body));

      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(digest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Incorrect prefix");
    });

    test("fails when emitter chain is unknown", async () => {
      const emitterChainId = 1;
      expect(emitterChainId).not.toEqual(PEER_CHAIN_ID);

      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        emitterChainId,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(emitterChainId), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Unknown peer chain");
    });

    test("fails when source chain is known but source address doesn't match", async () => {
      const emitterAddress = getRandomBytes(32);
      expect(Uint8Array.from(await client.getWormholePeer({ args: [PEER_CHAIN_ID] }))).not.toEqual(emitterAddress);

      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        PEER_CHAIN_ID,
        emitterAddress,
        sequence,
        encodeMessageToSend(message),
      );

      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("Unknown peer address");
    });

    test.each([{ messagePayloadLengthDelta: -1 }, { messagePayloadLengthDelta: 1 }])(
      "fails when message payload length delta is $messagePayloadLengthDelta bytes",
      async ({ messagePayloadLengthDelta }) => {
        const sequence = getRandomUInt(1000);
        const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
        const handlerPayload = Uint8Array.from([
          ...message.id,
          ...message.userAddress,
          ...convertNumberToBytes(message.payload.length + messagePayloadLengthDelta, 2),
          ...message.payload,
        ]);
        const encodedMessage = Uint8Array.from([
          ...WORMHOLE_TRANSCEIVER_PAYLOAD_PREFIX,
          ...message.sourceAddress,
          ...message.handlerAddress,
          ...convertNumberToBytes(handlerPayload.length, 2),
          ...handlerPayload,
          ...convertNumberToBytes(0, 2),
        ]);
        const { vaaBytes, vaaDigest } = getWormholeVAA(PEER_CHAIN_ID, PEER_CONTRACT_ADDRESS, sequence, encodedMessage);

        const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
          sender: user,
          appId: wormholeCoreAppId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [enc.encode("verifyVAA"), vaaBytes],
        });
        await expect(
          client.send.receiveMessage({
            sender: user,
            args: [verifyVAATxn],
            appReferences: [transceiverManagerAppId],
            boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
            extraFee: (1000).microAlgos(),
          }),
        ).rejects.toThrow("Incorrect length");
      },
    );

    test("succeeds and delivers message to transceiver manager", async () => {
      const APP_MIN_BALANCE = (21_300).microAlgos();
      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        PEER_CHAIN_ID,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        })
        .send();

      expect(res.confirmations[2].logs).toBeDefined();
      expect(res.confirmations[2].logs![0]).toEqual(
        getEventBytes("ReceivedMessage(byte[32],byte[32])", [vaaDigest, message.id]),
      );
      expect(res.confirmations[2].innerTxns!.length).toEqual(1);
      expect(res.confirmations[2].innerTxns![0].txn.txn.type).toEqual("appl");
      expect(res.confirmations[2].innerTxns![0].txn.txn.applicationCall!.appIndex).toEqual(transceiverManagerAppId);
      expect(res.confirmations[2].innerTxns![0].logs![0]).toEqual(
        getEventBytes("AttestationReceived(byte[32],uint16,byte[32],uint64,byte[32],uint64)", [
          message.id,
          PEER_CHAIN_ID,
          message.sourceAddress,
          convertBytesToNumber(message.handlerAddress),
          MESSAGE_DIGEST,
          1,
        ]),
      );

      const isConsumed = await client.state.box.vaasConsumed.value(vaaDigest);
      expect(isConsumed).toBeTruthy();
    });

    test("fails when vaa is already consumed", async () => {
      const APP_MIN_BALANCE = (21_300).microAlgos();
      const sequence = getRandomUInt(1000);
      const message = getRandomMessageToSend({ destinationChainId: Number(SOURCE_CHAIN_ID) });
      const { vaaBytes, vaaDigest } = getWormholeVAA(
        PEER_CHAIN_ID,
        PEER_CONTRACT_ADDRESS,
        sequence,
        encodeMessageToSend(message),
      );

      // receive once
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      let verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await client
        .newGroup()
        .addTransaction(fundingTxn)
        .receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        })
        .send();

      // receive again
      verifyVAATxn = await localnet.algorand.createTransaction.appCall({
        sender: user,
        appId: wormholeCoreAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        args: [enc.encode("verifyVAA"), vaaBytes],
      });
      await expect(
        client.send.receiveMessage({
          sender: user,
          args: [verifyVAATxn],
          appReferences: [transceiverManagerAppId],
          boxReferences: [getWormholePeersBoxKey(PEER_CHAIN_ID), getVAAsConsumedBoxKey(vaaDigest)],
          extraFee: (1000).microAlgos(),
        }),
      ).rejects.toThrow("VAA already seen");
    });
  });
});
