package com.didww.verification.rn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status

/**
 * Arms the platform SMS Retriever and hands whole message bodies to [emit].
 *
 * @param arm a seam so the tests can drive arming, and its failure, without Play Services.
 */
internal class SmsRetrieverBridge(
    private val context: Context,
    private val emit: (String) -> Unit,
    private val arm: () -> Unit = { SmsRetriever.getClient(context).startSmsRetriever() },
) {

    private var receiver: BroadcastReceiver? = null

    @Synchronized
    fun start() {
        stop()

        val registered = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                handle(intent.extras)
            }
        }

        ContextCompat.registerReceiver(
            context,
            registered,
            IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
            // Not optional: a runtime-exported receiver is reachable by every app on the device
            // and the Retriever's extras are forgeable, so without this a hostile app can inject a
            // code this SDK then submits. `ContextCompat.registerReceiver` has a 4-arg and a 6-arg
            // overload and no 5-arg form; the 4-arg one compiles cleanly and drops the permission.
            SmsRetriever.SEND_PERMISSION,
            null,
            ContextCompat.RECEIVER_EXPORTED,
        )
        receiver = registered

        try {
            arm()
        } catch (t: Throwable) {
            // Without this the receiver survives the failed start for the whole process lifetime.
            stop()
            throw t
        }
    }

    /** Idempotent and never throws: this is what a React cleanup ends up calling. */
    @Synchronized
    fun stop() {
        val registered = receiver ?: return
        receiver = null
        runCatching { context.unregisterReceiver(registered) }
    }

    private fun handle(extras: Bundle?) {
        @Suppress("DEPRECATION")
        val status = extras?.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return

        when (status.statusCode) {
            CommonStatusCodes.SUCCESS -> {
                @Suppress("DEPRECATION")
                val body = extras.get(SmsRetriever.EXTRA_SMS_MESSAGE) as? String ?: return
                // The whole body, unparsed: extraction lives on the JavaScript side and a second
                // copy of that rule here could disagree with it.
                emit(body)
            }

            CommonStatusCodes.TIMEOUT -> {
                // The platform's own five-minute window, which may be shorter than the server's
                // deadline. Re-arm rather than inventing a timeout here: the JavaScript listener
                // owns that budget and a second countdown could disagree with it.
                Log.d(LOG_TAG, "SMS Retriever window elapsed; re-arming")
                runCatching(arm)
            }
        }
    }

    private companion object {
        private const val LOG_TAG = "DidwwVerification"
    }
}
