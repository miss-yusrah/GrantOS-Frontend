// lib/zk/prover.ts
//
// Changes from v1:
//   C3 FIX: wallet_address_hi / wallet_address_lo added as public inputs to
//     the circuit — the proof is now cryptographically bound to the initiating wallet.
//   M1 FIX: circuit.json integrity verified against a SHA-256 hash pinned at
//     build time via NEXT_PUBLIC_ZK_CIRCUIT_HASH env var before proof generation.
//   STABILITY FIX: Dynamic imports for Barretenberg to avoid Turbopack/Next.js init issues.
//   TIMEOUT FIX: Increased timeout and added detailed init logging.

export interface ProveInputs {
  /** 64 bytes: Grumpkin Schnorr signature from the oracle, `s` (32) || `e` (32),
   *  big-endian. The circuit takes each scalar as 128-bit lo/hi limbs. */
  signature:          number[];
  github_id:          string;
  github_created_year: string;
  commits:            number;
  stars:              number;
  events:             number;
  wallet_address_hi:  string;
  wallet_address_lo:  string;
}

import { UltraHonkBackend } from '../../node_modules/@aztec/bb.js/dest/browser/index.js';
import { Noir } from '@noir-lang/noir_js';

// Singleton backend — reuse across calls to avoid re-initialising WASM
let backendPromise: Promise<any> | null = null;
let cachedBytecode: string | null = null;

async function getBackend(bytecode: string) {
  // Invalidate if circuit changed
  if (cachedBytecode !== bytecode) {
    backendPromise = null;
    cachedBytecode = bytecode;
  }
  if (!backendPromise) {
    backendPromise = (async () => {
      try {
        // bb.js 0.87.0 API: UltraHonkBackend takes BackendOptions directly and
        // lazily constructs its own Barretenberg worker on first use — no more
        // separate Barretenberg.new()/BackendType (both removed in this version;
        // pinned to 0.87.0 to match the bb CLI version the on-chain Soroban
        // verifier's VK was built with, see ProveOptions.oracleHash below).
        // Multi-threaded WASM needs SharedArrayBuffer (unavailable e.g. behind a
        // wallet popup's COOP policy); fall back to a single thread without it.
        const hasSAB = typeof SharedArrayBuffer !== 'undefined';
        const threads = hasSAB
          ? Math.min(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1, 4)
          : 1;
        console.log(`[ZK] Initializing UltraHonkBackend (${threads} thread(s), SAB=${hasSAB})...`);

        return new UltraHonkBackend(bytecode, { threads });
      } catch (e) {
        backendPromise = null;
        throw e;
      }
    })();
  }
  return backendPromise;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function assertFixedBytes(name: string, value: number[], expectedLength: number): number[] {
  if (value.length !== expectedLength) {
    throw new Error(`${name} must be exactly ${expectedLength} bytes, got ${value.length}`);
  }
  return value.map((byte, i) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`${name}[${i}] is not a valid byte (got ${byte})`);
    }
    return byte;
  });
}

function assertU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} must be an unsigned 32-bit integer (got ${value})`);
  }
  return value;
}

function assertFieldScalar(name: string, value: string | number | bigint): string {
  const text = value.toString().trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer string`);
  return text;
}

// ── Grumpkin scalar decomposition ─────────────────────────────────────────────
//
// The v3 circuit (Schnorr over Grumpkin, schnorr lib v0.4.0) takes each
// signature scalar as an `EmbeddedCurveScalar { lo, hi }` pair of 128-bit
// limbs: scalar = hi * 2^128 + lo.

const GRUMPKIN_SCALAR_MODULUS = BigInt(
  '0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47'
);
const MASK_128 = (BigInt(1) << BigInt(128)) - BigInt(1);

