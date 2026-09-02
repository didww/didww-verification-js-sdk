import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  API_ERROR_CODES as SDK_API_ERROR_CODES,
  DELIVERY_METHODS as SDK_DELIVERY_METHODS,
  VERIFICATION_STATUSES,
} from '@didww/verification-core';

interface WireContract {
  paths: Record<string, unknown>;
  constraints: {
    appHash: { pattern: string };
    languageTag: { acceptedPattern: string; canonicalization: string; fallback: string };
    generatedCodeLength: number;
    verificationLifetimeSeconds: number;
    interceptionTimeoutSeconds: number;
    reportAttempts: { max: number };
  };
  signing: { timestamp: { replayWindowSeconds: number } };
  callback: {
    request: { retries: number };
    expectedResponse: { responseReadLimitBytes: number };
  };
}

const CONTRACT_URL = new URL('../../../contract/wire-contract.json', import.meta.url);

export const contract = JSON.parse(
  readFileSync(fileURLToPath(CONTRACT_URL), 'utf8'),
) as WireContract;

const API_ERROR_CODES: ReadonlySet<string> = new Set(SDK_API_ERROR_CODES);
const STATUSES: ReadonlySet<string> = new Set(VERIFICATION_STATUSES);
const DELIVERY_METHODS: ReadonlySet<string> = new Set(SDK_DELIVERY_METHODS);

function member(set: ReadonlySet<string>, list: string, slug: string): string {
  if (!set.has(slug)) {
    throw new Error(`'${slug}' is not a member of ${list} in @didww/verification-core`);
  }
  return slug;
}

// Every slug this server can emit is resolved here, at module load, against the SDK's own
// vocabulary, so a rename on either side fails the boot instead of serving a value the SDK
// no longer knows.
export const CODE = {
  destinationBlank: member(API_ERROR_CODES, 'API_ERROR_CODES', 'destination_blank'),
  destinationInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'destination_invalid'),
  deliveryMethodBlank: member(API_ERROR_CODES, 'API_ERROR_CODES', 'delivery_method_blank'),
  deliveryMethodInclusion: member(API_ERROR_CODES, 'API_ERROR_CODES', 'delivery_method_inclusion'),
  deliveryMethodInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'delivery_method_invalid'),
  languagesInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'languages_invalid'),
  appHashInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'app_hash_invalid'),
  codeBlank: member(API_ERROR_CODES, 'API_ERROR_CODES', 'code_blank'),
  codeValuePresent: member(API_ERROR_CODES, 'API_ERROR_CODES', 'code_value_present'),
  cliBlank: member(API_ERROR_CODES, 'API_ERROR_CODES', 'cli_blank'),
  cliValuePresent: member(API_ERROR_CODES, 'API_ERROR_CODES', 'cli_value_present'),
  codeInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'code_invalid'),
  cliInvalid: member(API_ERROR_CODES, 'API_ERROR_CODES', 'cli_invalid'),
  alreadyVerified: member(API_ERROR_CODES, 'API_ERROR_CODES', 'already_verified'),
  notReadyToReport: member(API_ERROR_CODES, 'API_ERROR_CODES', 'not_ready_to_report'),
  parameterMissing: member(API_ERROR_CODES, 'API_ERROR_CODES', 'parameter_missing'),
  notFound: member(API_ERROR_CODES, 'API_ERROR_CODES', 'not_found'),
  unauthorized: member(API_ERROR_CODES, 'API_ERROR_CODES', 'unauthorized'),
  internalError: member(API_ERROR_CODES, 'API_ERROR_CODES', 'internal_error'),
  expired: member(API_ERROR_CODES, 'API_ERROR_CODES', 'expired'),
  tooManyAttempts: member(API_ERROR_CODES, 'API_ERROR_CODES', 'too_many_attempts'),
  superseded: member(API_ERROR_CODES, 'API_ERROR_CODES', 'superseded'),
  deniedMissingCallbackUrl: member(
    API_ERROR_CODES,
    'API_ERROR_CODES',
    'denied_missing_callback_url',
  ),
  deniedByCallback: member(API_ERROR_CODES, 'API_ERROR_CODES', 'denied_by_callback'),
  deniedInvalidCallbackResponse: member(
    API_ERROR_CODES,
    'API_ERROR_CODES',
    'denied_invalid_callback_response',
  ),
} as const;

