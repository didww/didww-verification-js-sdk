import { getAppHash, isSmsAutoCaptureAvailable } from '@didww/verification-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform } from 'react-native';

import { Body, Button, Card, Field, Heading, Muted, Notice, Screen } from '../src/ui';

type HashState = { status: 'loading' } | { status: 'read'; hash: string | null };

export interface AppHashScreenProps {
  onBack: () => void;
}

export default function AppHashScreen({ onBack }: AppHashScreenProps) {
  const [result, setResult] = useState<HashState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // Never rejects: an unreadable certificate and an unlinked module both answer null.
    void getAppHash().then((hash) => {
      if (!cancelled) {
        setResult({ status: 'read', hash });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Screen title="App hash">
      <Card>
        <Heading>This build</Heading>
        {result.status === 'loading' ? (
          <ActivityIndicator />
        ) : (
          <Field label="getAppHash()" value={result.hash ?? 'null'} />
        )}
        <Field label="Platform" value={Platform.OS} />
        <Field label="isSmsAutoCaptureAvailable()" value={String(isSmsAutoCaptureAvailable())} />
      </Card>

      {result.status === 'read' && result.hash === null ? (
        <Notice tone="warning">
          null means no hash could be read here: iOS, Expo Go, or a bare app without Expo Modules.
          SMS auto-capture is off and the user types the code. Nothing else is wrong.
        </Notice>
      ) : null}

      <Card>
        <Heading>Why this screen exists</Heading>
        <Body>
          The hash is derived from the certificate this build is actually signed with. A store
          re-signs an uploaded artifact with its own key, so the hash of the build users install is
          not the hash of the build you uploaded.
        </Body>
        <Body>
          A mismatch is completely silent: the message still arrives, nothing fires, and manual
          entry still works. Reading the value off the running build is the only way to see it.
        </Body>
        <Muted>
          Compare this value against the one the server echoes back on a started SMS verification —
          the verify screen shows it as &quot;Echoed app hash&quot;.
        </Muted>
      </Card>

      <Button onPress={onBack} title="Back" tone="secondary" />
    </Screen>
  );
}
