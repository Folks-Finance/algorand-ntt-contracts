import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { type Account, type Address, OnApplicationComplete, getApplicationAddress } from "algosdk";

import {
  NttRateLimiterExposedClient,
  NttRateLimiterExposedFactory,
  type TrimmedAmount,
} from "../../specs/client/NttRateLimiterExposed.client.ts";
import { OpUpClient, OpUpFactory } from "../../specs/client/OpUp.client.ts";
import {
  getAddressRolesBoxKey,
  getBucketBoxKey,
  getInboundQueuedTransfersBoxKey,
  getOutboundQueuedTransfersBoxKey,
  getRoleBoxKey,
} from "../utils/boxes.ts";
import {
  convertNumberToBytes,
  getEventBytes,
  getInboundBucketIdBytes,
  getOutboundBucketIdBytes,
  getRandomBytes,
  getRoleBytes,
} from "../utils/bytes.ts";
import type { TransceiverInstruction } from "../utils/message.ts";
import { SECONDS_IN_DAY, SECONDS_IN_WEEK, advancePrevBlockTimestamp, getPrevBlockTimestamp } from "../utils/time.ts";
import { MAX_UINT64, bigIntMin, getRandomUInt } from "../utils/uint.ts";

describe("NttRateLimiter", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const RATE_LIMITER_MANAGER_ROLE = getRoleBytes("RATE_LIMITER_MANAGER");

  const SOURCE_CHAIN_ID = 123n;
  const PEER_CHAIN_ID = 56n;

  const OUTBOUND_LIMIT = BigInt(500e6);
  const OUTBOUND_DURATION = SECONDS_IN_WEEK;
  const INBOUND_LIMIT = BigInt(100e6);
  const INBOUND_DURATION = SECONDS_IN_DAY;

  const MESSAGE_ID = getRandomBytes(32);
  const MESSAGE_DIGEST = getRandomBytes(32);

  let opUpFactory: OpUpFactory;
  let opUpClient: OpUpClient;
  let opUpAppId: bigint;

  let factory: NttRateLimiterExposedFactory;
  let client: NttRateLimiterExposedClient;
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

    factory = algorand.client.getTypedAppFactory(NttRateLimiterExposedFactory, {
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
    expect(await client.state.global.isInitialised()).toBeFalsy();
    expect(Uint8Array.from(await client.defaultAdminRole())).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [DEFAULT_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.rateLimiterManagerRole())).toEqual(RATE_LIMITER_MANAGER_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [RATE_LIMITER_MANAGER_ROLE] }))).toEqual(
      DEFAULT_ADMIN_ROLE,
    );
  });

  test("inbound bucket id returns correct value", async () => {
    expect(await client.inboundBucketId({ args: [PEER_CHAIN_ID] })).toEqual(getInboundBucketIdBytes(PEER_CHAIN_ID));
  });

  test("outbound bucket id returns correct value", async () => {
    expect(await client.outboundBucketId()).toEqual(getOutboundBucketIdBytes());
  });

  test("get current inbound capacity fails if chain unknown", async () => {
    await expect(client.send.getCurrentInboundCapacity({ args: [PEER_CHAIN_ID] })).rejects.toThrow("Unknown bucket");
  });

  describe("when uninitialised", () => {
    test("get current outbound capacity fails", async () => {
      await expect(client.send.getCurrentOutboundCapacity()).rejects.toThrow("Unknown bucket");
    });

    test("fails to set outbound rate limit", async () => {
      await expect(client.send.setOutboundRateLimit({ sender: admin, args: [0] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test("fails to set outbound rate duration", async () => {
      await expect(client.send.setOutboundRateDuration({ sender: admin, args: [0] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test("fails to set inbound rate limit", async () => {
      await expect(client.send.setInboundRateLimit({ sender: admin, args: [1, 0] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test("fails to set inbound rate duration", async () => {
      await expect(client.send.setInboundRateDuration({ sender: admin, args: [1, 0] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test.each([
      { adminLength: 30, arg: "arc4.static_array<arc4.uint8, 32>" },
      { adminLength: 34, arg: "arc4.static_array<arc4.uint8, 32>" },
    ])(`fails to initialise when admin is $adminLength bytes`, async ({ adminLength, arg }) => {
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
      const APP_MIN_BALANCE = (210_300).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });

      const bucketId = getOutboundBucketIdBytes();
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .initialise({
          args: [admin.toString()],
          boxReferences: [
            getRoleBoxKey(DEFAULT_ADMIN_ROLE),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, admin.publicKey),
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
            getBucketBoxKey(bucketId),
          ],
        })
        .send();

      expect(await client.state.global.isInitialised()).toBeTruthy();
      expect(await client.hasRole({ args: [DEFAULT_ADMIN_ROLE, admin.toString()] })).toBeTruthy();
      expect(await client.hasRole({ args: [RATE_LIMITER_MANAGER_ROLE, admin.toString()] })).toBeTruthy();

      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("BucketAdded(byte[32],uint256,uint64)", [bucketId, 0n, 0n]),
      );
      expect(await client.getCurrentOutboundCapacity()).toEqual(0n);
      expect(await client.getCurrentCapacity({ args: [bucketId] })).toEqual(0n);
      expect(await client.getRateLimit({ args: [bucketId] })).toEqual(0n);
      expect(await client.getRateDuration({ args: [bucketId] })).toEqual(0n);
    });
  });

  describe("set outbound rate limit", () => {
    test.each([
      { limitLength: 8, arg: "arc4.uint256" },
      { limitLength: 34, arg: "arc4.uint256" },
    ])(`fails when limit is $limitLength bytes`, async ({ limitLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [
            client.appClient.getABIMethod("set_outbound_rate_limit").getSelector(),
            convertNumberToBytes(0, limitLength),
          ],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("fails when caller is not rate limiter manager", async () => {
      await expect(
        client.send.setOutboundRateLimit({
          sender: user,
          args: [OUTBOUND_LIMIT],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, user.publicKey),
            getBucketBoxKey(getOutboundBucketIdBytes()),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("succeeds", async () => {
      const bucketId = getOutboundBucketIdBytes();
      const res = await client.send.setOutboundRateLimit({
        sender: admin,
        args: [OUTBOUND_LIMIT],
        boxReferences: [
          getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
          getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
          getBucketBoxKey(bucketId),
        ],
      });

      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("BucketRateLimitUpdated(byte[32],uint256)", [bucketId, OUTBOUND_LIMIT]),
      );
      expect(await client.getRateLimit({ args: [bucketId] })).toEqual(OUTBOUND_LIMIT);
    });
  });

  describe("set outbound rate duration", () => {
    test.each([
      { durationLength: 4, arg: "arc4.uint64" },
      { durationLength: 16, arg: "arc4.uint64" },
    ])(`fails when duration is $durationLength bytes`, async ({ durationLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: admin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [
            client.appClient.getABIMethod("set_outbound_rate_duration").getSelector(),
            convertNumberToBytes(0, durationLength),
          ],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("fails when caller is not rate limiter manager", async () => {
      await expect(
        client.send.setOutboundRateDuration({
          sender: user,
          args: [OUTBOUND_DURATION],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, user.publicKey),
            getBucketBoxKey(getOutboundBucketIdBytes()),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("succeeds", async () => {
      const bucketId = getOutboundBucketIdBytes();
      const res = await client.send.setOutboundRateDuration({
        sender: admin,
        args: [OUTBOUND_DURATION],
        boxReferences: [
          getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
          getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
          getBucketBoxKey(bucketId),
        ],
      });

      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("BucketRateDurationUpdated(byte[32],uint64)", [bucketId, OUTBOUND_DURATION]),
      );
      expect(await client.getRateDuration({ args: [bucketId] })).toEqual(OUTBOUND_DURATION);
    });
  });

  describe("set inbound rate limit", () => {
    beforeAll(async () => {
      const APP_MIN_BALANCE = (54_900).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });

      const bucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .addOutboundChain({
          args: [PEER_CHAIN_ID],
          boxReferences: [getBucketBoxKey(bucketId)],
        })
        .send();

      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("BucketAdded(byte[32],uint256,uint64)", [bucketId, 0n, 0n]),
      );
    });

    test.each([
      { chainIdLength: 1, limitLength: 32, arg: "arc4.uint16" },
      { chainIdLength: 4, limitLength: 32, arg: "arc4.uint16" },
      { chainIdLength: 2, limitLength: 8, arg: "arc4.uint256" },
      { chainIdLength: 2, limitLength: 34, arg: "arc4.uint256" },
    ])(
      `fails when chain id is $chainIdLength and limit is $limitLength bytes`,
      async ({ chainIdLength, limitLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("set_inbound_rate_limit").getSelector(),
              convertNumberToBytes(0, chainIdLength),
              convertNumberToBytes(0, limitLength),
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when caller is not rate limiter manager", async () => {
      await expect(
        client.send.setInboundRateLimit({
          sender: user,
          args: [PEER_CHAIN_ID, INBOUND_LIMIT],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, user.publicKey),
            getInboundBucketIdBytes(PEER_CHAIN_ID),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("fails when chain is unknown", async () => {
      await expect(
        client.send.setInboundRateLimit({
          sender: admin,
          args: [SOURCE_CHAIN_ID, INBOUND_LIMIT],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
            getInboundBucketIdBytes(SOURCE_CHAIN_ID),
          ],
        }),
      ).rejects.toThrow("Unknown bucket");
    });

    test("succeeds", async () => {
      const bucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const res = await client.send.setInboundRateLimit({
        sender: admin,
        args: [PEER_CHAIN_ID, INBOUND_LIMIT],
        boxReferences: [
          getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
          getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
          getBucketBoxKey(bucketId),
        ],
      });

      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("BucketRateLimitUpdated(byte[32],uint256)", [bucketId, INBOUND_LIMIT]),
      );
      expect(await client.getRateLimit({ args: [bucketId] })).toEqual(INBOUND_LIMIT);
    });
  });

  describe("set inbound rate duration", () => {
    test.each([
      { chainIdLength: 1, durationLength: 8, arg: "arc4.uint16" },
      { chainIdLength: 4, durationLength: 8, arg: "arc4.uint16" },
      { chainIdLength: 2, durationLength: 4, arg: "arc4.uint64" },
      { chainIdLength: 2, durationLength: 16, arg: "arc4.uint64" },
    ])(
      `fails when chain id is $chainIdLength and duration is $durationLength bytes`,
      async ({ chainIdLength, durationLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: admin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("set_inbound_rate_duration").getSelector(),
              convertNumberToBytes(0, chainIdLength),
              convertNumberToBytes(0, durationLength),
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails when caller is not rate limiter manager", async () => {
      await expect(
        client.send.setInboundRateDuration({
          sender: user,
          args: [PEER_CHAIN_ID, INBOUND_DURATION],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, user.publicKey),
            getInboundBucketIdBytes(PEER_CHAIN_ID),
          ],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("fails when chain is unknown", async () => {
      await expect(
        client.send.setInboundRateDuration({
          sender: admin,
          args: [SOURCE_CHAIN_ID, INBOUND_DURATION],
          boxReferences: [
            getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
            getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
            getInboundBucketIdBytes(SOURCE_CHAIN_ID),
          ],
        }),
      ).rejects.toThrow("Unknown bucket");
    });

    test("succeeds", async () => {
      const bucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const res = await client.send.setInboundRateDuration({
        sender: admin,
        args: [PEER_CHAIN_ID, INBOUND_DURATION],
        boxReferences: [
          getRoleBoxKey(RATE_LIMITER_MANAGER_ROLE),
          getAddressRolesBoxKey(RATE_LIMITER_MANAGER_ROLE, admin.publicKey),
          getBucketBoxKey(bucketId),
        ],
      });

      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("BucketRateDurationUpdated(byte[32],uint64)", [bucketId, INBOUND_DURATION]),
      );
      expect(await client.getRateDuration({ args: [bucketId] })).toEqual(INBOUND_DURATION);
    });
  });

  describe("enqueue or consume outbound transfer", () => {
    test("fails when cannot queue and insufficient capacity", async () => {
      // check there is insufficient capacity
      const outboundBucketId = getOutboundBucketIdBytes();
      const currentCapacity = await client.getCurrentOutboundCapacity();
      const untrimmedAmount = currentCapacity + BigInt(1);
      expect(await client.hasCapacity({ args: [outboundBucketId, untrimmedAmount] })).toBeFalsy();

      const recipient = getRandomBytes(32);
      const shouldQueue = false;
      const transceiverInstructions: TransceiverInstruction[] = [[getRandomUInt(MAX_UINT64), getRandomBytes(10)]];
      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };

      await expect(
        client.send.enqueueOrConsumeOutboundTransfer({
          sender: user,
          args: [
            untrimmedAmount,
            PEER_CHAIN_ID,
            recipient,
            shouldQueue,
            transceiverInstructions,
            trimmedAmount,
            MESSAGE_ID,
          ],
          boxReferences: [outboundBucketId],
        }),
      ).rejects.toThrow("Insufficient capacity for outbound queued transfer");
    });

    test("succeeds when can queue and insufficient capacity", async () => {
      // check there is insufficient capacity
      const outboundBucketId = getOutboundBucketIdBytes();
      const currentCapacity = await client.getCurrentOutboundCapacity();
      const untrimmedAmount = currentCapacity + BigInt(1);
      expect(await client.hasCapacity({ args: [outboundBucketId, untrimmedAmount] })).toBeFalsy();

      const recipient = getRandomBytes(32);
      const shouldQueue = true;
      const transceiverInstructions: TransceiverInstruction[] = [[getRandomUInt(MAX_UINT64), getRandomBytes(10)]];
      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };
      const latestTimestamp = await getPrevBlockTimestamp(localnet);

      const APP_MIN_BALANCE = (70_100).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .enqueueOrConsumeOutboundTransfer({
          sender: user,
          args: [
            untrimmedAmount,
            PEER_CHAIN_ID,
            recipient,
            shouldQueue,
            transceiverInstructions,
            trimmedAmount,
            MESSAGE_ID,
          ],
          boxReferences: [outboundBucketId, getOutboundQueuedTransfersBoxKey(MESSAGE_ID)],
        })
        .send();

      expect(res.returns).toEqual([true]);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("OutboundTransferRateLimited(address,byte[32],uint256,uint64)", [
          user.toString(),
          MESSAGE_ID,
          currentCapacity,
          untrimmedAmount,
        ]),
      );

      const outboundQueuedTransfer = await client.getOutboundQueuedTransfer({ args: [MESSAGE_ID] });
      expect(outboundQueuedTransfer[1]).toEqual([
        latestTimestamp,
        Object.values(trimmedAmount),
        Number(PEER_CHAIN_ID),
        recipient,
        user.toString(),
        transceiverInstructions,
      ]);
    });

    test("succeeds when sufficient capacity", async () => {
      // check there is sufficient capacity
      const outboundBucketId = getOutboundBucketIdBytes();
      const currentCapacity = await client.getCurrentOutboundCapacity();
      const untrimmedAmount = currentCapacity / BigInt(2);
      expect(await client.hasCapacity({ args: [outboundBucketId, untrimmedAmount] })).toBeTruthy();

      // calculate fill amount
      const inboundBucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const currentInboundCapacity = await client.getCurrentInboundCapacity({ args: [PEER_CHAIN_ID] });
      const inboundRateLimit = await client.getRateLimit({ args: [inboundBucketId] });
      const fillAmount = bigIntMin(inboundRateLimit - currentInboundCapacity, untrimmedAmount);

      const recipient = getRandomBytes(32);
      const shouldQueue = Boolean(getRandomUInt(1));
      const transceiverInstructions: TransceiverInstruction[] = [[getRandomUInt(MAX_UINT64), getRandomBytes(10)]];
      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };
      const messageId = getRandomBytes(32);

      const {
        transactions: [opUpTxn],
      } = await opUpClient.createTransaction.ensureBudget({
        sender: admin,
        args: [0],
      });
      const res = await client
        .newGroup()
        .addTransaction(opUpTxn)
        .enqueueOrConsumeOutboundTransfer({
          sender: user,
          args: [
            untrimmedAmount,
            PEER_CHAIN_ID,
            recipient,
            shouldQueue,
            transceiverInstructions,
            trimmedAmount,
            messageId,
          ],
          boxReferences: [outboundBucketId, inboundBucketId],
        })
        .send();

      expect(res.returns).toEqual([false]);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("BucketConsumed(byte[32],uint256)", [outboundBucketId, untrimmedAmount]),
      );
      expect(res.confirmations[1].logs![1]).toEqual(
        getEventBytes("BucketFilled(byte[32],uint256,uint256)", [inboundBucketId, untrimmedAmount, fillAmount]),
      );
    });
  });

  describe("get outbound queued transfer", () => {
    test("fails when transfer is unknown", async () => {
      const messageId = getRandomBytes(32);
      await expect(
        client.send.getOutboundQueuedTransfer({
          sender: user,
          args: [messageId],
          boxReferences: [getOutboundQueuedTransfersBoxKey(messageId)],
        }),
      ).rejects.toThrow("Unknown outbound queued transfer");
    });

    test("succeeds and return false if insufficient time has passed", async () => {
      const outboundQueuedTransfer = await client.getOutboundQueuedTransfer({ args: [MESSAGE_ID] });

      // ensure insufficient time has passed
      const latestTimestamp = await getPrevBlockTimestamp(localnet);
      const targetTimestamp = outboundQueuedTransfer[1][0] + OUTBOUND_DURATION;
      expect(latestTimestamp).toBeLessThan(targetTimestamp);

      // check if false
      expect(outboundQueuedTransfer[0]).toBeFalsy();
    });

    test("succeeds and return true if sufficient time has passed", async () => {
      let outboundQueuedTransfer = await client.getOutboundQueuedTransfer({ args: [MESSAGE_ID] });

      // advance till sufficient time has passed
      const latestTimestamp = await getPrevBlockTimestamp(localnet);
      const targetTimestamp = outboundQueuedTransfer[1][0] + OUTBOUND_DURATION;
      await advancePrevBlockTimestamp(localnet, targetTimestamp - latestTimestamp);

      // check if now true
      outboundQueuedTransfer = await client.getOutboundQueuedTransfer({ args: [MESSAGE_ID] });
      expect(outboundQueuedTransfer[0]).toBeTruthy();
    });
  });

  describe("enqueue or consume inbound transfer", () => {
    test("fails when chain is unknown", async () => {
      const inboundBucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const untrimmedAmount = 0n;
      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };

      await expect(
        client.send.enqueueOrConsumeInboundTransfer({
          sender: user,
          args: [untrimmedAmount, SOURCE_CHAIN_ID, trimmedAmount, user.toString(), MESSAGE_DIGEST],
          boxReferences: [inboundBucketId, getInboundQueuedTransfersBoxKey(MESSAGE_DIGEST)],
        }),
      ).rejects.toThrow("Unknown bucket");
    });

    test("succeeds when insufficient capacity", async () => {
      // check there is insufficient capacity
      const inboundBucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const currentCapacity = await client.getCurrentInboundCapacity({ args: [PEER_CHAIN_ID] });
      const untrimmedAmount = currentCapacity + BigInt(1);
      expect(await client.hasCapacity({ args: [inboundBucketId, untrimmedAmount] })).toBeFalsy();

      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };
      const latestTimestamp = await getPrevBlockTimestamp(localnet);

      const APP_MIN_BALANCE = (45_700).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const res = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .enqueueOrConsumeInboundTransfer({
          sender: user,
          args: [untrimmedAmount, PEER_CHAIN_ID, trimmedAmount, user.toString(), MESSAGE_DIGEST],
          boxReferences: [inboundBucketId, getInboundQueuedTransfersBoxKey(MESSAGE_DIGEST)],
        })
        .send();

      expect(res.returns).toEqual([true]);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("InboundTransferRateLimited(address,byte[32],uint256,uint64)", [
          user.toString(),
          MESSAGE_DIGEST,
          currentCapacity,
          untrimmedAmount,
        ]),
      );

      const inboundQueuedTransfer = await client.getInboundQueuedTransfer({ args: [MESSAGE_DIGEST] });
      expect(inboundQueuedTransfer[1]).toEqual([
        latestTimestamp,
        Object.values(trimmedAmount),
        Number(PEER_CHAIN_ID),
        user.toString(),
      ]);
    });

    test("succeeds when sufficient capacity", async () => {
      // check there is sufficient capacity
      const inboundBucketId = getInboundBucketIdBytes(PEER_CHAIN_ID);
      const currentCapacity = await client.getCurrentInboundCapacity({ args: [PEER_CHAIN_ID] });
      const untrimmedAmount = currentCapacity / BigInt(2);
      expect(await client.hasCapacity({ args: [inboundBucketId, untrimmedAmount] })).toBeTruthy();

      // calculate fill amount
      const outboundBucketId = getOutboundBucketIdBytes();
      const currentOutboundCapacity = await client.getCurrentOutboundCapacity();
      const outboundRateLimit = await client.getRateLimit({ args: [outboundBucketId] });
      const fillAmount = bigIntMin(outboundRateLimit - currentOutboundCapacity, untrimmedAmount);

      const trimmedAmount: TrimmedAmount = { amount: untrimmedAmount, decimals: 6 };
      const messageDigest = getRandomBytes(32);

      const {
        transactions: [opUpTxn],
      } = await opUpClient.createTransaction.ensureBudget({
        sender: admin,
        args: [0],
      });
      const res = await client
        .newGroup()
        .addTransaction(opUpTxn)
        .enqueueOrConsumeInboundTransfer({
          sender: user,
          args: [untrimmedAmount, PEER_CHAIN_ID, trimmedAmount, user.toString(), messageDigest],
          boxReferences: [inboundBucketId],
        })
        .send();

      expect(res.returns).toEqual([false]);
      expect(res.confirmations[1].logs![0]).toEqual(
        getEventBytes("BucketConsumed(byte[32],uint256)", [inboundBucketId, untrimmedAmount]),
      );
      expect(res.confirmations[1].logs![1]).toEqual(
        getEventBytes("BucketFilled(byte[32],uint256,uint256)", [outboundBucketId, untrimmedAmount, fillAmount]),
      );
    });
  });

  describe("get inbound queued transfer", () => {
    test("fails when transfer is unknown", async () => {
      const messageDigest = getRandomBytes(32);
      await expect(
        client.send.getInboundQueuedTransfer({
          sender: user,
          args: [messageDigest],
          boxReferences: [getInboundQueuedTransfersBoxKey(messageDigest)],
        }),
      ).rejects.toThrow("Unknown inbound queued transfer");
    });

    test("succeeds and return false if insufficient time has passed", async () => {
      const inboundQueuedTransfer = await client.getInboundQueuedTransfer({ args: [MESSAGE_DIGEST] });

      // ensure insufficient time has passed
      const latestTimestamp = await getPrevBlockTimestamp(localnet);
      const targetTimestamp = inboundQueuedTransfer[1][0] + OUTBOUND_DURATION;
      expect(latestTimestamp).toBeLessThan(targetTimestamp);

      // check if false
      expect(inboundQueuedTransfer[0]).toBeFalsy();
    });

    test("succeeds and return true if sufficient time has passed", async () => {
      let inboundQueuedTransfer = await client.getInboundQueuedTransfer({ args: [MESSAGE_DIGEST] });

      // advance till sufficient time has passed
      const latestTimestamp = await getPrevBlockTimestamp(localnet);
      const targetTimestamp = inboundQueuedTransfer[1][0] + INBOUND_DURATION;
      await advancePrevBlockTimestamp(localnet, targetTimestamp - latestTimestamp);

      // check if now true
      inboundQueuedTransfer = await client.getInboundQueuedTransfer({ args: [MESSAGE_DIGEST] });
      expect(inboundQueuedTransfer[0]).toBeTruthy();
    });
  });

  describe("delete outbound transfer", () => {
    test("fails when transfer is unknown", async () => {
      const messageId = getRandomBytes(32);
      await expect(
        client.send.deleteOutboundTransfer({
          sender: user,
          args: [messageId],
          boxReferences: [getOutboundQueuedTransfersBoxKey(messageId)],
        }),
      ).rejects.toThrow("Unknown outbound queued transfer");
    });

    test("succeeds", async () => {
      const res = await client.send.deleteOutboundTransfer({
        sender: user,
        args: [MESSAGE_ID],
        boxReferences: [getOutboundQueuedTransfersBoxKey(MESSAGE_ID)],
      });
      expect(res.confirmations[0].logs![0]).toEqual(getEventBytes("OutboundTransferDeleted(byte[32])", [MESSAGE_ID]));
      await expect(client.state.box.outboundQueuedTransfers.value(MESSAGE_ID)).rejects.toThrow("box not found");
    });
  });

  describe("delete inbound transfer", () => {
    test("fails when transfer is unknown", async () => {
      const messageDigest = getRandomBytes(32);
      await expect(
        client.send.deleteInboundTransfer({
          sender: user,
          args: [messageDigest],
          boxReferences: [getInboundQueuedTransfersBoxKey(messageDigest)],
        }),
      ).rejects.toThrow("Unknown inbound queued transfer");
    });

    test("succeeds", async () => {
      const res = await client.send.deleteInboundTransfer({
        sender: user,
        args: [MESSAGE_DIGEST],
        boxReferences: [getInboundQueuedTransfersBoxKey(MESSAGE_DIGEST)],
      });
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("InboundTransferDeleted(byte[32])", [MESSAGE_DIGEST]),
      );
      await expect(client.state.box.inboundQueuedTransfers.value(MESSAGE_DIGEST)).rejects.toThrow("box not found");
    });
  });
});