function bytesToBigInt(bytes: number[]): bigint {
  return BigInt('0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join(''));
}

function splitGrumpkinScalar(name: string, bytes32: number[]): { lo: string; hi: string } {
  const value = bytesToBigInt(bytes32);
  if (value <= BigInt(0)) throw new Error(`${name} must be a non-zero scalar`);
  if (value >= GRUMPKIN_SCALAR_MODULUS) throw new Error(`${name} is out of Grumpkin scalar range`);
  return {
    lo: (value & MASK_128).toString(),
    hi: (value >> BigInt(128)).toString(),
  };
}

// ── Circuit artifact integrity check ─────────────────────────────────

async function fetchAndVerifyCircuit(): Promise<{ bytecode: string }> {
  console.log('[ZK] Fetching circuit.json...');
  const response = await fetch(`/circuit.json?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to fetch circuit.json: ${response.status}`);
  const circuit = (await response.json()) as { bytecode: string };
  if (!circuit.bytecode) throw new Error('circuit.json missing bytecode field');

  const expectedHash = process.env.NEXT_PUBLIC_ZK_CIRCUIT_HASH;
  if (expectedHash) {
    const encoder   = new TextEncoder();
    const data      = encoder.encode(circuit.bytecode);
    const hashBuf   = await crypto.subtle.digest('SHA-256', data);
    const hashHex   = '0x' + Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (hashHex !== expectedHash.toLowerCase()) {
      throw new Error(`Circuit artifact integrity check FAILED.`);
    }
    console.log('[ZK] Circuit artifact integrity verified ✓');
  }
  return circuit;
}

// ── Main proof generation ─────────────────────────────────────────────────────

/** Call this early (e.g. on page mount) to warm up the WASM backend so proof
 *  generation feels instant when the user clicks the button. */
export async function warmupProver(): Promise<void> {
  try {
    const circuit = await fetchAndVerifyCircuit();
    await getBackend(circuit.bytecode);
  } catch {
    // Silently ignore — warmup is best-effort
  }
}

export interface ProveOptions {
  /** Oracle hash flavor for the UltraHonk transcript.
   *  - 'poseidon' (default): the original EVM/archive flavor.
   *  - 'keccak': required by the Stellar Soroban UltraHonk verifier
   *    (bb `--oracle_hash keccak`). NOTE: the proving toolchain version must
   *    match the on-chain VK's bb version, otherwise the proof will not verify.
   *    See GrantOS-Soroban/README.md. */
  oracleHash?: 'poseidon' | 'keccak';
}

export async function generateProof(inputs: ProveInputs, options: ProveOptions = {}): Promise<
  | { success: true;  proof: Uint8Array; publicInputs: string[] }
  | { success: false; error: unknown }
> {
  const startTime = Date.now();
  try {
    const circuit = await fetchAndVerifyCircuit();

    console.log('[ZK] Initializing backend...');
    const backend = await getBackend(circuit.bytecode);

    console.log('[ZK] Creating Noir instance...');
    const noir = new Noir(circuit as any);

    const rawSignature = assertFixedBytes('signature', Array.from(inputs.signature), 64);
    const sigS = splitGrumpkinScalar('sig_s', rawSignature.slice(0, 32));
    const sigE = splitGrumpkinScalar('sig_e', rawSignature.slice(32, 64));

    const witnessInputs = {
      sig_s_lo:             sigS.lo,
      sig_s_hi:             sigS.hi,
      sig_e_lo:             sigE.lo,
      sig_e_hi:             sigE.hi,
      commits:              assertU32('commits', inputs.commits),
      stars:                assertU32('stars',   inputs.stars),
      events:               assertU32('events',  inputs.events),
      github_id:            assertFieldScalar('github_id',            inputs.github_id),
      github_created_year:  assertFieldScalar('github_created_year',  inputs.github_created_year),
      wallet_address_hi:    assertFieldScalar('wallet_address_hi',    inputs.wallet_address_hi),
      wallet_address_lo:    assertFieldScalar('wallet_address_lo',    inputs.wallet_address_lo),
    };

    console.log('[ZK] Generating witness...');
    const { witness } = await noir.execute(witnessInputs);

    const useKeccak = options.oracleHash === 'keccak';
    console.log(`[ZK] Generating proof (UltraHonk, oracle_hash=${useKeccak ? 'keccak' : 'poseidon'})...`);
    const proof = await backend.generateProof(witness, useKeccak ? { keccak: true } : undefined);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ZK] Proof generated successfully in ${duration}s ✓`);
    return { success: true, proof: proof.proof, publicInputs: proof.publicInputs };
  } catch (error) {
    console.error('[ZK] Proof generation failed:', error);
    return { success: false, error };
  }
}
