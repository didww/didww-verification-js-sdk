// Compile-time only: `tsc --noEmit` is the runner, and a `@ts-expect-error` that stops erroring is
// itself an error. This fails the build if `ReportOptions` regains an open `string & {}` arm, which
// would swallow the closed one and let every malformed call below compile.

import type { VerificationClient } from './client.js';

declare const client: VerificationClient;
declare const signal: AbortSignal;

const bothFieldsViaVariable: { deliveryMethod: 'sms'; code: string; cli: string } = {
  deliveryMethod: 'sms',
  code: '1234',
  cli: '+15551234567',
};

client.reportVerification('v1', { deliveryMethod: 'sms', code: '1234', signal });
client.reportVerification('v1', { deliveryMethod: 'callout', code: '1234', signal });
client.reportVerificationByNumber('+15551234567', { deliveryMethod: 'callout', code: '1234' });

// @ts-expect-error an sms is reported with `code`, and `cli?: never` rejects a cli
client.reportVerification('v1', { deliveryMethod: 'sms', cli: '+15551234567' });
// @ts-expect-error one value field per report, never both
client.reportVerification('v1', { deliveryMethod: 'sms', code: '1234', cli: '+15551234567' });
// @ts-expect-error under exactOptionalPropertyTypes an explicit undefined is not an absent field
client.reportVerification('v1', { deliveryMethod: 'sms', code: '1234', cli: undefined });
// @ts-expect-error a report carries a value field; neither is supplied here
client.reportVerification('v1', { deliveryMethod: 'sms' });
// @ts-expect-error the rejection survives a variable, where excess-property checking cannot apply, so `cli?: never` is what rejects it
client.reportVerification('v1', bothFieldsViaVariable);
// @ts-expect-error the type is closed, so a channel this release does not model needs the raw method
client.reportVerification('v1', { deliveryMethod: 'carrier_pigeon', code: '1234' });

client.reportVerificationRaw('v1', { deliveryMethod: 'whatsapp', cli: '+15551234567' });
client.reportVerificationRaw('v1', { deliveryMethod: 'sms', cli: '+15551234567' });
client.reportVerificationRaw('v1', { deliveryMethod: 'sms', code: '1234', cli: '+15551234567' });
client.reportVerificationRaw('v1', { deliveryMethod: 'sms' });
client.reportVerificationRaw('v1', bothFieldsViaVariable);
client.reportVerificationRaw('v1', { deliveryMethod: 'carrier_pigeon', code: '1234', signal });
client.reportVerificationRawByNumber('+15551234567', { deliveryMethod: 'carrier_pigeon', signal });
