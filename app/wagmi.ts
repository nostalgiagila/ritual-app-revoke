import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { injected } from 'wagmi/connectors';

export const ritualChain = defineChain({
  id: 1979,
  name: 'Ritual Chain Testnet',
  nativeCurrency: { name: 'RITUAL', symbol: 'RITUAL', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.ritualfoundation.org'] } },
  blockExplorers: { 
    default: { name: 'Explorer', url: 'https://explorer.ritualfoundation.org' } 
  },
});

export const config = createConfig({
  chains: [ritualChain],
  transports: {
    [1979]: http(),
  },
  connectors: [injected()],
});