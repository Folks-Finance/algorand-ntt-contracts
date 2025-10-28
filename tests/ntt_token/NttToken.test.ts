import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { OnApplicationComplete, getApplicationAddress } from "algosdk";
import type { Account, Address } from "algosdk";

import { EmptyNttTokenClient, EmptyNttTokenFactory } from "../../specs/client/EmptyNttToken.client.ts";
import { getAddressRolesBoxKey, getRoleBoxKey } from "../utils/boxes.ts";
import { convertNumberToBytes, getEventBytes, getRandomBytes, getRoleBytes } from "../utils/bytes.ts";
import { SECONDS_IN_DAY } from "../utils/time.ts";

describe("NttToken", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const MINTER_ROLE = getRoleBytes("MINTER");
  const UPGRADEABLE_ADMIN_ROLE = getRoleBytes("UPGRADEABLE_ADMIN");

  const MIN_UPGRADE_DELAY = SECONDS_IN_DAY;

  let factory: EmptyNttTokenFactory;
  let client: EmptyNttTokenClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;
  let defaultAdmin: Address & Account & TransactionSignerAccount;
  let minter: Address & Account & TransactionSignerAccount;
  let user: Address & Account & TransactionSignerAccount;

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });
    defaultAdmin = await generateAccount({ initialFunds: (100).algo() });
    minter = await generateAccount({ initialFunds: (100).algo() });
    user = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(EmptyNttTokenFactory, {
      defaultSender: creator,
      defaultSigner: creator.signer,
    });
  });

  test("deploys with correct state", async () => {
    const { appClient, result } = await factory.deploy({
      createParams: {
        sender: creator,
        method: "create",
        args: [MIN_UPGRADE_DELAY],
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
    expect(await client.state.global.assetId()).toBeUndefined();

    expect(Uint8Array.from(await client.defaultAdminRole())).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [DEFAULT_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.upgradableAdminRole())).toEqual(UPGRADEABLE_ADMIN_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [UPGRADEABLE_ADMIN_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
    expect(Uint8Array.from(await client.minterRole())).toEqual(MINTER_ROLE);
    expect(Uint8Array.from(await client.getRoleAdmin({ args: [MINTER_ROLE] }))).toEqual(DEFAULT_ADMIN_ROLE);
  });

  describe("when uninitialised", () => {
    test("fails to mint", async () => {
      await expect(client.send.mint({ sender: user, args: [user.toString(), 0] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test("fails to set minter", async () => {
      await expect(client.send.setMinter({ sender: user, args: [user.toString()] })).rejects.toThrow(
        "Uninitialised contract",
      );
    });

    test("succeeds to initialise and sets correct state", async () => {
      const APP_MIN_BALANCE = (127_700).microAlgos();
      const assetId = 123n;

      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      await client
        .newGroup()
        .addTransaction(fundingTxn)
        .initialise({
          args: [defaultAdmin.toString(), assetId],
          boxReferences: [
            getRoleBoxKey(DEFAULT_ADMIN_ROLE),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, defaultAdmin.publicKey),
          ],
        })
        .send();
      expect(await client.state.global.isInitialised()).toBeTruthy();
      expect(await client.state.global.assetId()).toEqual(assetId);
      expect(await client.getAssetId()).toEqual(assetId);
      expect(await client.hasRole({ args: [DEFAULT_ADMIN_ROLE, defaultAdmin.toString()] })).toBeTruthy();
    });
  });

  describe("set minter", () => {
    beforeAll(async () => {
      // fund for enough balance for one role
      const APP_MIN_BALANCE = (27_700).microAlgos();
      await localnet.algorand.send.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
    });

    test.each([
      { minterLength: 30, arg: "arc4.static_array<arc4.uint8, 32>" },
      { minterLength: 34, arg: "arc4.static_array<arc4.uint8, 32>" },
    ])(`fails when minter is $minterLength bytes`, async ({ minterLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: defaultAdmin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [client.appClient.getABIMethod("set_minter").getSelector(), getRandomBytes(minterLength)],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("fails when caller is not minter", async () => {
      await expect(
        client.send.setMinter({
          sender: user,
          args: [user.toString()],
          boxReferences: [getRoleBoxKey(MINTER_ROLE), getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, user.publicKey)],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    test("succeeds", async () => {
      const res = await client.send.setMinter({
        sender: defaultAdmin,
        args: [minter.toString()],
        boxReferences: [
          getRoleBoxKey(MINTER_ROLE),
          getAddressRolesBoxKey(MINTER_ROLE, minter.publicKey),
          getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, defaultAdmin.publicKey),
        ],
      });
      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(
        getEventBytes("RoleGranted(byte[16],address,address)", [MINTER_ROLE, minter.publicKey, defaultAdmin.publicKey]),
      );
      expect(await client.hasRole({ args: [MINTER_ROLE, minter.toString()] })).toBeTruthy();
    });
  });

  describe("mint", () => {
    test.each([
      { receiverLength: 30, amountLength: 8, arg: "arc4.static_array<arc4.uint8, 32>" },
      { receiverLength: 34, amountLength: 8, arg: "arc4.static_array<arc4.uint8, 32>" },
      { receiverLength: 32, amountLength: 4, arg: "arc4.uint64" },
      { receiverLength: 32, amountLength: 16, arg: "arc4.uint64" },
    ])(`fails when minter is $receiverLength bytes`, async ({ receiverLength, amountLength, arg }) => {
      await expect(
        localnet.algorand.send.appCall({
          sender: defaultAdmin,
          appId,
          onComplete: OnApplicationComplete.NoOpOC,
          args: [
            client.appClient.getABIMethod("mint").getSelector(),
            getRandomBytes(receiverLength),
            convertNumberToBytes(0, amountLength),
          ],
        }),
      ).rejects.toThrow(`invalid number of bytes for ${arg}`);
    });

    test("fails when caller is not minter", async () => {
      await expect(
        client.send.mint({
          sender: user,
          args: [user.toString(), 0],
          boxReferences: [getAddressRolesBoxKey(MINTER_ROLE, user.publicKey)],
        }),
      ).rejects.toThrow("Access control unauthorised account");
    });

    // succeeds test in child contracts' tests
  });
});
