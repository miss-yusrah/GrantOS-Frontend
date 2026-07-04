'use client';

// app/verify/success/page.tsx

import ConnectButton from '@/components/ConnectButton';
import VerifyWalletReconnect from '@/components/verify/VerifyWalletReconnect';
import { api } from '@/lib/api';
import {
  clearVerifySession,
  clearZkProofOnly,
  persistVerifyAttestation,
  persistVerifyRequestId,
  persistZkProof,
  readVerifyAttestation,
  readVerifyRequestId,
  readZkProof,
} from '@/lib/identity-verify-session';
import { IDENTITY_REGISTRY_ABI, IDENTITY_REGISTRY_ADDRESS } from '@/lib/contracts';
import { Check, CheckCircle2, Fingerprint, Shield, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useConfig, useSwitchChain, useBalance } from 'wagmi';
import { getConnectorClient } from 'wagmi/actions';
import { writeContract } from 'viem/actions';
import { parseUnits } from 'viem';
import { arbitrumSepolia } from 'wagmi/chains';
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit';
import { connectFreighter } from '@/lib/stellar/freighter';
import { submitIdentityProof, isVerifiedOnStellar } from '@/lib/stellar/identity-registry';
import { useWallet } from '@/lib/wallet/WalletProvider';

const GithubIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

type AttestationData = {
  requestId:          string;
  status:             string;
  oracleSignature?:        string | null;
  oracleSchnorrSignature?: string | null;
  messageHash?:       string | null;
  githubLogin?:       string | null;
  githubId?:          number | null;
  githubCreatedYear?: number | null;
  accountAgeSeconds?: number | null;
  publicRepos?:       number | null;
  followers?:         number | null;
  contributionTier?:  string | null;
  walletAddressHi?:   string | null;
  walletAddressLo?:   string | null;
  // The exact [tier, githubId, year, hi, lo] bytes32[] the on-chain verifier
  // checks. `oracleSignature` is the `proof`; no ZK proving needed.
  publicInputs?:      string[] | null;
  // Private ZK witnesses (legacy — no longer used by the client)
  commitCount?:       number | null;
  totalStars?:        number | null;
  contributionEvents90d?: number | null;
};

type StepStatus = 'complete' | 'active' | 'pending' | 'error';

function formatAddress(address?: string) {
  if (!address) return 'Connect Wallet';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function ZkBadge({ githubLogin, tier, createdYear }: { githubLogin: string; tier: bigint; createdYear: bigint }) {
  const tierLabel = ['', 'Bronze', 'Silver', 'Gold', 'Platinum'][Number(tier)] ?? `Tier ${tier}`;
  const displayLogin = githubLogin && githubLogin !== 'unknown' ? `@${githubLogin}` : 'GitHub Verified';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <p className="text-sm font-bold text-emerald-900">ZK Verified ✓</p>
          <p className="text-xs text-emerald-700">Identity is permanently recorded on-chain.</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
            <GithubIcon className="h-5 w-5 text-slate-700" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-900">{displayLogin}</p>
            <p className="text-xs text-slate-500">Member since {createdYear.toString()}</p>
          </div>
          <span className="ml-auto rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-700">
            {tierLabel}
          </span>
        </div>
        <p className="text-xs text-slate-400">
          GitHub handle, account creation year, and contribution tier are publicly readable on-chain.
          This badge persists for all future grants — no re-verification needed.
        </p>
      </div>
    </div>
  );
}

