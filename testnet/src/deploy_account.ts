/**
 * Flow 1: deploy a fresh ECDSA-R1 account on Aztec testnet, paying fees via the
 * SponsoredFPC, with the ClientIVC proof produced by THIS REPO'S native prover.
 *
 * Run: (see testnet/README + .env)
 *   BRIDGE=host  npm run deploy-account     # prove on host CPU (native lib)
 *   BRIDGE=adb   npm run deploy-account     # prove on the phone via adb
 */
import 'dotenv/config';
import { Fr } from '@aztec/aztec.js/fields';
import { NO_FROM } from '@aztec/aztec.js/account';
import { createLogger } from '@aztec/foundation/log';

import { Bench } from './bench.js';
import { bridgeFromEnv, connectWithNativeProver, testnetConfigFromEnv } from './testnet.js';

const log = createLogger('mobile-proving:deploy-account');
const say = (s: string) => log.info(s);

async function main() {
  const cfg = testnetConfigFromEnv();
  const bridge = await bridgeFromEnv();
  say(`Prover bridge: ${bridge.location}`);

  const bench = new Bench();
  const { wallet, paymentMethod, metrics } = await connectWithNativeProver(cfg, bridge);
  bench.mark('connect+pxe');

  // Fresh account. The signing key comes ONLY from env (never committed).
  const secret = process.env.ACCOUNT_SECRET ? Fr.fromString(process.env.ACCOUNT_SECRET) : Fr.random();
  const salt = process.env.ACCOUNT_SALT ? Fr.fromString(process.env.ACCOUNT_SALT) : Fr.random();
  const signingKeyHex = process.env.ACCOUNT_SIGNING_KEY;
  if (!signingKeyHex) {
    throw new Error('ACCOUNT_SIGNING_KEY not set (32-byte hex, env only). See .env.example');
  }
  const signingKey = Buffer.from(signingKeyHex.replace(/^0x/, ''), 'hex');

  const account = await wallet.createECDSARAccount(secret, salt, signingKey, 'testnet');
  say(`Account address: ${account.address.toString()}`);
  bench.mark('create-account');

  const deployMethod = await account.getDeployMethod();
  say('Deploying account (native prover produces the ClientIVC proof)...');
  // Self-deployment (from: AztecAddress.ZERO) — the account deploys itself, so
  // the entrypoint doesn't read a signing-key note that doesn't exist yet. This
  // matches the canonical testnet wallet-extension deploy flow. EmbeddedWallet
  // auto-estimates gas. send() proves (native), submits, waits for mining.
  // Publish the account contract class in this same tx (the ECDSA-R class may
  // not be published on this testnet instance). skipClassPublication:false.
  const { receipt } = await deployMethod.send({
    from: NO_FROM,
    skipClassPublication: false,
    skipInstancePublication: false,
    skipInitialization: false,
    fee: { paymentMethod },
    wait: { timeout: 1200, interval: 5 },
  });
  const txHash = receipt.txHash;
  bench.mark('prove+submit+mined');

  say(`Status: ${receipt.status}`);
  say(`Tx: ${txHash.toString()}`);
  say(`Explorer: https://testnet.aztecscan.xyz/tx/${txHash.toString()}`);
  if (metrics.last) {
    const n = metrics.last.native;
    say(`Native proof: verified=${n.verified} prove=${n.proveMs}ms peakRss=${n.peakRssMb}MB circuits=${n.numCircuits}`);
  }
  bench.print(say);
  say(JSON.stringify({ txHash: txHash.toString(), status: receipt.status, bench: bench.toJSON(), native: metrics.last?.native }));

  await wallet.stop();
}

main().catch((e) => {
  log.error(`FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