export const STATUS = {
  pending: member(STATUSES, 'VERIFICATION_STATUSES', 'pending'),
  verified: member(STATUSES, 'VERIFICATION_STATUSES', 'verified'),
  failed: member(STATUSES, 'VERIFICATION_STATUSES', 'failed'),
  expired: member(STATUSES, 'VERIFICATION_STATUSES', 'expired'),
  denied: member(STATUSES, 'VERIFICATION_STATUSES', 'denied'),
} as const;

export const METHOD = {
  sms: member(DELIVERY_METHODS, 'DELIVERY_METHODS', 'sms'),
  callout: member(DELIVERY_METHODS, 'DELIVERY_METHODS', 'callout'),
} as const;

export function isDeliveryMethod(value: string): boolean {
  return DELIVERY_METHODS.has(value);
}

export const APP_HASH_PATTERN = new RegExp(contract.constraints.appHash.pattern);
export const LANGUAGE_TAG_PATTERN = new RegExp(contract.constraints.languageTag.acceptedPattern);
export const LANGUAGE_TAG_FALLBACK = contract.constraints.languageTag.fallback;
export const GENERATED_CODE_LENGTH = contract.constraints.generatedCodeLength;
export const VERIFICATION_LIFETIME_SECONDS = contract.constraints.verificationLifetimeSeconds;
export const INTERCEPTION_TIMEOUT_SECONDS = contract.constraints.interceptionTimeoutSeconds;
export const MAX_REPORT_ATTEMPTS = contract.constraints.reportAttempts.max;
export const REPLAY_WINDOW_SECONDS = contract.signing.timestamp.replayWindowSeconds;
export const CALLBACK_READ_LIMIT_BYTES = contract.callback.expectedResponse.responseReadLimitBytes;
export const CALLBACK_RETRIES = contract.callback.request.retries;

// The snapshot states the pattern in prose ("^\+?[0-9]{8,15}$ after removing spaces, hyphens and
// parentheses"), so it cannot be compiled from the file the way the two above are.
export const DESTINATION_PATTERN = /^\+?[0-9]{8,15}$/;
const DESTINATION_SEPARATORS = /[ \-()]/g;

/** `detail` is fixed prose selected by `code`; it is display-only and never per-request text. */
const ERROR_DETAILS: Record<string, string> = {
  [CODE.destinationBlank]: 'Destination is required.',
  [CODE.destinationInvalid]: 'Destination is not a valid phone number.',
  [CODE.deliveryMethodBlank]: 'Delivery method is required.',
  [CODE.deliveryMethodInclusion]: 'Delivery method is not supported.',
  [CODE.deliveryMethodInvalid]: 'Delivery method does not match the verification.',
  [CODE.languagesInvalid]: 'Languages are not valid language tags.',
  [CODE.appHashInvalid]: 'App hash is not a valid application hash.',
  [CODE.codeBlank]: 'Code is required.',
  [CODE.codeValuePresent]: 'Code must not be sent for this delivery method.',
  [CODE.cliBlank]: 'CLI is required.',
  [CODE.cliValuePresent]: 'CLI must not be sent for this delivery method.',
  [CODE.codeInvalid]: 'Code is not correct.',
  [CODE.cliInvalid]: 'CLI is not correct.',
  [CODE.alreadyVerified]: 'Verification is already verified.',
  [CODE.notReadyToReport]: 'Verification is not ready to be reported.',
  [CODE.parameterMissing]: 'A required parameter is missing.',
  [CODE.notFound]: 'Resource not found.',
  [CODE.unauthorized]: 'Unauthorized.',
  [CODE.internalError]: 'Internal error.',
  [CODE.expired]: 'Verification has expired.',
  [CODE.tooManyAttempts]: 'Too many report attempts.',
  [CODE.superseded]: 'Verification was superseded by a newer one.',
  [CODE.deniedMissingCallbackUrl]: 'No callback URL is registered for the application.',
  [CODE.deniedByCallback]: 'The callback denied the verification.',
  [CODE.deniedInvalidCallbackResponse]: 'The callback answer could not be accepted.',
};

