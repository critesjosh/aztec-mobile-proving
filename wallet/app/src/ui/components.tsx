import React from 'react';
import {ActivityIndicator, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {colors, spacing} from './theme';

export function Button({
  title,
  onPress,
  disabled,
  kind = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
}) {
  const bg =
    kind === 'primary' ? colors.accent : kind === 'danger' ? colors.bad : colors.card;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? colors.border : bg,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: kind === 'secondary' ? 1 : 0,
        borderColor: colors.border,
        alignItems: 'center',
      }}>
      <Text style={{color: disabled ? colors.dim : colors.accentText, fontWeight: '600'}}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

export function Card({children}: {children: React.ReactNode}) {
  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: spacing.l,
        marginBottom: spacing.m,
      }}>
      {children}
    </View>
  );
}

export function H1({children}: {children: React.ReactNode}) {
  return (
    <Text style={{color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: spacing.m}}>
      {children}
    </Text>
  );
}

export function Label({children}: {children: React.ReactNode}) {
  return <Text style={{color: colors.dim, fontSize: 12, marginBottom: 4}}>{children}</Text>;
}

export function Body({children}: {children: React.ReactNode}) {
  return <Text style={{color: colors.text, fontSize: 14}}>{children}</Text>;
}

export function Mono({children, dim}: {children: React.ReactNode; dim?: boolean}) {
  return (
    <Text
      style={{
        color: dim ? colors.dim : colors.mono,
        fontFamily: 'monospace',
        fontSize: 12,
      }}>
      {children}
    </Text>
  );
}

export function Input({
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric';
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.dim}
      keyboardType={keyboardType}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        backgroundColor: colors.bg,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        color: colors.text,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: spacing.s,
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    />
  );
}

export function StatusPill({status}: {status: string}) {
  const color =
    status === 'dropped' || status === 'reverted' || status === 'not deployed'
      ? colors.bad
      : status === 'submitted' || status === 'pending'
        ? colors.warn
        : colors.good;
  return (
    <View
      style={{
        borderColor: color,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}>
      <Text style={{color, fontSize: 11}}>{status}</Text>
    </View>
  );
}

export function Busy({
  label,
  stage,
  onCancel,
}: {
  label: string;
  stage?: {label: string; index: number; total: number};
  onCancel?: () => void;
}) {
  return (
    <View style={{flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: spacing.s}}>
      <ActivityIndicator color={colors.accent} />
      <Text style={{color: colors.dim, flex: 1}}>
        {stage ? `${stage.label} (${stage.index}/${stage.total})` : `${label}…`}
      </Text>
      {onCancel ? (
        <TouchableOpacity onPress={onCancel} accessibilityLabel="Cancel">
          <Text style={{color: colors.accent, fontWeight: '600'}}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function ErrorBanner({message}: {message: string}) {
  return (
    <View
      style={{
        backgroundColor: '#2d1517',
        borderColor: colors.bad,
        borderWidth: 1,
        borderRadius: 8,
        padding: spacing.m,
        marginBottom: spacing.m,
      }}>
      <Text style={{color: colors.bad, fontSize: 12}}>{message}</Text>
    </View>
  );
}

export function short(addr?: string): string {
  if (!addr) {
    return '';
  }
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}
