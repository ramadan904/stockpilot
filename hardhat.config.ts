import "@nomicfoundation/hardhat-toolbox-viem";
import { subtask, type HardhatUserConfig } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";

// Compile with the solc-js build pinned in package.json instead of downloading a native compiler, so builds work
// offline and behind restrictive proxies, and every machine uses the exact same compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  const solc = require("solc");
  const bundled: string = require("solc/package.json").version;
  if (args.solcVersion !== bundled) return runSuper(args);
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: bundled,
    longVersion: solc.version(),
  };
});

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { hardfork: "cancun" },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com/rpc",
      chainId: 46630,
      accounts,
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts,
    },
  },
  mocha: { timeout: 120_000 },
};

export default config;
