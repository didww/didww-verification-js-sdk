import type { KnownDeliveryMethod } from '@didww/verification-core';
import { useState } from 'react';
import { StatusBar } from 'react-native';

import AppHashScreen from './app/app-hash';
import HomeScreen from './app/index';
import VerifyScreen from './app/verify';
import { client, clientError } from './src/client';
import { Body, Card, Heading, Notice, Screen } from './src/ui';

type Route =
  | { name: 'home' }
  | { name: 'verify'; destination: string; deliveryMethod: KnownDeliveryMethod }
  | { name: 'appHash' };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });

  return (
    <>
      <StatusBar barStyle="dark-content" />
      {renderRoute()}
    </>
  );

  function renderRoute() {
    if (route.name === 'appHash') {
      return <AppHashScreen onBack={() => setRoute({ name: 'home' })} />;
    }

    if (client === null) {
      return (
        <Screen title="Not configured">
          <Notice tone="danger">{clientError ?? 'The client could not be constructed.'}</Notice>
          <Card>
            <Heading>Fix</Heading>
            <Body>
              Copy .env.example to .env and restart the bundler. Expo inlines EXPO_PUBLIC_ variables
              at build time, so a change to .env is not picked up by a reload.
            </Body>
          </Card>
        </Screen>
      );
    }

    if (route.name === 'verify') {
      return (
        <VerifyScreen
          client={client}
          deliveryMethod={route.deliveryMethod}
          destination={route.destination}
          onBack={() => setRoute({ name: 'home' })}
        />
      );
    }

    return (
      <HomeScreen
        onOpenAppHash={() => setRoute({ name: 'appHash' })}
        onStart={(destination, deliveryMethod) =>
          setRoute({ name: 'verify', destination, deliveryMethod })
        }
      />
    );
  }
}
