/**
 * Wallet screens. Focused MVP UI: Onboarding, Wallet (home), Send, AMM,
 * Activity, plus a Debug drawer with logs/memory/prove metrics.
 */
import React, {useState} from 'react';
import {Linking, ScrollView, Text, TouchableOpacity, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {EXPLORER_TX_BASE} from '../config';
import type {WalletController, WalletSnapshot} from '../wallet/WalletController';
import {Body, Busy, Button, Card, ErrorBanner, H1, Input, Label, Mono, short, StatusPill} from './components';
import {colors, spacing} from './theme';

interface ScreenProps {
  s: WalletSnapshot;
  c: WalletController;
}

// ---------------------------------------------------------------------------

export function OnboardingScreen({s, c}: ScreenProps) {
  const [alias, setAlias] = useState('my-account');
  return (
    <ScrollView contentContainerStyle={{padding: spacing.l}}>
      <H1>Welcome to Aztec</H1>
      <Card>
        <Body>
          Create a private account on Aztec testnet. Keys are generated with the
          platform secure RNG and stored sealed by the Android Keystore — they
          never leave this device.
        </Body>
        <View style={{height: spacing.m}} />
        <Label>Account name</Label>
        <Input value={alias} onChangeText={setAlias} placeholder="my-account" />
        {s.flowError ? <ErrorBanner message={s.flowError} /> : null}
        {s.busy ? (
          <Busy label={s.busy} />
        ) : (
          <Button
            title="Create account"
            onPress={() => void c.onboardCreateAccount(alias.trim() || 'my-account')}
          />
        )}
        <View style={{height: spacing.s}} />
        <Label>
          Deployment proves the account circuits on this device (~seconds) and
          submits to testnet with sponsored fees.
        </Label>
      </Card>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

export function HomeScreen({s, c}: ScreenProps) {
  const a = s.account;
  const deployTx = s.txs.find(t => t.kind === 'account-deploy');
  return (
    <ScrollView contentContainerStyle={{padding: spacing.l}}>
      <H1>Wallet</H1>
      {s.flowError ? <ErrorBanner message={s.flowError} /> : null}
      <Card>
        <Label>Account · {a?.alias}</Label>
        <TouchableOpacity
          onPress={() => a && Clipboard.setString(a.address)}
          accessibilityLabel="Copy address">
          <Mono>{a?.address}</Mono>
          <Label>tap to copy</Label>
        </TouchableOpacity>
        <View style={{height: spacing.s}} />
        {a?.deployed ? (
          <StatusPill status="deployed" />
        ) : deployTx ? (
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
            <StatusPill status={deployTx.status} />
            <Label>deployment {deployTx.status} — balances unlock once mined</Label>
          </View>
        ) : (
          <StatusPill status="not deployed" />
        )}
      </Card>

      <Card>
        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
          <Label>Tokens</Label>
          <Button title="Refresh" kind="secondary" onPress={() => void c.refreshBalances()} />
        </View>
        {s.tokens.length === 0 ? (
          <Body>No tokens yet. Deploy a test token to try private transfers.</Body>
        ) : (
          s.tokens.map(t => (
            <View
              key={t.address}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingVertical: spacing.s,
                borderBottomColor: colors.border,
                borderBottomWidth: 1,
              }}>
              <View>
                <Body>
                  {t.name} ({t.symbol})
                </Body>
                <Mono dim>{short(t.address)}</Mono>
              </View>
              <Body>{s.balances[t.address] ?? '—'}</Body>
            </View>
          ))
        )}
        <View style={{height: spacing.m}} />
        {s.busy ? (
          <Busy label={s.busy} />
        ) : (
          <TokenActions s={s} c={c} />
        )}
      </Card>
    </ScrollView>
  );
}

function TokenActions({s, c}: ScreenProps) {
  const [mintAmount, setMintAmount] = useState('1000');
  const nextIdx = s.tokens.length;
  const disabled = !s.account?.deployed;
  return (
    <View style={{gap: spacing.s}}>
      {!s.account?.deployed ? (
        <Label>Waiting for account deployment to mine…</Label>
      ) : null}
      <Button
        title={`Deploy test token ${nextIdx === 0 ? 'A' : nextIdx === 1 ? 'B' : String(nextIdx)}`}
        kind="secondary"
        disabled={disabled}
        onPress={() =>
          void c.deployToken(
            `TestToken${nextIdx === 0 ? 'A' : nextIdx === 1 ? 'B' : nextIdx}`,
            nextIdx === 0 ? 'TTA' : nextIdx === 1 ? 'TTB' : `TT${nextIdx}`,
          )
        }
      />
      {s.tokens.length > 0 ? (
        <View style={{gap: spacing.s}}>
          <Label>Mint to self</Label>
          <Input value={mintAmount} onChangeText={setMintAmount} keyboardType="numeric" />
          {s.tokens.map(t => (
            <Button
              key={t.address}
              title={`Mint ${t.symbol} privately`}
              kind="secondary"
              disabled={disabled}
              onPress={() => void c.mint(t.address, mintAmount)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------

export function SendScreen({s, c}: ScreenProps) {
  const [token, setToken] = useState(s.tokens[0]?.address ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('100');
  const [sender, setSender] = useState('');
  const selected = s.tokens.find(t => t.address === (token || s.tokens[0]?.address));
  return (
    <ScrollView contentContainerStyle={{padding: spacing.l}}>
      <H1>Send privately</H1>
      {s.flowError ? <ErrorBanner message={s.flowError} /> : null}
      <Card>
        <Label>Token</Label>
        {s.tokens.map(t => (
          <TouchableOpacity key={t.address} onPress={() => setToken(t.address)}>
            <View style={{flexDirection: 'row', gap: 8, paddingVertical: 4}}>
              <Text style={{color: selected?.address === t.address ? colors.accent : colors.dim}}>
                {selected?.address === t.address ? '●' : '○'}
              </Text>
              <Body>
                {t.symbol} — {s.balances[t.address] ?? '?'}
              </Body>
            </View>
          </TouchableOpacity>
        ))}
        <View style={{height: spacing.s}} />
        <Label>Recipient address (0x…)</Label>
        <Input value={to} onChangeText={setTo} placeholder="0x…" />
        <Label>Amount</Label>
        <Input value={amount} onChangeText={setAmount} keyboardType="numeric" />
        {s.busy ? (
          <Busy label={s.busy} />
        ) : (
          <Button
            title="Send"
            disabled={!selected || !to.startsWith('0x') || !s.account?.deployed}
            onPress={() => selected && void c.transfer(selected.address, to.trim(), amount)}
          />
        )}
      </Card>
      <Card>
        <Label>Receiving? Register the sender so your PXE can discover their notes.</Label>
        <Input value={sender} onChangeText={setSender} placeholder="sender 0x…" />
        <Button
          title="Register sender"
          kind="secondary"
          disabled={!sender.startsWith('0x') || !!s.busy}
          onPress={() => void c.registerSender(sender.trim())}
        />
      </Card>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

export function AmmScreen({s, c}: ScreenProps) {
  const [amount0, setAmount0] = useState('100');
  const [amount1, setAmount1] = useState('100');
  const amm = s.amm;
  const haveTwoTokens = s.tokens.length >= 2;
  return (
    <ScrollView contentContainerStyle={{padding: spacing.l}}>
      <H1>AMM · add liquidity</H1>
      {s.flowError ? <ErrorBanner message={s.flowError} /> : null}
      <Card>
        <Label>
          The heaviest supported flow (14 circuits proven on-device). Swap is not
          in this MVP. Setup deploys an LP token + AMM over your first two
          tokens, then authorizes the AMM to mint LP.
        </Label>
        <View style={{height: spacing.s}} />
        {!haveTwoTokens ? (
          <Body>Deploy two test tokens on the Wallet tab first (and mint both).</Body>
        ) : !amm || amm.step !== 'ready' ? (
          <View style={{gap: spacing.s}}>
            <Body>
              Step: {amm?.step ?? 'not started'} — token0 {short(s.tokens[0].address)}, token1{' '}
              {short(s.tokens[1].address)}
            </Body>
            {amm ? (
              <Label>
                Each step confirms on testnet before the next unlocks — tap
                continue again after the pending tx mines (see Activity).
              </Label>
            ) : null}
            {s.busy ? (
              <Busy label={s.busy} />
            ) : (
              <Button
                title={
                  !amm
                    ? 'Set up AMM (deploy LP token + AMM)'
                    : amm.step === 'deploying'
                      ? 'Continue setup (needs confirmed deploys)'
                      : 'Continue setup (set minter)'
                }
                onPress={() => void c.ammSetup(s.tokens[0].address, s.tokens[1].address)}
              />
            )}
          </View>
        ) : (
          <View style={{gap: spacing.s}}>
            <Label>AMM</Label>
            <Mono>{short(amm.amm)}</Mono>
            <Label>Amount token0 / token1 (needs private balance in both)</Label>
            <Input value={amount0} onChangeText={setAmount0} keyboardType="numeric" />
            <Input value={amount1} onChangeText={setAmount1} keyboardType="numeric" />
            {s.busy ? (
              <Busy label={s.busy} />
            ) : (
              <Button title="Add liquidity" onPress={() => void c.ammAddLiquidity(amount0, amount1)} />
            )}
          </View>
        )}
      </Card>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

export function ActivityScreen({s}: ScreenProps) {
  return (
    <ScrollView contentContainerStyle={{padding: spacing.l}}>
      <H1>Activity</H1>
      {s.txs.length === 0 ? (
        <Card>
          <Body>No transactions yet.</Body>
        </Card>
      ) : (
        s.txs.map(tx => (
          <Card key={tx.txHash}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
              <Body>{tx.label}</Body>
              <StatusPill status={tx.executionResult === 'reverted' ? 'reverted' : tx.status} />
            </View>
            <Mono dim>{short(tx.txHash)}</Mono>
            {tx.blockNumber ? <Label>block {tx.blockNumber}</Label> : null}
            {tx.error ? <Label>{tx.error}</Label> : null}
            <TouchableOpacity onPress={() => void Linking.openURL(EXPLORER_TX_BASE + tx.txHash)}>
              <Text style={{color: colors.accent, fontSize: 12, marginTop: 4}}>
                view on explorer
              </Text>
            </TouchableOpacity>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

export function DebugScreen({s, c}: ScreenProps) {
  const m = s.memory;
  const lastProve = s.proveMetrics[s.proveMetrics.length - 1];
  return (
    <View style={{flex: 1, padding: spacing.l}}>
      <H1>Debug</H1>
      <Card>
        <Label>
          node {s.nodeInfo ? `chain ${s.nodeInfo.l1ChainId} / rollup ${s.nodeInfo.rollupVersion}` : '—'}
          {'  ·  '}mem{' '}
          {m ? `rss ${fmtMb(m.vmRssMb)} peak ${fmtMb(m.peakRssMb)} pss ${fmtMb(m.totalPssMb)}` : '—'}
        </Label>
        {lastProve ? (
          <Label>
            last prove: {lastProve.proveMs}ms, {lastProve.proofFields} fields, native peak{' '}
            {lastProve.peakRssMb}MB
          </Label>
        ) : null}
        <View style={{flexDirection: 'row', gap: 8, marginTop: 8}}>
          <Button title="Sample memory" kind="secondary" onPress={() => void c.sampleMemory()} />
        </View>
      </Card>
      <ScrollView
        style={{flex: 1, backgroundColor: '#000', borderRadius: 8, padding: spacing.s}}
        contentContainerStyle={{paddingBottom: spacing.l}}>
        {s.logs.map((l, i) => (
          <Text key={i} style={{color: '#3fb950', fontFamily: 'monospace', fontSize: 10}}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function fmtMb(v?: number): string {
  return v === undefined ? '?' : `${Math.round(v)}MB`;
}
