'use client';

// ============================================================
// CHANGELOG - Bug Fixes
// ============================================================
// [BUG-4] FIXED: Duplikasi ritualChain & config dihapus dari sini.
//         Sebelumnya providers.tsx mendefinisikan ulang ritualChain dan config
//         yang sudah ada di wagmi.ts — sekarang cukup import dari wagmi.ts.
//         Satu source of truth, tidak ada risiko definisi chain berbeda.
// ============================================================

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { config } from './wagmi';

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