export function errorDetail(code: string): string {
  return ERROR_DETAILS[code] ?? code.replace(/_/g, ' ');
}

export type AuthScheme = 'public' | 'basic' | 'application';

export const SCHEME_RANK: Record<AuthScheme, number> = { public: 0, basic: 1, application: 2 };

export interface MockApplication {
  key: string;
  secret: string;
  minimumScheme: AuthScheme;
  callbackUrl: string | null;
}

export interface VerificationRow {
  id: string;
  applicationKey: string;
  destination: string;
  deliveryMethod: string;
  expectedValue: string;
  status: string;
  errorCode: string | null;
  attempts: number;
  template: string | null;
  language: string | null;
  appHash: string | null;
  fee: string;
  createdAt: number;
  expiresAt: number;
  sequence: number;
}

export const SMS_TEMPLATES: Record<string, string> = {
  'en-US': 'Your verification code is {{CODE}}',
  'de-DE': 'Ihr Verifizierungscode lautet {{CODE}}',
  'fr-FR': 'Votre code de vérification est {{CODE}}',
};

// Deliberately not the SMS tag set: a channel resolves against its own catalogue, so fr-FR has a
// template here and no recording, and asking for it over callout falls back.
export const CALLOUT_LANGUAGES: readonly string[] = ['en-US', 'de-DE', 'pt-PT'];

/** Primary subtag lower-cased, region subtag upper-cased. */
export function canonicalLanguageTag(tag: string): string {
  const [primary, region] = tag.split('-');
  const head = (primary ?? '').toLowerCase();
  return region === undefined ? head : `${head}-${region.toUpperCase()}`;
}

// Catalogues are matched on the exact canonical tag, so a bare primary subtag passes validation and
// then falls back — the trap the snapshot records under constraints.languageTag.
export function resolveLanguage(
  languages: readonly string[],
  catalogue: readonly string[],
): string {
  for (const tag of languages) {
    const canonical = canonicalLanguageTag(tag);
    if (catalogue.includes(canonical)) return canonical;
  }
  return LANGUAGE_TAG_FALLBACK;
}

export function resolveTemplate(language: string): string | null {
  return SMS_TEMPLATES[language] ?? null;
}

/**
 * The channels that announce a code, each with its own catalogue. Membership is what makes a
 * channel read a language block at all, so adding one is a single entry.
 */
export const LANGUAGE_CATALOGUES: ReadonlyMap<string, readonly string[]> = new Map([
  [METHOD.sms, Object.keys(SMS_TEMPLATES)],
  [METHOD.callout, CALLOUT_LANGUAGES],
]);

export function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizedDestination(value: string): string {
  return value.replace(DESTINATION_SEPARATORS, '');
}

export interface CreateRowInput {
  applicationKey: string;
  id: string;
  destination: string;
  deliveryMethod: string;
  status: string;
  errorCode: string | null;
  template: string | null;
  language: string | null;
  appHash: string | null;
}

export class MockState {
  readonly applications = new Map<string, MockApplication>();

  private readonly rows = new Map<string, VerificationRow>();
  private sequence = 0;

  constructor(
    applications: readonly MockApplication[],
    private readonly settings: {
      code: string;
      fee: string;
      lifetimeSeconds: number;
    },
  ) {
    for (const application of applications) this.applications.set(application.key, application);
  }

  /** Fixed, so a caller can report the right value without reading an SMS. */
  get verificationCode(): string {
    return this.settings.code;
  }

  application(key: string): MockApplication | undefined {
    return this.applications.get(key);
  }

  create(input: CreateRowInput, at: number): VerificationRow {
    this.sequence += 1;
    const row: VerificationRow = {
      ...input,
      expectedValue: this.settings.code,
      attempts: 0,
      fee: this.settings.fee,
      createdAt: at,
      expiresAt: at + this.settings.lifetimeSeconds * 1000,
      sequence: this.sequence,
    };
    this.rows.set(row.id, row);
    return row;
  }

  findById(applicationKey: string, id: string): VerificationRow | undefined {
    const row = this.rows.get(id);
    return row?.applicationKey === applicationKey ? row : undefined;
  }

