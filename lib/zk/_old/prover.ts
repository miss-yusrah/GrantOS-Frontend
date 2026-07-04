import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

export interface ProveInputs {
  signature: number[];
  message_hash: number[];
  github_id: string;
  github_created_year: string;
  commits: number;
  stars: number;
  events: number;
}

function assertFixedBytes(name: string, value: number[], expectedLength: number): number[] {
  if (value.length !== expectedLength) {
    throw new Error(`${name} must be exactly ${expectedLength} bytes, received ${value.length}`);
  }

  const normalized = value.map((byte, index) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`${name}[${index}] is not a valid byte`);
    }
    return byte;
  });

  return normalized;
}

function assertU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

function assertFieldScalar(name: string, value: string | number | bigint): string {
  const text = value.toString().trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return text;
}

const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);
const SECP256K1_HALF_N = SECP256K1_N / BigInt(2);

function bytesToBigInt(bytes: number[]): bigint {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return BigInt(`0x${hex}`);
}

function bigIntTo32Bytes(value: bigint): number[] {
  const hex = value.toString(16).padStart(64, '0');
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function sanitizeSignatureForNoir(signature: number[]): number[] {
  const normalized = [...signature];

  let r = bytesToBigInt(normalized.slice(0, 32));
  let s = bytesToBigInt(normalized.slice(32, 64));

  // Recover from compact-2098 packed signatures where yParity sits in s's top bit.
  if (s >= SECP256K1_N && (normalized[32] & 0x80) !== 0) {
    normalized[32] &= 0x7f;
    s = bytesToBigInt(normalized.slice(32, 64));
  }

  if (r <= BigInt(0) || r >= SECP256K1_N) {
    throw new Error('signature r is out of secp256k1 scalar range');
  }
  if (s <= BigInt(0) || s >= SECP256K1_N) {
    throw new Error('signature s is out of secp256k1 scalar range');
  }

  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    normalized.splice(32, 32, ...bigIntTo32Bytes(s));
  }

  r = bytesToBigInt(normalized.slice(0, 32));
  s = bytesToBigInt(normalized.slice(32, 64));
  if (
    r <= BigInt(0) ||
    r >= SECP256K1_N ||
    s <= BigInt(0) ||
    s > SECP256K1_HALF_N
  ) {
    throw new Error('signature could not be normalized to Noir-compatible low-s form');
  }

  return normalized;
}

export async function generateProof(inputs: ProveInputs) {
  try {
    console.log('Fetching circuit artifact...');
    const response = await fetch(`/circuit.json?v=${Date.now()}`, { cache: 'no-store' });
    const circuit = await response.json();

    console.log('Creating UltraHonkBackend and Noir instances...');
    const backend = new UltraHonkBackend(circuit.bytecode);
    const noir = new Noir(circuit);

    console.log('Executing circuit (generating witness)...');
    const rawSignature = assertFixedBytes('signature', Array.from(inputs.signature), 64);
    const rawMessageHash = assertFixedBytes('message_hash', Array.from(inputs.message_hash), 32);
    const signature = sanitizeSignatureForNoir(rawSignature);

    const baseInputs = {
      github_id: assertFieldScalar('github_id', inputs.github_id),
      github_created_year: assertFieldScalar('github_created_year', inputs.github_created_year),
      commits: assertU32('commits', inputs.commits),
      stars: assertU32('stars', inputs.stars),
      events: assertU32('events', inputs.events),
    };

    // The backend already signs and low-s normalizes exactly for this circuit.
    // Avoid trying speculative signature encodings here; malformed variants can
    // trigger hard asserts in the secp256k1 gadget.
    const witnessInputs = {
      ...baseInputs,
      signature,
      message_hash: rawMessageHash,
    };

    const { witness } = await noir.execute(witnessInputs);

    console.log('Generating proof (this may take a minute)...');
    const proof = await backend.generateProof(witness);
    console.log('Proof generated successfully.');

    console.log('ZK Proof generated successfully!');
    return {
      success: true,
      proof: proof.proof,
      publicInputs: proof.publicInputs,
    };
  } catch (error) {
    console.error('ZK proof generation failed:', error);
    return { success: false, error };
  }
}
