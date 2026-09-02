package com.didww.verification.rn

import android.content.pm.Signature
import android.content.pm.SigningInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.experimental.runners.Enclosed
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSigningInfo

private const val PACKAGE = "com.didww.android.sdk.verification.sample"
private const val SIGNATURE_HEX =
    "30820253308201bca003020102020450e3f1c9300d06092a864886f70d01010b0500"

/**
 * Derived once, outside this codebase, by running the platform vendor's own documented reference
 * helper against the fixture above. A test that derives its expected value with the code under
 * test asserts only determinism — it would pass just as happily on a wrong algorithm, and a wrong
 * app hash has no symptom at all.
 */
private const val REFERENCE_HASH = "cnXrLKACSkF"

@RunWith(Enclosed::class)
class AppHashTest {

    class Algorithm {

        @Test
        fun `matches the reference helper for the fixture certificate`() {
            assertEquals(REFERENCE_HASH, AppHash.hash(PACKAGE, SIGNATURE_HEX))
        }

        @Test
        fun `is exactly eleven characters`() {
            assertEquals(11, AppHash.hash(PACKAGE, SIGNATURE_HEX).length)
            assertEquals(11, AppHash.hash("a", "b").length)
            assertEquals(11, AppHash.hash("", "").length)
        }

        @Test
        fun `changes when the package changes and when the certificate changes`() {
            val base = AppHash.hash(PACKAGE, SIGNATURE_HEX)
            assertNotEquals(base, AppHash.hash("$PACKAGE.debug", SIGNATURE_HEX))
            assertNotEquals(base, AppHash.hash(PACKAGE, SIGNATURE_HEX.dropLast(2) + "ff"))
        }

        @Test
        fun `carries no padding and no line wrapping`() {
            val hash = AppHash.hash(PACKAGE, SIGNATURE_HEX)
            assertFalse("padding would make the appended hash the wrong length", hash.contains("="))
            assertFalse("a wrapped hash would break the message body", hash.contains("\n"))
        }

        @Test
        fun `wellFormed accepts what the algorithm produces and rejects what the server refuses`() {
            assertTrue(AppHash.wellFormed(AppHash.hash(PACKAGE, SIGNATURE_HEX)))
            assertTrue(AppHash.wellFormed("FA+9qCX9VSu"))
            assertFalse("empty", AppHash.wellFormed(""))
            assertFalse("ten characters", AppHash.wellFormed("cnXrLKACSk"))
            assertFalse("twelve characters", AppHash.wellFormed("cnXrLKACSkFF"))
            assertFalse("base64 padding", AppHash.wellFormed("cnXrLKACSk="))
            assertFalse("url-safe minus", AppHash.wellFormed("cnXrLKACSk-"))
            assertFalse("url-safe underscore", AppHash.wellFormed("cnXrLKACSk_"))
        }
    }

    /**
     * `java.util.Base64` is banned in production here (API 26 against a floor of 24) but always
     * present on the JVM, which makes it a real external oracle for the hand-rolled encoder — the
     * single fixture above only pins one nine-byte input.
     */
    class Encoder {

        private fun assertAgreesWithJvm(bytes: ByteArray) {
            assertEquals(
                java.util.Base64.getEncoder().withoutPadding().encodeToString(bytes),
                AppHash.base64NoPad(bytes),
            )
        }

        @Test
        fun `agrees with the JVM encoder at every input length mod three`() {
            val source = ByteArray(12) { (it * 37 + 11).toByte() }
            for (length in 0..12) {
                assertAgreesWithJvm(source.copyOf(length))
            }
        }

        @Test
        fun `agrees with the JVM encoder on the plus and slash alphabet positions`() {
            val bytes = byteArrayOf(0xfb.toByte(), 0xff.toByte())
            assertEquals("+/8", AppHash.base64NoPad(bytes))
            assertAgreesWithJvm(bytes)
        }

