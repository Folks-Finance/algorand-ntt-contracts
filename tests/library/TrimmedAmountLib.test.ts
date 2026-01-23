import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import type { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import type { Account, Address } from "algosdk";

import {
  TrimmedAmountLibExposedClient,
  TrimmedAmountLibExposedFactory,
} from "../../specs/client/TrimmedAmountLibExposed.client.ts";

describe("TrimmedAmountLib", () => {
  const localnet = algorandFixture();

  let factory: TrimmedAmountLibExposedFactory;
  let client: TrimmedAmountLibExposedClient;
  let appId: bigint;

  let creator: Address & Account & TransactionSignerAccount;

  beforeAll(async () => {
    await localnet.newScope();
    const { algorand, generateAccount } = localnet.context;

    creator = await generateAccount({ initialFunds: (100).algo() });

    factory = algorand.client.getTypedAppFactory(TrimmedAmountLibExposedFactory, {
      defaultSender: creator,
      defaultSigner: creator.signer,
    });
  });

  test("deploys with correct state", async () => {
    const { appClient, result } = await factory.deploy();
    appId = result.appId;
    client = appClient;
    expect(appId).not.toEqual(0n);
  });

  describe("scale", () => {
    test("fails when overflows", async () => {
      const amt = 2n ** 63n;
      await expect(client.send.scale({ args: [amt, 0, 1] })).rejects.toThrow("logic eval error: * overflowed");
    });

    test.each([
      // stays same
      { amt: 0n, fromDecimals: 6, toDecimals: 6, expected: 0n },
      { amt: 5000000n, fromDecimals: 6, toDecimals: 6, expected: 5000000n },
      // scale up
      { amt: 5, fromDecimals: 0, toDecimals: 6, expected: 5000000n },
      { amt: 123456n, fromDecimals: 6, toDecimals: 8, expected: 12345600n },
      // scale down
      { amt: 5000000n, fromDecimals: 6, toDecimals: 0, expected: 5n },
      { amt: 123456n, fromDecimals: 8, toDecimals: 6, expected: 1234n },
      // scale down and rounds to zero
      { amt: 123456n, fromDecimals: 6, toDecimals: 0, expected: 0n },
    ])(
      "$amt from $fromDecimals decimals to $toDecimals decimals is $expected",
      async ({ amt, fromDecimals, toDecimals, expected }) => {
        expect(await client.scale({ args: [amt, fromDecimals, toDecimals] })).toEqual(expected);
      },
    );
  });

  describe("trim", () => {
    test.each([
      // min of from, to and 8 decimals
      { amt: 0n, fromDecimals: 6, toDecimals: 6, expected: { amount: 0n, decimals: 6 } },
      { amt: 0n, fromDecimals: 4, toDecimals: 6, expected: { amount: 0n, decimals: 4 } },
      { amt: 0n, fromDecimals: 6, toDecimals: 4, expected: { amount: 0n, decimals: 4 } },
      { amt: 0n, fromDecimals: 18, toDecimals: 12, expected: { amount: 0n, decimals: 8 } },
      { amt: 0n, fromDecimals: 12, toDecimals: 18, expected: { amount: 0n, decimals: 8 } },
      // stays same
      { amt: 0n, fromDecimals: 6, toDecimals: 6, expected: { amount: 0n, decimals: 6 } },
      { amt: 5000000n, fromDecimals: 6, toDecimals: 6, expected: { amount: 5000000n, decimals: 6 } },
      // scales down
      { amt: 5000000n, fromDecimals: 6, toDecimals: 0, expected: { amount: 5n, decimals: 0 } },
      { amt: 123456n, fromDecimals: 8, toDecimals: 6, expected: { amount: 1234n, decimals: 6 } },
      { amt: 123456n, fromDecimals: 12, toDecimals: 10, expected: { amount: 12n, decimals: 8 } },
      // scale down and rounds to zero
      { amt: 123456n, fromDecimals: 12, toDecimals: 6, expected: { amount: 0n, decimals: 6 } },
    ])(
      "$amt from $fromDecimals decimals to $toDecimals decimals is $expected",
      async ({ amt, fromDecimals, toDecimals, expected }) => {
        expect(await client.trim({ args: [amt, fromDecimals, toDecimals] })).toEqual(expected);
      },
    );
  });

  describe("untrim", () => {
    test("fails when overflows", async () => {
      const amt = { amount: 2n ** 62n, decimals: 6 };
      await expect(client.send.untrim({ args: [amt, 8] })).rejects.toThrow("logic eval error: * overflowed");
    });

    test.each([
      // stays same
      { amt: { amount: 0n, decimals: 6 }, toDecimals: 6, expected: 0n },
      { amt: { amount: 5000000n, decimals: 6 }, toDecimals: 6, expected: 5000000n },
      // scale up
      { amt: { amount: 5n, decimals: 0 }, toDecimals: 6, expected: 5000000n },
      { amt: { amount: 123456n, decimals: 6 }, toDecimals: 8, expected: 12345600n },
      // scale down
      { amt: { amount: 5000000n, decimals: 6 }, toDecimals: 0, expected: 5n },
      { amt: { amount: 123456n, decimals: 8 }, toDecimals: 6, expected: 1234n },
      // scale down and rounds to zero
      { amt: { amount: 123456n, decimals: 6 }, toDecimals: 0, expected: 0n },
    ])("$amt to $toDecimals decimals is $expected", async ({ amt, toDecimals, expected }) => {
      expect(await client.untrim({ args: [amt, toDecimals] })).toEqual(expected);
    });
  });
});
