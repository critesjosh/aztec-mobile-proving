/**
 * Aztec wallet (Android-first). A hidden WebView hosts the real Aztec browser
 * PXE served from a loopback origin (secure context + persistent IndexedDB);
 * ClientIVC proofs are produced on-device by the native Rust prover via the
 * Prover module. Account keys are generated with the platform secure RNG and
 * stored sealed by the Android Keystore. See wallet/PLAN.md.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {SafeAreaView, StatusBar, Text, TouchableOpacity, View} from 'react-native';
import WebView, {type WebViewProps} from 'react-native-webview';

// react-native-webview@14 class-component typings collapse to `props: never`
// under React 19 types (same pre-existing issue in the rn-spike). Runtime is
// unaffected; this cast restores prop checking against WebViewProps.
const WebViewComp = WebView as unknown as React.ComponentClass<
  WebViewProps & {ref?: React.Ref<WebView>}
>;
import {PXE_ORIGIN} from './src/config';
import {WalletController, type WalletSnapshot} from './src/wallet/WalletController';
import {Body, Busy, Button, Card, ErrorBanner, H1, Label} from './src/ui/components';
import {ActivityScreen, AmmScreen, DebugScreen, HomeScreen, OnboardingScreen, SendScreen} from './src/ui/screens';
import {colors, spacing} from './src/ui/theme';

type Tab = 'wallet' | 'send' | 'amm' | 'activity' | 'debug';
const TABS: {key: Tab; label: string}[] = [
  {key: 'wallet', label: 'Wallet'},
  {key: 'send', label: 'Send'},
  {key: 'amm', label: 'AMM'},
  {key: 'activity', label: 'Activity'},
  {key: 'debug', label: 'Debug'},
];

export default function App() {
  const controller = useMemo(() => new WalletController(), []);
  const [snapshot, setSnapshot] = useState<WalletSnapshot>(controller.getSnapshot());
  const [tab, setTab] = useState<Tab>('wallet');
  const webRef = useRef<WebView | null>(null);

  useEffect(() => {
    const unsub = controller.subscribe(setSnapshot);
    void controller.start();
    return unsub;
  }, [controller]);

  const s = snapshot;
  const reload = () => webRef.current?.reload();

  // Attach the session once the WebView mounts (it mounts when origin is set).
  useEffect(() => {
    controller.session.attach(webRef.current);
  }, [controller, s.origin]);

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: colors.bg}}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      {/* Hidden PXE WebView: mounted once the loopback server is up, kept
          mounted for the app's lifetime. Hardened: pinned to our origin,
          no file access, content debugging only in dev builds. */}
      {s.origin ? (
        <View style={{height: 0, overflow: 'hidden'}}>
          <WebViewComp
            ref={webRef}
            source={{uri: `${s.origin}/index.html`}}
            originWhitelist={[`${PXE_ORIGIN}*`]}
            onShouldStartLoadWithRequest={req => req.url.startsWith(PXE_ORIGIN)}
            javaScriptEnabled
            domStorageEnabled
            webviewDebuggingEnabled={__DEV__}
            setSupportMultipleWindows={false}
            onMessage={controller.session.handleMessage}
            onRenderProcessGone={e =>
              controller.onWebViewCrash(e.nativeEvent.didCrash ? 'renderer crashed' : 'renderer killed')
            }
            onError={e => controller.onWebViewCrash(`load error: ${e.nativeEvent.description}`)}
            style={{height: 1, opacity: 0}}
          />
        </View>
      ) : null}

      <MainView s={s} c={controller} tab={tab} onReload={reload} />

      {(s.phase === 'ready' || s.phase === 'onboarding') && (
        <View
          style={{
            flexDirection: 'row',
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.card,
          }}>
          {TABS.map(t => (
            <TouchableOpacity
              key={t.key}
              onPress={() => setTab(t.key)}
              style={{flex: 1, alignItems: 'center', paddingVertical: 10}}>
              <Text
                style={{
                  color: tab === t.key ? colors.accent : colors.dim,
                  fontSize: 12,
                  fontWeight: tab === t.key ? '700' : '400',
                }}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function MainView({
  s,
  c,
  tab,
  onReload,
}: {
  s: WalletSnapshot;
  c: WalletController;
  tab: Tab;
  onReload: () => void;
}) {
  if (s.phase === 'fatal') {
    return (
      <View style={{flex: 1, padding: spacing.l, justifyContent: 'center'}}>
        <Card>
          <H1>Something is wrong</H1>
          <ErrorBanner message={s.fatalError ?? 'unknown error'} />
          <Body>
            The wallet could not start. Check network connectivity to the Aztec
            testnet node and retry.
          </Body>
          <View style={{height: spacing.m}} />
          <Button
            title="Retry"
            onPress={() => {
              void c.restartSession().then(onReload);
            }}
          />
        </Card>
      </View>
    );
  }
  if (s.phase === 'crashed') {
    return (
      <View style={{flex: 1, padding: spacing.l, justifyContent: 'center'}}>
        <Card>
          <H1>PXE session stopped</H1>
          <Body>
            The in-app PXE process was stopped (often memory pressure).
            Submitted transactions are unaffected and keep confirming; restart
            the session to continue.
          </Body>
          <View style={{height: spacing.m}} />
          <Button
            title="Restart session"
            onPress={() => {
              void c.restartSession().then(onReload);
            }}
          />
        </Card>
      </View>
    );
  }
  if (s.phase === 'init' || s.phase === 'webview' || s.phase === 'boot') {
    return (
      <View style={{flex: 1, padding: spacing.l, justifyContent: 'center'}}>
        <Card>
          <H1>Aztec wallet</H1>
          <Busy
            label={
              s.phase === 'init'
                ? 'starting'
                : s.phase === 'webview'
                  ? 'loading PXE'
                  : 'booting PXE + syncing testnet'
            }
          />
          <Label>
            Full PXE on-device: witness generation in WASM, ClientIVC proofs in
            native code. First boot downloads circuit artifacts and can take a
            minute on testnet.
          </Label>
        </Card>
      </View>
    );
  }
  if (s.phase === 'onboarding') {
    return tab === 'debug' ? <DebugScreen s={s} c={c} /> : <OnboardingScreen s={s} c={c} />;
  }
  switch (tab) {
    case 'wallet':
      return <HomeScreen s={s} c={c} />;
    case 'send':
      return <SendScreen s={s} c={c} />;
    case 'amm':
      return <AmmScreen s={s} c={c} />;
    case 'activity':
      return <ActivityScreen s={s} c={c} />;
    case 'debug':
      return <DebugScreen s={s} c={c} />;
  }
}