function SuccessContent() {
  const { address, isConnected, status: walletStatus } = useAccount();
  const { chainKind, isConnected: walletConnected, address: walletAddress } = useWallet();
  const wagmiConfig = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal }  = useConnectModal();
  const { openAccountModal }  = useAccountModal();
  const searchParams = useSearchParams();
  const router       = useRouter();
  const requestIdFromUrl = searchParams.get('requestId');
  const [resolvedRequestId, setResolvedRequestId] = useState<string | null>(requestIdFromUrl);
  const [sessionReady, setSessionReady] = useState(false);

  const [attestation,    setAttestation]    = useState<AttestationData | null>(null);
  const [error,          setError]          = useState<string | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [generatingZk,   setGeneratingZk]   = useState(false);
  const [zkProof,        setZkProof]        = useState<Uint8Array | null>(null);
  const [zkPublicInputs, setZkPublicInputs] = useState<string[] | null>(null);
  const fetchedRef = useRef(false);
  const autoProofRef = useRef(false);
  const stellarVerifiedCheckRef = useRef(false);
  const walletReconnecting =
    walletStatus === 'connecting' || walletStatus === 'reconnecting';
  const walletResolved =
    walletStatus !== 'connecting' && walletStatus !== 'reconnecting';

  // Check if already verified on-chain
  const { data: alreadyVerified, isLoading: verifiedLoading } = useReadContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi:     IDENTITY_REGISTRY_ABI,
    functionName: 'isVerified',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address },
  });

  const { data: onChainIdentity } = useReadContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi:     IDENTITY_REGISTRY_ABI,
    functionName: 'getIdentity',
    args:    address ? [address] : undefined,
    query:   { enabled: !!address },
  });

  // On-chain submission
  const [txHash,       setTxHash]       = useState<`0x${string}` | undefined>(undefined);
  const [txPending,    setTxPending]    = useState(false);
  const [txError,      setTxError]      = useState<Error | null>(null);
  const { isLoading: txConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });
  const confirmedRef = useRef(false);
  const [isMockConfirmed, setIsMockConfirmed] = useState(false);
  // Stellar txs are already confirmed by the time submitIdentityProof() resolves
  // (it polls the Soroban RPC internally) — wagmi's useWaitForTransactionReceipt
  // above only understands EVM hashes, so it never resolves for a Stellar hash.
  const [stellarConfirmed, setStellarConfirmed] = useState(false);
  const { data: balanceData } = useBalance({ address });
  const isZeroBalance = balanceData ? balanceData.value === 0n : false;
  
  const boundAddress = useMemo(() => {
    if (!attestation?.walletAddressHi || !attestation?.walletAddressLo) return null;
    try {
      const hi = BigInt(attestation.walletAddressHi);
      const lo = BigInt(attestation.walletAddressLo);
      const addressShiftBits = BigInt(128);
      return '0x' + ((hi << addressShiftBits) | lo).toString(16).padStart(40, '0').toLowerCase();
    } catch (e) {
      console.error('Failed to reconstruct bound address', e);
      return null;
    }
  }, [attestation?.walletAddressHi, attestation?.walletAddressLo]);

  const isWalletMismatch = useMemo(() => {
    if (!address || !boundAddress) return false;
    return address.toLowerCase() !== boundAddress.toLowerCase();
  }, [address, boundAddress]);

  useEffect(() => {
    if (requestIdFromUrl) {
      persistVerifyRequestId(requestIdFromUrl);
      setResolvedRequestId(requestIdFromUrl);
      setSessionReady(true);
      return;
    }
    const stored = readVerifyRequestId();
    if (stored) {
      setResolvedRequestId(stored);
      router.replace(`/verify/success?requestId=${encodeURIComponent(stored)}`);
    }
    setSessionReady(true);
  }, [requestIdFromUrl, router]);

  useEffect(() => {
    if (!resolvedRequestId) return;
    const cached = readZkProof(resolvedRequestId);
    if (cached) {
      setZkProof(cached.proof);
      setZkPublicInputs(cached.publicInputs);
      autoProofRef.current = true;
    }
    const cachedAttestation = readVerifyAttestation<AttestationData>(resolvedRequestId);
    if (cachedAttestation) {
      setAttestation(cachedAttestation);
    }
  }, [resolvedRequestId]);

  useEffect(() => {
    if (!sessionReady) return;
    if (resolvedRequestId) return;
    if (!address) return;
    if (verifiedLoading) return;
    if (alreadyVerified) return;
    if (alreadyVerified === undefined) return;
    router.replace('/verify/identity-verification');
  }, [
    resolvedRequestId,
    sessionReady,
    alreadyVerified,
    verifiedLoading,
    address,
    router,
  ]);

  // Stellar: if the user lands on this page and is already verified on-chain (no
  // active session), redirect to the onboarding page immediately. Runs once per mount.
  useEffect(() => {
    if (chainKind !== 'stellar') return;
    if (!walletAddress || !walletResolved) return;
    if (resolvedRequestId || stellarConfirmed) return;
    if (stellarVerifiedCheckRef.current) return;
    stellarVerifiedCheckRef.current = true;
    isVerifiedOnStellar(walletAddress).then(verified => {
      if (verified) router.replace('/?select=1&toast=already_verified');
    }).catch(() => {});
  }, [chainKind, walletAddress, walletResolved, resolvedRequestId, stellarConfirmed, router]);

  // Eagerly warm up the ZK prover WASM so it's ready when the user clicks "Generate Proof"
  useEffect(() => {
    import('@/lib/zk/prover').then(({ warmupProver }) => warmupProver());
  }, []);

  useEffect(() => {
    if (!resolvedRequestId || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);

    let attempts = 0;
    const MAX = 150; // Poll for up to 5 minutes

    async function poll() {
      while (attempts < MAX) {
        try {
          const data = await api.get<AttestationData>(`/identity/attestation/${resolvedRequestId}`);
          setAttestation(data);
          persistVerifyAttestation(resolvedRequestId!, data);
          
          // Only stop polling if we have a final state (attested, verified, or failed)
          if (data.status === 'attested' || data.status === 'verified') {
            setLoading(false);
            return;
          }
          
          if (data.status === 'failed') {
            setError(data.status === 'failed' ? 'Verification failed on backend.' : null);
            setLoading(false);
            return;
          }

          // If we are in an intermediate state (oauth_complete, data_fetched), keep polling
          attempts++;
          if (attempts % 5 === 0) {
            console.log(`Polling attestation... attempt ${attempts}/${MAX}`);
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('Attestation fetch attempt', attempts, msg);
          // 404 means not ready yet — keep polling
          if (msg.includes('404') || msg.includes('not yet complete')) {
            attempts++;
            await new Promise(r => setTimeout(r, 2000));
          } else {
            setError(msg);
            setLoading(false);
            return;
          }
        }
      }
      setError('Attestation timed out. Please try again.');
      setLoading(false);
    }

    poll();
  }, [resolvedRequestId]);

  // Auto-generate ZK proof once attestation is ready and no proof exists yet.
  // EVM sessions gate on the ECDSA oracleSignature; Stellar sessions never get
  // one (verified on-chain via the Soroban UltraHonk verifier instead) and gate
  // on the Grumpkin Schnorr signature.
  const attestationSignature = chainKind === 'stellar'
    ? attestation?.oracleSchnorrSignature
    : attestation?.oracleSignature;
  useEffect(() => {
    if (zkProof || !attestationSignature || autoProofRef.current || alreadyVerified) return;
    autoProofRef.current = true;
    handleGenerateZk();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attestationSignature, zkProof, alreadyVerified]);

  useEffect(() => {
    if (!txConfirmed || !txHash || !resolvedRequestId || confirmedRef.current) return;
    confirmedRef.current = true;
    clearVerifySession(resolvedRequestId);
    api.post(`/identity/confirmed/${resolvedRequestId}`, { txHash, chain: 'evm' }).catch(() => {
      // Non-critical — the on-chain state is the source of truth
    });
  }, [txConfirmed, txHash, resolvedRequestId]);

  // The on-chain verifier (OracleAttestationVerifier) checks the oracle's ECDSA
  // signature via native ecrecover, so the signature IS the proof — no in-browser
  // ZK proving. This step just decodes the backend attestation into the
  // (proof, publicInputs) pair the contract expects.
  async function handleGenerateZk() {
    if (chainKind === 'stellar') {
      if (attestation?.status !== 'attested' && attestation?.status !== 'verified') {
        setError('GitHub attestation not ready. Please wait a moment and try again.');
        return;
      }
      if (!attestation.oracleSchnorrSignature) {
        setError('Schnorr oracle signature not available. Please try again.');
        return;
      }
      setGeneratingZk(true);
      setError(null);
      try {
        const { generateProof } = await import('@/lib/zk/prover');
        const sigHex = attestation.oracleSchnorrSignature.replace(/^0x/i, '');
        if (sigHex.length !== 128) throw new Error(`Schnorr signature must be 64 bytes, got ${sigHex.length / 2}`);
        const signature = Array.from({ length: 64 }, (_, i) =>
          parseInt(sigHex.slice(i * 2, i * 2 + 2), 16));
        // Convert any hex-prefixed field to a decimal string (assertFieldScalar requires decimal).
        const toDecStr = (v: string | number | null | undefined) =>
          v == null ? '0' : BigInt(v).toString();

        const result = await generateProof({
          signature,
          github_id:           toDecStr(attestation.githubId),
          github_created_year: toDecStr(attestation.githubCreatedYear),
          commits: attestation.commitCount           ?? 0,
          stars:   attestation.totalStars            ?? 0,
          events:  attestation.contributionEvents90d ?? 0,
          wallet_address_hi: toDecStr(attestation.walletAddressHi),
          wallet_address_lo: toDecStr(attestation.walletAddressLo),
        }, { oracleHash: 'keccak' });

        if (!result.success) {
          throw result.error instanceof Error ? result.error : new Error(String(result.error));
        }
        // Convert 32-byte hex field elements to decimal strings for display
        const decimalInputs = result.publicInputs.map(v => BigInt(v).toString());
        setZkProof(result.proof);
        setZkPublicInputs(decimalInputs);
        if (resolvedRequestId) persistZkProof(resolvedRequestId, result.proof, decimalInputs);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to generate Stellar ZK proof');
      } finally {
        setGeneratingZk(false);
      }
      return;
    }
    if (!attestation?.oracleSignature) {
      setError('Oracle attestation not ready. Please wait a moment and try again.');
      return;
    }
    if (!attestation.publicInputs || attestation.publicInputs.length < 5) {
      setError('Attestation is missing public inputs. Please restart verification.');
      return;
    }

    setGeneratingZk(true);
    setError(null);
    try {
      // oracleSignature is a 65-byte (r‖s‖v) hex string — convert to raw bytes.
      const clean = attestation.oracleSignature.startsWith('0x')
        ? attestation.oracleSignature.slice(2)
        : attestation.oracleSignature;
      if (clean.length !== 130) {
        throw new Error(`Oracle signature must be 65 bytes, got ${clean.length / 2}`);
      }
      const proofBytes = new Uint8Array(65);
      for (let i = 0; i < 65; i++) proofBytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);

      // publicInputs already arrive as 32-byte hex words from the backend.
      const publicInputs = attestation.publicInputs;

      setZkProof(proofBytes);
      setZkPublicInputs(publicInputs);
      if (resolvedRequestId) {
        persistZkProof(resolvedRequestId, proofBytes, publicInputs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to prepare attestation');
    } finally {
      setGeneratingZk(false);
    }
  }

  // Stellar path: submit the REAL Noir UltraHonk proof to the Soroban registry,
  // which verifies it on-chain (bb v0.87.0 keccak proof, Protocol 26 BN254 host
  // functions). Demo fixtures live in /public/stellar; in production the backend
  // serves a per-wallet bb-0.87.0 proof. See GrantOS-Soroban/DEPLOYED.md.
  async function handleSubmitOnStellar() {
    const githubLogin = attestation?.githubLogin ?? 'octocat';
    setTxPending(true);
    setTxError(null);
    try {
      const caller = await connectFreighter();

      // Cross-chain Sybil guardrail: a GitHub account verified on another chain
      // (e.g. EVM) cannot be re-verified on Stellar.
      if (attestation?.githubId != null) {
        try {
          const status = await api.get<{ verified: boolean; chain?: string; wallet?: string }>(
            `/identity/github/${attestation.githubId}/verified`,
          );
          if (status.verified && status.chain && status.chain !== 'stellar') {
            setTxError(
              new Error(
                `GitHub @${githubLogin} is already verified on the ${status.chain} chain. ` +
                  `A GitHub account can verify on only one chain.`,
              ),
            );
            return;
          }
        } catch {
          /* if the check is unreachable, fall through to the on-chain uniqueness guard */
        }
      }

      // zkProof and zkPublicInputs were already loaded from the fixture in
      // handleGenerateZk — reuse them rather than fetching again.
      if (!zkProof || !zkPublicInputs) {
        throw new Error('Proof not ready. Click "Generate ZK proof" first.');
      }
      const proof = zkProof;
      const publicInputs = new Uint8Array(zkPublicInputs.flatMap(v => {
        const hex = BigInt(v).toString(16).padStart(64, '0');
        return Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
      }));

      if (await isVerifiedOnStellar(caller)) {
        // Already registered — treat as success so the UI shows the verified state.
        setStellarConfirmed(true);
        return;
      }
      let hash: string;
      try {
        hash = await submitIdentityProof({ caller, proof, publicInputs, githubHandle: githubLogin });
      } catch (submitErr) {
        // Contract error #5 = AlreadyVerified — the wallet was registered in a prior
        // tx. Treat it as success rather than surfacing an error to the user.
        const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
        if (msg.includes('#5') || msg.toLowerCase().includes('alreadyverified')) {
          setStellarConfirmed(true);
          return;
        }
        throw submitErr;
      }
      setTxHash(hash as `0x${string}`);
      setStellarConfirmed(true);
      if (resolvedRequestId) {
        clearVerifySession(resolvedRequestId);
        api
          .post(`/identity/confirmed/${resolvedRequestId}`, { txHash: hash, chain: 'stellar' })
          .catch(() => {});
      }
    } catch (e) {
      setTxError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setTxPending(false);
    }
  }

  function handleSubmitOnChain() {
    if (chainKind === 'stellar') {
      void handleSubmitOnStellar();
      return;
    }
    if (!zkProof || !zkPublicInputs) return;
    const githubLogin = attestation?.githubLogin;

    if (!githubLogin) {
      setError('GitHub handle missing from attestation. Please restart verification.');
      return;
    }

    if (!IDENTITY_REGISTRY_ADDRESS || IDENTITY_REGISTRY_ADDRESS === '0x0000000000000000000000000000000000000000') {
      setError(
        'Identity Registry contract is not deployed. ' +
        'Set NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS in .env.local and restart the dev server.'
      );
      return;
    }

    // If no wallet connected, open connect modal
    if (!isConnected || !address) {
      openConnectModal?.();
      return;
    }

    // The proof is cryptographically bound to the wallet used during initVerification.
    // Warn if a different wallet is connected — the tx will revert on-chain.
    if (boundAddress && address) {
      if (address.toLowerCase() !== boundAddress.toLowerCase()) {
        setError(
          `This proof is bound to ${boundAddress.slice(0, 10)}…${boundAddress.slice(-6)}. ` +
          `You are currently connected with ${address.slice(0, 10)}…${address.slice(-6)}. ` +
          `Please switch to the original wallet or start a new verification.`
        );
        // We open account modal to let them disconnect/switch
        openAccountModal?.();
        return;
      }
    }

    const proofHex = ('0x' + Array.from(zkProof).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
    const pubInputsBytes32 = zkPublicInputs.map(v => {
      const hex = BigInt(v).toString(16).padStart(64, '0');
      return `0x${hex}` as `0x${string}`;
    });

    setTxPending(true);
    setTxError(null);
    switchChainAsync({ chainId: arbitrumSepolia.id })
      .then(() => getConnectorClient(wagmiConfig, { chainId: arbitrumSepolia.id }))
      .then(client =>
      writeContract(client, {
        address:      IDENTITY_REGISTRY_ADDRESS,
        abi:          IDENTITY_REGISTRY_ABI,
        functionName: 'verifyIdentity',
        args:         [proofHex, pubInputsBytes32, githubLogin],
        account:      client.account,
        chain:        arbitrumSepolia,
        gasPrice:     parseUnits('0.1', 9), // 0.1 Gwei
        gas:          BigInt(2000000),      // Generous 2M gas limit
      })
    ).then(hash => {
      setTxHash(hash);
    }).catch(e => {
      const raw = e instanceof Error ? e : new Error(String(e));
      const msg = raw.message || '';
      // Detect user-rejected transactions and show a friendly message
      if (
        msg.includes('User rejected') ||
        msg.includes('user rejected') ||
        msg.includes('User denied') ||
        msg.includes('rejected the request') ||
        msg.includes('ACTION_REJECTED')
      ) {
        setTxError(new Error('Transaction cancelled. Click "Submit proof on-chain" to try again.'));
      } else {
        // For other errors, extract just the meaningful part
        const short = msg.split('Request Arguments')[0]?.trim() || msg.slice(0, 200);
        setTxError(new Error(short));
      }
    }).finally(() => {
      setTxPending(false);
    });
  }

  const handleSimulateSuccess = () => {
    setIsMockConfirmed(true);
    const mockHash = '0x' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('') as `0x${string}`;
    setTxHash(mockHash);
    
    if (resolvedRequestId) {
      clearVerifySession(resolvedRequestId);
      api.post(`/identity/confirmed/${resolvedRequestId}`, { txHash: mockHash }).catch(() => {});
    }
  };

  const proofHex = useMemo(() => {
    if (!zkProof) return null;
    return '0x' + Array.from(zkProof).map(b => b.toString(16).padStart(2, '0')).join('');
  }, [zkProof]);

  const status = attestation?.status;
  const isOAuthDone = ['oauth_complete', 'data_fetched', 'attested', 'verified'].includes(status || '');
  const isDataDone  = ['data_fetched', 'attested', 'verified'].includes(status || '');
  const isOracleDone = ['attested', 'verified'].includes(status || '');

  const steps: { title: string; description: string; status: StepStatus }[] = [
    { 
      title: 'Wallet connected',     
      description: 'Registry verification complete',                                    
      status: 'complete' 
    },
    { 
      title: 'GitHub authenticated', 
      description: attestation?.githubLogin ? `@${attestation.githubLogin}` : 'Authenticated', 
      status: isOracleDone ? 'complete' : (status === 'oauth_complete' ? 'active' : isOAuthDone ? 'complete' : loading ? 'active' : 'pending') 
    },
    { 
      title: 'Data collected',       
      description: 'Contributor profile fetched',                                       
      status: isOracleDone ? 'complete' : (status === 'data_fetched' ? 'active' : isDataDone ? 'complete' : loading ? 'active' : 'pending') 
    },
    { 
      title: 'ZK proof generated',   
      description: zkProof ? 'Wallet-bound proof ready' : isOracleDone ? 'Ready to generate' : 'Pending',                   
      status: zkProof ? 'complete' : isOracleDone ? 'active' : 'pending' 
    },
    { 
      title: 'On-chain submission',  
      description: txConfirmed || alreadyVerified || isMockConfirmed ? 'ZK Verified badge issued' : 'Sign one transaction', 
      status: txConfirmed || alreadyVerified || isMockConfirmed ? 'complete' : zkProof ? 'active' : 'pending' 
    },
  ];

  const isFullyVerified = txConfirmed || alreadyVerified || isMockConfirmed || stellarConfirmed;

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!walletResolved || verifiedLoading) return;
    if (!alreadyVerified || generatingZk || txPending || txConfirming) return;
    if (isFullyVerified) return;
    router.replace('/?select=1&toast=already_verified');
  }, [
    alreadyVerified,
    generatingZk,
    isFullyVerified,
    router,
    txConfirming,
    txPending,
    verifiedLoading,
    walletResolved,
  ]);

  useEffect(() => {
    // Redirect to onboarding after verification. For Stellar, stellarConfirmed is
    // the source of truth — don't require resolvedRequestId (session may be cleared).
    const shouldRedirect = isFullyVerified && (resolvedRequestId || stellarConfirmed);
    if (!shouldRedirect) return;
    const timer = setTimeout(() => {
      router.replace('/?select=1&toast=identity_verified');
    }, 3000);
    return () => clearTimeout(timer);
  }, [isFullyVerified, resolvedRequestId, stellarConfirmed, router]);

  const hasVerifyProgress = Boolean(
    resolvedRequestId && (attestation || zkProof || loading || generatingZk),
  );
  const showConnectWall =
    !walletConnected && !walletReconnecting && !hasVerifyProgress && !loading;

  return (
    <div className="min-h-screen bg-white">
      <VerifyWalletReconnect />
      <header className="border-b border-slate-200 bg-white">
        <div className="flex w-full items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <Link href="/?select=1" className="flex items-center gap-3 transition hover:opacity-80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800">
              <span className="text-sm font-bold text-white">G</span>
            </div>
            <h1 className="text-base font-bold text-slate-900">GrantOS</h1>
            <span className="hidden rounded-lg border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500 sm:inline-flex">
              Sepolia
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {isFullyVerified && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> ZK Verified
              </span>
            )}
            <ConnectButton variant="header" />
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-start px-4 pb-6 pt-6 sm:px-6 sm:pt-8">
        <div className="mx-auto mt-0 flex min-h-[calc(100vh-96px)] w-full max-w-6xl flex-col rounded-3xl border-x border-b border-slate-200 bg-white shadow-sm lg:min-h-[680px]">
          <main className="flex flex-1 flex-col lg:flex-row">
            {/* Sidebar */}
            <aside className="w-full border-b border-slate-100 bg-slate-50/60 p-6 lg:w-[280px] lg:border-b-0 lg:border-r lg:p-8">
              <h2 className="text-sm font-bold tracking-tight text-slate-900">Verification flow</h2>
              <div className="mt-6 flex flex-col">
                {mounted && steps.map((step, idx) => (
                  <div key={idx} className="relative pb-7 last:pb-0">
                    {idx !== steps.length - 1 && (
                      <div className={`absolute left-[11px] top-6 h-full w-px ${step.status === 'complete' ? 'bg-blue-500' : 'bg-slate-200'}`} />
                    )}
                    <div className="relative z-10 flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">
                        {step.status === 'complete' ? (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full border border-emerald-500 bg-white">
                            <Check className="h-3.5 w-3.5 text-emerald-500" strokeWidth={3} />
                          </div>
                        ) : step.status === 'active' ? (
                          <div className="relative flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white">
                            <div className="animate-spin absolute inset-[3px] rounded-full border border-blue-500 border-r-transparent border-b-transparent" />
                            <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                          </div>
                        ) : (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-slate-200 bg-white text-xs font-semibold text-slate-400">
                            {idx + 1}
                          </div>
                        )}
                      </div>
                      <div className="pt-0.5">
                        <p className={`text-sm font-bold ${step.status === 'pending' ? 'text-slate-400' : 'text-slate-900'}`}>
                          {step.title}
                        </p>
                        {step.description && (
                          <p className={`mt-0.5 text-xs ${step.status === 'active' ? 'text-blue-500' : 'text-slate-500'}`}>
                            {step.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {attestation?.contributionTier && (
                <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Tier</p>
                  <p className="mt-1 text-xl font-bold text-slate-900">{attestation.contributionTier}</p>
                  <p className="mt-0.5 text-xs text-slate-400">Computed inside ZK — not revealed on-chain</p>
                </div>
              )}
            </aside>

            {/* Main content */}
            <section className="flex flex-1 flex-col gap-4 p-4 sm:p-6 lg:p-8">
              {error && (
                <div className="flex items-center justify-between rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  <span>{error}</span>
                  <button onClick={() => setError(null)} className="ml-3 shrink-0 text-red-400 hover:text-red-600 transition-colors">✕</button>
                </div>
              )}
              {txError && (
                <div className="flex items-center justify-between rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                  <span>{txError.message}</span>
                  <button onClick={() => setTxError(null)} className="ml-3 shrink-0 text-amber-400 hover:text-amber-600 transition-colors">✕</button>
                </div>
              )}

              {!walletConnected && (walletReconnecting || hasVerifyProgress) && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                  {walletReconnecting ? (
                    <p>Restoring your wallet session…</p>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p>
                        Reconnect the same wallet you used to start verification to submit on-chain.
                      </p>
                      <ConnectButton variant="black" />
                    </div>
                  )}
                </div>
              )}

              {loading || verifiedLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-sm text-slate-500">Loading…</div>
                </div>

              ) : showConnectWall ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <p className="text-sm text-slate-500 mb-4">Connect your wallet to continue verification.</p>
                    <ConnectButton variant="black" />
                  </div>
                </div>

              ) : isFullyVerified && onChainIdentity ? (
                // Already verified — show persistent badge
                <ZkBadge
                  githubLogin={onChainIdentity.githubHandle || attestation?.githubLogin || 'unknown'}
                  tier={onChainIdentity.tier}
                  createdYear={onChainIdentity.createdYear}
                />

              ) : isFullyVerified ? (
                // Tx confirmed but identity not yet readable (propagation delay)
                <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                  <p className="text-sm font-bold text-emerald-900">
                    ZK Verified ✓ — identity recorded on-chain.
                  </p>
                </div>

              ) : zkProof ? (
                // Proof ready — show submit button
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-blue-600" />
                    <div>
                      <p className="text-sm font-bold text-blue-900">ZK proof generated</p>
                      <p className="text-xs text-blue-700">
                        Bound to wallet <span className="font-bold">{formatAddress(boundAddress || undefined)}</span>.
                        <button onClick={openAccountModal} className="ml-1 font-bold underline hover:text-blue-800 transition-colors">Switch wallet?</button>
                      </p>
                    </div>
                  </div>

                  {isWalletMismatch && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start gap-3">
                        <Shield className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                        <div>
                          <p className="text-sm font-bold text-amber-900">Wallet mismatch detected</p>
                          <p className="text-xs text-amber-700 mt-1">
                            The ZK proof is cryptographically bound to the wallet that started the verification process.
                            To submit on-chain, please switch back to <span className="font-bold">{formatAddress(boundAddress || undefined)}</span>.
                          </p>
                          <div className="mt-3 flex gap-3">
                            <button
                              onClick={openAccountModal}
                              className="text-xs font-bold text-amber-900 underline hover:no-underline"
                            >
                              Switch account
                            </button>
                            <button
                              onClick={() => router.push('/verify/identity-verification')}
                              className="text-xs font-bold text-amber-900 underline hover:no-underline"
                            >
                              Start over with current wallet
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {zkPublicInputs && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs font-bold text-slate-500 mb-2">Public outputs</p>
                      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-xs text-slate-700">
                        <span className="font-medium">Tier:</span>         <span className="font-mono truncate">{zkPublicInputs[0]}</span>
                        <span className="font-medium">GitHub ID:</span>    <span className="font-mono truncate">{zkPublicInputs[1]}</span>
                        <span className="font-medium">Created year:</span> <span className="font-mono truncate">{zkPublicInputs[2]}</span>
                        <span className="font-medium">Wallet (hi):</span>  <span className="font-mono truncate">{zkPublicInputs[3]}</span>
                        <span className="font-medium">Wallet (lo):</span>  <span className="font-mono truncate">{zkPublicInputs[4]}</span>
                      </div>
                    </div>
                  )}

                  {proofHex && (
                    <div className="rounded-xl border border-slate-200 bg-slate-900 p-4">
                      <p className="text-xs font-bold text-slate-400 mb-2">Proof bytes (hex)</p>
                      <div className="overflow-y-auto break-all font-mono text-[10px] text-emerald-400 leading-5 max-h-32">
                        {proofHex}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleSubmitOnChain}
                    disabled={txPending || txConfirming || isWalletMismatch}
                    className={`w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all ${
                      txPending || txConfirming || isWalletMismatch
                        ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                        : 'bg-slate-900 text-white hover:bg-black'
                    }`}
                  >
                    {txPending    ? 'Waiting for wallet…' :
                     txConfirming ? 'Confirming transaction…' :
                     isWalletMismatch ? 'Switch wallet to submit' :
                     !walletConnected ? 'Connect wallet to submit →' :
                                    'Submit proof on-chain →'}
                  </button>

                  {isZeroBalance && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                        <div>
                          <p className="text-sm font-bold text-amber-900">Insufficient Sepolia ETH for Gas</p>
                          <p className="text-xs text-amber-700 mt-1">
                            You need a small amount of Arbitrum Sepolia ETH to cover the gas fee for on-chain submission. 
                            If you don't have Sepolia ETH, you can request some from a faucet or bypass the on-chain requirement for testing.
                          </p>
                          <div className="mt-3 flex gap-3 flex-wrap">
                            <a
                              href="https://faucet.quicknode.com/drip"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-bold text-amber-900 underline hover:no-underline"
                            >
                              Get Sepolia ETH (Faucet)
                            </a>
                            <button
                              onClick={handleSimulateSuccess}
                              className="text-xs font-bold text-amber-900 underline hover:no-underline bg-amber-200/50 hover:bg-amber-200 px-2 py-0.5 rounded transition"
                            >
                              Simulate On-chain Success (Bypass)
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setZkProof(null);
                      setZkPublicInputs(null);
                      if (resolvedRequestId) {
                        clearZkProofOnly(resolvedRequestId);
                        autoProofRef.current = false;
                      }
                    }}
                    className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-slate-500 hover:text-slate-700"
                  >
                    Regenerate proof
                  </button>
                </div>

              ) : (
                // Step 1: generate ZK proof
                <div className="flex flex-1 items-center justify-center">
                  <div className="w-full max-w-[420px] rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50">
                        <Fingerprint className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-900">Generate ZK proof</h2>
                        <p className="text-xs text-slate-500">Runs in your browser — raw data never leaves the oracle.</p>
                      </div>
                    </div>

                    {attestation?.githubLogin && (
                      <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                        <GithubIcon className="h-4 w-4 text-slate-600" />
                        <span className="text-sm font-medium text-slate-700">@{attestation.githubLogin}</span>
                        <span className="ml-auto text-xs text-slate-400">{attestation.publicRepos} repos</span>
                      </div>
                    )}

                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <Shield className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                      <span>
                        Proof is wallet-bound to <span className="font-mono font-bold">{formatAddress(walletAddress ?? undefined)}</span>.
                        It cannot be replayed by another wallet.
                      </span>
                    </div>

                    <button
                      onClick={handleGenerateZk}
                      disabled={generatingZk || !isOracleDone}
                      className={`w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all ${
                        isOracleDone && !generatingZk
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'cursor-not-allowed bg-slate-100 text-slate-400'
                      }`}
                    >
                      {generatingZk ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                          </svg>
                          Generating proof…
                        </span>
                      ) : !isOracleDone ? (
                        'Waiting for oracle…'
                      ) : (
                        'Generate ZK proof'
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-slate-500 text-sm">Loading…</div>}>
      <SuccessContent />
    </Suspense>
  );
}
