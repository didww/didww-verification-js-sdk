import type {
  ApiErrorItem,
  KnownDeliveryMethod,
  VerificationClient,
} from '@didww/verification-core';
import {
  otpInputProps,
  useVerification,
  type SdkError,
  type VerificationState,
} from '@didww/verification-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Body, Button, Card, Field, Heading, Muted, Notice, Screen, styles } from '../src/ui';

export interface VerifyScreenProps {
  client: VerificationClient;
  destination: string;
  deliveryMethod: KnownDeliveryMethod;
  onBack: () => void;
}

interface StateCardProps {
  state: VerificationState;
  value: string;
  onChangeValue: (value: string) => void;
  onStart: () => void;
  onResume: () => void;
  onSubmit: (value: string) => void;
  onStartOver: () => void;
  onBack: () => void;
}

function assertNever(state: never): never {
  throw new Error(`Unhandled verification state: ${JSON.stringify(state)}`);
}

function describeSdkError(error: SdkError): string {
  switch (error.code) {
    case 'already_running':
      return 'already_running — a start was issued while one was still in flight.';
    case 'superseded':
      return 'superseded — a newer run in this process took over.';
    case 'transport':
      return `transport — ${error.message}`;
    case 'decoding':
      return `decoding — ${error.message}`;
  }
}

function describeApiError(error: ApiErrorItem): string {
  return error.detail === null ? error.code : `${error.code} — ${error.detail}`;
}

function StateCard({
  state,
  value,
  onChangeValue,
  onStart,
  onResume,
  onSubmit,
  onStartOver,
  onBack,
}: StateCardProps) {
  switch (state.kind) {
    case 'idle':
      return (
        <Card>
          <Heading>Idle</Heading>
          <Body>Nothing has been requested yet. This is also where `reset()` lands.</Body>
          <Button onPress={onStart} title="Send code" />
        </Card>
      );

    case 'starting':
      return (
        <Card>
          <Heading>Starting</Heading>
          <ActivityIndicator />
          <Muted>
            On SMS the hook reads this build&apos;s app hash first, then issues the start request.
          </Muted>
        </Card>
      );

    case 'awaitingInput': {
      return (
        <Card>
          <Heading>Awaiting input</Heading>
          <Field label="Verification id" value={state.verificationId} />
          <Field label="Fee" value={state.fee ?? 'null'} />
          <Field
            label="Expires at"
            value={state.expiresAt === null ? 'null' : state.expiresAt.toISOString()}
          />
          {state.sms === null ? (
            <Muted>No SMS block: this channel does not carry one.</Muted>
          ) : (
            <View style={styles.cardInner}>
              <Field label="SMS template" value={state.sms.template ?? 'null'} />
              <Field label="Echoed app hash" value={state.sms.appHash ?? 'null'} />
              <Field
                label="Interception timeout"
                value={
                  state.sms.interceptionTimeoutSeconds === null
                    ? 'null'
                    : `${state.sms.interceptionTimeoutSeconds}s`
                }
              />
            </View>
          )}

          {state.lastError === null ? null : (
            <Notice tone="danger">
              {describeApiError(state.lastError)}
              {'\n'}The verification is still alive and accepts another value.
            </Notice>
          )}

          <Heading>Verification code</Heading>
          <TextInput
            {...otpInputProps}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onChangeValue}
            placeholder="123456"
            style={styles.input}
            value={value}
          />
          <Button
            disabled={value.trim() === ''}
            onPress={() => onSubmit(value.trim())}
            title="Submit"
          />
          <Button onPress={onResume} title="Reload from server" tone="secondary" />
          <Muted>
            `resume()` re-reads the newest verification for this number. A row that quietly ran out
            of time reaches `expired` here — nothing was written when it did.
          </Muted>
        </Card>
      );
    }

    case 'captured':
      return (
        <Card>
          <Heading>Captured</Heading>
          <Field label="Value" value={state.value} />
          <Body>
            Read out of the incoming message by the Android SMS Retriever. The hook does not submit
            it for you.
          </Body>
          <Button onPress={() => onSubmit(state.value)} title="Submit" />
        </Card>
      );

    case 'submitting':
      return (
        <Card>
          <Heading>Submitting</Heading>
          <ActivityIndicator />
        </Card>
      );

    case 'verified':
      return (
        <Card>
          <Heading>Verified</Heading>
          <Field label="Verification id" value={state.verificationId} />
          <Button onPress={onStartOver} title="Start over" />
        </Card>
      );

    case 'failed':
      return (
        <Card>
          <Heading>Failed</Heading>
          <Field label="Decided by" value={state.reason.source} />
          <Notice tone="danger">
            {state.reason.source === 'api'
              ? describeApiError(state.reason.error)
              : describeSdkError(state.reason.error)}
          </Notice>
          <Button onPress={onStartOver} title="Start over" />
        </Card>
      );

    case 'denied':
      return (
        <Card>
          <Heading>Denied</Heading>
          <Notice tone="danger">
            {state.error === null
              ? 'The server denied the verification and named no reason.'
              : describeApiError(state.error)}
          </Notice>
          <Muted>
            A denial is the callback&apos;s answer, not the user&apos;s: the server asked the
            registered callback URL whether to proceed and it said no, or the answer could not be
            read.
          </Muted>
          <Button onPress={onStartOver} title="Start over" />
        </Card>
      );

    case 'expired':
      return (
        <Card>
          <Heading>Expired</Heading>
          <Body>The verification passed its deadline before a value was accepted.</Body>
          <Button onPress={onStartOver} title="Start over" />
        </Card>
      );

    case 'setupError':
      return (
        <Card>
          <Heading>Setup error</Heading>
          <Notice tone="danger">
            {state.detail === null ? state.code : `${state.code} — ${state.detail}`}
          </Notice>
          <Muted>
            The application is misconfigured. Retrying the same call cannot succeed — fix the
            application, not the request.
          </Muted>
          <Button onPress={onBack} title="Back" tone="secondary" />
        </Card>
      );

    default:
      return assertNever(state);
  }
}

export default function VerifyScreen({
  client,
  destination,
  deliveryMethod,
  onBack,
}: VerifyScreenProps) {
  const controller = useVerification({ client });
  const { state } = controller;
  const [value, setValue] = useState('');

  // Held in a ref: the controller is a new object on every state change, so depending on it in the
  // effect below would restart the verification each time it advances.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const start = () => controllerRef.current.start({ destination, deliveryMethod });

  useEffect(() => {
    controllerRef.current.start({ destination, deliveryMethod });
  }, [destination, deliveryMethod]);

  return (
    <Screen title="Verification">
      <Card>
        <Field label="Destination" value={destination} />
        <Field label="Channel" value={deliveryMethod} />
        <Field label="State" value={state.kind} />
      </Card>

      <StateCard
        onBack={onBack}
        onChangeValue={setValue}
        onResume={() => controllerRef.current.resume({ destination, deliveryMethod })}
        onStart={start}
        onStartOver={() => {
          setValue('');
          controllerRef.current.reset();
        }}
        onSubmit={(submitted) => controllerRef.current.submit(submitted)}
        state={state}
        value={value}
      />

      <Button onPress={onBack} title="Back" tone="secondary" />
    </Screen>
  );
}
