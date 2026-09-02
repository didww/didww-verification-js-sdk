import { DELIVERY_METHODS, type KnownDeliveryMethod } from '@didww/verification-core';
import { isSmsAutoCaptureAvailable } from '@didww/verification-react-native';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { applicationKey, authMode, baseUrl } from '../src/config';
import { Body, Button, Card, Field, Heading, Muted, Notice, Screen, styles } from '../src/ui';

const CHANNEL_LABELS: Record<KnownDeliveryMethod, string> = {
  sms: 'SMS',
  callout: 'Call-out',
};

export interface HomeScreenProps {
  onStart: (destination: string, deliveryMethod: KnownDeliveryMethod) => void;
  onOpenAppHash: () => void;
}

export default function HomeScreen({ onStart, onOpenAppHash }: HomeScreenProps) {
  const [destination, setDestination] = useState('+37200000000');
  const [deliveryMethod, setDeliveryMethod] = useState<KnownDeliveryMethod>('sms');

  return (
    <Screen title="Verify a number">
      <Card>
        <View style={styles.field}>
          <Heading>Destination</Heading>
          <Muted>E.164. The server strips every non-digit, including the leading plus.</Muted>
        </View>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="phone-pad"
          onChangeText={setDestination}
          placeholder="+37200000000"
          style={styles.input}
          value={destination}
        />

        <View style={styles.field}>
          <Heading>Channel</Heading>
          <Muted>Both channels are reported with the code the recipient receives.</Muted>
        </View>
        <View style={styles.choiceRow}>
          {DELIVERY_METHODS.map((method) => {
            const selected = method === deliveryMethod;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={method}
                onPress={() => setDeliveryMethod(method)}
                style={[styles.choice, selected && styles.choiceSelected]}
              >
                <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                  {CHANNEL_LABELS[method]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Button
          disabled={destination.trim() === ''}
          onPress={() => onStart(destination.trim(), deliveryMethod)}
          title="Continue"
        />
      </Card>

      <Card>
        <Heading>This build</Heading>
        <Field label="Base URL" value={baseUrl} />
        <Field label="Auth scheme" value={authMode} />
        <Field
          label="Application key"
          value={applicationKey === '' ? '(not set)' : applicationKey}
        />
        <Field
          label="SMS auto-capture"
          value={isSmsAutoCaptureAvailable() ? 'available' : 'unavailable'}
        />
        <Button onPress={onOpenAppHash} tone="secondary" title="App hash" />
      </Card>

      {authMode === 'basic' ? (
        <Notice tone="warning">
          `basic` sends the application secret with every request. It is here so the example
          completes a verification against the local mock; a shipped app uses `publicAuth`, because
          anything in a bundle is recoverable from it.
        </Notice>
      ) : (
        <Body>
          `public` sends only the application key, which is an identifier rather than a secret. The
          server decides each start by calling your registered callback URL.
        </Body>
      )}
    </Screen>
  );
}
