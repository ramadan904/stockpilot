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

// Accepted with or without the 0x prefix (MetaMask exports keys without it), and with stray spaces or line breaks.
const rawKey = process.env.PRIVATE_KEY?.trim();
const accounts = rawKey ? [rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { hardfork: "cancun" },
    // A local `hardhat node`; LOCAL_RPC points elsewhere, e.g. at the `chain` service in docker-compose.yml.
    localhost: { url: process.env.LOCAL_RPC ?? "http://127.0.0.1:8545", ...(accounts.length ? { accounts } : {}) },
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
