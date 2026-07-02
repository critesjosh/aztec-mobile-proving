/**
 * Flow 2: a private token transfer on Aztec testnet, ClientIVC proof produced
 * by THIS REPO'S native prover, fees via SponsoredFPC.
 *
 * Deploys a Token, mints privately to the sender, then does a private
 * `transfer` to a recipient. Each tx's proof is produced natively.
 *
 * Prereq: a deployed+funded account (run deploy_account first, or set
 * ACCOUNT_* env for an already-deployed account).
 *
 * Run:  BRIDGE=host npm run transfer   |   BRIDGE=adb npm run transfer
 */
import 'dotenv/config';
import { Fr } from '@aztec/aztec.js/fields';
import { createLogger } from '@aztec/foundation/log';

import { Bench } from './bench.js';
import { bridgeFromEnv, connectWithNativeProver, testnetConfigFromEnv } from './testnet.js';

const log = createLogger('mobile-proving:transfer');
const say = (s: string) => log.info(s);

async function main() {
  const cfg = testnetConfigFromEnv();
  const bridge = await bridgeFromEnv();
  say(`Prover bridge: ${bridge.location}`);

  const bench = new Bench();
  const { wallet, paymentMethod, metrics } = await connectWithNativeProver(cfg, bridge);
  bench.mark('connect+pxe');

  const secret = Fr.fromString(reqEnv('ACCOUNT_SECRET'));
  const salt = Fr.fromString(reqEnv('ACCOUNT_SALT'));
  const signingKey = Buffer.from(reqEnv('ACCOUNT_SIGNING_KEY').replace(/^0x/, ''), 'hex');
  const account = await wallet.createECDSARAccount(secret, salt, signingKey, 'testnet');
  const from = account.address;
  say(`Sender: ${from.toString()}`);
  bench.mark('load-account');

  const wait = { timeout: 600, interval: 5 } as const;
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  say('Deploying Token (native prover)...');
  const { contract: token } = await TokenContract.deploy(wallet, from, 'MobileToken', 'MTK', 18).send({
    from,
    fee: { paymentMethod },
    wait,
  });
  say(`Token: ${token.address.toString()}`);
  bench.mark('deploy-token');

  const mintAmount = 1000n;
  say('Minting privately to sender (native prover)...');
  await token.methods.mint_to_private(from, mintAmount).send({ from, fee: { paymentMethod }, wait });
  bench.mark('mint');

  const recipient = process.env.RECIPIENT_ADDRESS
    ? (await import('@aztec/aztec.js/addresses')).AztecAddress.fromStringUnsafe(process.env.RECIPIENT_ADDRESS)
    : from; // self-transfer if no recipient given
  say(`Private transfer of 100 to ${recipient.toString()} (native prover)...`);
  const { receipt } = await token.methods
    .transfer(recipient, 100n)
    .send({ from, fee: { paymentMethod }, wait });
  const txHash = receipt.txHash;
  bench.mark('prove+submit+mined');

  say(`Status: ${receipt.status}`);
  say(`Transfer tx: ${txHash.toString()}`);
  say(`Explorer: https://testnet.aztecscan.xyz/tx/${txHash.toString()}`);
  if (metrics.last) {
    const n = metrics.last.native;
    say(`Native proof (transfer): verified=${n.verified} prove=${n.proveMs}ms peakRss=${n.peakRssMb}MB circuits=${n.numCircuits}`);
  }
  bench.print(say);
  say(JSON.stringify({ txHash: txHash.toString(), status: receipt.status, bench: bench.toJSON(), native: metrics.last?.native }));

  await wallet.stop();
}

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    throw new Error(`${k} not set (env only). See .env.example`);
  }
  return v;
}

main().catch((e) => {
  log.error(`FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