        @Test
        fun `agrees with the JVM encoder on the nine-byte extremes`() {
            assertAgreesWithJvm(ByteArray(9))
            assertAgreesWithJvm(ByteArray(9) { 0xff.toByte() })
        }
    }

    /**
     * Only the `PackageManager` reads need an Android runtime; the algorithm above deliberately
     * does not. Pinned above 28 because assigning `PackageInfo.signingInfo` below it throws
     * `NoSuchFieldError`.
     */
    @RunWith(RobolectricTestRunner::class)
    @Config(sdk = [34])
    class Compute {

        private val context get() = RuntimeEnvironment.getApplication()

        private val otherHex =
            "30820253308201bca003020102020450e3f1c9300d06092a864886f70d01010bffff"

        @Suppress("DEPRECATION")
        private fun install(signingInfo: SigningInfo?, signatures: Array<Signature>?) {
            val info = context.packageManager.getPackageInfo(context.packageName, 0).apply {
                this.signingInfo = signingInfo
                this.signatures = signatures
            }
            shadowOf(context.packageManager).installPackage(info)
        }

        private fun signingInfo(
            current: Array<Signature>,
            history: Array<Signature>?,
        ): SigningInfo {
            val info = Shadow.newInstanceOf(SigningInfo::class.java)
            val shadow = Shadow.extract<ShadowSigningInfo>(info)
            shadow.setSignatures(current)
            history?.let(shadow::setPastSigningCertificates)
            return info
        }

        private fun expected(hex: String) = AppHash.hash(context.packageName, hex)

        @Test
        fun `hashes the certificate the APK is currently signed with`() {
            install(signingInfo(arrayOf(Signature(SIGNATURE_HEX)), null), null)
            assertEquals(expected(SIGNATURE_HEX), AppHash.compute(context))
        }

        @Test
        fun `takes the last rotation entry, not the first`() {
            // An empty apkContentsSigners is what forces the history path. The original
            // certificate sorts first there and no longer signs anything.
            val history = arrayOf(Signature(otherHex), Signature(SIGNATURE_HEX))
            install(signingInfo(emptyArray(), history), null)

            assertEquals(expected(SIGNATURE_HEX), AppHash.compute(context))
            assertNotEquals(expected(otherHex), AppHash.compute(context))
        }

        @Test
        fun `falls back to the deprecated array when signingInfo is null above API 28`() {
            install(null, arrayOf(Signature(SIGNATURE_HEX)))
            assertEquals(expected(SIGNATURE_HEX), AppHash.compute(context))
        }

        @Test
        fun `returns null instead of throwing when no certificate can be read`() {
            install(null, null)
            assertNull(AppHash.compute(context))
        }

        @Test
        fun `never returns a value the server would reject`() {
            install(signingInfo(arrayOf(Signature(SIGNATURE_HEX)), null), null)
            assertTrue(AppHash.wellFormed(AppHash.compute(context)!!))
        }
    }

    /**
     * Below 28 the deprecated array is the only source of the certificate, and 24 is the floor —
     * a quarter of the supported range takes a path the class above never reaches. Separate
     * because this setup must never assign `PackageInfo.signingInfo`; the field is absent here.
     */
    @RunWith(RobolectricTestRunner::class)
    @Config(sdk = [24])
    class ComputeBelowApi28 {

        private val context get() = RuntimeEnvironment.getApplication()

        @Suppress("DEPRECATION")
        private fun install(signatures: Array<Signature>?) {
            val info = context.packageManager.getPackageInfo(context.packageName, 0).apply {
                this.signatures = signatures
            }
            shadowOf(context.packageManager).installPackage(info)
        }

        @Test
        fun `reads the certificate from the deprecated array`() {
            install(arrayOf(Signature(SIGNATURE_HEX)))
            assertEquals(AppHash.hash(context.packageName, SIGNATURE_HEX), AppHash.compute(context))
        }

        @Test
        fun `returns null instead of throwing when no certificate can be read`() {
            install(null)
            assertNull(AppHash.compute(context))
        }
    }
}
