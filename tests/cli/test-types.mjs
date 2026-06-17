/**
 * Unit tests for @memfork/core constants and type helpers.
 *
 * Verifies that PERM, PERM_ALL, RESOLVER_KIND, ATTEST_KIND, PROPOSAL_STATUS,
 * ERROR_CODE, and branchNamespace all match the values specified in SPEC §3–10.
 *
 * No network, no MemWal, no Sui.
 *
 * Run: node --test test-types.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PERM,
  PERM_ALL,
  RESOLVER_KIND,
  ATTEST_KIND,
  PROPOSAL_STATUS,
  ERROR_CODE,
  PAYLOAD_VERSION,
  branchNamespace,
} from "@memfork/core";

// ─── branchNamespace ─────────────────────────────────────────────────────────

describe("branchNamespace", () => {
  test("strips 0x prefix from treeId", () => {
    const ns = branchNamespace("0x" + "a".repeat(64), "main");
    assert.equal(ns, "memforks/" + "a".repeat(64) + "/main");
  });

  test("works without 0x prefix", () => {
    const ns = branchNamespace("a".repeat(64), "main");
    assert.equal(ns, "memforks/" + "a".repeat(64) + "/main");
  });

  test("both forms produce the same namespace", () => {
    const hex = "1".repeat(64);
    assert.equal(
      branchNamespace("0x" + hex, "main"),
      branchNamespace(hex, "main"),
    );
  });

  test("preserves branch names with slashes (topology names)", () => {
    const ns = branchNamespace("0x" + "a".repeat(64), "strategy/momentum");
    assert.ok(ns.endsWith("/strategy/momentum"));
  });

  test("short treeId is not padded — namespace reflects actual hex", () => {
    const ns = branchNamespace("0x1234", "dev");
    assert.equal(ns, "memforks/1234/dev");
  });

  test("format is always memforks/<treeHex>/<branch>", () => {
    const ns = branchNamespace("0xdeadbeef", "feat/auth");
    assert.match(ns, /^memforks\/[0-9a-f]+\/feat\/auth$/);
  });
});

// ─── PERM bitmask ─────────────────────────────────────────────────────────────

describe("PERM bitmask values (SPEC §3.1)", () => {
  test("READ is 0x01", ()  => assert.equal(PERM.READ,    0x01));
  test("WRITE is 0x02", () => assert.equal(PERM.WRITE,   0x02));
  test("FORK is 0x04", ()  => assert.equal(PERM.FORK,    0x04));
  test("MERGE is 0x08", () => assert.equal(PERM.MERGE,   0x08));
  test("PROPOSE is 0x10", () => assert.equal(PERM.PROPOSE, 0x10));

  test("all PERM values are distinct powers of 2", () => {
    const values = Object.values(PERM);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "duplicate PERM values");
    for (const v of values) {
      assert.ok((v & (v - 1)) === 0, `${v} is not a power of 2`);
    }
  });

  test("no two PERM bits overlap", () => {
    const values = Object.values(PERM);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        assert.equal(values[i] & values[j], 0, `PERM bits ${i} and ${j} overlap`);
      }
    }
  });
});

describe("PERM_ALL", () => {
  test("equals the bitwise OR of all individual PERM flags", () => {
    const expected = PERM.READ | PERM.WRITE | PERM.FORK | PERM.MERGE | PERM.PROPOSE;
    assert.equal(PERM_ALL, expected);
    assert.equal(PERM_ALL, 0x1f);
  });

  test("every individual PERM is set in PERM_ALL", () => {
    for (const [name, bit] of Object.entries(PERM)) {
      assert.ok((PERM_ALL & bit) === bit, `PERM.${name} missing from PERM_ALL`);
    }
  });
});

// ─── RESOLVER_KIND ────────────────────────────────────────────────────────────

describe("RESOLVER_KIND values (SPEC §4.6)", () => {
  test("LAST_WRITE_WINS is 0x00", () => assert.equal(RESOLVER_KIND.LAST_WRITE_WINS, 0x00));
  test("UNION is 0x01",           () => assert.equal(RESOLVER_KIND.UNION,           0x01));
  test("LLM_RECONCILE is 0x02",   () => assert.equal(RESOLVER_KIND.LLM_RECONCILE,  0x02));
  test("JURY_RECONCILE is 0x03",  () => assert.equal(RESOLVER_KIND.JURY_RECONCILE, 0x03));
  test("EVALUATOR_PICK is 0x04",  () => assert.equal(RESOLVER_KIND.EVALUATOR_PICK, 0x04));
  test("AND is 0x05",             () => assert.equal(RESOLVER_KIND.AND,             0x05));
  test("SEQUENCE is 0x06",        () => assert.equal(RESOLVER_KIND.SEQUENCE,        0x06));

  test("all RESOLVER_KIND values are distinct", () => {
    const values = Object.values(RESOLVER_KIND);
    assert.equal(new Set(values).size, values.length, "duplicate RESOLVER_KIND values");
  });
});

// ─── ATTEST_KIND ─────────────────────────────────────────────────────────────

describe("ATTEST_KIND values (SPEC §4.4)", () => {
  test("JURY_VOTE is 0x01",          () => assert.equal(ATTEST_KIND.JURY_VOTE,         0x01));
  test("EVALUATOR_VERDICT is 0x02",  () => assert.equal(ATTEST_KIND.EVALUATOR_VERDICT, 0x02));
  test("ORACLE_REPORT is 0x03",      () => assert.equal(ATTEST_KIND.ORACLE_REPORT,     0x03));
  test("LLM_RESOLVE is 0x04",        () => assert.equal(ATTEST_KIND.LLM_RESOLVE,       0x04));

  test("all ATTEST_KIND values are distinct", () => {
    const values = Object.values(ATTEST_KIND);
    assert.equal(new Set(values).size, values.length, "duplicate ATTEST_KIND values");
  });
});

// ─── PROPOSAL_STATUS ─────────────────────────────────────────────────────────

describe("PROPOSAL_STATUS values (SPEC §4.7)", () => {
  test("PENDING is 0",   () => assert.equal(PROPOSAL_STATUS.PENDING,   0));
  test("FINALIZED is 1", () => assert.equal(PROPOSAL_STATUS.FINALIZED, 1));
  test("ABORTED is 2",   () => assert.equal(PROPOSAL_STATUS.ABORTED,   2));
  test("EXPIRED is 3",   () => assert.equal(PROPOSAL_STATUS.EXPIRED,   3));

  test("all PROPOSAL_STATUS values are distinct", () => {
    const values = Object.values(PROPOSAL_STATUS);
    assert.equal(new Set(values).size, values.length, "duplicate PROPOSAL_STATUS values");
  });
});

// ─── ERROR_CODE ───────────────────────────────────────────────────────────────

describe("ERROR_CODE values (SPEC §10)", () => {
  test("E_NOT_OWNER is 0x0001",              () => assert.equal(ERROR_CODE.E_NOT_OWNER,              0x0001));
  test("E_NOT_DELEGATE is 0x0002",           () => assert.equal(ERROR_CODE.E_NOT_DELEGATE,           0x0002));
  test("E_DELEGATE_REVOKED is 0x0003",       () => assert.equal(ERROR_CODE.E_DELEGATE_REVOKED,       0x0003));
  test("E_DELEGATE_EXPIRED is 0x0004",       () => assert.equal(ERROR_CODE.E_DELEGATE_EXPIRED,       0x0004));
  test("E_MISSING_PERMISSION is 0x0005",     () => assert.equal(ERROR_CODE.E_MISSING_PERMISSION,     0x0005));
  test("E_BRANCH_NOT_FOUND is 0x0006",       () => assert.equal(ERROR_CODE.E_BRANCH_NOT_FOUND,       0x0006));
  test("E_BRANCH_EXISTS is 0x0007",          () => assert.equal(ERROR_CODE.E_BRANCH_EXISTS,          0x0007));
  test("E_PROPOSAL_NOT_PENDING is 0x0010",   () => assert.equal(ERROR_CODE.E_PROPOSAL_NOT_PENDING,   0x0010));
  test("E_FAST_FORWARD_CONFLICT is 0x0012",  () => assert.equal(ERROR_CODE.E_FAST_FORWARD_CONFLICT,  0x0012));
  test("E_RESOLVER_REJECT is 0x0013",        () => assert.equal(ERROR_CODE.E_RESOLVER_REJECT,        0x0013));
  test("E_ATTESTATION_INVALID is 0x0016",    () => assert.equal(ERROR_CODE.E_ATTESTATION_INVALID,    0x0016));
  test("E_PAYLOAD_VERSION_UNKNOWN is 0x0020",() => assert.equal(ERROR_CODE.E_PAYLOAD_VERSION_UNKNOWN, 0x0020));

  test("all ERROR_CODE values are distinct", () => {
    const values = Object.values(ERROR_CODE);
    assert.equal(new Set(values).size, values.length, "duplicate ERROR_CODE values");
  });
});

// ─── PAYLOAD_VERSION ─────────────────────────────────────────────────────────

describe("PAYLOAD_VERSION", () => {
  test("is 1", () => assert.equal(PAYLOAD_VERSION, 1));
});