  /** The newest verification for the number, finished ones included. */
  newestByNumber(applicationKey: string, destination: string): VerificationRow | undefined {
    let newest: VerificationRow | undefined;
    for (const row of this.rows.values()) {
      if (row.applicationKey !== applicationKey || row.destination !== destination) continue;
      if (newest === undefined || row.sequence > newest.sequence) newest = row;
    }
    return newest;
  }

  supersede(applicationKey: string, destination: string): VerificationRow[] {
    const superseded: VerificationRow[] = [];
    for (const row of this.rows.values()) {
      if (row.applicationKey !== applicationKey || row.destination !== destination) continue;
      if (row.status !== STATUS.pending) continue;
      row.status = STATUS.failed;
      row.errorCode = CODE.superseded;
      superseded.push(row);
    }
    return superseded;
  }
}

export function newVerificationId(): string {
  return randomUUID();
}

interface VerificationView {
  status: string;
  errorCode: string | null;
}

/**
 * `expired` is synthesised on read: an unfinished row past its deadline reads as expired with
 * error_code `expired` and nothing is written, so a poll can reach the state on its own.
 */
export function viewOf(row: VerificationRow, at: number): VerificationView {
  if (row.status === STATUS.pending && at > row.expiresAt) {
    return { status: STATUS.expired, errorCode: CODE.expired };
  }
  return { status: row.status, errorCode: row.errorCode };
}

export function renderVerification(row: VerificationRow, at: number): Record<string, unknown> {
  const view = viewOf(row, at);
  const body: Record<string, unknown> = {
    id: row.id,
    destination: row.destination,
    delivery_method: row.deliveryMethod,
    fee: row.fee,
    status: view.status,
    error_code: view.errorCode,
    error_detail: view.errorCode === null ? null : errorDetail(view.errorCode),
    expires_at: new Date(row.expiresAt).toISOString(),
  };
  if (row.deliveryMethod === METHOD.sms) {
    const sms: Record<string, unknown> = {
      template: row.template,
      language: row.language,
      interception_timeout: INTERCEPTION_TIMEOUT_SECONDS,
    };
    // The key is omitted entirely unless a hash was stored on this verification.
    if (row.appHash !== null) sms.app_hash = row.appHash;
    body.sms = sms;
  }
  if (row.deliveryMethod === METHOD.callout) {
    body.callout = { language: row.language };
  }
  return body;
}

export interface DefaultApplicationOptions {
  /** Origin the seeded callback URLs point at. */
  callbackBaseUrl: string;
}

export const DEFAULT_CALLBACK_BASE_URL = 'http://127.0.0.1:4010';

export function defaultApplications({
  callbackBaseUrl,
}: DefaultApplicationOptions): MockApplication[] {
  const base = callbackBaseUrl.replace(/\/+$/, '');
  return [
    {
      key: 'app_signed_only',
      secret: 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNU',
      minimumScheme: 'application',
      callbackUrl: null,
    },
    {
      key: 'app_basic',
      secret: 'acBpD4X47M4weWWYOsMgHb4UNJb8knib9LnBkqa8j_g',
      minimumScheme: 'basic',
      callbackUrl: null,
    },
    {
      key: 'app_basic_callback',
      secret: 'IvZkI6-ySzvs6ZtTlooMhdYKfoj3k9RGeQAySzQSFv4',
      minimumScheme: 'basic',
      callbackUrl: `${base}/callbacks/verification`,
    },
    {
      key: 'app_public_callback',
      secret: 'gRsKvkdrOL7WBmPnQx69bdaEI-u-VDC_RZLwkRMwG_k',
      minimumScheme: 'public',
      callbackUrl: `${base}/callbacks/verification`,
    },
    // Registered at a bare origin: the callback signature is computed over the EMPTY STRING, not
    // over '/'. A receiver that signs the pathname it was called on denies every verification.
    {
      key: 'app_public_bare_origin',
      secret: 'N_LcOP92KN816zeNCr7QBecO5JR1vuhZ-wAVeTrC5TM',
      minimumScheme: 'public',
      callbackUrl: base,
    },
    {
      key: 'app_public_no_callback',
      secret: 'QfhoxiHzoUA8aC-4LpVnk2Si-v-S98zcXycW_gr5SbI',
      minimumScheme: 'public',
      callbackUrl: null,
    },
  ];
}
