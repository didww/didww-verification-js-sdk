import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#f5f6f8',
  card: '#ffffff',
  border: '#dfe3e8',
  text: '#12161c',
  muted: '#5b6572',
  accent: '#1f6feb',
  danger: '#b42318',
  warning: '#8a5a00',
  success: '#087443',
} as const;

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </ScrollView>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} selectable>
        {value}
      </Text>
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Notice({ tone, children }: { tone: 'danger' | 'warning'; children: ReactNode }) {
  return (
    <View style={[styles.notice, tone === 'danger' ? styles.noticeDanger : styles.noticeWarning]}>
      <Text
        style={[styles.noticeText, { color: tone === 'danger' ? colors.danger : colors.warning }]}
      >
        {children}
      </Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  tone = 'primary',
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  tone?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'secondary' && styles.buttonSecondary,
        (pressed || disabled) && styles.buttonDimmed,
      ]}
    >
      <Text style={[styles.buttonText, tone === 'secondary' && styles.buttonTextSecondary]}>
        {title}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  screenContent: { gap: 16, padding: 20, paddingBottom: 48, paddingTop: 64 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  heading: { color: colors.text, fontSize: 17, fontWeight: '600' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  field: { gap: 2 },
  cardInner: { gap: 12 },
  fieldLabel: { color: colors.muted, fontSize: 12, textTransform: 'uppercase' },
  fieldValue: { color: colors.text, fontSize: 15 },
  notice: { borderRadius: 10, borderWidth: 1, padding: 12 },
  noticeDanger: { backgroundColor: '#fdf1f0', borderColor: '#f2c4bf' },
  noticeWarning: { backgroundColor: '#fdf6e7', borderColor: '#efd9a3' },
  noticeText: { fontSize: 14, lineHeight: 20 },
  button: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  buttonSecondary: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 },
  buttonDimmed: { opacity: 0.55 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  buttonTextSecondary: { color: colors.text },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choiceRow: { flexDirection: 'row', gap: 8 },
  choice: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 11,
  },
  choiceSelected: { backgroundColor: '#e8f0fe', borderColor: colors.accent },
  choiceText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  choiceTextSelected: { color: colors.accent },
});
