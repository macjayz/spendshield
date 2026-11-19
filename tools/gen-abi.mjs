#!/usr/bin/env node
// Writes packages/aevum/src/spendShieldAbi.ts from the compiled contract. Usage: pnpm abi
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const abi = JSON.parse(execSync("forge inspect SpendShield abi --json", { cwd: "contracts" }).toString());
writeFileSync(
  "packages/aevum/src/spendShieldAbi.ts",
  `/** ABI of contracts/src/SpendShield.sol. Regenerate with \`pnpm abi\`. */\nexport const spendShieldAbi = ${JSON.stringify(abi, null, 2)} as const;\n`,
);
console.log(`spendShieldAbi: ${abi.length} entries`);
