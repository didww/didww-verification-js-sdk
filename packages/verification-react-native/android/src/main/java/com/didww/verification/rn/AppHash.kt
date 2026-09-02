package com.didww.verification.rn

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.util.Log
import java.security.MessageDigest

/**
 * The 11-character hash the platform SMS Retriever requires at the end of a message before it
 * will hand that message to this app.
 */
internal object AppHash {

    private const val HASHED_BYTES = 9
    private const val BASE64_CHARS = 11
    private const val LOG_TAG = "DidwwVerification"
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    private val FORMAT = Regex("[A-Za-z0-9+/]{$BASE64_CHARS}")

    /** `null` when the signing certificate cannot be read at all; never throws. */
    fun compute(context: Context): String? {
        val packageName = context.packageName
        val signature = currentSigner(context, packageName) ?: run {
            Log.w(LOG_TAG, "no signing certificate for $packageName; SMS auto-capture unavailable")
            return null
        }

        val hash = hash(packageName, signature.toCharsString())
        if (!wellFormed(hash)) {
            Log.w(LOG_TAG, "computed app hash is malformed; SMS auto-capture unavailable")
            return null
        }

        // A wrong hash means the broadcast simply never arrives, with no error anywhere, so the
        // logged value is the only way a mismatch is diagnosable on a device we do not have.
        Log.d(LOG_TAG, "app hash for $packageName: $hash")
        return hash
    }

    /**
     * The server validates this key and rejects a malformed one with a 422 that fails the whole
     * verification, not just auto-capture — so a malformed value must never leave the device.
     */
    fun wellFormed(hash: String): Boolean = FORMAT.matches(hash)

    /**
     * @param signatureHex `Signature.toCharsString()` — lowercase hex of the certificate's DER
     *   bytes, **not** a digest of them. A digest yields a plausible hash that never matches, and
     *   the only symptom is that auto-capture never fires.
     */
    fun hash(packageName: String, signatureHex: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$packageName $signatureHex".toByteArray(Charsets.UTF_8))
        return base64NoPad(digest.copyOf(HASHED_BYTES)).take(BASE64_CHARS)
    }

    /**
     * Hand-rolled because `java.util.Base64` is API 26 against a floor of 24, where it is a
     * `NoClassDefFoundError` that no JVM test can see; `android.util.Base64` returns stub values
     * off-device, which would force this file's tests onto an Android runtime.
     */
    internal fun base64NoPad(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i < bytes.size) {
            val remaining = bytes.size - i
            var triple = (bytes[i].toInt() and 0xff) shl 16
            if (remaining > 1) triple = triple or ((bytes[i + 1].toInt() and 0xff) shl 8)
            if (remaining > 2) triple = triple or (bytes[i + 2].toInt() and 0xff)

            out.append(ALPHABET[(triple ushr 18) and 0x3f])
            out.append(ALPHABET[(triple ushr 12) and 0x3f])
            if (remaining > 1) out.append(ALPHABET[(triple ushr 6) and 0x3f])
            if (remaining > 2) out.append(ALPHABET[triple and 0x3f])
            i += 3
        }
        return out.toString()
    }

    @Suppress("DEPRECATION")
    private fun currentSigner(context: Context, packageName: String): Signature? = runCatching {
        val pm = context.packageManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                .signingInfo
            // Under certificate rotation `signingCertificateHistory` holds the original first and
            // the current one last, so its first entry no longer signs anything.
            val current = info?.apkContentsSigners?.firstOrNull()
                ?: info?.signingCertificateHistory?.lastOrNull()
            if (current != null) return@runCatching current
        }

        // `signingInfo` is documented nullable and really is null in practice, so the deprecated
        // array stays the fallback at every API level, not only below 28.
        pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()
    }.getOrNull()
}
