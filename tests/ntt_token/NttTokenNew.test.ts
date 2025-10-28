import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { OnApplicationComplete, getApplicationAddress } from "algosdk";
import type { Account, Address } from "algosdk";

import { NttTokenNewClient, NttTokenNewFactory } from "../../specs/client/NttTokenNew.client.ts";
import { getAddressRolesBoxKey, getRoleBoxKey } from "../utils/boxes.ts";
import { convertNumberToBytes, getEventBytes, getRandomBytes, getRoleBytes } from "../utils/bytes.ts";
import { SECONDS_IN_DAY } from "../utils/time.ts";

describe("NttTokenNew", () => {
  const localnet = algorandFixture();

  const DEFAULT_ADMIN_ROLE = new Uint8Array(16);
  const MINTER_ROLE = getRoleBytes("MINTER");
  const UPGRADEABLE_ADMIN_ROLE = getRoleBytes("UPGRADEABLE_ADMIN");

  const MIN_UPGRADE_DELAY = SECONDS_IN_DAY;

  let factory: NttTokenNewFactory;
  let client: NttTokenNewClient;
  let appId: bigint;
  let assetId: bigint;

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

    factory = algorand.client.getTypedAppFactory(NttTokenNewFactory, {
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
    const TOTAL = 50_000_000_000_000n;
    const DECIMALS = 6;
    const ASSET_NAME = "Folks Finance";
    const UNIT_NAME = "FOLKS";
    const URL = "https://folks.finance";
    const METADATA_HASH = getRandomBytes(32);

    test.each([
      { adminLength: 30, totalLength: 8, decimalsLength: 8, arg: "arc4.static_array<arc4.uint8, 32>" },
      { adminLength: 34, totalLength: 8, decimalsLength: 8, arg: "arc4.static_array<arc4.uint8, 32>" },
      { adminLength: 32, totalLength: 4, decimalsLength: 8, arg: "arc4.uint64" },
      { adminLength: 32, totalLength: 16, decimalsLength: 8, arg: "arc4.uint64" },
      { adminLength: 32, totalLength: 8, decimalsLength: 4, arg: "arc4.uint64" },
      { adminLength: 32, totalLength: 8, decimalsLength: 16, arg: "arc4.uint64" },
    ])(
      `fails to initialise when admin is $adminLength, total is $totalLength and decimals is $decimalsLength bytes`,
      async ({ adminLength, totalLength, decimalsLength, arg }) => {
        await expect(
          localnet.algorand.send.appCall({
            sender: defaultAdmin,
            appId,
            onComplete: OnApplicationComplete.NoOpOC,
            args: [
              client.appClient.getABIMethod("initialise").getSelector(),
              getRandomBytes(adminLength),
              convertNumberToBytes(0, totalLength),
              convertNumberToBytes(0, decimalsLength),
              getRandomBytes(8),
              getRandomBytes(4),
              getRandomBytes(10),
              METADATA_HASH,
            ],
          }),
        ).rejects.toThrow(`invalid number of bytes for ${arg}`);
      },
    );

    test("fails to initialise when caller is not creator", async () => {
      await expect(
        client.send.initialise({
          sender: user,
          args: [user.toString(), TOTAL, DECIMALS, ASSET_NAME, UNIT_NAME, URL, METADATA_HASH],
        }),
      ).rejects.toThrow("Caller must be the contract creator");
    });

    test("succeeds to initialise and sets correct state", async () => {
      const APP_MIN_BALANCE = (255_400).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      const { returns, confirmations } = await client
        .newGroup()
        .addTransaction(fundingTxn)
        .initialise({
          args: [defaultAdmin.toString(), TOTAL, DECIMALS, ASSET_NAME, UNIT_NAME, URL, METADATA_HASH],
          extraFee: (1000).microAlgos(),
          boxReferences: [
            getRoleBoxKey(DEFAULT_ADMIN_ROLE),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, defaultAdmin.publicKey),
          ],
        })
        .send();

      expect(confirmations.length).toEqual(2);
      expect(confirmations[1].innerTxns).toBeDefined();
      const createAssetTx = confirmations[1].innerTxns![0];
      expect(createAssetTx.assetIndex).toBeDefined();
      assetId = createAssetTx.assetIndex!;
      expect(createAssetTx.txn.txn.type).toEqual("acfg");
      expect(createAssetTx.txn.txn.sender).toEqual(getApplicationAddress(appId));
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig).toBeDefined();
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.assetIndex).toEqual(0n);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.total).toEqual(TOTAL);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.decimals).toEqual(DECIMALS);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.defaultFrozen).toBeFalsy();
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.manager).toBeUndefined();
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.reserve).toBeUndefined();
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.clawback).toBeUndefined();
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.unitName).toEqual(UNIT_NAME);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.assetName).toEqual(ASSET_NAME);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.assetURL).toEqual(URL);
      expect(confirmations[1]!.innerTxns![0].txn.txn.assetConfig!.assetMetadataHash).toEqual(METADATA_HASH);

      expect(await client.state.global.isInitialised()).toBeTruthy();
      expect(returns.length).toEqual(1);
      expect(returns[0]).toEqual(assetId);
      expect(await client.state.global.assetId()).toEqual(assetId);
      expect(await client.getAssetId()).toEqual(assetId);
      expect(await client.hasRole({ args: [DEFAULT_ADMIN_ROLE, defaultAdmin.toString()] })).toBeTruthy();
    });

    test("fails to initialise when already initialised", async () => {
      await expect(
        client.send.initialise({
          args: [defaultAdmin.toString(), TOTAL, DECIMALS, ASSET_NAME, UNIT_NAME, URL, METADATA_HASH],
        }),
      ).rejects.toThrow("Contract already initialised");
    });
  });

  describe("mint", () => {
    beforeAll(async () => {
      // set minter role
      const APP_MIN_BALANCE = (27_700).microAlgos();
      const fundingTxn = await localnet.algorand.createTransaction.payment({
        sender: creator,
        receiver: getApplicationAddress(appId),
        amount: APP_MIN_BALANCE,
      });
      await client
        .newGroup()
        .addTransaction(fundingTxn)
        .setMinter({
          sender: defaultAdmin,
          args: [minter.toString()],
          boxReferences: [
            getRoleBoxKey(MINTER_ROLE),
            getAddressRolesBoxKey(MINTER_ROLE, minter.publicKey),
            getAddressRolesBoxKey(DEFAULT_ADMIN_ROLE, defaultAdmin.publicKey),
          ],
        })
        .send();

      // opt user into asset
      await localnet.algorand.send.assetOptIn({ sender: user, assetId });
    });

    test("succeeds", async () => {
      const { balance: appAssetBalanceBefore } = await localnet.algorand.asset.getAccountInformation(
        getApplicationAddress(appId),
        assetId,
      );
      const { balance: userAssetBalanceBefore } = await localnet.algorand.asset.getAccountInformation(user, assetId);

      const amount = 1_000_000n;
      const res = await client.send.mint({
        sender: minter,
        args: [user.toString(), amount],
        extraFee: (1000).microAlgos(),
        accountReferences: [user],
        assetReferences: [assetId],
        boxReferences: [getAddressRolesBoxKey(MINTER_ROLE, minter.publicKey)],
      });

      const { balance: appAssetBalanceAfter } = await localnet.algorand.asset.getAccountInformation(
        getApplicationAddress(appId),
        assetId,
      );
      const { balance: userAssetBalanceAfter } = await localnet.algorand.asset.getAccountInformation(user, assetId);

      expect(res.confirmations[0].logs).toBeDefined();
      expect(res.confirmations[0].logs![0]).toEqual(getEventBytes("Minted(address,uint64)", [user.publicKey, amount]));
      expect(appAssetBalanceAfter).toEqual(appAssetBalanceBefore - amount);
      expect(userAssetBalanceAfter).toEqual(userAssetBalanceBefore + amount);
    });
  });
});
