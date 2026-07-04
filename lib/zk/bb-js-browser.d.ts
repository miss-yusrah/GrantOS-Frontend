// bb.js 0.87.0 ships type declarations only under dest/node(-cjs)/, not
// dest/browser/ — but we import the raw dest/browser/index.js path directly
// (see prover.ts) so webpack always bundles the browser build, regardless of
// which "exports" condition it'd otherwise pick for the server vs. client
// compilation. Re-export the real (node-dist) types for that same shape.
declare module '*/bb.js/dest/browser/index.js' {
  export * from '@aztec/bb.js';
}
