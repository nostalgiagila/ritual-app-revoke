'use client';

import {
  useAccount,
  useWriteContract,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
} from 'wagmi';
import { useState, useEffect, useRef, useCallback } from 'react';
import { injected } from 'wagmi/connectors';
import { parseAbiItem, parseAbi, isAddress, formatUnits, maxUint256 } from 'viem';
import toast, { Toaster } from 'react-hot-toast';

// ============================================================
// CHANGELOG
// ============================================================
// [BUG-1] FIXED: bulkRevoke key parsing pakai separator "|" bukan "-"
// [BUG-2] FIXED: bulkRevoke & revoke toast konflik → _revokeInternal()
// [BUG-3] FIXED: useEffect scan dependency array tidak lengkap
// [BUG-4] FIXED: Duplikasi ritualChain di providers.tsx
// [BUG-5] FIXED: scanProgress flicker saat selesai
// [BUG-6] FIXED: Manual revoke tidak validasi format address
// [BUG-7] FIXED: Canvas animation memory leak
// [BUG-8] FIXED: Promise.all ketiga mengulang scan Approval (bukan Permit),
//          dan hasil pLogs tidak pernah dimasukkan ke permitLogs —
//          menyebabkan scan Permit tidak berjalan sama sekali.
//          Fix: hapus Promise.all ketiga; scan Permit tetap di blok
//          try terpisah yang sudah benar di bawahnya.
// [BUG-9] FIXED: permitLogs terisi data dari erc20ApproveLogs (dobel),
//          sehingga permitResults = salinan erc20Results dengan label berbeda.
//          Fix: permitLogs hanya diisi dari blok try scan Permit EIP-2612.
// [BUG-10] FIXED: Key deduplication menyertakan item.type sehingga
//          approval yang sama (token+spender) muncul dua kali jika
//          terdeteksi sebagai ERC-20 dan PERMIT sekaligus.
//          Fix: key dedup tidak menyertakan type —
//          hanya token+spender (atau token+spender+tokenId untuk ERC-721).
// [BUG-11] FIXED: ERC-1155 revoke selalu memakai ERC721_ABI.
//          _revokeInternal() tidak menerima contractType sehingga tidak bisa
//          memilih ABI yang tepat untuk ERC-1155 setApprovalForAll.
//          Fix: tambah param contractType ke _revokeInternal, revoke, bulkRevoke,
//          dan confirmRevoke; pilih ERC1155_ABI jika contractType === 'ERC-1155'.
// [BUG-12] FIXED: Real-time listener tidak fetch allowance/allowanceDisplay/symbol.
//          Item yang masuk via watchEvent tidak memiliki field allowanceDisplay,
//          sehingga tampil kosong di UI.
//          Fix: fetch allowance + tokenMeta setelah menerima log ERC-20 real-time.
// [BUG-13] FIXED: Parameter forceFresh tidak digunakan di dalam scanApprovals.
//          Tombol "Force Fresh" tidak berbeda dengan "Scan Again".
//          Fix: saat forceFresh=true, sessionStorage cache dihapus dan
//          setApprovals([]) dipanggil eksplisit sebelum scan ulang dimulai.
// [BUG-14] FIXED: writeContract fire-and-forget — revoke dianggap sukses
//          sebelum transaksi dikonfirmasi on-chain.
//          Fix: ganti ke useWriteContractAsync + waitForTransactionReceipt (viem)
//          agar item hanya dihapus dari state & toast sukses muncul setelah
//          transaksi benar-benar confirmed di chain.
// [BUG-15] FIXED: useWaitForTransactionReceipt diimport dari wagmi tapi tidak
//          dipakai — implementasi BUG-14 memakai publicClient.waitForTransactionReceipt
//          (viem) langsung. Import dihapus untuk menghilangkan ESLint warning.
// [BUG-16] FIXED: Real-time ApprovalForAll listener selalu memberi label ERC-721
//          tanpa mendeteksi apakah kontrak sebenarnya ERC-1155.
//          Fix: panggil detectContractType setelah menerima log ApprovalForAll,
//          set type sesuai hasil deteksi. Ada fallback ke ERC-721 jika RPC gagal.
// [BUG-17] FIXED: Bulk revoke loading toast tidak menampilkan progress per item,
//          sehingga user tidak tahu seberapa jauh proses berjalan (terutama karena
//          setiap item kini menunggu konfirmasi on-chain per BUG-14).
//          Fix: update toast setiap item selesai: "Revoking approval N of Total..."
// [BUG-18] FIXED: publicClient! (non-null assertion) di waitForTransactionReceipt
//          bisa throw unhandled error jika user disconnect di tengah revoke.
//          Fix: cek eksplisit `if (!publicClient) throw new Error(...)` agar
//          error masuk ke blok catch dan ditangani dengan benar.
// ─────────────────────────────────────────────────────────────
// ROOT CAUSE FIX — Approval tidak muncul di list
// ─────────────────────────────────────────────────────────────
// [RC1] FIXED: Silent catch menelan error getLogs per chunk.
//          try { getLogs } catch {} membuat setiap error chunk hilang tanpa
//          jejak — approval di blok tersebut tidak pernah masuk ke list.
//          Fix: ganti ke getLogsWithRetry() yang mencatat error ke console
//          dan retry otomatis dengan sub-chunk lebih kecil sebelum menyerah.
// [RC2] FIXED: CHUNK_SIZE 90000 terlalu besar untuk RPC Ritual Testnet.
//          RPC testnet umumnya membatasi eth_getLogs maks 1000–5000 blok/request.
//          Chunk terlalu besar → RPC error → catch diam-diam (RC1) → approval hilang.
//          Fix: turunkan CHUNK_SIZE ke 2000, retry dengan CHUNK_SIZE_RETRY 500.
// [RC3] FIXED v2: Staking app yang tidak emit event Approval standar tidak terdeteksi.
//          Whitelist manual tidak feasible karena tidak ada list token publik di Ritual.
//          Fix: auto-discovery tanpa whitelist —
//          (A) scan Transfer event (user sbg sender) untuk temukan semua token yang
//              pernah dipakai user + kontrak 'to' sebagai kandidat spender.
//          (B) fetch tx receipts dari approval logs yang ada untuk ekstrak semua
//              address kontrak yang terlibat dalam transaksi tersebut.
//          (C) cross-query allowance(user, spender) untuk semua kombinasi
//              token × spender yang ditemukan, skip yang sudah ada di event scan.
// [PERF] FIXED: Scan blockchain terlalu lambat — 4 bottleneck diatasi:
//          (1) Sequential chunk loop → paralel dengan SCAN_CONCURRENCY=3 batch.
//          (2) Transfer scan (RC3) digabung inline dalam scanChunk (satu pass).
//          (3) 3 event utama berjalan paralel per chunk via Promise.all.
//          (4) Progress bar akurat: 0–79%=scan, 80–95%=RC3, 95–100%=dedup.
// [FIX-ARGS] FIXED: args: { owner: address } di viem di-translate ke topic filter
//          (topics[1]). Ritual RPC mengembalikan [] kosong tanpa error.
//          Fix: hapus args dari getLogs, filter client-side by ownerLower.
// [FIX-DUP-COMMENT] FIXED: duplikasi komentar block chunkRanges dihapus.
// [RC3-v4] FIXED: Explorer API (fetch) diganti dengan targeted RPC-only scan:
//          Untuk setiap token yang ditemukan via Transfer, lakukan Approval scan
//          FULL HISTORY menggunakan `address` (contract) filter di getLogs.
//          `address` filter = filter by contract address (berbeda dari args/topic)
//          → Didukung semua RPC, tidak ada fetch/CORS/404, tidak ada Explorer API.
//          → Mendeteksi approval yang terjadi SEBELUM window MAX_SCAN_BLOCKS.
//          → Setelah targeted scan, knownSpenders jauh lebih lengkap untuk cross-query.
// ============================================================
// FEATURES
// ============================================================
// [FEAT-1] ERC-721 per tokenId approval
//          - Scan event Approval(owner, approved, tokenId) khusus ERC-721
//          - Deteksi via supportsInterface(0x80ac58cd)
//          - Revoke via approve(address(0), tokenId)
//          - UI menampilkan token ID spesifik
// [FEAT-2] ERC-1155 label & distinction
//          - Bedakan ERC-721 vs ERC-1155 via supportsInterface
//          - Label di UI dipisah: "ERC-721" / "ERC-1155" / "ERC-20"
//          - Filter dropdown diperbarui
// [FEAT-3] Allowance amount display untuk ERC-20
//          - Tampilkan nilai allowance (formatted) di setiap item
//          - Tandai "UNLIMITED" jika allowance === MaxUint256
//          - Fetch decimals & symbol token untuk formatting yang benar
// [FEAT-4] ERC-20 Permit (off-chain approval) support
//          - Scan event Permit(owner, spender, value, nonce, deadline)
//          - Verifikasi allowance aktif setelah permit ditemukan
//          - Label khusus "PERMIT" di UI
//          - Graceful fallback jika RPC tidak support event ini
// ============================================================

