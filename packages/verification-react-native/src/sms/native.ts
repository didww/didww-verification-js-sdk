// Declared locally because this package's `types` deliberately exclude Node globals, and
// non-optional because Metro's dependency collector does not visit an OptionalCallExpression:
// `require?.()` would keep the specifier out of the bundle.
declare const require: (id: string) => unknown;

// The name the Android module registers with `Name(...)`, which must match exactly; a mismatch
// resolves to `null` and degrades to manual entry with no error anywhere.
const NATIVE_MODULE_NAME = 'DidwwVerificationSms';

/** Payload of the `onSmsReceived` event. */
export interface SmsReceivedEvent {
  readonly message: string;
}

export interface EventSubscription {
  remove(): void;
}

/** The Android module's surface. */
export interface NativeSmsModule {
  // Nullable: the module answers `null` for a build whose signing certificate it cannot read.
  getAppHash(): Promise<string | null>;
  startRetriever(): Promise<void>;
  stopRetriever(): Promise<void>;
  addListener(
    event: 'onSmsReceived',
    listener: (payload: SmsReceivedEvent) => void,
  ): EventSubscription;
}

/** The part of `expo-modules-core` this package uses. */
export interface ExpoModulesCore {
  requireOptionalNativeModule<T>(name: string): T | null;
}

let expoModulesCore: ExpoModulesCore | null;
try {
  // Must stay inline in this try, never a static import or a hoisted require: only that shape is
  // collected as an optional dependency, so a bare app without Expo Modules otherwise fails to bundle.
  expoModulesCore = require('expo-modules-core') as ExpoModulesCore;
} catch {
  expoModulesCore = null;
}

/**
 * @internal Second optionality: the module is not linked in Expo Go, and never can be.
 * `requireOptionalNativeModule` answers `null` there rather than throwing.
 */
export function resolveNativeSmsModule(core: ExpoModulesCore | null): NativeSmsModule | null {
  return core === null
    ? null
    : core.requireOptionalNativeModule<NativeSmsModule>(NATIVE_MODULE_NAME);
}

/** @internal The gate {@link isSmsAutoCaptureAvailable} applies, over an explicit module. */
export function supportsAutoCapture(module: NativeSmsModule | null): boolean {
  return typeof module?.startRetriever === 'function';
}

const nativeSmsModule = resolveNativeSmsModule(expoModulesCore);

/** The linked native module, or `null` on iOS, in Expo Go, and in a bare app without Expo Modules. */
export function getNativeSmsModule(): NativeSmsModule | null {
  return nativeSmsModule;
}

/**
 * Whether SMS auto-capture can run. This is module presence, not `Platform.OS === 'android'`: on
 * Android in Expo Go the OS answers yes while the module is unlinked and capture is impossible.
 */
export function isSmsAutoCaptureAvailable(): boolean {
  return supportsAutoCapture(nativeSmsModule);
}
