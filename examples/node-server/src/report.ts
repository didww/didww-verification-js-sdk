import {
  isKnownDeliveryMethod,
  type VerificationClient,
  type VerificationResult,
} from '@didww/verification-core';

/**
 * The channel arrives from the HTTP layer as an untrusted string, and `ReportOptions` rejects one
 * this release does not model — so those go to `reportVerificationRaw`, where only the server
 * judges. Both paths send `code`: it is the field every modelled channel uses.
 */
export function report(
  client: VerificationClient,
  id: string,
  method: string,
  value: string,
): Promise<VerificationResult> {
  return isKnownDeliveryMethod(method)
    ? client.reportVerification(id, { deliveryMethod: method, code: value })
    : client.reportVerificationRaw(id, { deliveryMethod: method, code: value });
}
