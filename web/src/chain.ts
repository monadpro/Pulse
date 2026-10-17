import { defineChain } from "viem";

// viem's built-in monadTestnet is outdated (no WebSocket, old explorer), so define our own.
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://testnet-rpc.monad.xyz"],
      webSocket: ["wss://testnet-rpc.monad.xyz"],
    },
  },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
});

// `VITE_LOCAL=1 npm run dev` points the app at a local anvil for development.
export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"], webSocket: ["ws://127.0.0.1:8545"] },
  },
});

export const chain = import.meta.env.VITE_LOCAL ? anvilLocal : monadTestnet;