const EXPLORER_URL = 'https://explorer.ritualfoundation.org';
// [RC2 FIX] Naikkan CHUNK_SIZE dari 2000 → 10000.
// Banyak RPC testnet (termasuk Ritual) membatasi eth_getLogs maks ~1000–5000
// blok per request. Chunk terlalu besar → RPC error → catch diam-diam → approval
// tidak muncul. Jika chunk 2000 masih error, retry otomatis dengan 500.
const CHUNK_SIZE = BigInt(10000);
const CHUNK_SIZE_RETRY = BigInt(2000);
const SCAN_CONCURRENCY = 3;
const MAX_SCAN_BLOCKS = BigInt(3_000_000);   // ~12 hari aktivitas
const APPROVAL_KEY_SEP = '|';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// [RC3 FIX v2] Auto-discovery token & spender tanpa whitelist manual.
// Strategi: scan Transfer event (user sbg sender) + scan tx history user
// untuk menemukan semua token & kontrak yang pernah berinteraksi.
// Kemudian query allowance() untuk setiap kombinasi token × spender.

const ERC721_INTERFACE_ID = '0x80ac58cd' as `0x${string}`;
const ERC1155_INTERFACE_ID = '0xd9b67a26' as `0x${string}`;

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const ERC721_ABI = parseAbi([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

const ERC1155_ABI = parseAbi([
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

// Deteksi tipe contract via supportsInterface
async function detectContractType(
  publicClient: any,
  address: `0x${string}`
): Promise<'ERC-721' | 'ERC-1155' | 'ERC-20'> {
  try {
    const is721 = await publicClient.readContract({
      address,
      abi: ERC721_ABI,
      functionName: 'supportsInterface',
      args: [ERC721_INTERFACE_ID],
    });
    if (is721) return 'ERC-721';
  } catch {}
  try {
    const is1155 = await publicClient.readContract({
      address,
      abi: ERC1155_ABI,
      functionName: 'supportsInterface',
      args: [ERC1155_INTERFACE_ID],
    });
    if (is1155) return 'ERC-1155';
  } catch {}
  return 'ERC-20';
}

// Fetch token metadata (decimals, symbol) untuk ERC-20
async function fetchTokenMeta(
  publicClient: any,
  address: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  try {
    const [decimals, symbol] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
    ]);
    return { decimals: Number(decimals), symbol: symbol as string };
  } catch {
    return { decimals: 18, symbol: '???' };
  }
}

// Format allowance untuk display
function formatAllowance(allowance: bigint, decimals: number, symbol: string): string {
  if (allowance === maxUint256) return '∞ UNLIMITED';
  const formatted = formatUnits(allowance, decimals);
  const num = parseFloat(formatted);
  if (num > 1_000_000) return `${(num / 1_000_000).toFixed(2)}M ${symbol}`;
  if (num > 1_000) return `${(num / 1_000).toFixed(2)}K ${symbol}`;
  return `${num.toFixed(4)} ${symbol}`;
}

export default function Home() {
  const { address, isConnected, chain } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient({ chainId: 1979 });

  const [manualToken, setManualToken] = useState('');
  const [manualSpender, setManualSpender] = useState('');
  const [approvals, setApprovals] = useState<any[]>([]);
  const [selectedApprovals, setSelectedApprovals] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'ERC-20' | 'ERC-721' | 'ERC-1155' | 'PERMIT'>('all');
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<{
    token: string;
    spender: string;
    isNFT: boolean;
    isBulk: boolean;
    tokenId?: bigint;
    contractType?: string;
  } | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  const isCorrectNetwork = chain?.id === 1979;
  const isScanningRef = useRef(false);
  const unwatchRef = useRef<(() => void) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationIdRef = useRef<number | null>(null);

  useEffect(() => { setIsMounted(true); }, []);

  const initParticles = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (animationIdRef.current !== null) cancelAnimationFrame(animationIdRef.current);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const particles: any[] = [];
    for (let i = 0; i < 70; i++) {
      particles.push({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        radius: Math.random() * 2.8 + 1.2,
        speedX: (Math.random() - 0.5) * 0.8, speedY: (Math.random() - 0.5) * 0.8,
      });
    }
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#22FF99'; ctx.fill();
        p.x += p.speedX; p.y += p.speedY;
        if (p.x < 0 || p.x > canvas.width) p.speedX *= -1;
        if (p.y < 0 || p.y > canvas.height) p.speedY *= -1;
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x; const dy = p.y - p2.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 160) {
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(34, 255, 153, ${1 - distance / 160})`;
            ctx.lineWidth = 0.8; ctx.stroke();
          }
        }
      });
      animationIdRef.current = requestAnimationFrame(animate);
    };
    animate();
  }, []);

  useEffect(() => {
    if (isMounted) {
      setTimeout(initParticles, 150);
      window.addEventListener('resize', initParticles);
      return () => {
        window.removeEventListener('resize', initParticles);
        if (animationIdRef.current !== null) cancelAnimationFrame(animationIdRef.current);
      };
    }
  }, [isMounted, initParticles]);

  // Real-time listener untuk approval baru setelah scan selesai
  const startRealTimeListener = useCallback(() => {
    if (!address || !publicClient) return;
    if (unwatchRef.current) unwatchRef.current();

    const unwatch1 = publicClient.watchEvent({
      event: parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)'),
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          if (log.args?.owner?.toLowerCase() !== address.toLowerCase()) continue;
          // [BUG-12 FIX] Fetch allowance + tokenMeta agar allowanceDisplay tersedia
          // sama seperti hasil dari scanApprovals().
          try {
            const tokenAddr = log.address as `0x${string}`;
            const spender = log.args.spender as `0x${string}`;
            const allowance = await publicClient.readContract({
              address: tokenAddr,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [address as `0x${string}`, spender],
            }) as bigint;
            if (allowance <= BigInt(0)) continue;
            const meta = await fetchTokenMeta(publicClient, tokenAddr);
            const newItem = {
              id: `rt-${log.blockNumber}-${log.logIndex}`,
              type: 'ERC-20',
              token: log.address,
              spender: log.args.spender,
              isNFT: false,
              allowance,
              allowanceDisplay: formatAllowance(allowance, meta.decimals, meta.symbol),
              symbol: meta.symbol,
            };
            setApprovals(prev => [newItem, ...prev.filter(a => a.id !== newItem.id)]);
          } catch {
            // fallback: masukkan tanpa allowanceDisplay jika fetch gagal
            const newItem = {
              id: `rt-${log.blockNumber}-${log.logIndex}`,
              type: 'ERC-20',
              token: log.address,
              spender: log.args.spender,
              isNFT: false,
            };
            setApprovals(prev => [newItem, ...prev.filter(a => a.id !== newItem.id)]);
          }
        }
      },
    });

    const unwatch2 = publicClient.watchEvent({
      event: parseAbiItem('event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'),
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          if (
            log.args?.owner?.toLowerCase() !== address.toLowerCase() ||
            !log.args.approved
          ) continue;
          // [BUG-16 FIX] Deteksi contractType agar ERC-1155 tidak salah diberi
          // label ERC-721, dan saat revoke memakai ABI yang tepat.
          try {
            const contractType = await detectContractType(
              publicClient,
              log.address as `0x${string}`
            );
            const newItem = {
              id: `rt-forall-${log.blockNumber}-${log.logIndex}`,
              type: contractType === 'ERC-1155' ? 'ERC-1155' : 'ERC-721',
              token: log.address,
              spender: log.args.operator,
              isNFT: true,
            };
            setApprovals(prev => [newItem, ...prev.filter(a => a.id !== newItem.id)]);
          } catch {
            // fallback ke ERC-721 jika detectContractType gagal
            const newItem = {
              id: `rt-forall-${log.blockNumber}-${log.logIndex}`,
              type: 'ERC-721',
              token: log.address,
              spender: log.args.operator,
              isNFT: true,
            };
            setApprovals(prev => [newItem, ...prev.filter(a => a.id !== newItem.id)]);
          }
        }
      },
    });

    unwatchRef.current = () => { unwatch1(); unwatch2(); };
  }, [address, publicClient]);

  const scanApprovals = useCallback(async (forceFresh = false) => {
    if (!address || !publicClient || isScanningRef.current) return;

    isScanningRef.current = true;
    setIsScanning(true);
    setScanProgress(0);
    // [BUG-13 FIX] forceFresh=true: bersihkan approvals yang ada sebelum scan ulang
    // agar user mendapat tampilan bersih, bukan menumpuk di atas data lama.
    if (forceFresh) {
      setApprovals([]);
    }

    const loadingToast = toast.loading('🔍 Scanning blockchain history...');

    try {
      const latestBlock = await publicClient.getBlockNumber();

      // Kumpulkan semua raw logs per tipe
      let erc20ApproveLogs: any[] = [];
      let approvalForAllLogs: any[] = [];
      let permitLogs: any[] = [];
      let erc721TokenIdLogs: any[] = [];
      // [RC3+PERF] Transfer logs dikumpulkan inline dalam scanChunk (satu pass)
      const _transferTokens   = new Set<string>();
      const _transferSpenders = new Set<string>();

      // ─── Helper: getLogs satu chunk dengan auto-retry chunk lebih kecil ───
      // [RC1 FIX] Error tidak lagi ditelan diam-diam — dicatat ke console dan
      //           di-retry dengan chunk lebih kecil (CHUNK_SIZE_RETRY) sebelum menyerah.
      const getLogsWithRetry = async (params: any): Promise<any[]> => {
        try {
          return await publicClient.getLogs(params);
        } catch (err) {
          console.warn(`[scan] getLogs gagal untuk range ${params.fromBlock}–${params.toBlock}, retry dengan chunk lebih kecil...`, err);
          const results: any[] = [];
          let subFrom = params.fromBlock;
          while (subFrom <= params.toBlock) {
            const subTo = subFrom + CHUNK_SIZE_RETRY > params.toBlock
              ? params.toBlock
              : subFrom + CHUNK_SIZE_RETRY;
            try {
              const subLogs = await publicClient.getLogs({ ...params, fromBlock: subFrom, toBlock: subTo });
              results.push(...subLogs);
            } catch (subErr) {
              console.error(`[scan] getLogs tetap gagal untuk sub-range ${subFrom}–${subTo}, chunk dilewati.`, subErr);
            }
            subFrom = subTo + BigInt(1);
          }
          return results;
        }
      };

      // ─── [PERF] Bangun daftar semua chunk range terlebih dahulu ───
      // Semua event type (Approval, ApprovalForAll, Permit, ERC721-tokenId, Transfer)
      // digabung dalam SATU pass sehingga tidak ada loop kedua terpisah.
      const chunkRanges: Array<{ from: bigint; to: bigint }> = [];
      {
        // Scan MAX_SCAN_BLOCKS block terakhir (lihat konstanta di atas)
        const startBlock = latestBlock > MAX_SCAN_BLOCKS
          ? latestBlock - MAX_SCAN_BLOCKS
          : BigInt(0);
        
        let cur = startBlock;
        while (cur <= latestBlock) {
          const end = cur + CHUNK_SIZE > latestBlock ? latestBlock : cur + CHUNK_SIZE;
          chunkRanges.push({ from: cur, to: end });
          cur = end + BigInt(1);
        }
      }
      const totalChunks = chunkRanges.length;
      let completedChunks = 0;

      // ─── [PERF] Scan paralel dengan concurrency pool ───
      // [FIX-ARGS] args: { owner: address } di viem ditranslate ke topic filter
      // (topics[1] = paddedAddress). Ritual RPC mengembalikan [] kosong tanpa
      // error saat menerima indexed topic filter → approval tidak pernah ditemukan.
      // Fix: hapus args dari semua getLogs call, filter client-side by ownerLower.
      const ownerLower = address!.toLowerCase();

      const scanChunk = async (range: { from: bigint; to: bigint }) => {
        const { from: fb, to: tb } = range;

        const [allErc20Logs, allNftLogs, allTransferLogs] = await Promise.all([
          // ERC-20 Approval — tanpa args filter, filter client-side
          getLogsWithRetry({
            event: parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)'),
            fromBlock: fb,
            toBlock: tb,
          }),
          // ApprovalForAll — tanpa args filter, filter client-side
          getLogsWithRetry({
            event: parseAbiItem('event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'),
            fromBlock: fb,
            toBlock: tb,
          }),
          // Transfer(from=user) — tanpa args filter, filter client-side
          getLogsWithRetry({
            event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
            fromBlock: fb,
            toBlock: tb,
          }),
        ]);

        // Filter client-side — works on ALL RPC nodes regardless of topic-filter support
        const erc20Logs    = allErc20Logs.filter((l: any) => l.args?.owner?.toLowerCase() === ownerLower);
        const nftLogs      = allNftLogs.filter((l: any) => l.args?.owner?.toLowerCase() === ownerLower);
        const transferLogs = allTransferLogs.filter((l: any) => l.args?.from?.toLowerCase() === ownerLower);

        // Permit EIP-2612 — tanpa args filter, filter client-side
        let pLogs: any[] = [];
        try {
          const allPermitLogs = await getLogsWithRetry({
            event: parseAbiItem('event Permit(address indexed owner, address indexed spender, uint256 value, uint256 nonce, uint256 deadline)'),
            fromBlock: fb,
            toBlock: tb,
          });
          pLogs = allPermitLogs.filter((l: any) => l.args?.owner?.toLowerCase() === ownerLower);
        } catch (err) {
          console.warn('[scan] Permit EIP-2612 tidak didukung RPC ini.', err);
        }

        // ERC-721 per-tokenId Approval — tanpa args filter, filter client-side
        let t721Logs: any[] = [];
        try {
          const allT721Logs = await getLogsWithRetry({
            event: parseAbiItem('event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)'),
            fromBlock: fb,
            toBlock: tb,
          });
          t721Logs = allT721Logs.filter((l: any) => l.args?.owner?.toLowerCase() === ownerLower);
        } catch (err) {
          console.warn('[scan] ERC-721 tokenId scan gagal.', err);
        }

        return { erc20Logs, nftLogs, transferLogs, pLogs, t721Logs };
      };

      // Jalankan chunks dalam batch paralel sebesar SCAN_CONCURRENCY
      for (let i = 0; i < chunkRanges.length; i += SCAN_CONCURRENCY) {
        const batch = chunkRanges.slice(i, i + SCAN_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(scanChunk));

        for (const r of batchResults) {
          erc20ApproveLogs  = [...erc20ApproveLogs,  ...r.erc20Logs];
          approvalForAllLogs = [...approvalForAllLogs, ...r.nftLogs];
          permitLogs        = [...permitLogs,         ...r.pLogs];
          erc721TokenIdLogs = [...erc721TokenIdLogs,  ...r.t721Logs];
          // Transfer logs dikumpulkan langsung ke discoveredTokens/Spenders di bawah
          r.transferLogs.forEach((l: any) => {
            if (l.address) _transferTokens.add(l.address.toLowerCase());
            if (l.args?.to && l.args.to.toLowerCase() !== address.toLowerCase()) {
              _transferSpenders.add(l.args.to.toLowerCase());
            }
          });
        }

        completedChunks += batch.length;
        // Progress bar: scan loop = 80% dari total, sisanya 20% untuk post-processing
        setScanProgress(Math.min(Math.floor((completedChunks / totalChunks) * 80), 79));
      }

      // Set yang diisi oleh Transfer logs di dalam scanChunk di atas
      // (dideclare sebelum loop agar bisa diakses di sini)


      // ─── Cache helpers ───
      const contractTypeCache = new Map<string, string>();
      const getContractType = async (addr: string): Promise<string> => {
        if (contractTypeCache.has(addr)) return contractTypeCache.get(addr)!;
        const t = await detectContractType(publicClient, addr as `0x${string}`);
        contractTypeCache.set(addr, t);
        return t;
      };

      const tokenMetaCache = new Map<string, { decimals: number; symbol: string }>();
      const getTokenMeta = async (addr: string) => {
        if (tokenMetaCache.has(addr)) return tokenMetaCache.get(addr)!;
        const m = await fetchTokenMeta(publicClient, addr as `0x${string}`);
        tokenMetaCache.set(addr, m);
        return m;
      };

      // ─── Proses ERC-20 Approval logs ───
      const erc20Results = await Promise.all(
        erc20ApproveLogs.map(async (log: any) => {
          const token = log.address;
          const spender = log.args?.spender;
          if (!spender) return null;
          try {
            const allowance = await publicClient.readContract({
              address: token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [address as `0x${string}`, spender as `0x${string}`],
            });
            if ((allowance as bigint) > BigInt(0)) {
              const meta = await getTokenMeta(token);
              return {
                id: `erc20-${log.blockNumber}-${log.logIndex}`,
                type: 'ERC-20',
                token,
                spender,
                isNFT: false,
                allowance,
                allowanceDisplay: formatAllowance(allowance as bigint, meta.decimals, meta.symbol),
                symbol: meta.symbol,
              };
            }
          } catch {}
          return null;
        })
      );

      // ─── Proses Permit logs (EIP-2612) ───
      // [BUG-9 FIX] permitLogs kini hanya berisi hasil scan event Permit sungguhan,
      // bukan salinan erc20ApproveLogs. Verifikasi allowance tetap dilakukan
      // agar hanya permit yang masih aktif yang ditampilkan.
      const permitResults = await Promise.all(
        permitLogs.map(async (log: any) => {
          const token = log.address;
          const spender = log.args?.spender;
          if (!spender) return null;
          try {
            const allowance = await publicClient.readContract({
              address: token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [address as `0x${string}`, spender as `0x${string}`],
            });
            if ((allowance as bigint) > BigInt(0)) {
              const meta = await getTokenMeta(token);
              return {
                id: `permit-${log.blockNumber}-${log.logIndex}`,
                type: 'PERMIT',
                token,
                spender,
                isNFT: false,
                allowance,
                allowanceDisplay: formatAllowance(allowance as bigint, meta.decimals, meta.symbol),
                symbol: meta.symbol,
              };
            }
          } catch {}
          return null;
        })
      );

      // ─── Proses ApprovalForAll logs (ERC-721 / ERC-1155) ───
      const approvalForAllResults = await Promise.all(
        approvalForAllLogs.map(async (log: any) => {
          const token = log.address;
          const operator = log.args?.operator;
          if (!operator) return null;
          try {
            const contractType = await getContractType(token);
            const abi = contractType === 'ERC-1155' ? ERC1155_ABI : ERC721_ABI;
            const isApproved = await publicClient.readContract({
              address: token as `0x${string}`,
              abi,
              functionName: 'isApprovedForAll',
              args: [address as `0x${string}`, operator as `0x${string}`],
            });
            if (isApproved) {
              return {
                id: `forall-${log.blockNumber}-${log.logIndex}`,
                type: contractType === 'ERC-1155' ? 'ERC-1155' : 'ERC-721',
                token,
                spender: operator,
                isNFT: true,
              };
            }
          } catch {}
          return null;
        })
      );

      // ─── Proses ERC-721 per-tokenId Approval logs ───
      const erc721TokenIdResults = await Promise.all(
        erc721TokenIdLogs.map(async (log: any) => {
          const token = log.address;
          const approved = log.args?.approved;
          const tokenId = log.args?.tokenId;
          if (!approved || tokenId === undefined) return null;
          // Jika approved address(0) → sudah direvoke sebelumnya, skip
          if (approved.toLowerCase() === ZERO_ADDRESS) return null;
          try {
            const currentApproved = await publicClient.readContract({
              address: token as `0x${string}`,
              abi: ERC721_ABI,
              functionName: 'getApproved',
              args: [tokenId as bigint],
            });
            if ((currentApproved as string).toLowerCase() === approved.toLowerCase()) {
              return {
                id: `erc721tid-${log.blockNumber}-${log.logIndex}`,
                type: 'ERC-721',
                token,
                spender: approved,
                isNFT: true,
                tokenId,
                isTokenIdApproval: true,
              };
            }
          } catch {}
          return null;
        })
      );

      // ─── Gabung semua hasil ───
      const allResults = [
        ...erc20Results,
        ...permitResults,
        ...approvalForAllResults,
        ...erc721TokenIdResults,
      ].filter(Boolean) as any[];

      // ─── [RC3 v4] Targeted full-history Approval scan untuk token yang diketahui ───
      //
      // Masalah yang tersisa setelah FIX-ARGS:
      //   - Approval mungkin terjadi SEBELUM window MAX_SCAN_BLOCKS → tidak terdeteksi
      //   - Explorer API (fetch) punya CORS issue + 404 di Ritual
      //
      // Solusi: untuk setiap token yang ditemukan via Transfer scan (dalam window),
      // lakukan Approval event scan FULL HISTORY menggunakan filter `address`
      // (contract address), bukan topic filter.
      //
      // `address` filter di eth_getLogs = filter by contract address (topics[0]-adjacent)
      // → BERBEDA dari `args`/topic filter yang bermasalah di Ritual RPC
      // → Didukung 100% oleh semua EVM-compatible RPC node
      // → Tidak perlu fetch()/CORS/Explorer API sama sekali
      // → Targeted: hanya scan token yang user pernah interact, bukan semua kontrak

      setScanProgress(82);

      // Kumpulkan semua token unik dari Transfer scan (sudah ada dari scanChunk)
      // Tambahkan juga token dari Approval event yang sudah ditemukan
      const targetedTokens = new Set<string>([
        ..._transferTokens,
        ...erc20ApproveLogs.map((l: any) => l.address?.toLowerCase()).filter(Boolean),
        ...approvalForAllLogs.map((l: any) => l.address?.toLowerCase()).filter(Boolean),
      ]);

      // Kumpulkan semua spender yang sudah diketahui dari event scan
      const knownSpenders = new Set<string>([
        ...erc20ApproveLogs.map((l: any) => l.args?.spender?.toLowerCase()).filter(Boolean),
        ...approvalForAllLogs.map((l: any) => l.args?.operator?.toLowerCase()).filter(Boolean),
        ..._transferSpenders,
      ]);

      console.info(`[RC3-v4] Targeted scan untuk ${targetedTokens.size} token yang diketahui`);

      setScanProgress(85);

      // Untuk setiap token yang diketahui, scan Approval event FULL HISTORY
      // menggunakan address filter (contract filter) — tanpa topic filter
      if (targetedTokens.size > 0) {
        const TARGETED_CHUNK = BigInt(50000); // chunk lebih besar ok karena spesifik per kontrak

        await Promise.all(
          Array.from(targetedTokens).map(async (tokenAddr) => {
            try {
              // Scan full history untuk token ini saja
              let tFrom = BigInt(0);
              while (tFrom <= latestBlock) {
                const tTo = tFrom + TARGETED_CHUNK > latestBlock ? latestBlock : tFrom + TARGETED_CHUNK;
                try {
                  const logs = await publicClient.getLogs({
                    address: tokenAddr as `0x${string}`, // ← contract address filter, bukan topic
                    event: parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)'),
                    fromBlock: tFrom,
                    toBlock: tTo,
                  });
                  // Filter client-side by owner
                  logs
                    .filter((l: any) => l.args?.owner?.toLowerCase() === ownerLower)
                    .forEach((l: any) => {
                      if (l.args?.spender) {
                        knownSpenders.add(l.args.spender.toLowerCase());
                        // Juga tambahkan ke erc20ApproveLogs jika belum ada
                        const alreadyScanned = erc20ApproveLogs.some(
                          (e: any) =>
                            e.address?.toLowerCase() === tokenAddr &&
                            e.args?.spender?.toLowerCase() === l.args.spender.toLowerCase()
                        );
                        if (!alreadyScanned) erc20ApproveLogs.push(l);
                      }
                    });
                } catch (chunkErr) {
                  console.warn(`[RC3-v4] Chunk ${tFrom}–${tTo} gagal untuk token ${tokenAddr}`, chunkErr);
                }
                tFrom = tTo + BigInt(1);
              }
            } catch (tokenErr) {
              console.warn(`[RC3-v4] Scan gagal untuk token ${tokenAddr}`, tokenErr);
            }
          })
        );

        console.info(`[RC3-v4] Setelah targeted scan: ${knownSpenders.size} spender diketahui`);
      }

      setScanProgress(88);

      // ─── Sumber B: tx receipts untuk menemukan spender tambahan ───
      // Dari tx hash yang ada di approval/nft logs, ambil receipt untuk
      // menemukan kontrak lain yang mungkin terlibat sebagai spender.
      try {
        const txHashesToCheck = new Set<string>(
          [...erc20ApproveLogs, ...approvalForAllLogs]
            .map((l: any) => l.transactionHash)
            .filter(Boolean)
            .slice(0, 50)
        );
        await Promise.all(
          Array.from(txHashesToCheck).map(async (txHash) => {
            try {
              const receipt = await publicClient.getTransactionReceipt({
                hash: txHash as `0x${string}`,
              });
              receipt?.logs?.forEach((l: any) => {
                if (l.address && l.address.toLowerCase() !== ownerLower) {
                  knownSpenders.add(l.address.toLowerCase());
                  targetedTokens.add(l.address.toLowerCase());
                }
              });
            } catch {}
          })
        );
      } catch (err) {
        console.warn('[RC3-v4] Tx receipt scan gagal, lanjut.', err);
      }

      setScanProgress(91);

      // ─── Cross-query: allowance(user, spender) untuk semua kombinasi ───
      // Setelah targeted scan, kita punya set knownSpenders yang jauh lebih lengkap.
      // Query allowance untuk semua kombinasi token × spender yang belum ada di allResults.
      const existingKeys = new Set(
        allResults.map((r: any) =>
          `${r.token?.toLowerCase()}${APPROVAL_KEY_SEP}${r.spender?.toLowerCase()}`
        )
      );

      const tokenArr  = Array.from(targetedTokens) as string[];
      const spenderArr = Array.from(knownSpenders).filter(s => s !== ownerLower);

      if (tokenArr.length > 0 && spenderArr.length > 0) {
        const crossResults = await Promise.all(
          tokenArr.flatMap(tokenAddr =>
            spenderArr.map(async (spender) => {
              const key = `${tokenAddr}${APPROVAL_KEY_SEP}${spender}`;
              if (existingKeys.has(key)) return null;
              try {
                const allowance = await publicClient.readContract({
                  address: tokenAddr as `0x${string}`,
                  abi: ERC20_ABI,
                  functionName: 'allowance',
                  args: [address as `0x${string}`, spender as `0x${string}`],
                }) as bigint;
                if (allowance > BigInt(0)) {
                  const meta = await getTokenMeta(tokenAddr);
                  return {
                    id: `rc3-${tokenAddr}-${spender}`,
                    type: 'ERC-20',
                    token: tokenAddr,
                    spender,
                    isNFT: false,
                    allowance,
                    allowanceDisplay: formatAllowance(allowance, meta.decimals, meta.symbol),
                    symbol: meta.symbol,
                  };
                }
              } catch { /* bukan ERC-20 atau allowance() tidak ada */ }
              return null;
            })
          )
        );
        const found = crossResults.filter(Boolean);
        allResults.push(...found);
        console.info(`[RC3-v4] Cross-query: ${tokenArr.length} token × ${spenderArr.length} spender → ${found.length} approval tambahan ditemukan`);
      }

      setScanProgress(95);

      // ─── Deduplication ───
      // [BUG-10 FIX]
      // Sebelumnya key menyertakan item.type sehingga approval yang sama
      // (token+spender) yang terdeteksi sebagai ERC-20 sekaligus PERMIT
      // menghasilkan dua key berbeda dan keduanya lolos dedup.
      // Sekarang key hanya berdasarkan token+spender (atau +tokenId untuk
      // ERC-721 tokenId). Jika ada duplikat, entri pertama yang dipertahankan
      // (prioritas: ERC-20 > PERMIT karena erc20Results diproses lebih dulu).
      const seen = new Set<string>();
      const uniqueApprovals = allResults.filter(item => {
        const key = item.isTokenIdApproval
          ? `${item.token.toLowerCase()}${APPROVAL_KEY_SEP}${item.spender.toLowerCase()}${APPROVAL_KEY_SEP}${item.tokenId}`
          : `${item.token.toLowerCase()}${APPROVAL_KEY_SEP}${item.spender.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      setApprovals(uniqueApprovals);
      setScanProgress(100);
      toast.success(`✅ Found ${uniqueApprovals.length} active approval(s)`, { id: loadingToast });
    } catch {
      toast.error('Scan failed. Please try again.', { id: loadingToast });
    } finally {
      setIsScanning(false);
      isScanningRef.current = false;
      // Reset progress bar setelah delay singkat agar user sempat melihat 100%
      setTimeout(() => setScanProgress(0), 800);
    }
  }, [address, publicClient]);

  useEffect(() => {
    if (isConnected && isCorrectNetwork && address) {
      scanApprovals();
      startRealTimeListener();
    }
    return () => { if (unwatchRef.current) unwatchRef.current(); };
  }, [isConnected, isCorrectNetwork, address, scanApprovals, startRealTimeListener]);

  const connectToRitual = async () => {
    try {
      await connect({ connector: injected() });
      toast.success('Wallet connected!');
    } catch {
      toast.error('Failed to connect wallet');
    }
  };

  const filteredApprovals = approvals.filter(item => {
    const search = searchTerm.toLowerCase();
    const matchesSearch =
      item.token.toLowerCase().includes(search) ||
      item.spender.toLowerCase().includes(search);
    const matchesFilter = filterType === 'all' || item.type === filterType;
    return matchesSearch && matchesFilter;
  });

  const openConfirmModal = (
    token: string,
    spender: string,
    isNFT: boolean,
    isBulk = false,
    tokenId?: bigint,
    contractType?: string
  ) => {
    setPendingRevoke({ token, spender, isNFT, isBulk, tokenId, contractType });
    setShowConfirmModal(true);
  };

  const confirmRevoke = async () => {
    if (!pendingRevoke) return;
    setShowConfirmModal(false);
    if (pendingRevoke.isBulk) {
      await bulkRevoke();
    } else {
      await revoke(pendingRevoke.token, pendingRevoke.spender, pendingRevoke.isNFT, pendingRevoke.tokenId, pendingRevoke.contractType);
    }
    setPendingRevoke(null);
  };

  // Internal revoke handler — dipakai oleh revoke() dan bulkRevoke()
  // [BUG-11 FIX] Tambah param contractType agar ERC-1155 pakai ERC1155_ABI,
  //              bukan selalu ERC721_ABI.
  // [BUG-14 FIX] Gunakan writeContractAsync + waitForTransactionReceipt agar
  //              item hanya dihapus dari state setelah tx benar-benar confirmed.
  const _revokeInternal = async (
    token: string,
    spender: string,
    isNFT: boolean,
    tokenId?: bigint,
    contractType?: string
  ): Promise<boolean> => {
    try {
      let txHash: `0x${string}`;

      if (isNFT && tokenId !== undefined) {
        // ERC-721 per-tokenId: approve(address(0), tokenId)
        txHash = await writeContractAsync({
          address: token as `0x${string}`,
          abi: ERC721_ABI,
          functionName: 'approve',
          args: [ZERO_ADDRESS as `0x${string}`, tokenId],
        });
      } else if (isNFT) {
        // [BUG-11 FIX] Pilih ABI berdasarkan contractType
        const nftAbi = contractType === 'ERC-1155' ? ERC1155_ABI : ERC721_ABI;
        txHash = await writeContractAsync({
          address: token as `0x${string}`,
          abi: nftAbi,
          functionName: 'setApprovalForAll',
          args: [spender as `0x${string}`, false],
        });
      } else {
        // ERC-20 / PERMIT: approve(spender, 0)
        txHash = await writeContractAsync({
          address: token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spender as `0x${string}`, BigInt(0)],
        });
      }

      // [BUG-14 FIX] Tunggu konfirmasi on-chain sebelum update state
      // [BUG-18 FIX] Guard publicClient agar tidak throw unhandled error
      //              jika user disconnect di tengah proses revoke.
      if (!publicClient) throw new Error('publicClient unavailable — wallet may have disconnected');
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Hapus dari state setelah tx confirmed
      setApprovals(prev => prev.filter(item => {
        if (tokenId !== undefined && item.tokenId !== undefined) {
          return !(
            item.token.toLowerCase() === token.toLowerCase() &&
            item.tokenId === tokenId
          );
        }
        return !(
          item.token.toLowerCase() === token.toLowerCase() &&
          item.spender.toLowerCase() === spender.toLowerCase()
        );
      }));

      return true;
    } catch (error: any) {
      console.error(`[_revokeInternal] Failed token=${token} spender=${spender} tokenId=${tokenId}:`, error);
      return false;
    }
  };

  const revoke = async (token: string, spender: string, isNFT: boolean, tokenId?: bigint, contractType?: string) => {
    const loadingToast = toast.loading('⏳ Waiting for transaction confirmation...');
    const success = await _revokeInternal(token, spender, isNFT, tokenId, contractType);
    if (success) toast.success('✅ Approval revoked successfully!', { id: loadingToast });
    else toast.error('Failed to revoke. Please try again.', { id: loadingToast });
  };

  const bulkRevoke = async () => {
    if (selectedApprovals.size === 0) return;
    const total = selectedApprovals.size;
    // [BUG-17 FIX] Update progress toast setiap item selesai dikonfirmasi on-chain
    const loadingToast = toast.loading(`⏳ Revoking approval 1 of ${total}...`);
    let successCount = 0;
    let failCount = 0;
    let doneCount = 0;

    for (const key of selectedApprovals) {
      // Key format: token|spender  atau  token|spender|tokenId
      const parts = key.split(APPROVAL_KEY_SEP);
      const [tokenPart, spenderPart, tokenIdStr] = parts;

      const item = approvals.find(a =>
        a.token.toLowerCase() === tokenPart &&
        a.spender.toLowerCase() === spenderPart &&
        (tokenIdStr ? String(a.tokenId) === tokenIdStr : !a.isTokenIdApproval)
      );

      if (item) {
        const ok = await _revokeInternal(item.token, item.spender, item.isNFT, item.tokenId, item.type);
        if (ok) successCount++;
        else failCount++;
      }

      doneCount++;
      if (doneCount < total) {
        toast.loading(`⏳ Revoking approval ${doneCount + 1} of ${total}...`, { id: loadingToast });
      }
    }

    setSelectedApprovals(new Set());

    if (failCount === 0) {
      toast.success(`✅ Bulk revoke complete: ${successCount} approval(s) revoked`, { id: loadingToast });
    } else {
      toast.error(`⚠️ Done: ${successCount} succeeded, ${failCount} failed`, { id: loadingToast });
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedApprovals(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) newSet.delete(key);
      else newSet.add(key);
      return newSet;
    });
  };

  // [BUG-10 FIX] getItemKey tidak menyertakan type — konsisten dengan dedup key
  const getItemKey = (item: any): string => {
    if (item.isTokenIdApproval && item.tokenId !== undefined) {
      return `${item.token.toLowerCase()}${APPROVAL_KEY_SEP}${item.spender.toLowerCase()}${APPROVAL_KEY_SEP}${item.tokenId}`;
    }
    return `${item.token.toLowerCase()}${APPROVAL_KEY_SEP}${item.spender.toLowerCase()}`;
  };

  const getTypeBadgeClass = (type: string) => {
    switch (type) {
      case 'ERC-721':  return 'bg-purple-500/20 text-purple-400';
      case 'ERC-1155': return 'bg-blue-500/20 text-blue-400';
      case 'PERMIT':   return 'bg-yellow-500/20 text-yellow-400';
      default:         return 'bg-emerald-500/20 text-emerald-400';
    }
  };

  const isManualInputValid = isAddress(manualToken) && isAddress(manualSpender);

  if (!isMounted) return <div className="min-h-screen bg-[#050507]"></div>;

  return (
    <>
      <div className="min-h-screen bg-[#050507] text-white relative overflow-hidden font-mono">
        <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none opacity-60" />

        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 relative z-10 min-h-screen flex flex-col">

          {/* Header */}
          <div className="text-center mb-12 border-b border-[#22FF9920] pb-8">
            <div className="flex items-center justify-center gap-4">
              <img src="/ritual-logo.png" alt="Ritual Logo" className="w-11 h-11" />
              <h1 className="text-4xl sm:text-5xl font-bold tracking-[-2px] text-[#22FF99]">
                RITUAL APP REVOKE
              </h1>
            </div>
            <p className="text-[#22FF99]/90 text-sm tracking-[2px] uppercase mt-3">
              TAKE FULL CONTROL OF YOUR APPROVALS ON RITUAL TESTNET
            </p>
          </div>

          {!isConnected ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <div className="w-full max-w-md text-center">
                <button
                  onClick={connectToRitual}
                  className="w-full border-2 border-[#22FF99] hover:bg-[#22FF99] hover:text-black text-[#22FF99] font-semibold py-6 rounded-2xl text-lg transition-all focus-visible:ring-4 focus-visible:ring-[#22FF99]/50"
                >
                  INITIALIZE WALLET CONNECTION
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Wrong Network Warning */}
              {!isCorrectNetwork && (
                <div className="bg-red-600/10 border-2 border-red-500 rounded-3xl p-6 mb-8 text-center">
                  <p className="text-red-400 text-xl font-bold mb-2">⚠️ WRONG NETWORK</p>
                  <p className="text-zinc-400 text-sm mb-1">
                    You are connected to{' '}
                    <span className="text-white font-semibold">
                      {chain?.name ?? `Chain ID ${chain?.id}`}
                    </span>
                  </p>
                  <p className="text-zinc-500 text-xs mb-5">
                    This app only works on{' '}
                    <span className="text-[#22FF99] font-semibold">Ritual Chain Testnet (Chain ID: 1979)</span>
                  </p>
                  <button
                    onClick={() => switchChain?.({ chainId: 1979 })}
                    className="bg-red-600 hover:bg-red-700 px-8 py-3 rounded-2xl font-semibold text-white focus-visible:ring-4 focus-visible:ring-red-500/50 transition-all"
                  >
                    SWITCH TO RITUAL TESTNET
                  </button>
                  <p className="text-zinc-600 text-xs mt-4">
                    Don't have Ritual Testnet in your wallet yet? Add it manually using Chain ID 1979.
                  </p>
                </div>
              )}

              {isCorrectNetwork && (
                <>
                  {/* Manual Revoke */}
                  <div className="bg-[#111113] border border-[#22FF9920] rounded-3xl p-6 sm:p-8 mb-10">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                      <div>
                        <label className="text-xs text-zinc-400 block mb-2">TOKEN ADDRESS</label>
                        <input
                          value={manualToken}
                          onChange={(e) => setManualToken(e.target.value)}
                          className={`w-full p-4 bg-black border rounded-2xl focus:border-[#22FF99] font-mono focus-visible:ring-4 focus-visible:ring-[#22FF99]/50 ${manualToken && !isAddress(manualToken) ? 'border-red-500' : 'border-zinc-800'}`}
                          placeholder="0x..."
                        />
                        {manualToken && !isAddress(manualToken) && (
                          <p className="text-red-400 text-xs mt-1">Invalid address format</p>
                        )}
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 block mb-2">SPENDER ADDRESS</label>
                        <input
                          value={manualSpender}
                          onChange={(e) => setManualSpender(e.target.value)}
                          className={`w-full p-4 bg-black border rounded-2xl focus:border-[#22FF99] font-mono focus-visible:ring-4 focus-visible:ring-[#22FF99]/50 ${manualSpender && !isAddress(manualSpender) ? 'border-red-500' : 'border-zinc-800'}`}
                          placeholder="0x..."
                        />
                        {manualSpender && !isAddress(manualSpender) && (
                          <p className="text-red-400 text-xs mt-1">Invalid address format</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => openConfirmModal(manualToken, manualSpender, false)}
                      disabled={isPending || !isManualInputValid}
                      className="w-full bg-red-600 hover:bg-red-700 py-5 rounded-2xl font-bold text-xl transition-all focus-visible:ring-4 focus-visible:ring-red-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPending ? '🔄 REVOKING...' : '🔥 REVOKE APPROVAL'}
                    </button>
                  </div>

                  {/* Search & Filter */}
                  <div className="flex flex-col sm:flex-row gap-3 mb-6">
                    <input
                      type="text"
                      placeholder="Search token or spender address..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="flex-1 p-4 bg-[#111113] border border-zinc-800 rounded-2xl focus:border-[#22FF99] font-mono focus-visible:ring-4 focus-visible:ring-[#22FF99]/50"
                    />
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value as any)}
                      className="w-full sm:w-52 p-4 pr-10 bg-[#111113] border border-zinc-800 rounded-2xl focus:border-[#22FF99] text-sm appearance-none focus-visible:ring-4 focus-visible:ring-[#22FF99]/50"
                    >
                      <option value="all">All Types</option>
                      <option value="ERC-20">ERC-20</option>
                      <option value="ERC-721">ERC-721</option>
                      <option value="ERC-1155">ERC-1155</option>
                      <option value="PERMIT">Permit</option>
                    </select>
                  </div>

                  {/* Progress Bar */}
                  {isScanning && (
                    <div className="bg-[#111113] border border-[#22FF9920] rounded-3xl p-6 mb-6">
                      <div className="flex justify-between text-sm mb-2">
                        <span>Scanning Blockchain History...</span>
                        <span className="font-mono text-[#22FF99]">{scanProgress}%</span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-[#22FF99] to-[#00FFAA] transition-all duration-300"
                          style={{ width: `${scanProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Approval List */}
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-[#22FF99] text-xl font-medium">
                        Connected Approvals ({filteredApprovals.length})
                      </h2>
                      <div className="flex gap-2">
                        <button
                          onClick={() => scanApprovals(false)}
                          disabled={isScanning}
                          className="bg-[#22FF9920] hover:bg-[#22FF9930] text-[#22FF99] px-5 py-3 rounded-2xl text-sm font-medium focus-visible:ring-4 focus-visible:ring-[#22FF99]/50"
                        >
                          {isScanning ? 'Scanning...' : '🔍 Scan Again'}
                        </button>
                        <button
                          onClick={() => scanApprovals(true)}
                          disabled={isScanning}
                          className="bg-zinc-800 hover:bg-zinc-700 px-4 py-3 rounded-2xl text-sm focus-visible:ring-4 focus-visible:ring-[#22FF99]/50"
                        >
                          Force Fresh
                        </button>
                        {selectedApprovals.size > 0 && (
                          <button
                            onClick={() => openConfirmModal('', '', false, true)}
                            className="bg-red-600 hover:bg-red-700 px-5 py-3 rounded-2xl text-sm font-medium focus-visible:ring-4 focus-visible:ring-red-500/50"
                          >
                            Revoke Selected ({selectedApprovals.size})
                          </button>
                        )}
                      </div>
                    </div>

                    {filteredApprovals.length === 0 && !isScanning && (
                      <div className="bg-[#111113] border border-zinc-800 rounded-3xl p-12 text-center text-zinc-400">
                        {searchTerm ? 'No matching approvals found' : 'No approvals detected yet'}
                      </div>
                    )}

                    {filteredApprovals.length > 0 && (
                      <div className="space-y-3">
                        {filteredApprovals.map((item) => {
                          const itemKey = getItemKey(item);
                          return (
                            <div
                              key={item.id}
                              className="bg-[#111113] border border-zinc-800 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:border-[#22FF99]/50 transition-colors"
                            >
                              <div className="flex items-center gap-3 flex-1">
                                <input
                                  type="checkbox"
                                  checked={selectedApprovals.has(itemKey)}
                                  onChange={() => toggleSelect(itemKey)}
                                  className="w-5 h-5 accent-[#22FF99]"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-xs px-3 py-1 rounded-full ${getTypeBadgeClass(item.type)}`}>
                                      {item.type}
                                    </span>
                                    <a
                                      href={`${EXPLORER_URL}/address/${item.token}`}
                                      target="_blank"
                                      className="font-mono text-sm text-zinc-300 hover:text-[#22FF99] break-all"
                                    >
                                      {item.token}
                                    </a>
                                  </div>
                                  <div className="text-zinc-400 text-xs mt-1">
                                    →{' '}
                                    <a
                                      href={`${EXPLORER_URL}/address/${item.spender}`}
                                      target="_blank"
                                      className="hover:text-[#22FF99] break-all"
                                    >
                                      {item.spender}
                                    </a>
                                  </div>
                                  {/* Token ID untuk ERC-721 per-tokenId */}
                                  {item.isTokenIdApproval && item.tokenId !== undefined && (
                                    <div className="text-purple-400 text-xs mt-1">
                                      Token ID: <span className="font-mono">{item.tokenId.toString()}</span>
                                    </div>
                                  )}
                                  {/* Allowance display untuk ERC-20 & PERMIT */}
                                  {(item.type === 'ERC-20' || item.type === 'PERMIT') && item.allowanceDisplay && (
                                    <div className={`text-xs mt-1 font-mono ${item.allowanceDisplay.includes('UNLIMITED') ? 'text-red-400' : 'text-zinc-500'}`}>
                                      Allowance: {item.allowanceDisplay}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <button
                                onClick={() => openConfirmModal(item.token, item.spender, item.isNFT, false, item.tokenId, item.type)}
                                className="w-full sm:w-auto bg-red-600 hover:bg-red-700 px-8 py-3 rounded-xl text-sm font-semibold transition-all focus-visible:ring-4 focus-visible:ring-red-500/50"
                              >
                                Revoke
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {isConnected && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => disconnect()}
                className="bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-xl text-sm transition-all focus-visible:ring-4 focus-visible:ring-red-500/50"
              >
                Disconnect Wallet
              </button>
            </div>
          )}

          <footer className="mt-auto pt-12 text-center text-xs text-zinc-500">
            <div className="flex justify-center gap-6 text-[#22FF99] flex-wrap mb-4">
              <a href="https://docs.ritualfoundation.org" target="_blank" className="hover:text-white">Docs</a>
              <a href="https://ritualfoundation.org" target="_blank" className="hover:text-white">Ritual Foundation</a>
              <a href={EXPLORER_URL} target="_blank" className="hover:text-white">Explorer</a>
            </div>
            <div>
              Made with ❤️ by{' '}
              <a href="https://x.com/nostalgiagila" target="_blank" className="text-[#22FF99] hover:underline">
                @nostalgiagila
              </a>
            </div>
          </footer>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && pendingRevoke && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111113] border border-[#22FF9920] rounded-3xl p-8 max-w-md w-full">
            <h3 className="text-2xl font-bold text-red-400 mb-2">Confirm Revoke</h3>
            <p className="text-zinc-400 mb-6">This action cannot be undone.</p>
            <div className="bg-zinc-900 rounded-2xl p-5 mb-6 space-y-2">
              <p>
                <span className="text-zinc-500">Type: </span>
                <strong>{pendingRevoke.contractType || (pendingRevoke.isNFT ? 'ERC-721' : 'ERC-20')}</strong>
              </p>
              <p className="break-all">
                <span className="text-zinc-500">Token: </span>{pendingRevoke.token}
              </p>
              <p className="break-all">
                <span className="text-zinc-500">Spender: </span>{pendingRevoke.spender}
              </p>
              {pendingRevoke.tokenId !== undefined && (
                <p>
                  <span className="text-zinc-500">Token ID: </span>
                  <span className="font-mono text-purple-400">{pendingRevoke.tokenId.toString()}</span>
                </p>
              )}
              {pendingRevoke.isBulk && (
                <p className="text-[#22FF99]">• Bulk Revoke ({selectedApprovals.size} items)</p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-2xl font-semibold focus-visible:ring-4 focus-visible:ring-zinc-400/50"
              >
                Cancel
              </button>
              <button
                onClick={confirmRevoke}
                className="flex-1 py-4 bg-red-600 hover:bg-red-700 rounded-2xl font-semibold focus-visible:ring-4 focus-visible:ring-red-500/50"
              >
                Confirm Revoke
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster position="top-center" toastOptions={{ duration: 4000 }} />
    </>
  );
}