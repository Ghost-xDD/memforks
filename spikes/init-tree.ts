import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL(".env.local", import.meta.url).pathname });

import { MemForksClient } from "../sdk/src/client.js";

const mem = await MemForksClient.connect({
  treeId: "",
  packageId: process.env["MEMFORKS_PACKAGE_ID"]!,
  signer: process.env["SUI_OWNER_PRIVATE_KEY"]!,
  memwal: {
    delegateKey: process.env["MEMFORKS_MEMWAL_KEY"]!,
    accountId: process.env["MEMWAL_ACCOUNT_ID"]!,
  },
});

const { treeId } = await mem.initTree(process.env["MEMWAL_ACCOUNT_ID"]!);
console.log("New tree ID:", treeId);
console.log("\nAdd to .env.local:");
console.log(`MEMFORKS_TREE_ID=${treeId}`);
