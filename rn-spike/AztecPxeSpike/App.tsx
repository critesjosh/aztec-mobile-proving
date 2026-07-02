/**
 * Aztec on-device PXE spike (RN 0.84).
 *
 * A WebView hosts the real Aztec browser PXE (acvm_js WASM witgen + IndexedDB),
 * and the ClientIVC proof is produced ON THE DEVICE by this repo's native Rust
 * prover (libnoir_prover_jni.so) via the `Prover` native module. The WebView
 * posts execution steps out (`proveRequest`); RN proves and injects the result
 * back (`proveResult`); the PXE reconstructs the proof and submits to testnet.
 *
 * The account signing key is generated on-device per run (never committed).
 */
import React, {useCallback, useRef, useState} from 'react';
import {
  NativeModules,
  SafeAreaView,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';

const {Prover} = NativeModules as {
  Prover: {
    initSrs(): Promise<string>;
    chonkProve(ivcInputsB64: string): Promise<string>;
  };
};

const NODE_URL = 'https://v5.testnet.rpc.aztec-labs.com';
const SPONSORED_FPC =
  '0x1969946536f0c09269e2c75e414eef4e21a76e763c5514125208db33d7d944d7';

// WebView bundle shipped in android/app/src/main/assets/pxe (vite dist).
const PXE_URI = 'file:///android_asset/pxe/index.html';

function randHex(n: number): string {
  // SPIKE ONLY: Math.random() is NOT cryptographically secure. Fine here — the
  // account is a fresh throwaway generated per run and never reused or funded.
  // A real wallet MUST use secure randomness (react-native-get-random-values /
  // Keystore) and store the key in the Android Keystore / iOS Keychain.
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = Math.floor(Math.random() * 256);
  }
  return '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export default function App() {
  const webRef = useRef<WebView>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [srsReady, setSrsReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const log = useCallback((s: string) => {
    setLogs(prev => [...prev, s]);
    // eslint-disable-next-line no-console
    console.log('[App]', s);
  }, []);

  const post = (msg: object) => {
    webRef.current?.injectJavaScript(
      `window.__aztecOnHostMessage(${JSON.stringify(msg)}); true;`,
    );
  };

  const onMessage = useCallback(
    async (e: WebViewMessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        log('WebView ready');
      } else if (msg.type === 'status') {
        log(`status: ${msg.phase} ${msg.data ? JSON.stringify(msg.data) : ''}`);
      } else if (msg.type === 'log') {
        log(msg.msg);
      } else if (msg.type === 'proveRequest') {
        // The WebView content is trusted (bundled), but guard the bridge
        // against malformed/oversized payloads before handing bytes to native.
        if (typeof msg.id !== 'number' || typeof msg.ivcInputsB64 !== 'string') {
          log('proveRequest: bad payload, ignored');
          return;
        }
        if (msg.ivcInputsB64.length > 64 * 1024 * 1024) {
          post({type: 'proveResult', id: msg.id, verified: false, proofFields: [], vkHex: ''});
          log('proveRequest: payload too large, rejected');
          return;
        }
        log(`proveRequest #${msg.id} -> native prover (on-device)`);
        try {
          const t = Date.now();
          const resJson = await Prover.chonkProve(msg.ivcInputsB64);
          const r = JSON.parse(resJson);
          log(
            `native prove: verified=${r.verified} prove=${r.prove_ms}ms ` +
              `fields=${r.proof_fields.length} wall=${Date.now() - t}ms`,
          );
          post({
            type: 'proveResult',
            id: msg.id,
            verified: r.verified,
            proofFields: (r.proof_fields as string[]).map((h: string) =>
              h.startsWith('0x') ? h : '0x' + h,
            ),
            vkHex: r.vk,
            proveMs: r.prove_ms,
            peakRssMb: r.peak_rss_mb,
          });
        } catch (err: any) {
          log(`native prove FAILED: ${err?.message ?? err}`);
          post({type: 'proveResult', id: msg.id, verified: false, proofFields: [], vkHex: ''});
        }
      } else if (msg.type === 'result') {
        log(`TX ${msg.status}: ${msg.txHash}`);
        log(`explorer: ${msg.explorer}`);
        setBusy(false);
      } else if (msg.type === 'error') {
        log(`ERROR: ${msg.error}`);
        setBusy(false);
      }
    },
    [log],
  );

  const initSrs = useCallback(async () => {
    try {
      log('loading SRS into native prover…');
      const res = await Prover.initSrs();
      log(`SRS init: ${res}`);
      setSrsReady(true);
    } catch (e: any) {
      log(`SRS init FAILED: ${e?.message ?? e}`);
    }
  }, [log]);

  const deployAccount = useCallback(() => {
    setBusy(true);
    log('=== deploy account (WebView PXE + on-device native prover) ===');
    post({
      type: 'deployAccount',
      nodeUrl: NODE_URL,
      sponsoredFpc: SPONSORED_FPC,
      secret: randHex(31),
      salt: randHex(31),
      signingKey: randHex(32),
    });
  }, [log]);

  return (
    <SafeAreaView style={{flex: 1, padding: 12}}>
      <Text style={{fontSize: 18, fontWeight: 'bold'}}>
        Aztec on-device PXE spike
      </Text>
      <View style={{flexDirection: 'row', gap: 8, marginVertical: 8}}>
        <Btn title="1. Init SRS" onPress={initSrs} disabled={busy} />
        <Btn
          title="2. Deploy account"
          onPress={deployAccount}
          disabled={busy || !srsReady}
        />
      </View>
      <ScrollView style={{flex: 1, backgroundColor: '#111', padding: 8}}>
        {logs.map((l, i) => (
          <Text key={i} style={{color: '#0f0', fontFamily: 'monospace', fontSize: 11}}>
            {l}
          </Text>
        ))}
      </ScrollView>
      <WebView
        ref={webRef}
        source={{uri: PXE_URI}}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        style={{height: 1, opacity: 0}}
        onError={e => log(`WebView error: ${e.nativeEvent.description}`)}
      />
    </SafeAreaView>
  );
}

function Btn({title, onPress, disabled}: {title: string; onPress: () => void; disabled?: boolean}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? '#999' : '#3355ff',
        padding: 10,
        borderRadius: 6,
      }}>
      <Text style={{color: 'white'}}>{title}</Text>
    </TouchableOpacity>
  );
}
